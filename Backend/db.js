import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// ⚡ Pour accepter les certificats auto-signés (dev uniquement)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Supabase impose SSL
});

export default pool;
