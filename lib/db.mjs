import pg from "pg";
import pgvector from "pgvector/pg";

const { Pool } = pg;
let pool = null;

export async function getPool() {
  if (pool) return pool;
  const url = process.env.MEMORY_DATABASE_URL;
  if (!url) throw new Error("MEMORY_DATABASE_URL not set. Example: postgres://user:pass@host:5432/memory");
  pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000 });
  const client = await pool.connect();
  await pgvector.registerTypes(client);
  client.release();
  return pool;
}

export async function query(sql, params) {
  const p = await getPool();
  return p.query(sql, params);
}

export async function end() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
