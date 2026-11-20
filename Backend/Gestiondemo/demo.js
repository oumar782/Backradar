import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import db from '../db.js';
import { persistSale } from '../sales.js';

const router = express.Router();
router.use(express.json());

// ============================================
// GESTION DES TOKENS DE DÉMO (USAGE UNIQUE)
// ============================================
const DEVICE_COOKIE = 'monradar_demo_device';
const hashIdentifier = value => createHash('sha256').update(value).digest('hex');

function getCookie(req, name) {
    const prefix = `${name}=`;
    const entry = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
    return entry ? decodeURIComponent(entry.slice(prefix.length)) : null;
}

const checkDemoAccess = async (req, res, next) => {
    const token = req.headers['x-demo-token'];
    if (!token) return res.status(401).json({ success: false, message: "Token manquant." });
    try {
        const result = await db.query(
            `SELECT store_id, expires_at FROM demo_device_sessions WHERE token_hash = $1 AND expires_at > NOW()`,
            [hashIdentifier(token)]
        );
        if (!result.rows[0]) return res.status(403).json({ success: false, message: "Session de démonstration expirée ou invalide." });
        req.demoSession = result.rows[0];
        next();
    } catch (error) {
        next(error);
    }
};

router.post('/demo/start', async (req, res, next) => {
    let deviceId = getCookie(req, DEVICE_COOKIE);
    const isNewDevice = !deviceId;
    if (isNewDevice) deviceId = randomUUID();

    const deviceHash = hashIdentifier(deviceId);
    const existing = await db.query(
        `SELECT expires_at FROM demo_device_sessions WHERE device_key_hash = $1`,
        [deviceHash]
    );
    if (existing.rows.length) {
        if (isNewDevice) setDeviceCookie(res, deviceId);
        return res.status(403).json({
            success: false,
            code: 'DEMO_ALREADY_USED',
            message: 'Cette démonstration a déjà été utilisée sur cet appareil.'
        });
    }

    const token = randomUUID();
    const client = await db.connect();
    try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const store = await client.query(
            `INSERT INTO stores (name, timezone) VALUES ($1, $2) RETURNING id`,
            [`Magasin d'essai ${deviceHash.slice(0, 8)}`, 'Europe/Paris']
        );
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await client.query(
            `INSERT INTO demo_device_sessions (device_key_hash, token_hash, store_id, expires_at)
             VALUES ($1, $2, $3, $4)`,
            [deviceHash, hashIdentifier(token), store.rows[0].id, expiresAt]
        );
        await client.query('COMMIT');
        setDeviceCookie(res, deviceId);
        res.json({ success: true, token, expires_at: expiresAt.toISOString(), expires_in: '15 minutes' });
    } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') {
            return res.status(403).json({ success: false, code: 'DEMO_ALREADY_USED', message: 'Cette démonstration a déjà été utilisée sur cet appareil.' });
        }
        next(error);
    } finally {
        client.release();
    }
});

function setDeviceCookie(res, deviceId) {
    const production = process.env.NODE_ENV === 'production';
    res.cookie(DEVICE_COOKIE, deviceId, {
        httpOnly: true,
        secure: production,
        sameSite: production ? 'none' : 'lax',
        path: '/api/demo',
        maxAge: 10 * 365 * 24 * 60 * 60 * 1000
    });
}

// ============================================
// CRUD (STORES, PRODUCTS, SALES)
// ============================================
router.get('/stores', checkDemoAccess, async (req, res) => {
    const result = await db.query('SELECT * FROM stores WHERE id = $1', [req.demoSession.store_id]);
    res.json({ success: true, data: result.rows });
});

router.post('/stores', checkDemoAccess, async (req, res) => {
    const { name, timezone } = req.body;
    const result = await db.query(
        'UPDATE stores SET name = COALESCE($2, name), timezone = COALESCE($3, timezone) WHERE id = $1 RETURNING *',
        [req.demoSession.store_id, name, timezone]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
});

router.get('/products', checkDemoAccess, async (req, res) => {
    const result = await db.query('SELECT * FROM products WHERE store_id = $1 ORDER BY name ASC', [req.demoSession.store_id]);
    res.json({ success: true, data: result.rows });
});

router.get('/sales', checkDemoAccess, async (req, res) => {
    const result = await db.query(`
        SELECT s.*,
               COALESCE(
                   jsonb_agg(jsonb_build_object(
                       'id', si.id,
                       'product_id', si.product_id,
                       'product_name', p.name,
                       'quantity', si.quantity,
                       'unit_price', si.unit_price,
                       'unit_cost', si.unit_cost,
                       'discount_amount', si.discount_amount,
                       'tax_rate', si.tax_rate
                   ) ORDER BY si.id) FILTER (WHERE si.id IS NOT NULL),
                   '[]'::jsonb
               ) AS items
        FROM sales s
        LEFT JOIN sale_items si ON si.sale_id = s.id AND si.store_id = s.store_id
        LEFT JOIN products p ON p.id = si.product_id AND p.store_id = si.store_id
        WHERE s.store_id = $1
        GROUP BY s.id
        ORDER BY s.sold_at DESC, s.id DESC
    `, [req.demoSession.store_id]);
    res.json({ success: true, store_id: String(req.demoSession.store_id), data: result.rows });
});

router.get('/stock-movements', checkDemoAccess, async (req, res) => {
    const result = await db.query(`
        SELECT movement.*, product.name AS product_name, product.sku
        FROM stock_movements movement
        JOIN products product
          ON product.id = movement.product_id
         AND product.store_id = movement.store_id
        WHERE movement.store_id = $1
        ORDER BY movement.occurred_at DESC, movement.id DESC
    `, [req.demoSession.store_id]);
    res.json({ success: true, store_id: String(req.demoSession.store_id), data: result.rows });
});

router.post('/products', checkDemoAccess, async (req, res) => {
    const { sku, name, category, product_type, unit_label, tracks_stock, reference_cost } = req.body;
    const referenceCost = Number(reference_cost);
    if (!String(name || '').trim() || !product_type || !Number.isFinite(referenceCost) || referenceCost < 0) {
        return res.status(400).json({
            success: false,
            message: 'Le nom, le type et le coût de référence réel du produit sont requis pour calculer des marges fiables.'
        });
    }
    const tracksStock = tracks_stock === undefined
        ? String(product_type).toLowerCase() !== 'service'
        : tracks_stock === true;
    const result = await db.query(
        `INSERT INTO products (store_id, sku, name, category, product_type, unit_label, tracks_stock, reference_cost) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [req.demoSession.store_id, sku, String(name).trim(), category, product_type, unit_label || 'unit', tracksStock, referenceCost]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
});

router.post('/stock-movements', checkDemoAccess, async (req, res) => {
    const { product_id, movement_type, quantity_delta, unit_cost, occurred_at, notes } = req.body;
    const allowedTypes = new Set(['opening_balance', 'purchase', 'adjustment', 'loss', 'customer_return', 'supplier_return']);
    const quantity = Number(quantity_delta);
    if (!allowedTypes.has(movement_type) || !Number.isFinite(quantity) || quantity === 0) {
        return res.status(400).json({ success: false, message: 'Type ou quantité de mouvement invalide.' });
    }
    if (['opening_balance', 'purchase', 'customer_return'].includes(movement_type) && quantity < 0) {
        return res.status(400).json({ success: false, message: 'Ce type de mouvement doit ajouter du stock.' });
    }
    if (['loss', 'supplier_return'].includes(movement_type) && quantity > 0) {
        return res.status(400).json({ success: false, message: 'Ce type de mouvement doit retirer du stock.' });
    }

    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const product = await client.query(
            `SELECT product_type, tracks_stock FROM products WHERE id = $1 AND store_id = $2`,
            [product_id, req.demoSession.store_id]
        );
        if (!product.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Produit introuvable dans ce magasin de démo.' });
        }
        if (String(product.rows[0].product_type).toLowerCase() === 'service' || !product.rows[0].tracks_stock) {
            await client.query('ROLLBACK');
            return res.status(422).json({ success: false, message: 'Ce produit ne suit pas le stock.' });
        }
        const result = await client.query(
            `INSERT INTO stock_movements
                (store_id, product_id, movement_type, quantity_delta, unit_cost, occurred_at, notes)
             VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()), $7)
             RETURNING *`,
            [req.demoSession.store_id, product_id, movement_type, quantity, unit_cost ?? null, occurred_at ?? null, notes ?? null]
        );
        await client.query('COMMIT');
        res.status(201).json({ success: true, data: result.rows[0] });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
});

router.post('/sales', checkDemoAccess, async (req, res) => {
    const { sale_reference, status, currency, items } = req.body;
    const client = await db.connect();
    try {
        const sale = await persistSale(client, { store_id: req.demoSession.store_id, sale_reference, status, currency, items });
        res.status(201).json({ success: true, data: sale });
    } catch (error) {
        const status = error.code === 'INVALID_SALE_ITEMS' ? 400
            : error.code === 'MISSING_PRODUCT_COST' ? 422
            : ['MIXED_CURRENCY', 'CURRENCY_MISMATCH'].includes(error.code) ? 409 : 500;
        res.status(status)
            .json({ success: false, code: error.code, error: error.message });
    } finally {
        client.release();
    }
});

// ============================================
// ANALYTICS ULTRA-COMPLET (RENTABILITÉ + AVANCÉ)
// ============================================
router.get('/analytics/complete', checkDemoAccess, async (req, res) => {
    try {
        const storeId = req.demoSession.store_id;
        const demoStoreResult = await db.query(
            'SELECT id, name FROM stores WHERE id = $1',
            [storeId]
        );
        const demoStore = demoStoreResult.rows[0];
        if (!demoStore) {
            return res.status(409).json({
                success: false,
                message: 'Le magasin de cette session de démo n’existe plus.'
            });
        }
        const dataSummary = await db.query(`
            SELECT
                (SELECT COUNT(*) FROM products WHERE store_id = $1) AS product_count,
                (SELECT COUNT(*) FROM sales WHERE store_id = $1 AND status = 'completed') AS completed_sale_count,
                (SELECT COUNT(*) FROM sale_items item JOIN sales sale ON sale.id = item.sale_id AND sale.store_id = item.store_id
                  WHERE item.store_id = $1 AND sale.status = 'completed') AS completed_sale_item_count,
                (SELECT COUNT(*) FROM sale_items item
                   JOIN sales sale ON sale.id = item.sale_id AND sale.store_id = item.store_id
                   JOIN products product ON product.id = item.product_id AND product.store_id = item.store_id
                  WHERE item.store_id = $1 AND sale.status = 'completed'
                    AND COALESCE(item.unit_cost, product.reference_cost) IS NULL) AS missing_cost_line_count,
                (SELECT COUNT(*) FROM stock_movements WHERE store_id = $1) AS stock_movement_count
        `, [storeId]);
        const currencyResult = await db.query(
            `SELECT DISTINCT upper(btrim(currency::text)) AS currency
             FROM sales WHERE store_id = $1 AND status = 'completed' ORDER BY currency`,
            [storeId]
        );
        if (currencyResult.rows.length > 1) {
            return res.status(409).json({
                success: false,
                code: 'MIXED_CURRENCY',
                message: 'Les ventes de ce magasin utilisent plusieurs devises. Les montants ne sont pas additionnés afin de ne pas afficher un total trompeur.',
                currencies: currencyResult.rows.map(row => row.currency),
                store_id: String(demoStore.id)
            });
        }
        const currencyCode = currencyResult.rows[0]?.currency || null;
        const currencySuffix = currencyCode ? ` ${currencyCode}` : '';
        const numeric = value => {
            if (value === null || value === undefined || value === '') return null;
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        };
        const safeNumber = value => numeric(value) ?? 0;
        const money = value => numeric(value) === null ? null : `${numeric(value).toFixed(2)}${currencySuffix}`;
        const percent = value => numeric(value) === null ? null : `${numeric(value).toFixed(2)}%`;
        const productCount = Number(dataSummary.rows[0].product_count);
        const completedSaleCount = Number(dataSummary.rows[0].completed_sale_count);
        const completedSaleItemCount = Number(dataSummary.rows[0].completed_sale_item_count);
        const missingCostLineCount = Number(dataSummary.rows[0].missing_cost_line_count);
        const stockMovementCount = Number(dataSummary.rows[0].stock_movement_count);
        if (missingCostLineCount > 0) {
            return res.status(409).json({
                success: false,
                code: 'MISSING_SALE_COST',
                store_id: String(demoStore.id),
                missing_cost_lines: missingCostLineCount,
                message: 'Certaines lignes de vente n’ont pas de coût enregistré. Les marges ne sont pas affichées afin de ne pas les inventer.'
            });
        }

        // ============================================
        // 1. KPIs GÉNÉRAUX & FINANCIERS DE BASE
        // ============================================
        const kpiQuery = await db.query(`
            WITH sales_data AS (
                SELECT 
                    SUM(si.quantity * si.unit_price) as total_revenue,
                    COUNT(DISTINCT s.id) as total_transactions,
                    AVG(si.quantity * si.unit_price) as avg_ticket,
                    SUM(si.quantity) as total_items_sold,
                    SUM(si.discount_amount) as total_discounts,
                    SUM(si.tax_rate * si.quantity * si.unit_price / 100) as total_taxes
                FROM sales s
                JOIN sale_items si ON s.id = si.sale_id
                WHERE s.store_id = $1 AND s.status = 'completed'
            ),
            cost_data AS (
                SELECT SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost)) as total_cost
                FROM sale_items si
                JOIN products p ON si.product_id = p.id AND p.store_id = $1
                JOIN sales s ON s.id = si.sale_id AND s.store_id = $1 AND s.status = 'completed'
            )
            SELECT 
                sd.*, cd.total_cost,
                (sd.total_revenue - cd.total_cost) as gross_margin,
                CASE WHEN sd.total_revenue > 0 THEN ((sd.total_revenue - cd.total_cost) / sd.total_revenue * 100) ELSE 0 END as gross_margin_pct,
                (sd.total_revenue - cd.total_cost - sd.total_discounts) as net_margin,
                CASE WHEN sd.total_revenue > 0 THEN ((sd.total_revenue - cd.total_cost - sd.total_discounts) / sd.total_revenue * 100) ELSE 0 END as net_margin_pct
            FROM sales_data sd, cost_data cd
        `, [storeId]);
        const kpis = kpiQuery.rows[0];

        // ============================================
        // 2. ANALYSE ABC (Pareto 80/20 sur les produits)
        // ============================================
        const abcAnalysis = await db.query(`
            WITH product_revenue AS (
                SELECT 
                    p.id, p.name, p.category,
                    SUM(si.quantity * si.unit_price) as revenue,
                    SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost)) as cost,
                    SUM(si.quantity * si.unit_price) - SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost)) as margin
                FROM products p
                JOIN sale_items si ON p.id = si.product_id AND si.store_id = $1
                JOIN sales s ON s.id = si.sale_id AND s.store_id = $1 AND s.status = 'completed'
                WHERE p.store_id = $1
                GROUP BY p.id, p.name, p.category
            ),
            cumulative AS (
                SELECT 
                    *,
                    SUM(revenue) OVER (ORDER BY revenue DESC) as cumulative_revenue,
                    SUM(revenue) OVER () as total_revenue,
                    (SUM(revenue) OVER (ORDER BY revenue DESC) / SUM(revenue) OVER () * 100) as cumulative_pct
                FROM product_revenue
            )
            SELECT 
                name, category, revenue, cost, margin,
                cumulative_pct,
                CASE 
                    WHEN cumulative_pct <= 80 THEN 'A (Top 80%)'
                    WHEN cumulative_pct <= 95 THEN 'B (Moyen)'
                    ELSE 'C (Faible)'
                END as abc_class
            FROM cumulative
            ORDER BY revenue DESC
        `, [storeId]);

        // ============================================
        // 3. ANALYSE DE RENTABILITÉ PAR PRODUIT (DEEP DIVE)
        // ============================================
        const productProfitability = await db.query(`
            SELECT 
                p.name, p.category, p.sku,
                SUM(si.quantity) as qty_sold,
                SUM(si.quantity * si.unit_price) as revenue,
                SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost)) as total_cost,
                SUM(si.quantity * si.unit_price) - SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost)) as gross_profit,
                CASE 
                    WHEN SUM(si.quantity * si.unit_price) > 0 
                    THEN ROUND(((SUM(si.quantity * si.unit_price) - SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost))) / SUM(si.quantity * si.unit_price) * 100)::numeric, 2)
                    ELSE 0 
                END as margin_pct,
                AVG(si.unit_price) as avg_selling_price,
                COALESCE(AVG(si.unit_cost), p.reference_cost) as unit_cost,
                AVG(si.unit_price) - COALESCE(AVG(si.unit_cost), p.reference_cost) as avg_unit_margin,
                CASE 
                    WHEN SUM(si.quantity * si.unit_price) - SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost)) < 0 THEN 'DÉFICITAIRE'
                    WHEN (SUM(si.quantity * si.unit_price) - SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost))) / NULLIF(SUM(si.quantity * si.unit_price), 0) < 0.1 THEN 'FAIBLE MARGE'
                    WHEN (SUM(si.quantity * si.unit_price) - SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost))) / NULLIF(SUM(si.quantity * si.unit_price), 0) < 0.3 THEN 'MARGE MOYENNE'
                    ELSE 'HAUTE MARGE'
                END as profitability_status
            FROM products p
            JOIN sale_items si ON p.id = si.product_id AND si.store_id = $1
                JOIN sales s ON s.id = si.sale_id AND s.store_id = $1 AND s.status = 'completed'
            WHERE p.store_id = $1
            GROUP BY p.id, p.name, p.category, p.sku, p.reference_cost
            ORDER BY gross_profit DESC
        `, [storeId]);

        // ============================================
        // 4. ANALYSE DE RENTABILITÉ PAR CATÉGORIE
        // ============================================
        const categoryProfitability = await db.query(`
            SELECT 
                p.category,
                COUNT(DISTINCT p.id) as nb_products,
                SUM(si.quantity) as qty_sold,
                SUM(si.quantity * si.unit_price) as revenue,
                SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost)) as cost,
                SUM(si.quantity * si.unit_price) - SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost)) as profit,
                ROUND(((SUM(si.quantity * si.unit_price) - SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost))) / NULLIF(SUM(si.quantity * si.unit_price), 0) * 100)::numeric, 2) as margin_pct,
                ROUND(AVG(si.quantity * si.unit_price)::numeric, 2) as avg_ticket,
                ROUND(SUM(si.quantity * si.unit_price) / NULLIF(SUM(si.quantity), 0)::numeric, 2) as avg_price_per_unit
            FROM products p
            JOIN sale_items si ON p.id = si.product_id AND si.store_id = $1
                JOIN sales s ON s.id = si.sale_id AND s.store_id = $1 AND s.status = 'completed'
            WHERE p.store_id = $1
            GROUP BY p.category
            ORDER BY profit DESC
        `, [storeId]);

        // ============================================
        // 5. ANALYSE DE RENTABILITÉ PAR MAGASIN
        // ============================================
        const storeProfitability = await db.query(`
            SELECT 
                st.name as store_name,
                COUNT(DISTINCT s.id) as nb_transactions,
                SUM(si.quantity * si.unit_price) as revenue,
                SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost)) as cost,
                SUM(si.quantity * si.unit_price) - SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost)) as profit,
                ROUND(((SUM(si.quantity * si.unit_price) - SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost))) / NULLIF(SUM(si.quantity * si.unit_price), 0) * 100)::numeric, 2) as margin_pct,
                ROUND(AVG(si.quantity * si.unit_price)::numeric, 2) as avg_ticket,
                ROUND(SUM(si.quantity * si.unit_price) / NULLIF(COUNT(DISTINCT s.id), 0)::numeric, 2) as revenue_per_transaction
            FROM sales s
            JOIN sale_items si ON s.id = si.sale_id
            JOIN products p ON si.product_id = p.id
            JOIN stores st ON s.store_id = st.id
            WHERE s.store_id = $1 AND s.status = 'completed'
            GROUP BY st.id, st.name
            ORDER BY profit DESC
        `, [storeId]);

        // ============================================
        // 6. ANALYSE DES COÛTS CACHÉS (Remises, Taxes, Pertes)
        // ============================================
        const hiddenCosts = await db.query(`
            SELECT 
                SUM(si.discount_amount) as total_discounts,
                SUM(si.tax_rate * si.quantity * si.unit_price / 100) as total_taxes,
                COUNT(CASE WHEN si.discount_amount > 0 THEN 1 END) as nb_discounted_sales,
                ROUND(AVG(CASE WHEN si.discount_amount > 0 THEN si.discount_amount ELSE NULL END)::numeric, 2) as avg_discount,
                ROUND(SUM(si.discount_amount) / NULLIF(SUM(si.quantity * si.unit_price), 0) * 100, 2) as discount_rate_pct,
                (SELECT COALESCE(SUM(ABS(quantity_delta) * unit_cost), 0) FROM stock_movements WHERE store_id = $1 AND movement_type = 'loss') as inventory_loss_cost
            FROM sale_items si
            JOIN sales s ON s.id = si.sale_id AND s.store_id = si.store_id AND s.status = 'completed'
            WHERE si.store_id = $1
        `, [storeId]);

        // ============================================
        // 7. ANALYSE BREAK-EVEN (Seuil de rentabilité)
        // ============================================
        const breakEven = await db.query(`
            WITH monthly_data AS (
                SELECT 
                    TO_CHAR(s.sold_at, 'YYYY-MM') as month,
                    SUM(si.quantity * si.unit_price) as revenue,
                    SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost)) as cost
                FROM sales s
                JOIN sale_items si ON s.id = si.sale_id
                JOIN products p ON si.product_id = p.id
                WHERE s.store_id = $1 AND s.status = 'completed'
                GROUP BY month
            )
            SELECT 
                month,
                revenue,
                cost,
                revenue - cost as profit,
                ROUND(AVG(revenue - cost) OVER ()::numeric, 2) as avg_monthly_profit,
                CASE 
                    WHEN revenue - cost < 0 THEN 'MARGE BRUTE NÉGATIVE'
                    ELSE 'MARGE BRUTE POSITIVE'
                END as status
            FROM monthly_data
            ORDER BY month DESC
        `, [storeId]);

        // ============================================
        // 8. ANALYSE D'ÉLASTICITÉ DES PRIX
        // ============================================
        const priceElasticity = await db.query(`
            WITH price_analysis AS (
                SELECT 
                    p.id, p.name,
                    MIN(si.unit_price) as min_price,
                    MAX(si.unit_price) as max_price,
                    AVG(si.unit_price) as avg_price,
                    STDDEV(si.unit_price) as price_stddev,
                    COUNT(*) as sale_lines,
                    SUM(si.quantity) as total_qty,
                    CASE 
                        WHEN MAX(si.unit_price) > MIN(si.unit_price) 
                        THEN (MAX(si.unit_price) - MIN(si.unit_price)) / NULLIF(MIN(si.unit_price), 0) * 100
                        ELSE 0 
                    END as price_range_pct
                FROM products p
                JOIN sale_items si ON p.id = si.product_id AND si.store_id = $1
                JOIN sales s ON s.id = si.sale_id AND s.store_id = $1 AND s.status = 'completed'
                WHERE p.store_id = $1
                GROUP BY p.id, p.name
                HAVING COUNT(*) > 1
            )
            SELECT *
            FROM price_analysis
            ORDER BY price_range_pct DESC
        `, [storeId]);

        // ============================================
        // 9. RÉSUMÉ DES TRANSACTIONS (sans identifiant client)
        // ============================================
        const customerAnalytics = await db.query(`
            WITH customer_data AS (
                SELECT 
                    s.id as sale_id,
                    s.sold_at,
                    SUM(si.quantity * si.unit_price) as transaction_value
                FROM sales s
                JOIN sale_items si ON s.id = si.sale_id
                WHERE s.store_id = $1 AND s.status = 'completed'
                GROUP BY s.id, s.sold_at
            )
            SELECT 
                COUNT(*) as total_transactions,
                COUNT(DISTINCT DATE_TRUNC('day', sold_at)) as active_days,
                SUM(transaction_value) as total_revenue,
                AVG(transaction_value) as avg_transaction_value,
                ROUND(STDDEV(transaction_value)::numeric, 2) as transaction_volatility,
                MAX(transaction_value) as max_transaction,
                MIN(transaction_value) as min_transaction,
                ROUND((SUM(transaction_value) / NULLIF(COUNT(DISTINCT DATE_TRUNC('day', sold_at)), 0))::numeric, 2) as avg_daily_revenue
            FROM customer_data
        `, [storeId]);

        // ============================================
        // 10. ANALYSE DES MOUVEMENTS DE STOCK (Pertes & Ajustements)
        // ============================================
        const stockMovementsAnalysis = await db.query(`
            SELECT 
                movement_type,
                COUNT(*) as nb_movements,
                SUM(quantity_delta) as total_quantity,
                SUM(ABS(quantity_delta) * unit_cost) as total_value,
                ROUND(AVG(ABS(quantity_delta))::numeric, 2) as avg_quantity_per_movement
            FROM stock_movements
            WHERE store_id = $1
            GROUP BY movement_type
            ORDER BY total_value DESC
        `, [storeId]);

        // ============================================
        // 11. ANALYSE DES PRODUITS DÉFICITAIRES (Ventes à perte)
        // ============================================
        const lossMakingProducts = await db.query(`
            SELECT 
                p.name, p.sku, p.category,
                COALESCE(AVG(si.unit_cost), p.reference_cost) as reference_cost,
                AVG(si.unit_price) as avg_selling_price,
                COALESCE(AVG(si.unit_cost), p.reference_cost) - AVG(si.unit_price) as loss_per_unit,
                COUNT(*) as sale_lines,
                SUM(si.quantity) as qty_sold,
                SUM(si.quantity * (COALESCE(si.unit_cost, p.reference_cost) - si.unit_price)) as total_loss
            FROM products p
            JOIN sale_items si ON p.id = si.product_id AND si.store_id = $1
                JOIN sales s ON s.id = si.sale_id AND s.store_id = $1 AND s.status = 'completed'
            WHERE p.store_id = $1 AND si.unit_price < COALESCE(si.unit_cost, p.reference_cost)
            GROUP BY p.id, p.name, p.sku, p.category, p.reference_cost
            ORDER BY total_loss DESC
        `, [storeId]);

        // ============================================
        // 12. ANALYSE DES MARGES PAR TRANCHE DE PRIX
        // ============================================
        const marginByPriceRange = await db.query(`
            WITH priced_lines AS (
                SELECT si.quantity, si.unit_price,
                       COALESCE(si.unit_cost, p.reference_cost) AS unit_cost,
                       NTILE(5) OVER (ORDER BY si.unit_price) AS price_quintile
                FROM sale_items si
                JOIN products p ON p.id = si.product_id AND p.store_id = si.store_id
                JOIN sales s ON s.id = si.sale_id AND s.store_id = si.store_id
                WHERE si.store_id = $1 AND s.status = 'completed'
            )
            SELECT price_quintile,
                   MIN(unit_price) AS min_unit_price,
                   MAX(unit_price) AS max_unit_price,
                   COUNT(*) AS sale_lines,
                   SUM(quantity) AS qty_sold,
                   SUM(quantity * unit_price) AS revenue,
                   SUM(quantity * unit_cost) AS cost,
                   SUM(quantity * (unit_price - unit_cost)) AS profit,
                   ROUND((SUM(quantity * (unit_price - unit_cost)) / NULLIF(SUM(quantity * unit_price), 0) * 100)::numeric, 2) AS margin_pct
            FROM priced_lines
            GROUP BY price_quintile
            ORDER BY price_quintile
        `, [storeId]);

        // ============================================
        // 13. ANALYSE DE LA CONCENTRATION DES VENTES (Top 10% des produits)
        // ============================================
        const salesConcentration = await db.query(`
            WITH product_sales AS (
                SELECT 
                    p.id, p.name,
                    SUM(si.quantity * si.unit_price) as revenue
                FROM products p
                JOIN sale_items si ON p.id = si.product_id AND si.store_id = $1
                JOIN sales s ON s.id = si.sale_id AND s.store_id = $1 AND s.status = 'completed'
                WHERE p.store_id = $1
                GROUP BY p.id, p.name
            ),
            ranked AS (
                SELECT 
                    *,
                    NTILE(10) OVER (ORDER BY revenue DESC) as decile
                FROM product_sales
            )
            SELECT 
                CASE 
                    WHEN decile = 1 THEN 'Top 10%'
                    WHEN decile <= 3 THEN 'Top 30%'
                    WHEN decile <= 5 THEN 'Top 50%'
                    ELSE 'Bottom 50%'
                END as segment,
                COUNT(*) as nb_products,
                SUM(revenue) as total_revenue,
                ROUND(AVG(revenue)::numeric, 2) as avg_revenue
            FROM ranked
            GROUP BY segment
            ORDER BY total_revenue DESC
        `, [storeId]);

        // ============================================
        // 14. ANALYSE DE LA VITESSE DE VENTE (Velocity)
        // ============================================
        const salesVelocity = await db.query(`
            WITH product_velocity AS (
                SELECT 
                    p.name, p.sku,
                    SUM(si.quantity) as total_qty_sold,
                    COUNT(DISTINCT DATE_TRUNC('day', s.sold_at)) as active_days,
                    ROUND((SUM(si.quantity) / NULLIF(COUNT(DISTINCT DATE_TRUNC('day', s.sold_at)), 0))::numeric, 2) as avg_daily_velocity
                FROM products p
                JOIN sale_items si ON p.id = si.product_id AND si.store_id = $1
                JOIN sales s ON s.id = si.sale_id AND s.store_id = $1 AND s.status = 'completed'
                WHERE p.store_id = $1 AND s.store_id = $1
                GROUP BY p.id, p.name, p.sku
            )
            SELECT 
                *,
                CASE 
                    WHEN avg_daily_velocity >= 5 THEN 'TRÈS RAPIDE'
                    WHEN avg_daily_velocity >= 2 THEN 'RAPIDE'
                    WHEN avg_daily_velocity >= 1 THEN 'MOYEN'
                    ELSE 'LENT'
                END as velocity_status
            FROM product_velocity
            ORDER BY avg_daily_velocity DESC
        `, [storeId]);

        // ============================================
        // 15. ANALYSE DES TENDANCES MENSUELLES (Croissance)
        // ============================================
        const monthlyTrends = await db.query(`
            WITH monthly_data AS (
                SELECT 
                    TO_CHAR(s.sold_at, 'YYYY-MM') as month,
                    SUM(si.quantity * si.unit_price) as revenue,
                    SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost)) as cost,
                    COUNT(DISTINCT s.id) as nb_transactions
                FROM sales s
                JOIN sale_items si ON s.id = si.sale_id
                JOIN products p ON si.product_id = p.id
                WHERE s.store_id = $1 AND s.status = 'completed'
                GROUP BY month
            )
            SELECT 
                month,
                revenue,
                cost,
                revenue - cost as profit,
                nb_transactions,
                LAG(revenue, 1) OVER (ORDER BY month) as prev_month_revenue,
                CASE 
                    WHEN LAG(revenue, 1) OVER (ORDER BY month) > 0 
                    THEN ROUND(((revenue - LAG(revenue, 1) OVER (ORDER BY month)) / LAG(revenue, 1) OVER (ORDER BY month) * 100)::numeric, 2)
                    ELSE 0 
                END as growth_pct
            FROM monthly_data
            ORDER BY month DESC
        `, [storeId]);

        // ============================================
        // 16. ANALYSE DES PRODUITS INVENDUS (Stock Mort)
        // ============================================
        const deadStock = await db.query(`
            SELECT 
                p.name, p.sku, p.category,
                p.reference_cost,
                COALESCE(SUM(CASE WHEN sm.quantity_delta > 0 THEN sm.quantity_delta ELSE 0 END), 0) as total_added,
                COALESCE(SUM(CASE WHEN sm.quantity_delta < 0 THEN ABS(sm.quantity_delta) ELSE 0 END), 0) as total_removed,
                COALESCE(SUM(CASE WHEN sm.movement_type = 'sale' THEN ABS(sm.quantity_delta) ELSE 0 END), 0) as total_sold,
                COALESCE(SUM(sm.quantity_delta), 0) as stock_on_hand,
                COALESCE(SUM(sm.quantity_delta), 0) * COALESCE(p.reference_cost, 0) as tied_capital
            FROM products p
            LEFT JOIN stock_movements sm ON p.id = sm.product_id AND sm.store_id = $1
            WHERE p.store_id = $1
            GROUP BY p.id, p.name, p.sku, p.category, p.reference_cost
            HAVING COALESCE(SUM(sm.quantity_delta), 0) > 0
               AND COALESCE(SUM(CASE WHEN sm.movement_type = 'sale' THEN ABS(sm.quantity_delta) ELSE 0 END), 0) = 0
            ORDER BY tied_capital DESC
        `, [storeId]);

        // ============================================
        // 17. ANALYSE DES MEILLEURS JOURS (Heatmap)
        // ============================================
        const bestDays = await db.query(`
            SELECT 
                TO_CHAR(s.sold_at, 'Day') as day_name,
                EXTRACT(DOW FROM s.sold_at) as day_number,
                COUNT(DISTINCT s.id) as nb_transactions,
                SUM(si.quantity * si.unit_price) as revenue,
                ROUND(AVG(si.quantity * si.unit_price)::numeric, 2) as avg_ticket
            FROM sales s
            JOIN sale_items si ON s.id = si.sale_id
            WHERE s.store_id = $1 AND s.status = 'completed'
            GROUP BY day_name, day_number
            ORDER BY revenue DESC
        `, [storeId]);

        // ============================================
        // 18. ANALYSE DE LA MARGE PAR HEURE
        // ============================================
        const marginByHour = await db.query(`
            SELECT 
                EXTRACT(HOUR FROM s.sold_at) as hour,
                COUNT(DISTINCT s.id) as nb_transactions,
                SUM(si.quantity * si.unit_price) as revenue,
                SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost)) as cost,
                SUM(si.quantity * si.unit_price) - SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost)) as profit,
                ROUND(((SUM(si.quantity * si.unit_price) - SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost))) / NULLIF(SUM(si.quantity * si.unit_price), 0) * 100)::numeric, 2) as margin_pct
            FROM sales s
            JOIN sale_items si ON s.id = si.sale_id
            JOIN products p ON si.product_id = p.id
            WHERE s.store_id = $1 AND s.status = 'completed'
            GROUP BY hour
            ORDER BY hour
        `, [storeId]);

        // ============================================
        // 19. ANALYSE DE LA CORRÉLATION PRIX / VOLUME
        // ============================================
        const priceVolumeCorrelation = await db.query(`
            WITH product_data AS (
                SELECT 
                    p.id, p.name,
                    AVG(si.unit_price) as avg_price,
                    SUM(si.quantity) as total_qty,
                    COUNT(*) as sale_lines,
                    SUM(si.unit_price * si.quantity) as total_revenue
                FROM products p
                JOIN sale_items si ON p.id = si.product_id AND si.store_id = $1
                JOIN sales s ON s.id = si.sale_id AND s.store_id = $1 AND s.status = 'completed'
                WHERE p.store_id = $1
                GROUP BY p.id, p.name
            )
            SELECT 
                name,
                avg_price,
                total_qty,
                sale_lines,
                ROUND(total_revenue::numeric, 2) as total_revenue,
                CASE 
                    WHEN avg_price > (SELECT AVG(avg_price) FROM product_data) 
                    AND total_qty > (SELECT AVG(total_qty) FROM product_data) THEN 'Premium Volume'
                    WHEN avg_price > (SELECT AVG(avg_price) FROM product_data) 
                    AND total_qty <= (SELECT AVG(total_qty) FROM product_data) THEN 'Premium Niche'
                    WHEN avg_price <= (SELECT AVG(avg_price) FROM product_data) 
                    AND total_qty > (SELECT AVG(total_qty) FROM product_data) THEN 'Volume Discount'
                    ELSE 'Low Performer'
                END as market_position
            FROM product_data
            ORDER BY total_revenue DESC
        `, [storeId]);

        // ============================================
        // 20. ANALYSE DES TAUX DE CONVERSION (Stock vs Ventes)
        // ============================================
        const conversionRates = await db.query(`
            WITH stock_data AS (
                SELECT 
                    product_id,
                    SUM(CASE WHEN movement_type IN ('opening_balance', 'purchase', 'customer_return', 'transfer_in') THEN quantity_delta ELSE 0 END) as total_received,
                    SUM(CASE WHEN movement_type = 'sale' THEN ABS(quantity_delta) ELSE 0 END) as total_sold
                FROM stock_movements
                WHERE store_id = $1
                GROUP BY product_id
            )
            SELECT 
                p.name, p.sku,
                sd.total_received,
                sd.total_sold,
                ROUND((sd.total_sold / NULLIF(sd.total_received, 0) * 100)::numeric, 2) as sell_through_rate,
                CASE 
                    WHEN sd.total_sold / NULLIF(sd.total_received, 0) > 0.8 THEN 'EXCELLENT'
                    WHEN sd.total_sold / NULLIF(sd.total_received, 0) > 0.5 THEN 'BON'
                    WHEN sd.total_sold / NULLIF(sd.total_received, 0) > 0.2 THEN 'MOYEN'
                    ELSE 'FAIBLE'
                END as performance
            FROM products p
            JOIN stock_data sd ON p.id = sd.product_id
            WHERE p.store_id = $1 AND sd.total_received > 0
            ORDER BY sell_through_rate DESC
        `, [storeId]);

        // ============================================
        // 21. ANALYSE DES SAISONS (Si données suffisantes)
        // ============================================
        const seasonality = await db.query(`
            SELECT 
                CASE 
                    WHEN EXTRACT(MONTH FROM s.sold_at) IN (12, 1, 2) THEN 'Hiver'
                    WHEN EXTRACT(MONTH FROM s.sold_at) IN (3, 4, 5) THEN 'Printemps'
                    WHEN EXTRACT(MONTH FROM s.sold_at) IN (6, 7, 8) THEN 'Été'
                    ELSE 'Automne'
                END as season,
                COUNT(DISTINCT s.id) as nb_transactions,
                SUM(si.quantity * si.unit_price) as revenue,
                SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost)) as cost,
                SUM(si.quantity * si.unit_price) - SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost)) as profit,
                ROUND(AVG(si.quantity * si.unit_price)::numeric, 2) as avg_ticket
            FROM sales s
            JOIN sale_items si ON s.id = si.sale_id
            JOIN products p ON si.product_id = p.id
            WHERE s.store_id = $1 AND s.status = 'completed'
            GROUP BY season
            ORDER BY revenue DESC
        `, [storeId]);

        // ============================================
        // 22. ANALYSE DES TOP PERFORMERS (Meilleur ratio Marge/Volume)
        // ============================================
        const topPerformers = await db.query(`
            WITH product_metrics AS (
                SELECT 
                    p.id, p.name, p.category,
                    SUM(si.quantity) as volume,
                    SUM(si.quantity * si.unit_price) as revenue,
                    SUM(si.quantity * (si.unit_price - COALESCE(si.unit_cost, p.reference_cost))) as profit,
                    ROUND(((SUM(si.quantity * si.unit_price) - SUM(si.quantity * COALESCE(si.unit_cost, p.reference_cost))) / NULLIF(SUM(si.quantity * si.unit_price), 0) * 100)::numeric, 2) as margin_pct,
                    ROUND((SUM(si.quantity * (si.unit_price - COALESCE(si.unit_cost, p.reference_cost))) / NULLIF(SUM(si.quantity), 0))::numeric, 2) as profit_per_unit
                FROM products p
                JOIN sale_items si ON p.id = si.product_id AND si.store_id = $1
                JOIN sales s ON s.id = si.sale_id AND s.store_id = $1 AND s.status = 'completed'
                WHERE p.store_id = $1
                GROUP BY p.id, p.name, p.category
            )
            SELECT 
                *,
                RANK() OVER (ORDER BY profit DESC) as global_rank,
                CASE 
                    WHEN margin_pct > 30 AND volume > (SELECT AVG(volume) FROM product_metrics) THEN 'STAR'
                    WHEN margin_pct > 30 AND volume <= (SELECT AVG(volume) FROM product_metrics) THEN 'NICHE'
                    WHEN margin_pct <= 30 AND volume > (SELECT AVG(volume) FROM product_metrics) THEN 'VOLUME'
                    ELSE 'À OPTIMISER'
                END as strategic_position
            FROM product_metrics
            ORDER BY global_rank
            LIMIT 15
        `, [storeId]);

        const totalRevenue = numeric(kpis.total_revenue);
        const classARevenue = abcAnalysis.rows
            .filter(product => product.abc_class.startsWith('A'))
            .reduce((sum, product) => sum + safeNumber(product.revenue), 0);
        const classASharePct = totalRevenue > 0 ? classARevenue / totalRevenue * 100 : null;
        const topTenRevenue = numeric(salesConcentration.rows.find(row => row.segment === 'Top 10%')?.total_revenue);
        const topTenSharePct = totalRevenue > 0 ? topTenRevenue / totalRevenue * 100 : null;
        const totalLoss = lossMakingProducts.rows.reduce((sum, product) => sum + safeNumber(product.total_loss), 0);
        const tiedCapital = deadStock.rows.reduce((sum, product) => sum + safeNumber(product.tied_capital), 0);
        const recommendations = [];
        if (totalLoss > 0) {
            recommendations.push({
                category: 'Rentabilité',
                evidence: { products_below_cost: lossMakingProducts.rows.length, recorded_loss: money(totalLoss) },
                action: 'Vérifier le coût unitaire enregistré et le prix de vente de ces produits.'
            });
        }
        if (deadStock.rows.length > 0) {
            recommendations.push({
                category: 'Stock',
                evidence: { unsold_products_with_stock: deadStock.rows.length, recorded_stock_value: money(tiedCapital) },
                action: 'Examiner ces quantités en stock avant de décider d’un réapprovisionnement.'
            });
        }
        if (numeric(hiddenCosts.rows[0]?.discount_rate_pct) > 0) {
            recommendations.push({
                category: 'Remises',
                evidence: { discount_rate_pct: numeric(hiddenCosts.rows[0]?.discount_rate_pct) },
                action: 'Comparer les remises enregistrées à la marge des ventes concernées.'
            });
        }

        // ============================================
        // RÉPONSE FINALE ULTRA-COMPLÈTE
        // ============================================
        const analysisResponse = {
            success: true,
            scope_confirmed: true,
            store_id: String(demoStore.id),
            store_name: demoStore.name,
            currency: currencyCode,
            store_scope: {
                type: 'single_demo_store',
                confirmed: true,
                store_id: String(demoStore.id),
                store_name: demoStore.name
            },
            timestamp: new Date().toISOString(),
            source: 'PostgreSQL',
            data_status: {
                products: productCount,
                completed_sales: completedSaleCount,
                completed_sale_lines: completedSaleItemCount,
                stock_movements: stockMovementCount,
                has_analyzable_sales: completedSaleCount > 0,
                message: completedSaleCount > 0
                    ? 'Indicateurs calculés à partir des ventes terminées enregistrées dans ce magasin.'
                    : 'Aucune vente terminée n’est enregistrée dans ce magasin. Les analyses de vente restent vides jusqu’à la saisie de ventes réelles.'
            },
            message: completedSaleCount > 0
                ? 'Analyse des données enregistrées dans votre magasin de démonstration.'
                : 'Aucune vente terminée à analyser dans ce magasin.',

            data: {
                // ============================================
                // 1. SYNTHÈSE EXÉCUTIVE
                // ============================================
                executive_summary: {
                    total_revenue: money(kpis.total_revenue || 0),
                    total_transactions: parseInt(kpis.total_transactions || 0),
                    average_ticket: money(kpis.avg_ticket || 0),
                    gross_margin: money(kpis.gross_margin || 0),
                    gross_margin_pct: percent(kpis.gross_margin_pct),
                    net_margin: money(kpis.net_margin || 0),
                    net_margin_pct: percent(kpis.net_margin_pct),
                    total_items_sold: parseInt(kpis.total_items_sold || 0),
                    total_discounts: money(kpis.total_discounts || 0),
                    total_taxes: money(kpis.total_taxes || 0)
                },

                // ============================================
                // 2. ANALYSE ABC (Pareto)
                // ============================================
                abc_analysis: {
                    description: "Classement des produits par contribution au chiffre d'affaires (Loi de Pareto)",
                    products: abcAnalysis.rows.map(p => ({
                        ...p,
                        revenue: money(p.revenue),
                        cost: money(p.cost),
                        margin: money(p.margin),
                        cumulative_pct: percent(p.cumulative_pct)
                    })),
                    summary: {
                        class_a: { products: abcAnalysis.rows.filter(p => p.abc_class.startsWith('A')).length, revenue_share_pct: Number(classASharePct.toFixed(2)) },
                        class_b: { products: abcAnalysis.rows.filter(p => p.abc_class.startsWith('B')).length },
                        class_c: { products: abcAnalysis.rows.filter(p => p.abc_class.startsWith('C')).length }
                    }
                },

                // ============================================
                // 3. RENTABILITÉ PAR PRODUIT (DEEP DIVE)
                // ============================================
                product_profitability: productProfitability.rows.map(p => ({
                    ...p,
                    revenue: money(p.revenue),
                    total_cost: money(p.total_cost),
                    gross_profit: money(p.gross_profit),
                    margin_pct: percent(p.margin_pct),
                    avg_selling_price: money(p.avg_selling_price),
                    unit_cost: money(p.unit_cost),
                    avg_unit_margin: money(p.avg_unit_margin)
                })),

                // ============================================
                // 4. RENTABILITÉ PAR CATÉGORIE
                // ============================================
                category_profitability: categoryProfitability.rows.map(c => ({
                    ...c,
                    revenue: money(c.revenue),
                    cost: money(c.cost),
                    profit: money(c.profit),
                    margin_pct: percent(c.margin_pct),
                    avg_ticket: money(c.avg_ticket),
                    avg_price_per_unit: money(c.avg_price_per_unit)
                })),

                // ============================================
                // 5. RENTABILITÉ PAR MAGASIN
                // ============================================
                store_profitability: storeProfitability.rows.map(s => ({
                    ...s,
                    revenue: money(s.revenue),
                    cost: money(s.cost),
                    profit: money(s.profit),
                    margin_pct: percent(s.margin_pct),
                    avg_ticket: money(s.avg_ticket),
                    revenue_per_transaction: money(s.revenue_per_transaction)
                })),

                // ============================================
                // 6. COÛTS CACHÉS (Remises, Taxes, Pertes)
                // ============================================
                hidden_costs: {
                    total_discounts: money(hiddenCosts.rows[0]?.total_discounts || 0),
                    total_taxes: money(hiddenCosts.rows[0]?.total_taxes || 0),
                    nb_discounted_sales: parseInt(hiddenCosts.rows[0]?.nb_discounted_sales || 0),
                    avg_discount: money(hiddenCosts.rows[0]?.avg_discount || 0),
                    discount_rate_pct: percent(hiddenCosts.rows[0]?.discount_rate_pct),
                    inventory_loss_cost: money(hiddenCosts.rows[0]?.inventory_loss_cost || 0),
                    impact_analysis: {
                        discount_impact_on_margin: numeric(hiddenCosts.rows[0]?.discount_rate_pct) === null
                            ? 'Aucune donnée de remise enregistrée.'
                            : `Taux de remise enregistré : ${percent(hiddenCosts.rows[0]?.discount_rate_pct)} du chiffre d’affaires brut.`,
                        loss_impact: "Valeur enregistrée des pertes de stock : " + money(hiddenCosts.rows[0]?.inventory_loss_cost || 0)
                    }
                },

                // ============================================
                // 7. BREAK-EVEN ANALYSIS
                // ============================================
                monthly_profitability: {
                    definition: 'Chiffre d’affaires moins coût des produits vendus. Les charges fixes ne sont pas présentes dans la base : ce calcul ne représente pas un seuil de rentabilité complet.',
                    monthly_data: breakEven.rows.map(b => ({
                        ...b,
                        revenue: money(b.revenue),
                        cost: money(b.cost),
                        profit: money(b.profit),
                        avg_monthly_profit: money(b.avg_monthly_profit)
                    }))
                },

                // ============================================
                // 8. ÉLASTICITÉ DES PRIX
                // ============================================
                price_variation: {
                    definition: 'Écart des prix réellement enregistrés par produit. Sans données de demande et de période comparables, cela ne mesure pas l’élasticité.',
                    products: priceElasticity.rows.map(p => ({
                        ...p,
                        min_price: money(p.min_price),
                        max_price: money(p.max_price),
                        avg_price: money(p.avg_price),
                        price_stddev: money(p.price_stddev || 0),
                        price_range_pct: percent(p.price_range_pct)
                    }))
                },

                // ============================================
                // 9. RÉSUMÉ DES TRANSACTIONS
                // ============================================
                transaction_summary: {
                    definition: 'Résumé des ventes terminées. Le schéma ne contient pas d’identifiant client : aucune valeur de fidélité client (CLV) n’est calculée.',
                    total_transactions: parseInt(customerAnalytics.rows[0]?.total_transactions || 0),
                    active_days: parseInt(customerAnalytics.rows[0]?.active_days || 0),
                    total_revenue: money(customerAnalytics.rows[0]?.total_revenue || 0),
                    avg_transaction_value: money(customerAnalytics.rows[0]?.avg_transaction_value || 0),
                    transaction_volatility: money(customerAnalytics.rows[0]?.transaction_volatility || 0),
                    max_transaction: money(customerAnalytics.rows[0]?.max_transaction || 0),
                    min_transaction: money(customerAnalytics.rows[0]?.min_transaction || 0),
                    avg_daily_revenue: money(customerAnalytics.rows[0]?.avg_daily_revenue || 0)
                },

                // ============================================
                // 10. MOUVEMENTS DE STOCK (Pertes & Ajustements)
                // ============================================
                stock_movements_analysis: stockMovementsAnalysis.rows.map(s => ({
                    ...s,
                    total_value: money(s.total_value),
                    avg_quantity_per_movement: parseFloat(s.avg_quantity_per_movement).toFixed(2)
                })),

                // ============================================
                // 11. PRODUITS DÉFICITAIRES (Ventes à perte)
                // ============================================
                loss_making_products: lossMakingProducts.rows.map(l => ({
                    ...l,
                    reference_cost: money(l.reference_cost),
                    avg_selling_price: money(l.avg_selling_price),
                    loss_per_unit: money(l.loss_per_unit),
                    total_loss: money(l.total_loss)
                })),

                // ============================================
                // 12. MARGES PAR TRANCHE DE PRIX
                // ============================================
                margin_by_price_range: marginByPriceRange.rows.map(m => ({
                    ...m,
                    revenue: money(m.revenue),
                    cost: money(m.cost),
                    profit: money(m.profit),
                    margin_pct: percent(m.margin_pct)
                })),

                // ============================================
                // 13. CONCENTRATION DES VENTES
                // ============================================
                sales_concentration: {
                    description: "Répartition du CA par décile de produits (Loi de Pareto)",
                    segments: salesConcentration.rows.map(s => ({
                        ...s,
                        total_revenue: money(s.total_revenue),
                        avg_revenue: money(s.avg_revenue)
                    })),
                    top_decile_revenue_share_pct: Number(topTenSharePct.toFixed(2))
                },

                // ============================================
                // 14. VITESSE DE VENTE (Velocity)
                // ============================================
                sales_velocity: salesVelocity.rows.map(v => ({
                    ...v,
                    avg_daily_velocity: parseFloat(v.avg_daily_velocity).toFixed(2)
                })),

                // ============================================
                // 15. TENDANCES MENSUELLES (Croissance)
                // ============================================
                monthly_trends: monthlyTrends.rows.map(m => ({
                    ...m,
                    revenue: money(m.revenue),
                    cost: money(m.cost),
                    profit: money(m.profit),
                    growth_pct: percent(m.growth_pct)
                })),

                // ============================================
                // 16. STOCK MORT (Dead Stock)
                // ============================================
                dead_stock: deadStock.rows.map(d => ({
                    ...d,
                    reference_cost: money(d.reference_cost),
                    tied_capital: money(d.tied_capital)
                })),

                // ============================================
                // 17. MEILLEURS JOURS
                // ============================================
                best_days: bestDays.rows.map(b => ({
                    ...b,
                    revenue: money(b.revenue),
                    avg_ticket: money(b.avg_ticket)
                })),

                // ============================================
                // 18. MARGE PAR HEURE
                // ============================================
                margin_by_hour: marginByHour.rows.map(m => ({
                    ...m,
                    revenue: money(m.revenue),
                    cost: money(m.cost),
                    profit: money(m.profit),
                    margin_pct: percent(m.margin_pct)
                })),

                // ============================================
                // 19. CORRÉLATION PRIX / VOLUME
                // ============================================
                price_volume_positioning: {
                    definition: 'Classe les produits selon leur prix moyen observé et leur quantité vendue, comparés aux moyennes de ce magasin.',
                    products: priceVolumeCorrelation.rows.map(p => ({
                        ...p,
                        avg_price: money(p.avg_price),
                        total_revenue: money(p.total_revenue)
                    }))
                },

                // ============================================
                // 20. TAUX DE CONVERSION (Sell-Through Rate)
                // ============================================
                conversion_rates: conversionRates.rows.map(c => ({
                    ...c,
                    sell_through_rate: percent(c.sell_through_rate)
                })),

                // ============================================
                // 21. SAISONNALITÉ
                // ============================================
                seasonality: seasonality.rows.map(s => ({
                    ...s,
                    revenue: money(s.revenue),
                    cost: money(s.cost),
                    profit: money(s.profit),
                    avg_ticket: money(s.avg_ticket)
                })),

                // ============================================
                // 22. TOP PERFORMERS (Marge/Volume)
                // ============================================
                top_performers: topPerformers.rows.map(t => ({
                    ...t,
                    revenue: money(t.revenue),
                    profit: money(t.profit),
                    margin_pct: percent(t.margin_pct),
                    profit_per_unit: money(t.profit_per_unit)
                })),

                // ============================================
                strategic_recommendations: recommendations,
                data_limitations: [
                    'La valeur à l’achat provient du coût unitaire enregistré sur la ligne de vente, avec le coût de référence du produit en repli.',
                    'Aucune valeur de vie client n’est calculée, car la base ne contient pas d’identifiant client.',
                    'Le seuil de rentabilité complet n’est pas calculé, car les charges fixes ne sont pas présentes dans la base.',
                    'La variation de prix ne permet pas à elle seule de mesurer l’élasticité de la demande.'
                ]
            }
        };
        res.json(analysisResponse);

    } catch (error) {
        console.error('Erreur Analytics:', error);
        res.status(500).json({ 
            success: false, 
            message: "Erreur lors de l'analyse des données.", 
            error: error.message 
        });
    }
});

export default router;