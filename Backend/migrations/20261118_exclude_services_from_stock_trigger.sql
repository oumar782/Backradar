-- Sale item stock movements are created by this database trigger, not by the
-- API. Keep the stock flag check and also exclude products classified as services.
CREATE OR REPLACE FUNCTION public.sync_sale_item_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    sale_status text;
    sale_date timestamptz;
    product_tracks_stock boolean;
    current_product_type text;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        DELETE FROM public.stock_movements
        WHERE sale_item_id = OLD.id;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    SELECT s.status, s.sold_at, p.tracks_stock, p.product_type
      INTO sale_status, sale_date, product_tracks_stock, current_product_type
      FROM public.sales s
      JOIN public.products p
        ON p.store_id = NEW.store_id
       AND p.id = NEW.product_id
     WHERE s.store_id = NEW.store_id
       AND s.id = NEW.sale_id;

    IF sale_status = 'completed'
       AND product_tracks_stock
       AND lower(coalesce(current_product_type, '')) <> 'service' THEN
        INSERT INTO public.stock_movements (
            store_id, product_id, movement_type, quantity_delta,
            unit_cost, occurred_at, sale_item_id
        )
        VALUES (
            NEW.store_id, NEW.product_id, 'sale', -NEW.quantity,
            NEW.unit_cost, sale_date, NEW.id
        )
        ON CONFLICT (sale_item_id) DO UPDATE
        SET product_id = EXCLUDED.product_id,
            quantity_delta = EXCLUDED.quantity_delta,
            unit_cost = EXCLUDED.unit_cost,
            occurred_at = EXCLUDED.occurred_at;
    END IF;

    RETURN NEW;
END;
$function$;
