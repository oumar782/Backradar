export async function cleanExpiredDemoStores(pool) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const expired = await client.query(
            `SELECT store_id FROM demo_device_sessions
             WHERE expires_at <= NOW() AND store_id IS NOT NULL
             FOR UPDATE`
        );
        const storeIds = expired.rows.map(row => row.store_id);
        if (storeIds.length) {
            await client.query('DELETE FROM stock_movements WHERE store_id = ANY($1::bigint[])', [storeIds]);
            await client.query('DELETE FROM sale_items WHERE store_id = ANY($1::bigint[])', [storeIds]);
            await client.query('DELETE FROM sales WHERE store_id = ANY($1::bigint[])', [storeIds]);
            await client.query('DELETE FROM products WHERE store_id = ANY($1::bigint[])', [storeIds]);
            await client.query('DELETE FROM stores WHERE id = ANY($1::bigint[])', [storeIds]);
        }
        await client.query('COMMIT');
        return storeIds.length;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
