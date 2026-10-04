/**
 * db.js — PostgreSQL pool + schema migration
 *
 * The installs table stores one row per device registration.
 * It is the single source of truth for the admin dashboard.
 */

require('dotenv').config();
const { Pool } = require('pg');

// pg v8.12+ treats sslmode=require in the connection string as verify-full,
// which fails against Aiven's self-signed CA chain.
// Fix: strip the sslmode param from the URL and control SSL purely via the
// Pool's ssl option (still encrypted, just no cert verification).
function buildConnectionConfig() {
  const rawUrl = process.env.DB_URL || '';
  // Remove ?sslmode=... or &sslmode=... from the URL
  const cleanUrl = rawUrl.replace(/[?&]sslmode=[^&]*/g, (match) => {
    // If sslmode was the first query param, turn ? into nothing
    // If it was a subsequent param, just remove it
    return match.startsWith('?') ? '?' : '';
  }).replace(/\?$/, ''); // clean trailing ? if sslmode was the only param

  return cleanUrl;
}

const pool = new Pool({
  connectionString: buildConnectionConfig(),
  ssl: {
    rejectUnauthorized: false, // trust Aiven's self-signed chain
  },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

// ─── Schema migration (runs on every startup, idempotent) ─────────────────────
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS installs (
      id             SERIAL PRIMARY KEY,
      device_id      TEXT        NOT NULL UNIQUE,  -- stable ID from mobile app
      business_name  TEXT,                          -- from the businesses table
      owner_name     TEXT,
      phone          TEXT,
      location       TEXT,
      device_name    TEXT,
      device_model   TEXT,
      os_name        TEXT,
      os_version     TEXT,
      app_version    TEXT,
      build_number   TEXT,
      platform       TEXT,                          -- 'android' | 'ios'
      is_physical    BOOLEAN     DEFAULT TRUE,
      first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      heartbeat_count INTEGER    NOT NULL DEFAULT 1
    );
  `);

  // Index for fast lookups
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_installs_device_id
    ON installs (device_id);
  `);

  console.log('[db] schema ready');
}

module.exports = { pool, migrate };
