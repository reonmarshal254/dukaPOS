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
  daily:    { amount: parseInt(process.env.PLAN_DAILY_PRICE    || '100',   10), days: 1   },
  weekly:   { amount: parseInt(process.env.PLAN_WEEKLY_PRICE   || '600',   10), days: 7   },
  monthly:  { amount: parseInt(process.env.PLAN_MONTHLY_PRICE  || '2000',  10), days: 30  },
  lifetime: { amount: parseInt(process.env.PLAN_LIFETIME_PRICE || '10000', 10), days: null },
};

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.static(path.join(__dirname)));

// ─── Logging Middleware ────────────────────────────────────────────────────────
const logBuffer = []; // In-memory circular buffer (max 1000 entries)
const MAX_LOGS = 1000;

function log(type, category, message, details = null) {
  const entry = {
    id: Date.now() + Math.random(),
    timestamp: new Date().toISOString(),
    type, // 'INFO' | 'SUCCESS' | 'ERROR' | 'WARNING' | 'REQUEST' | 'RESPONSE'
    category, // 'HTTP' | 'DB' | 'PAYSTACK' | 'AUTH' | 'SYSTEM'
    message,
    details,
  };
  
  logBuffer.unshift(entry);
  if (logBuffer.length > MAX_LOGS) logBuffer.pop();
  
  // Also console log with color
  const colors = {
    INFO: '\x1b[36m',     // Cyan
    SUCCESS: '\x1b[32m',  // Green
    ERROR: '\x1b[31m',    // Red
    WARNING: '\x1b[33m',  // Yellow
    REQUEST: '\x1b[35m',  // Magenta
    RESPONSE: '\x1b[34m', // Blue
  };
  const reset = '\x1b[0m';
  console.log(`${colors[type] || ''}[${type}] [${category}] ${message}${reset}`, details || '');
}

// HTTP Request/Response logger
app.use((req, res, next) => {
  const start = Date.now();
  const { method, url, body, query } = req;
  
  // Skip logging for admin page assets
  if (url.startsWith('/api') || url === '/health') {
    log('REQUEST', 'HTTP', `${method} ${url}`, { 
      query: Object.keys(query).length ? query : undefined,
      body: method === 'POST' ? body : undefined,
      ip: req.ip,
      userAgent: req.get('user-agent')?.substring(0, 50)
    });
    
    // Capture response
    const originalSend = res.send;
    res.send = function(data) {
      const duration = Date.now() - start;
      const type = res.statusCode >= 400 ? 'ERROR' : res.statusCode >= 200 && res.statusCode < 300 ? 'SUCCESS' : 'RESPONSE';
      
      log(type, 'HTTP', `${method} ${url} → ${res.statusCode} (${duration}ms)`, {
        status: res.statusCode,
        duration: `${duration}ms`,
        responseSize: data?.length || 0
      });
      
      return originalSend.call(this, data);
    };
  }
  
  next();
});

// ─── Admin auth middleware ─────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-secret'] || req.query.secret;
  const endpoint = req.path;
  
  if (token !== ADMIN_SECRET) {
    log('WARNING', 'AUTH', `Unauthorized admin access attempt: ${endpoint}`, {
      ip: req.ip,
      endpoint,
      providedToken: token ? '***' + token.slice(-4) : 'none'
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  log('SUCCESS', 'AUTH', `Admin authenticated: ${endpoint}`, { endpoint });
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

// ─── Helper: get billing_enabled flag ────────────────────────────────────────
async function isBillingEnabled() {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM admin_settings WHERE key = 'billing_enabled'`
    );
    return rows[0]?.value !== 'false';
  } catch { return true; } // default to enabled on error
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

    // Check if this is a new registration
    const { rows: existing } = await pool.query(
      `SELECT device_id FROM installs WHERE device_id = $1`, [deviceId]
    );
    const isNewRegistration = existing.length === 0;

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

    if (isNewRegistration) {
      log('SUCCESS', 'SYSTEM', `New device registered: ${businessName || 'Unknown Business'}`, {
        deviceId: deviceId.substring(0, 16) + '...',
        businessName,
        ownerName,
        platform,
        deviceModel
      });
    } else {
      log('INFO', 'SYSTEM', `Device heartbeat: ${businessName || deviceId.substring(0, 16)}`, {
        deviceId: deviceId.substring(0, 16) + '...'
      });
    }

    // Return current licence status alongside registration ack
    const { rows } = await pool.query(
      `SELECT status, plan, expires_at, licence_key FROM licences WHERE device_id = $1`,
      [deviceId]
    );
    const licence = rows[0] || null;

    res.json({ ok: true, licence });
  } catch (err) {
    log('ERROR', 'DB', `Registration failed: ${err.message}`, { deviceId: req.body.deviceId });
    console.error('[POST /api/register]', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ─── GET /api/licence/:deviceId ───────────────────────────────────────────────
app.get('/api/licence/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    console.log(`[licence] check for device: ${deviceId?.slice(0,16)}…`);

    // If billing is disabled globally → everyone gets free access
    const billingEnabled = await isBillingEnabled();
    if (!billingEnabled) {
      return res.json({
        valid: true,
        plan: 'free',
        licenceKey: null,
        expiresAt: null,
        activatedAt: null,
        billingEnabled: false,
      });
    }

    const { rows } = await pool.query(
      `SELECT status, plan, expires_at, licence_key, activated_at
       FROM licences WHERE device_id = $1`,
      [deviceId]
    );

    if (!rows[0]) return res.json({ valid: false, reason: 'no_licence', billingEnabled: true });

    const lic = rows[0];

    // Auto-expire + delete if past expiry date
    if (lic.expires_at && new Date(lic.expires_at) < new Date()) {
      await pool.query(`DELETE FROM licences WHERE device_id=$1`, [deviceId]);
      return res.json({ valid: false, reason: 'expired', expiredAt: lic.expires_at, billingEnabled: true });
    }

    if (lic.status === 'suspended') return res.json({ valid: false, reason: 'suspended', billingEnabled: true });
    if (lic.status === 'expired')   return res.json({ valid: false, reason: 'expired', expiredAt: lic.expires_at, billingEnabled: true });

    res.json({
      valid:          true,
      plan:           lic.plan,
      licenceKey:     lic.licence_key,
      expiresAt:      lic.expires_at,
      activatedAt:    lic.activated_at,
      billingEnabled: true,
    });
  } catch (err) {
    console.error('[GET /api/licence]', err.message);
    res.status(500).json({ error: 'Licence check failed' });
  }
});

// ─── GET /api/account-status/:deviceId ────────────────────────────────────────
// Mobile app calls this to check if account is deactivated
// Returns device info, business info, and account status
app.get('/api/account-status/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    console.log(`[account-status] check for device: ${deviceId?.slice(0,16)}…`);

    // Get device and business info including account_status
    const { rows: deviceRows } = await pool.query(
      `SELECT business_name, owner_name, phone, device_name, device_model, 
              os_name, platform, last_seen_at, account_status
       FROM installs WHERE device_id = $1`,
      [deviceId]
    );

    if (!deviceRows[0]) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const device = deviceRows[0];
    const accountDeactivated = device.account_status === 'deactivated';

    // Check licence status
    const { rows: licenceRows } = await pool.query(
      `SELECT status, plan, expires_at FROM licences WHERE device_id = $1`,
      [deviceId]
    );

    const licence = licenceRows[0];
    const licenceSuspended = licence?.status === 'suspended';

    res.json({
      suspended: licenceSuspended || accountDeactivated, // Account deactivation also suspends access
      accountStatus: device.account_status || 'active',
      accountDeactivated,
      deviceId,
      businessName: device.business_name || 'Unknown Business',
      ownerName: device.owner_name || 'Unknown Owner',
      phone: device.phone || 'N/A',
      deviceName: device.device_name || 'Unknown Device',
      deviceModel: device.device_model || '',
      osName: device.os_name || device.platform || 'Unknown OS',
      lastSeenAt: device.last_seen_at,
      licenceStatus: licence?.status || 'none',
      plan: licence?.plan || null,
    });
  } catch (err) {
    console.error('[GET /api/account-status]', err.message);
    res.status(500).json({ error: 'Account status check failed' });
  }
});

// ─── POST /api/payment/initiate ───────────────────────────────────────────────
// Triggers a Paystack M-Pesa (mobile_money) STK push charge.
// email is fixed to dukapos254@gmail.com as the merchant account email.
app.post('/api/payment/initiate', async (req, res) => {
  try {
    const { deviceId, plan, phone } = req.body;
    if (!deviceId || !plan || !phone) {
      log('WARNING', 'PAYSTACK', 'Payment initiation missing required fields', { deviceId, plan, phone });
      return res.status(400).json({ error: 'deviceId, plan, phone required' });
    }

    const planConfig = PLANS[plan];
    if (!planConfig) {
      log('WARNING', 'PAYSTACK', `Invalid plan requested: ${plan}`, { deviceId, plan });
      return res.status(400).json({ error: 'Invalid plan' });
    }

    // Ensure device is registered
    const { rows: devRows } = await pool.query(
      `SELECT device_id FROM installs WHERE device_id=$1`, [deviceId]
    );
    if (!devRows[0]) {
      log('WARNING', 'PAYSTACK', 'Payment attempt for unregistered device', { deviceId });
      return res.status(404).json({ error: 'Device not registered' });
    }

    const reference   = generateReference(deviceId);
    const amountKobo  = planConfig.amount * 100; // Paystack uses kobo (KES cents)

    log('INFO', 'PAYSTACK', `Payment initiated: ${plan} (KES ${planConfig.amount})`, {
      deviceId: deviceId.substring(0, 16) + '...',
      plan,
      amount: planConfig.amount,
      phone: phone.substring(0, 6) + '***',
      reference
    });

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
             l.expires_at, l.licence_key, l.activated_at,
             i.account_status
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

// ─── GET /api/billing-status ──────────────────────────────────────────────────
app.get('/api/billing-status', async (_req, res) => {
  try {
    const enabled = await isBillingEnabled();
    res.json({ billingEnabled: enabled });
  } catch (err) {
    console.error('[GET /api/billing-status]', err.message);
    res.status(500).json({ error: 'Failed to fetch billing status' });
  }
});

// ─── POST /api/admin/billing-toggle ──────────────────────────────────────────
app.post('/api/admin/billing-toggle', adminAuth, async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) is required' });
    }
    await pool.query(`
      INSERT INTO admin_settings (key, value, updated_at)
      VALUES ('billing_enabled', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()
    `, [enabled ? 'true' : 'false']);

    console.log(`[billing] Billing ${enabled ? 'ENABLED' : 'DISABLED'} by admin`);
    res.json({ ok: true, billingEnabled: enabled });
  } catch (err) {
    console.error('[POST /api/admin/billing-toggle]', err.message);
    res.status(500).json({ error: 'Toggle failed' });
  }
});

// ─── POST /api/admin/account/activate ─────────────────────────────────────────
app.post('/api/admin/account/activate', adminAuth, async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId is required' });
    }
    
    await pool.query(
      `UPDATE installs SET account_status = 'active' WHERE device_id = $1`,
      [deviceId]
    );
    
    console.log(`[admin] Account activated for device: ${deviceId?.slice(0,16)}…`);
    res.json({ ok: true, action: 'account_activated', deviceId, accountStatus: 'active' });
  } catch (err) {
    console.error('[POST /api/admin/account/activate]', err.message);
    res.status(500).json({ error: 'Account activation failed' });
  }
});

// ─── POST /api/admin/account/deactivate ───────────────────────────────────────
app.post('/api/admin/account/deactivate', adminAuth, async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId is required' });
    }
    
    await pool.query(
      `UPDATE installs SET account_status = 'deactivated' WHERE device_id = $1`,
      [deviceId]
    );
    
    console.log(`[admin] Account deactivated for device: ${deviceId?.slice(0,16)}…`);
    res.json({ ok: true, action: 'account_deactivated', deviceId, accountStatus: 'deactivated' });
  } catch (err) {
    console.error('[POST /api/admin/account/deactivate]', err.message);
    res.status(500).json({ error: 'Account deactivation failed' });
  }
});

// ─── GET /api/logs ────────────────────────────────────────────────────────────
app.get('/api/logs', adminAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '200', 10);
    const type = req.query.type; // Filter by type if provided
    const category = req.query.category; // Filter by category if provided
    
    let filtered = [...logBuffer];
    
    if (type) {
      filtered = filtered.filter(log => log.type === type);
    }
    
    if (category) {
      filtered = filtered.filter(log => log.category === category);
    }
    
    res.json({ 
      total: filtered.length,
      logs: filtered.slice(0, limit),
      types: ['INFO', 'SUCCESS', 'ERROR', 'WARNING', 'REQUEST', 'RESPONSE'],
      categories: ['HTTP', 'DB', 'PAYSTACK', 'AUTH', 'SYSTEM']
    });
  } catch (err) {
    console.error('[GET /api/logs]', err.message);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const billingEnabled = await isBillingEnabled();
  res.json({ status: 'ok', ts: new Date().toISOString(), billingEnabled });
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function start() {
  await migrate();
  app.listen(PORT, () => {
    log('SUCCESS', 'SYSTEM', `DukaPOS Backend started on port ${PORT}`, {
      port: PORT,
      nodeEnv: process.env.NODE_ENV || 'development'
    });
    console.log(`DukaPOS admin running on http://localhost:${PORT}`);
  });
}
start().catch((err) => { 
  log('ERROR', 'SYSTEM', `Failed to start server: ${err.message}`);
  console.error('Failed to start:', err); 
  process.exit(1); 
});
