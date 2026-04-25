import pg from "pg";
import pgvector from "pgvector/pg";

const { Pool } = pg;
let pool = null;

async function getPassword() {
  if (process.env.MEMORY_PG_PASSWORD) return process.env.MEMORY_PG_PASSWORD;
  try {
    const res = await fetch(
      "http://10.0.0.1/cgi-bin/kv-get?key=memory_pg_password"
    );
    if (res.ok) return (await res.text()).trim();
  } catch {}
  throw new Error("Cannot get PG password — set MEMORY_PG_PASSWORD or ensure vault is reachable");
}

export async function getPool() {
  if (pool) return pool;
  const password = await getPassword();
  pool = new Pool({
    host: process.env.MEMORY_PG_HOST || "10.0.2.0",
    port: Number(process.env.MEMORY_PG_PORT || 5432),
    database: "memory",
    user: "memory",
    password,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  // Register pgvector types once via a dedicated client
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
