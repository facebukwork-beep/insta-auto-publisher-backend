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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs_state (
      id TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  async function upsertJobRows(client, rows) {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const params = [];
      const values = chunk.map(([id, json], idx) => {
        params.push(id, json);
        const a = idx * 2 + 1, b = a + 1;
        return `($${a},$${b}::jsonb,NOW())`;
      }).join(",");
      await client.query(`INSERT INTO jobs_state(id,value,updated_at) VALUES ${values} ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, params);
    }
  }

  async function ensureAndRestoreSimple(key, file) {
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

  async function migrateAndRestoreJobs() {
    const count = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM jobs_state`)).rows[0]?.n || 0);
    if (!count) {
      let source = [];
      const legacy = await pool.query(`SELECT value FROM app_state WHERE key='jobs'`);
      if (legacy.rows.length && Array.isArray(legacy.rows[0].value)) source = legacy.rows[0].value;
      else {
        try { source = JSON.parse(fs.readFileSync(jobsFile, "utf8")); } catch (_) { source = []; }
      }
      if (source.length) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await upsertJobRows(client, source.filter(job=>job?.id).map(job => [String(job.id), JSON.stringify(job)]));
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK").catch(()=>{});
          throw e;
        } finally { client.release(); }
      }
      // Once migrated, stop rewriting the old giant jobs JSONB document.
      await pool.query(`DELETE FROM app_state WHERE key='jobs'`).catch(()=>{});
    }
    const rows = await pool.query(`SELECT value FROM jobs_state ORDER BY COALESCE((value->>'createdAt')::timestamptz, NOW()) ASC`);
    const jobs = rows.rows.map(r => r.value).filter(Boolean);
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
    return jobs;
  }

  fs.mkdirSync(dataDir, { recursive: true });
  await ensureAndRestoreSimple("accounts", accountsFile);
  const restoredJobs = await migrateAndRestoreJobs();

  let tail = Promise.resolve();
  let lastJobsMap = new Map(restoredJobs.filter(j=>j?.id).map(j => [String(j.id), JSON.stringify(j)]));

  function persistSimple(key, value) {
    const snapshot = JSON.stringify(value);
    tail = tail.then(() => pool.query(`
      INSERT INTO app_state(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
    `, [key, snapshot])).catch((e) => console.error("Persistent state write failed:", e.message));
    return tail;
  }

  function persistJobs(value) {
    const rows = (Array.isArray(value) ? value : []).filter(j=>j?.id).map(j => [String(j.id), JSON.stringify(j)]);
    tail = tail.then(async () => {
      const next = new Map(rows);
      const changed = rows.filter(([id, json]) => lastJobsMap.get(id) !== json);
      const removed = [...lastJobsMap.keys()].filter(id => !next.has(id));
      if (!changed.length && !removed.length) { lastJobsMap = next; return; }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await upsertJobRows(client, changed);
        if (removed.length) await client.query(`DELETE FROM jobs_state WHERE id = ANY($1::text[])`, [removed]);
        await client.query("COMMIT");
        lastJobsMap = next;
      } catch (e) {
        await client.query("ROLLBACK").catch(()=>{});
        console.error("Persistent jobs delta write failed:", e.message);
        throw e;
      } finally { client.release(); }
    }).catch((e) => console.error("Persistent state write failed:", e.message));
    return tail;
  }

  function persist(key, value) {
    return key === "jobs" ? persistJobs(value) : persistSimple(key, value);
  }

  async function get(key) {
    if (key === "jobs") {
      const r = await pool.query(`SELECT value FROM jobs_state ORDER BY COALESCE((value->>'createdAt')::timestamptz, NOW()) ASC`);
      return r.rows.map(x=>x.value);
    }
    const r = await pool.query(`SELECT value FROM app_state WHERE key=$1`, [key]);
    return r.rows.length ? r.rows[0].value : null;
  }

  async function set(key, value) {
    if (key === "jobs") { persistJobs(value); await tail; return true; }
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
    } finally { client.release(); }
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
