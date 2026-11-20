import test from 'node:test';
import assert from 'node:assert/strict';
import { persistSale } from '../sales.js';

test('sale delegates stock movements to the trigger, which excludes services and untracked products', async () => {
    const calls = [];
    const triggeredMovements = [];
    const products = new Map([
        ['tracked', { product_type: 'product', tracks_stock: true, reference_cost: 4 }],
        ['untracked', { product_type: 'product', tracks_stock: false, reference_cost: 3 }],
        ['service', { product_type: 'service', tracks_stock: true, reference_cost: 6 }]
    ]);
    const client = {
        async query(sql, values) {
            calls.push({ sql, values });
            if (sql.startsWith('SELECT id FROM stores')) return { rows: [{ id: 'store-id' }] };
            if (sql.startsWith('SELECT DISTINCT')) return { rows: [] };
            if (sql.startsWith('INSERT INTO sales')) return { rows: [{ id: 'sale-id' }] };
            if (sql.startsWith('SELECT reference_cost FROM products')) return { rows: [products.get(values[0])] };
            if (sql.startsWith('INSERT INTO sale_items')) {
                // Simulate trg_sync_sale_item_stock, which runs after this insert.
                const product = products.get(values[2]);
                if (product.tracks_stock && product.product_type !== 'service') {
                    triggeredMovements.push(values[2]);
                }
                return { rows: [{ id: `${values[2]}-line` }] };
            }
            return { rows: [] };
        }
    };

    const sale = await persistSale(client, {
        store_id: 'store-id',
        sale_reference: 'sale-1',
        items: [
            { product_id: 'tracked', quantity: 2, unit_price: 10 },
            { product_id: 'untracked', quantity: 3, unit_price: 5 },
            { product_id: 'service', quantity: 1, unit_price: 20 }
        ]
    });

    assert.equal(sale.id, 'sale-id');
    assert.equal(calls.filter(call => call.sql.startsWith('INSERT INTO sale_items')).length, 3);
    assert.deepEqual(triggeredMovements, ['tracked']);
    assert.equal(calls.some(call => call.sql.startsWith('INSERT INTO stock_movements')), false);
    assert.equal(calls[0].sql, 'BEGIN');
    assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('sale rolls back when the sale-item trigger fails', async () => {
    const calls = [];
    const client = {
        async query(sql) {
            calls.push(sql);
            if (sql.startsWith('SELECT id FROM stores')) return { rows: [{ id: 'store-id' }] };
            if (sql.startsWith('SELECT DISTINCT')) return { rows: [] };
            if (sql.startsWith('INSERT INTO sales')) return { rows: [{ id: 'sale-id' }] };
            if (sql.startsWith('SELECT reference_cost FROM products')) return { rows: [{ reference_cost: 4 }] };
            if (sql.startsWith('INSERT INTO sale_items')) throw new Error('trigger failure');
            return { rows: [] };
        }
    };

    await assert.rejects(persistSale(client, {
        store_id: 'store-id',
        items: [{ product_id: 'tracked', quantity: 1, unit_price: 10 }]
    }), /trigger failure/);
    assert.equal(calls[0], 'BEGIN');
    assert.equal(calls.at(-1), 'ROLLBACK');
});
