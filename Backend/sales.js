export async function persistSale(client, { store_id, sale_reference, status, currency, items }) {
    if (!Array.isArray(items) || items.length === 0 || items.some(item =>
        !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0 ||
        !Number.isFinite(Number(item.unit_price)) || Number(item.unit_price) < 0
    )) {
        const error = new Error('La vente doit contenir des lignes avec une quantité positive et un prix non négatif.');
        error.code = 'INVALID_SALE_ITEMS';
        throw error;
    }
    await client.query('BEGIN');
    try {
        const store = await client.query('SELECT id FROM stores WHERE id = $1 FOR UPDATE', [store_id]);
        if (!store.rows.length) throw new Error('Magasin de démonstration introuvable.');
        const existingCurrencies = await client.query(
            `SELECT DISTINCT upper(btrim(currency::text)) AS currency
             FROM sales WHERE store_id = $1 AND status = 'completed'`,
            [store_id]
        );
        if (existingCurrencies.rows.length > 1) {
            const error = new Error('Les ventes du magasin utilisent plusieurs devises; les totaux ne peuvent pas être additionnés.');
            error.code = 'MIXED_CURRENCY';
            throw error;
        }
        const existingCurrency = existingCurrencies.rows[0]?.currency;
        const saleCurrency = String(currency || existingCurrency || 'EUR').trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(saleCurrency)) throw new Error('La devise doit être un code ISO à trois lettres.');
        if (existingCurrency && existingCurrency !== saleCurrency) {
            const error = new Error(`La devise de ce magasin est déjà ${existingCurrency}.`);
            error.code = 'CURRENCY_MISMATCH';
            throw error;
        }
        const saleRes = await client.query(
            `INSERT INTO sales (store_id, sale_reference, status, currency, sold_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
            [store_id, sale_reference, status || 'completed', saleCurrency]
        );
        const saleId = saleRes.rows[0].id;
        for (const item of items) {
            const product = await client.query(
                'SELECT reference_cost FROM products WHERE id = $1 AND store_id = $2',
                [item.product_id, store_id]
            );
            if (!product.rows.length) {
                throw new Error(`Le produit ${item.product_id} n'appartient pas au magasin de démonstration.`);
            }
            if (product.rows[0].reference_cost === null) {
                const error = new Error(`Le produit ${item.product_id} doit avoir un coût de référence pour calculer la marge réelle.`);
                error.code = 'MISSING_PRODUCT_COST';
                throw error;
            }
            await client.query(
                `INSERT INTO sale_items (store_id, sale_id, product_id, quantity, unit_price, unit_cost) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [store_id, saleId, item.product_id, item.quantity, item.unit_price, product.rows[0].reference_cost]
            );
        }
        await client.query('COMMIT');
        return saleRes.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
}
