/**
 * server.js — DukaPOS Admin Backend
 *
 * Routes
 * ──────
 * POST /api/register            Mobile device check-in
 * GET  /api/licence/:deviceId   Check licence status (mobile polls on launch)
 * POST /api/payment/initiate    Mobile requests a Paystack payment reference
 * POST /api/payment/verify      Mobile confirms payment after Paystack callback
 * GET  /api/stats               Dashboard aggregate stats
 * GET  /api/users               Paginated installs list
 * GET  /api/payments            Admin payments list
 * GET  /api/licences            Admin licences list
 * POST /api/admin/suspend       Admin suspends a licence
 * POST /api/admin/activate      Admin manually activates a licence
 * GET  /health                  Health check
 * GET  /                        Admin SPA
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const crypto   = require('crypto');
const https    = require('https');
const { pool, migrate } = require('./db');

const app  = express();
const PORT = process.env.PORT || 5000;

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';
const ADMIN_SECRET    = process.env.ADMIN_SECRET        || 'dukapos-admin-2024';

// ─── Pricing ──────────────────────────────────────────────────────────────────
const PLANS = {
  daily:    { amount: 100,   days: 1   },
  weekly:   { amount: 600,   days: 7   },
  monthly:  { amount: 2000,  days: 30  },
  lifetime: { amount: 10000, days: null },
};

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.static(path.join(__dirname)));

// ─── Admin auth middleware ─────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-secret'] || req.query.secret;
  if (token !== ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateLicenceKey() {
  const seg = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `DUKA-${seg()}-${seg()}-${seg()}`;
}

function generateReference(deviceId) {
  const ts  = Date.now().toString(36).toUpperCase();
  const rnd = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `DPK-${ts}-${rnd}`;
}

function paystackRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.paystack.co',
      path,
      method,
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        'Content-Type': 'application/json',
        ...(data && { 'Content-Length': Buffer.byteLength(data) }),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Invalid JSON from Paystack')); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── POST /api/register ───────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const {
      deviceId, businessName, ownerName, phone, location,
      deviceName, deviceModel, osName, osVersion,
      appVersion, buildNumber, platform, isPhysical,
    } = req.body;

    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

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
    `, [deviceId, businessName||null, ownerName||null, phone||null, location||null,
        deviceName||null, deviceModel||null, osName||null, osVersion||null,
        appVersion||null, buildNumber||null, platform||null, isPhysical??true]);

    // Return current licence status alongside registration ack
    const { rows } = await pool.query(
      `SELECT status, plan, expires_at, licence_key FROM licences WHERE device_id = $1`,
      [deviceId]
    );
    const licence = rows[0] || null;

    res.json({ ok: true, licence });
  } catch (err) {
    console.error('[POST /api/register]', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ─── GET /api/licence/:deviceId ───────────────────────────────────────────────
app.get('/api/licence/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { rows } = await pool.query(
      `SELECT status, plan, expires_at, licence_key, activated_at
       FROM licences WHERE device_id = $1`,
      [deviceId]
    );

    if (!rows[0]) return res.json({ valid: false, reason: 'no_licence' });

    const lic = rows[0];

    // Auto-expire + delete if past expiry date — fresh row will be created on next payment
    if (lic.expires_at && new Date(lic.expires_at) < new Date()) {
      await pool.query(
        `DELETE FROM licences WHERE device_id=$1`,
        [deviceId]
      );
      return res.json({ valid: false, reason: 'expired', expiredAt: lic.expires_at });
    }

    if (lic.status === 'suspended') return res.json({ valid: false, reason: 'suspended' });
    if (lic.status === 'expired')   return res.json({ valid: false, reason: 'expired', expiredAt: lic.expires_at });

    res.json({
      valid:       true,
      plan:        lic.plan,
      licenceKey:  lic.licence_key,
      expiresAt:   lic.expires_at,
      activatedAt: lic.activated_at,
    });
  } catch (err) {
    console.error('[GET /api/licence]', err.message);
    res.status(500).json({ error: 'Licence check failed' });
  }
});

// ─── POST /api/payment/initiate ───────────────────────────────────────────────
// Triggers a Paystack M-Pesa (mobile_money) STK push charge.
// email is fixed to dukapos254@gmail.com as the merchant account email.
app.post('/api/payment/initiate', async (req, res) => {
  try {
    const { deviceId, plan, phone } = req.body;
    if (!deviceId || !plan || !phone) {
      return res.status(400).json({ error: 'deviceId, plan, phone required' });
    }

    const planConfig = PLANS[plan];
    if (!planConfig) return res.status(400).json({ error: 'Invalid plan' });

    // Ensure device is registered
    const { rows: devRows } = await pool.query(
      `SELECT device_id FROM installs WHERE device_id=$1`, [deviceId]
    );
    if (!devRows[0]) return res.status(404).json({ error: 'Device not registered' });

    const reference   = generateReference(deviceId);
    const amountKobo  = planConfig.amount * 100; // Paystack uses kobo (KES cents)

    // Store pending payment record
    await pool.query(`
      INSERT INTO payments (device_id, reference, plan, amount_kes, status)
      VALUES ($1,$2,$3,$4,'pending')
      ON CONFLICT (reference) DO NOTHING
    `, [deviceId, reference, plan, planConfig.amount]);

    // Paystack Charge API — mobile_money (M-Pesa Kenya)
    const psRes = await paystackRequest('POST', '/charge', {
      email:    'dukapos254@gmail.com',
      amount:   amountKobo,
      currency: 'KES',
      reference,
      mobile_money: {
        phone,
        provider: 'mpesa',
      },
      metadata: {
        deviceId,
        plan,
        custom_fields: [
          { display_name: 'Device ID', variable_name: 'device_id', value: deviceId },
          { display_name: 'Plan',      variable_name: 'plan',      value: plan },
        ],
      },
    });

    if (!psRes.status) {
      return res.status(502).json({ error: psRes.message || 'Paystack charge failed' });
    }

    // Paystack returns status: 'send_otp' | 'send_pin' | 'pending' | 'success'
    res.json({
      reference,
      paystackStatus: psRes.data?.status,
      displayText:    psRes.data?.display_text || 'Check your phone for the M-Pesa prompt',
      plan,
      amountKes:      planConfig.amount,
    });
  } catch (err) {
    console.error('[POST /api/payment/initiate]', err.message);
    res.status(500).json({ error: 'Payment initiation failed' });
  }
});

// ─── GET /api/payment/poll/:reference ────────────────────────────────────────
// Mobile app polls this every 3s after initiating an STK push.
// We check the Paystack transaction status and activate the licence on success.
app.get('/api/payment/poll/:reference', async (req, res) => {
  try {
    const { reference } = req.params;

    // Load payment record
    const { rows: payRows } = await pool.query(
      `SELECT * FROM payments WHERE reference=$1`, [reference]
    );
    if (!payRows[0]) return res.status(404).json({ error: 'Payment not found' });

    const payment = payRows[0];

    // Already resolved
    if (payment.status === 'success') {
      const { rows: licRows } = await pool.query(
        `SELECT licence_key, plan, expires_at, activated_at, status FROM licences WHERE device_id=$1`,
        [payment.device_id]
      );
      const lic = licRows[0];
      // Return flat camelCase same shape as first-time success so mobile client handles both identically
      return res.json({
        status:     'success',
        licenceKey: lic?.licence_key  ?? payment.licence_key,
        plan:       lic?.plan         ?? payment.plan,
        expiresAt:  lic?.expires_at   ?? null,
        activatedAt: lic?.activated_at ?? null,
      });
    }
    if (payment.status === 'failed') {
      return res.json({ status: 'failed' });
    }

    // Check with Paystack
    const psRes = await paystackRequest('GET', `/transaction/verify/${reference}`);
    const txStatus = psRes?.data?.status;

    if (txStatus === 'success') {
      const planConfig = PLANS[payment.plan];
      const licenceKey = generateLicenceKey();
      const now        = new Date();
      const expiresAt  = planConfig?.days
        ? new Date(now.getTime() + planConfig.days * 86400_000)
        : null;

      await pool.query('BEGIN');
      try {
        await pool.query(
          `UPDATE payments SET status='success', paystack_txn_id=$1, licence_key=$2, paid_at=NOW()
           WHERE reference=$3`,
          [String(psRes.data.id), licenceKey, reference]
        );
        await pool.query(`
          INSERT INTO licences (device_id, licence_key, plan, amount_kes, status, activated_at, expires_at)
          VALUES ($1,$2,$3,$4,'active',NOW(),$5)
          ON CONFLICT (device_id) DO UPDATE SET
            licence_key  = EXCLUDED.licence_key,
            plan         = EXCLUDED.plan,
            amount_kes   = EXCLUDED.amount_kes,
            status       = 'active',
            activated_at = NOW(),
            expires_at   = EXCLUDED.expires_at,
            updated_at   = NOW()
        `, [payment.device_id, licenceKey, payment.plan, payment.amount_kes, expiresAt]);
        await pool.query('COMMIT');
      } catch (e) {
        await pool.query('ROLLBACK');
        throw e;
      }

      return res.json({ status: 'success', licenceKey, plan: payment.plan, expiresAt, activatedAt: new Date().toISOString() });
    }

    if (txStatus === 'failed' || txStatus === 'abandoned') {
      await pool.query(`UPDATE payments SET status='failed' WHERE reference=$1`, [reference]);
      return res.json({ status: 'failed' });
    }

    // Still pending (awaiting user confirmation on phone)
    res.json({ status: 'pending', paystackStatus: txStatus });
  } catch (err) {
    console.error('[GET /api/payment/poll]', err.message);
    res.status(500).json({ error: 'Poll failed' });
  }
});

// ─── GET /api/stats ───────────────────────────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                                   AS total_installs,
        COUNT(*) FILTER (WHERE is_physical = TRUE)                 AS physical_devices,
        COUNT(*) FILTER (WHERE platform = 'android')               AS android,
        COUNT(*) FILTER (WHERE platform = 'ios')                   AS ios,
        COUNT(*) FILTER (WHERE last_seen_at >= NOW()-INTERVAL '7 days')  AS active_7d,
        COUNT(*) FILTER (WHERE last_seen_at >= NOW()-INTERVAL '30 days') AS active_30d,
        COUNT(DISTINCT business_name) FILTER (WHERE business_name IS NOT NULL) AS unique_businesses
      FROM installs;
    `);

    const { rows: licRows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='active')    AS active_licences,
        COUNT(*) FILTER (WHERE status='expired')   AS expired_licences,
        COUNT(*) FILTER (WHERE status='suspended') AS suspended_licences,
        COUNT(*) FILTER (WHERE plan='lifetime')    AS lifetime_licences
      FROM licences;
    `);

    const { rows: payRows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='success')  AS total_payments,
        COALESCE(SUM(amount_kes) FILTER (WHERE status='success'), 0) AS total_revenue_kes
      FROM payments;
    `);

    res.json({ ...rows[0], ...licRows[0], ...payRows[0] });
  } catch (err) {
    console.error('[GET /api/stats]', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ─── GET /api/users ───────────────────────────────────────────────────────────
app.get('/api/users', async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(req.query.page  || '1', 10));
    const limit    = Math.min(100, parseInt(req.query.limit || '50', 10));
    const offset   = (page - 1) * limit;
    const search   = (req.query.search   || '').trim();
    const platform = req.query.platform  || '';
    const status   = req.query.status    || '';

    const conditions = ['1=1'];
    const params = [];
    let p = 1;

    if (search) {
      conditions.push(`(i.business_name ILIKE $${p} OR i.owner_name ILIKE $${p} OR i.device_name ILIKE $${p} OR i.location ILIKE $${p})`);
      params.push(`%${search}%`); p++;
    }
    if (platform === 'android' || platform === 'ios') {
      conditions.push(`i.platform = $${p}`); params.push(platform); p++;
    }
    if (['active','expired','suspended','none'].includes(status)) {
      if (status === 'none') conditions.push(`l.device_id IS NULL`);
      else { conditions.push(`l.status = $${p}`); params.push(status); p++; }
    }

    const where = conditions.join(' AND ');

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM installs i LEFT JOIN licences l ON l.device_id=i.device_id WHERE ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const { rows } = await pool.query(`
      SELECT i.*, l.status AS licence_status, l.plan AS licence_plan,
             l.expires_at, l.licence_key, l.activated_at
      FROM installs i
      LEFT JOIN licences l ON l.device_id = i.device_id
      WHERE ${where}
      ORDER BY i.last_seen_at DESC
      LIMIT $${p} OFFSET $${p+1}
    `, [...params, limit, offset]);

    res.json({ total, page, pages: Math.ceil(total / limit), limit, data: rows });
  } catch (err) {
    console.error('[GET /api/users]', err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ─── GET /api/payments ────────────────────────────────────────────────────────
app.get('/api/payments', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1', 10));
    const limit  = Math.min(100, parseInt(req.query.limit || '50', 10));
    const offset = (page - 1) * limit;

    const countRes = await pool.query(`SELECT COUNT(*) FROM payments`);
    const total = parseInt(countRes.rows[0].count, 10);

    const { rows } = await pool.query(`
      SELECT p.*, i.business_name, i.owner_name, i.phone
      FROM payments p
      LEFT JOIN installs i ON i.device_id = p.device_id
      ORDER BY p.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    res.json({ total, page, pages: Math.ceil(total / limit), limit, data: rows });
  } catch (err) {
    console.error('[GET /api/payments]', err.message);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// ─── GET /api/licences ────────────────────────────────────────────────────────
app.get('/api/licences', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1', 10));
    const limit  = Math.min(100, parseInt(req.query.limit || '50', 10));
    const offset = (page - 1) * limit;

    const countRes = await pool.query(`SELECT COUNT(*) FROM licences`);
    const total = parseInt(countRes.rows[0].count, 10);

    const { rows } = await pool.query(`
      SELECT l.*, i.business_name, i.owner_name, i.phone, i.device_name
      FROM licences l
      LEFT JOIN installs i ON i.device_id = l.device_id
      ORDER BY l.updated_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    res.json({ total, page, pages: Math.ceil(total / limit), limit, data: rows });
  } catch (err) {
    console.error('[GET /api/licences]', err.message);
    res.status(500).json({ error: 'Failed to fetch licences' });
  }
});

// ─── POST /api/admin/suspend ──────────────────────────────────────────────────
app.post('/api/admin/suspend', adminAuth, async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    await pool.query(
      `UPDATE licences SET status='suspended', updated_at=NOW() WHERE device_id=$1`,
      [deviceId]
    );
    res.json({ ok: true, action: 'suspended', deviceId });
  } catch (err) {
    console.error('[POST /api/admin/suspend]', err.message);
    res.status(500).json({ error: 'Suspend failed' });
  }
});

// ─── POST /api/admin/activate ─────────────────────────────────────────────────
app.post('/api/admin/activate', adminAuth, async (req, res) => {
  try {
    const { deviceId, plan, days } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const activePlan = plan || 'monthly';
    const expiryDays = days ?? PLANS[activePlan]?.days ?? 30;
    const expiresAt  = expiryDays ? new Date(Date.now() + expiryDays * 86400_000) : null;
    const licenceKey = generateLicenceKey();

    await pool.query(`
      INSERT INTO licences (device_id, licence_key, plan, amount_kes, status, activated_at, expires_at)
      VALUES ($1,$2,$3,$4,'active',NOW(),$5)
      ON CONFLICT (device_id) DO UPDATE SET
        licence_key  = EXCLUDED.licence_key,
        plan         = EXCLUDED.plan,
        amount_kes   = EXCLUDED.amount_kes,
        status       = 'active',
        activated_at = NOW(),
        expires_at   = EXCLUDED.expires_at,
        updated_at   = NOW()
    `, [deviceId, licenceKey, activePlan, PLANS[activePlan]?.amount || 0, expiresAt]);

    res.json({ ok: true, action: 'activated', deviceId, licenceKey, expiresAt });
  } catch (err) {
    console.error('[POST /api/admin/activate]', err.message);
    res.status(500).json({ error: 'Activation failed' });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function start() {
  await migrate();
  app.listen(PORT, () => console.log(`DukaPOS admin running on http://localhost:${PORT}`));
}
start().catch((err) => { console.error('Failed to start:', err); process.exit(1); });
