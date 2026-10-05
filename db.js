/**
 * db.js — PostgreSQL pool + schema migration
 */

require('dotenv').config();
const { Pool } = require('pg');

function buildConnectionConfig() {
  const rawUrl = process.env.DB_URL || '';
  const cleanUrl = rawUrl
    .replace(/[?&]sslmode=[^&]*/g, (m) => (m.startsWith('?') ? '?' : ''))
    .replace(/\?$/, '');
  return cleanUrl;
}

const pool = new Pool({
  connectionString: buildConnectionConfig(),
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => console.error('[db] idle client error:', err.message));

async function migrate() {
  // ── installs ──────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS installs (
      id              SERIAL PRIMARY KEY,
      device_id       TEXT        NOT NULL UNIQUE,
      business_name   TEXT,
      owner_name      TEXT,
      phone           TEXT,
      location        TEXT,
      device_name     TEXT,
      device_model    TEXT,
      os_name         TEXT,
      os_version      TEXT,
      app_version     TEXT,
      build_number    TEXT,
      platform        TEXT,
      is_physical     BOOLEAN     DEFAULT TRUE,
      first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      heartbeat_count INTEGER     NOT NULL DEFAULT 1
    );
  `);

  // ── licences ──────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS licences (
      id             SERIAL PRIMARY KEY,
      device_id      TEXT        NOT NULL UNIQUE REFERENCES installs(device_id) ON DELETE CASCADE,
      licence_key    TEXT        NOT NULL UNIQUE,   -- e.g. DUKA-XXXX-XXXX-XXXX
      plan           TEXT        NOT NULL,           -- 'daily' | 'weekly' | 'monthly' | 'lifetime'
      amount_kes     INTEGER     NOT NULL,           -- amount in KES
      status         TEXT        NOT NULL DEFAULT 'active',  -- 'active' | 'expired' | 'suspended'
      activated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at     TIMESTAMPTZ,                   -- NULL for lifetime
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ── payments ──────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id              SERIAL PRIMARY KEY,
      device_id       TEXT        NOT NULL,
      reference       TEXT        NOT NULL UNIQUE,
      plan            TEXT        NOT NULL,
      amount_kes      INTEGER     NOT NULL,
      currency        TEXT        NOT NULL DEFAULT 'KES',
      status          TEXT        NOT NULL DEFAULT 'pending',
      paystack_txn_id TEXT,
      licence_key     TEXT,
      paid_at         TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ── indexes ───────────────────────────────────────────────────────────────
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_installs_device_id   ON installs (device_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_licences_device_id   ON licences (device_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_licences_key         ON licences (licence_key);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_device_id   ON payments (device_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_reference   ON payments (reference);`);

  console.log('[db] schema ready');
}

module.exports = { pool, migrate };
