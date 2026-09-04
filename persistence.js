import fs from "fs";
import pg from "pg";
const { Pool } = pg;

export async function createPersistence({ dataDir, accountsFile, jobsFile }) {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    return {
      mode: "local",
      durable: false,
      persist: async () => {},
      get: async () => null,
      set: async () => false,
      flush: async () => {},
      ping: async () => true,
      withSchedulerLock: async (fn) => { await fn(); return true; },
      close: async () => {}
    };
  }

  const ssl = /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: databaseUrl, ssl, max: 4, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  async function ensureAndRestore(key, file) {
    const remote = await pool.query(`SELECT value FROM app_state WHERE key=$1`, [key]);
    if (remote.rows.length) {
      fs.writeFileSync(file, JSON.stringify(remote.rows[0].value || [], null, 2));
      return;
    }
    let local = [];
    try { local = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
    await pool.query(`
      INSERT INTO app_state(key,value,updated_at)
      VALUES($1,$2::jsonb,NOW())
      ON CONFLICT(key) DO NOTHING
    `, [key, JSON.stringify(local)]);
  }

  fs.mkdirSync(dataDir, { recursive: true });
  await ensureAndRestore("accounts", accountsFile);
  await ensureAndRestore("jobs", jobsFile);

  let tail = Promise.resolve();
  function persist(key, value) {
    const snapshot = JSON.stringify(value);
    tail = tail.then(() => pool.query(`
      INSERT INTO app_state(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
    `, [key, snapshot])).catch((e) => console.error("Persistent state write failed:", e.message));
    return tail;
  }

  async function get(key) {
    const r = await pool.query(`SELECT value FROM app_state WHERE key=$1`, [key]);
    return r.rows.length ? r.rows[0].value : null;
  }

  async function set(key, value) {
    await pool.query(`
      INSERT INTO app_state(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
    `, [key, JSON.stringify(value)]);
    return true;
  }

  async function withSchedulerLock(fn) {
    const client = await pool.connect();
    try {
      const r = await client.query(`SELECT pg_try_advisory_lock(140014001) ok`);
      if (!r.rows[0]?.ok) return false;
      try { await fn(); } finally { await client.query(`SELECT pg_advisory_unlock(140014001)`); }
      return true;
    } finally {
      client.release();
    }
  }

  return {
    mode: "postgres",
    durable: true,
    persist,
    get,
    set,
    flush: async () => { await tail; },
    ping: async () => { await pool.query("SELECT 1"); return true; },
    withSchedulerLock,
    close: async () => { await tail; await pool.end(); }
  };
}
