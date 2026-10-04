/**
 * server.js — DukaPOS Admin Backend
 *
 * Routes
 * ──────
 * POST /api/register      Mobile app checks in on every launch
 * GET  /api/stats         Aggregate counts for the dashboard
 * GET  /api/users         Paginated list of registered installs
 * GET  /                  Serves the admin dashboard (index.html)
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { pool, migrate } = require('./db');

const app  = express();
const PORT = process.env.PORT || 5000;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST'],
}));

// Serve the admin SPA
app.use(express.static(path.join(__dirname)));

// ─── POST /api/register ────────────────────────────────────────────────────────
// Called by the mobile app on every launch (in notificationService / useDevice).
// Upserts the row so the admin always sees the latest data.
app.post('/api/register', async (req, res) => {
  try {
    const {
      deviceId,
      businessName,
      ownerName,
      phone,
      location,
      deviceName,
      deviceModel,
      osName,
      osVersion,
      appVersion,
      buildNumber,
      platform,
      isPhysical,
    } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId is required' });
    }

    await pool.query(`
      INSERT INTO installs (
        device_id, business_name, owner_name, phone, location,
        device_name, device_model, os_name, os_version,
        app_version, build_number, platform, is_physical,
        first_seen_at, last_seen_at, heartbeat_count
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW(),1)
      ON CONFLICT (device_id) DO UPDATE SET
        business_name   = COALESCE(EXCLUDED.business_name,  installs.business_name),
        owner_name      = COALESCE(EXCLUDED.owner_name,     installs.owner_name),
        phone           = COALESCE(EXCLUDED.phone,          installs.phone),
        location        = COALESCE(EXCLUDED.location,       installs.location),
        device_name     = EXCLUDED.device_name,
        device_model    = EXCLUDED.device_model,
        os_name         = EXCLUDED.os_name,
        os_version      = EXCLUDED.os_version,
        app_version     = EXCLUDED.app_version,
        build_number    = EXCLUDED.build_number,
        platform        = EXCLUDED.platform,
        is_physical     = EXCLUDED.is_physical,
        last_seen_at    = NOW(),
        heartbeat_count = installs.heartbeat_count + 1
    `, [
      deviceId,
      businessName  || null,
      ownerName     || null,
      phone         || null,
      location      || null,
      deviceName    || null,
      deviceModel   || null,
      osName        || null,
      osVersion     || null,
      appVersion    || null,
      buildNumber   || null,
      platform      || null,
      isPhysical    ?? true,
    ]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/register]', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ─── GET /api/stats ────────────────────────────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                              AS total_installs,
        COUNT(*) FILTER (WHERE is_physical = TRUE)           AS physical_devices,
        COUNT(*) FILTER (WHERE is_physical = FALSE)          AS emulators,
        COUNT(*) FILTER (WHERE platform = 'android')         AS android,
        COUNT(*) FILTER (WHERE platform = 'ios')             AS ios,
        COUNT(*) FILTER (
          WHERE last_seen_at >= NOW() - INTERVAL '7 days'
        )                                                     AS active_7d,
        COUNT(*) FILTER (
          WHERE last_seen_at >= NOW() - INTERVAL '30 days'
        )                                                     AS active_30d,
        COUNT(DISTINCT business_name)
          FILTER (WHERE business_name IS NOT NULL)            AS unique_businesses,
        MIN(first_seen_at)                                    AS oldest_install,
        MAX(last_seen_at)                                     AS latest_seen
      FROM installs;
    `);

    res.json(rows[0]);
  } catch (err) {
    console.error('[GET /api/stats]', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ─── GET /api/users ────────────────────────────────────────────────────────────
// ?page=1&limit=50&search=<text>&platform=android|ios
app.get('/api/users', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1', 10));
    const limit  = Math.min(100, parseInt(req.query.limit || '50', 10));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const platform = req.query.platform || '';

    const conditions = ['1=1'];
    const params     = [];
    let   p          = 1;

    if (search) {
      conditions.push(`(
        business_name ILIKE $${p} OR
        owner_name    ILIKE $${p} OR
        device_name   ILIKE $${p} OR
        location      ILIKE $${p}
      )`);
      params.push(`%${search}%`);
      p++;
    }

    if (platform === 'android' || platform === 'ios') {
      conditions.push(`platform = $${p}`);
      params.push(platform);
      p++;
    }

    const where = conditions.join(' AND ');

    // Total count
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM installs WHERE ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Rows
    const { rows } = await pool.query(`
      SELECT
        id,
        device_id,
        business_name,
        owner_name,
        phone,
        location,
        device_name,
        device_model,
        os_name,
        os_version,
        app_version,
        platform,
        is_physical,
        first_seen_at,
        last_seen_at,
        heartbeat_count
      FROM installs
      WHERE ${where}
      ORDER BY last_seen_at DESC
      LIMIT $${p} OFFSET $${p + 1}
    `, [...params, limit, offset]);

    res.json({
      total,
      page,
      pages: Math.ceil(total / limit),
      limit,
      data: rows,
    });
  } catch (err) {
    console.error('[GET /api/users]', err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ─── Health check (used by Render / Railway / uptime monitors) ────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Boot ──────────────────────────────────────────────────────────────────────
async function start() {
  await migrate();
  app.listen(PORT, () => {
    console.log(`DukaPOS admin server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
