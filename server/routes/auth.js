import express from 'express';
import { get, run, tx } from '../db.js';
import * as v from '../util.js';
import {
  hashPassword, verifyPassword, startSession, endSession, requireAuth, ownerOnly,
  checkLoginAllowed, recordLoginFailure, clearLoginFailures,
} from '../auth.js';
import { getBusiness, serializeBusiness } from '../services/business.js';
import { seedDemoCatalog, DEMO_ACCOUNT, demoAccountEnabled } from '../seed.js';
import { dashboardPrefs } from '../../shared/dashboard.js';

/** A login's saved choices; only the parts this app knows are kept. */
function readPreferences(value) {
  let saved = {};
  try {
    saved = JSON.parse(value || '{}') || {};
  } catch {
    // Damaged choices fall back to the defaults.
  }
  return { dashboard: dashboardPrefs(saved.dashboard) };
}

const router = express.Router();

export function password(value, field = 'password', label = 'Password') {
  if (typeof value !== 'string' || value.length < 8) throw v.badRequest(`${label} must be at least 8 characters.`, field);
  if (value.length > 200) throw v.badRequest(`${label} is too long.`, field);
  return value;
}

export function mePayload(userId) {
  const user = get('SELECT id, name, email, business_id, role, preferences FROM users WHERE id = ?', userId);
  const business = serializeBusiness(getBusiness(user.business_id));
  if (user.role === 'team') {
    // A team login sees the jobs only, so it gets just the business's name, logo and currency.
    return {
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      business: {
        id: business.id, name: business.name, currency: business.currency, has_logo: business.has_logo,
        logo_url: business.has_logo ? `/api/view/logo?v=${encodeURIComponent(business.logo_updated_at || '')}` : null,
      },
      has_demo_data: false,
    };
  }
  const demo = get(
    `SELECT (SELECT COUNT(*) FROM products WHERE business_id = ? AND is_demo = 1)
          + (SELECT COUNT(*) FROM customers WHERE business_id = ? AND is_demo = 1)
          + (SELECT COUNT(*) FROM bills WHERE business_id = ? AND is_demo = 1)
          + (SELECT COUNT(*) FROM day_entries WHERE business_id = ? AND is_demo = 1)
          + (SELECT COUNT(*) FROM bookings WHERE business_id = ? AND is_demo = 1)
          + (SELECT COUNT(*) FROM team_members WHERE business_id = ? AND is_demo = 1) AS n`,
    ...Array(6).fill(user.business_id),
  );
  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role, preferences: readPreferences(user.preferences) },
    business,
    has_demo_data: demo.n > 0,
  };
}

router.get('/config', (req, res) => {
  res.json(demoAccountEnabled() ? { demo: { email: DEMO_ACCOUNT.email, password: DEMO_ACCOUNT.password } } : { demo: null });
});

router.post('/register', async (req, res) => {
  const b = req.body || {};
  const businessName = v.text(b.business_name, 'business_name', 'Business name', { max: 120, required: true });
  const name = v.text(b.name, 'name', 'Your name', { max: 80, required: true });
  const email = v.email(b.email, 'email', 'Email', { required: true });
  const pw = password(b.password);
  if (get('SELECT 1 FROM users WHERE email = ?', email)) {
    throw v.conflict('An account with this email already exists. Sign in instead.', { field: 'email' });
  }
  const hash = await hashPassword(pw);
  const userId = tx(() => {
    const biz = run('INSERT INTO businesses (name, email) VALUES (?, ?)', businessName, email);
    const businessId = Number(biz.lastInsertRowid);
    const user = run('INSERT INTO users (business_id, name, email, password_hash) VALUES (?, ?, ?, ?)', businessId, name, email, hash);
    const uid = Number(user.lastInsertRowid);
    if (v.bool(b.load_demo)) seedDemoCatalog(businessId, uid);
    return uid;
  });
  startSession(req, res, userId);
  res.status(201).json(mePayload(userId));
});

router.post('/login', async (req, res) => {
  const b = req.body || {};
  const email = v.email(b.email, 'email', 'Email', { required: true });
  if (typeof b.password !== 'string' || !b.password) throw v.badRequest('Password is required.', 'password');
  const key = `${req.ip}|${email}`;
  checkLoginAllowed(key);
  const user = get('SELECT id, password_hash FROM users WHERE email = ?', email);
  const ok = user ? await verifyPassword(b.password, user.password_hash) : await verifyPassword(b.password, 'scrypt$AAAA$AAAA');
  if (!user || !ok) {
    recordLoginFailure(key);
    throw new v.HttpError(401, 'Incorrect email or password.', { code: 'BAD_CREDENTIALS' });
  }
  clearLoginFailures(key);
  startSession(req, res, user.id);
  res.json(mePayload(user.id));
});

router.post('/logout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json(mePayload(req.user.id));
});

/** Save this login's choices: { dashboard: { widgets: [{ key, show }], actions: [...], stats: [...] } }. */
router.put('/preferences', requireAuth, ownerOnly, (req, res) => {
  const body = req.body || {};
  if (!body.dashboard || typeof body.dashboard !== 'object') throw v.badRequest('Nothing to save.', 'dashboard');
  const current = readPreferences(get('SELECT preferences FROM users WHERE id = ?', req.user.id).preferences);
  const next = { ...current, dashboard: dashboardPrefs(body.dashboard) };
  run('UPDATE users SET preferences = ? WHERE id = ?', JSON.stringify(next), req.user.id);
  res.json(mePayload(req.user.id));
});

// A team login's password is set by the owner (Settings → Team login), so only the owner changes their own here.
router.post('/password', requireAuth, ownerOnly, async (req, res) => {
  const b = req.body || {};
  if (typeof b.current_password !== 'string' || !b.current_password) {
    throw v.badRequest('Current password is required.', 'current_password');
  }
  const next = password(b.new_password, 'new_password', 'New password');
  const user = get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!(await verifyPassword(b.current_password, user.password_hash))) {
    throw v.badRequest('Current password is incorrect.', 'current_password');
  }
  const hash = await hashPassword(next);
  run('UPDATE users SET password_hash = ? WHERE id = ?', hash, req.user.id);
  // Sign out other devices, keep this session.
  endSession(req, res);
  run('DELETE FROM sessions WHERE user_id = ?', req.user.id);
  startSession(req, res, req.user.id);
  res.json({ ok: true });
});

export default router;
