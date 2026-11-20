-- Each browser device receives one permanent demo claim and its own store.
-- The API stores only hashes of the device cookie and the bearer token.
CREATE TABLE IF NOT EXISTS public.demo_device_sessions (
    device_key_hash text PRIMARY KEY,
    token_hash text NOT NULL UNIQUE,
    store_id bigint UNIQUE REFERENCES public.stores(id) ON DELETE SET NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
