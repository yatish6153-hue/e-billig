import express from 'express';
import { get, all, run, tx, nowIso } from '../db.js';
import * as v from '../util.js';
import { hashPassword } from '../auth.js';
import { getBusiness, serializeBusiness } from '../services/business.js';
import { CURRENCIES } from '../../shared/format.js';
import { seedDemoCatalog, removeDemoData } from '../seed.js';
import { mePayload, password } from './auth.js';

const router = express.Router();
const MAX_LOGO_BYTES = 1024 * 1024;

function billColor(value) {
  const s = String(value || '#f26b1d').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) throw v.badRequest('Choose a bill colour like #f26b1d.', 'bill_color');
  return s.toLowerCase();
}

/** The UPI ID customers pay the balance to, like yourname@okaxis. */
function upiId(value) {
  const s = v.text(value, 'upi_id', 'UPI ID', { max: 100 }).replace(/\s/g, '').toLowerCase();
  if (s && !/^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,63}$/.test(s)) throw v.badRequest('Enter a UPI ID like yourname@okaxis.', 'upi_id');
  return s;
}

/** A website like www.deveshstudio.com (https:// is optional and dropped); the bill links it over https. */
function website(value) {
  const s = v.text(value, 'website', 'Website', { max: 120 }).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (s && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24}(\/[^\s<>"']*)?$/i.test(s)) {
    throw v.badRequest('Enter a website like www.yourstudio.com.', 'website');
  }
  // The domain in lower case; a path keeps its case.
  const slash = s.indexOf('/');
  return slash < 0 ? s.toLowerCase() : s.slice(0, slash).toLowerCase() + s.slice(slash);
}

router.get('/', (req, res) => {
  res.json({ business: serializeBusiness(getBusiness(req.businessId)) });
});

router.put('/', (req, res) => {
  const b = req.body || {};
  const prefix = v.text(b.invoice_prefix, 'invoice_prefix', 'Invoice prefix', { max: 12 });
  if (prefix && !/^[A-Za-z0-9/_#.-]+$/.test(prefix)) {
    throw v.badRequest('Invoice prefix can use letters, numbers and - / _ # . only.', 'invoice_prefix');
  }
  const d = {
    name: v.text(b.name, 'name', 'Business name', { max: 120, required: true }),
    address: v.text(b.address, 'address', 'Address', { max: 500, multiline: true }),
    phone: v.phone(b.phone, 'phone', 'Phone'),
    email: v.email(b.email, 'email', 'Email'),
    website: website(b.website),
    currency: v.oneOf(b.currency, Object.keys(CURRENCIES), 'currency', 'Currency'),
    invoice_prefix: prefix,
    next_invoice_no: v.integer(b.next_invoice_no, 'next_invoice_no', 'Next invoice number', { min: 1, max: 99_999_999 }),
    round_off: v.bool(b.round_off) ? 1 : 0,
    upi_id: upiId(b.upi_id),
    payment_details: v.text(b.payment_details, 'payment_details', 'Payment details', { max: 500, multiline: true }),
    invoice_terms: v.text(b.invoice_terms, 'invoice_terms', 'Terms & conditions', { max: 1000, multiline: true }),
    tagline: v.text(b.tagline, 'tagline', 'Tagline', { max: 80 }),
    bill_color: billColor(b.bill_color),
    bill_header: v.oneOf(b.bill_header || 'dark', ['dark', 'light'], 'bill_header', 'Bill header'),
  };
  const keys = Object.keys(d);
  run(`UPDATE businesses SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ...keys.map((k) => d[k]), nowIso(), req.businessId);
  res.json({ business: serializeBusiness(getBusiness(req.businessId)) });
});

router.get('/logo', (req, res) => {
  const row = get('SELECT logo_mime, logo_data FROM businesses WHERE id = ?', req.businessId);
  if (!row?.logo_mime) throw v.notFound('Logo');
  res.setHeader('Content-Type', row.logo_mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(Buffer.from(row.logo_data));
});

router.post('/logo', (req, res) => {
  const dataUrl = String((req.body || {}).data_url || '');
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw v.badRequest('Upload a PNG or JPEG image.', 'logo');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_LOGO_BYTES) throw v.badRequest('Logo must be 1 MB or smaller.', 'logo');
  const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (!isPng && !isJpeg) throw v.badRequest('That file is not a valid PNG or JPEG image.', 'logo');
  run('UPDATE businesses SET logo_mime = ?, logo_data = ?, logo_updated_at = ? WHERE id = ?',
    isPng ? 'image/png' : 'image/jpeg', buf, nowIso(), req.businessId);
  res.json({ business: serializeBusiness(getBusiness(req.businessId)) });
});

router.delete('/logo', (req, res) => {
  run('UPDATE businesses SET logo_mime = NULL, logo_data = NULL, logo_updated_at = ? WHERE id = ?', nowIso(), req.businessId);
  res.json({ business: serializeBusiness(getBusiness(req.businessId)) });
});

// ---- Team logins: sign-ins for the team that only see the jobs in Tracking, view only (routes/view.js) ----
const MAX_TEAM_LOGINS = 10;
const teamLogins = (businessId) => all(
  "SELECT id, name, email, created_at FROM users WHERE business_id = ? AND role = 'team' ORDER BY id",
  businessId,
);
const emailTaken = () => v.conflict('This email is already used to sign in. Choose another one.', { field: 'email' });

function ownedTeamLogin(req) {
  const login = get("SELECT id FROM users WHERE id = ? AND business_id = ? AND role = 'team'", v.id(req.params.id, 'Team login'), req.businessId);
  if (!login) throw v.notFound('Team login');
  return login;
}

router.get('/team-logins', (req, res) => {
  res.json({ logins: teamLogins(req.businessId) });
});

router.post('/team-logins', async (req, res) => {
  const b = req.body || {};
  const name = v.text(b.name, 'name', 'Name', { max: 80, required: true });
  const email = v.email(b.email, 'email', 'Login email', { required: true });
  const pw = password(b.password);
  if (teamLogins(req.businessId).length >= MAX_TEAM_LOGINS) throw v.conflict(`A business can have up to ${MAX_TEAM_LOGINS} team logins.`);
  if (get('SELECT 1 FROM users WHERE email = ?', email)) throw emailTaken();
  const hash = await hashPassword(pw);
  try {
    run("INSERT INTO users (business_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'team')", req.businessId, name, email, hash);
  } catch (err) {
    // Taken by someone else while the password was being hashed.
    if (/UNIQUE constraint failed: users\.email/.test(err.message)) throw emailTaken();
    throw err;
  }
  res.status(201).json({ logins: teamLogins(req.businessId) });
});

router.put('/team-logins/:id/password', async (req, res) => {
  const login = ownedTeamLogin(req);
  const hash = await hashPassword(password((req.body || {}).password));
  run('UPDATE users SET password_hash = ? WHERE id = ?', hash, login.id);
  // Anyone signed in with the old password has to sign in again.
  run('DELETE FROM sessions WHERE user_id = ?', login.id);
  res.json({ logins: teamLogins(req.businessId) });
});

router.delete('/team-logins/:id', (req, res) => {
  run('DELETE FROM users WHERE id = ?', ownedTeamLogin(req).id); // its sessions go with it
  res.json({ logins: teamLogins(req.businessId) });
});

router.post('/demo/load', (req, res) => {
  const { n } = get('SELECT COUNT(*) AS n FROM products WHERE business_id = ? AND is_demo = 1', req.businessId);
  if (n > 0) throw v.conflict('Demo data is already loaded.');
  const counts = tx(() => seedDemoCatalog(req.businessId, req.user.id));
  res.json({ ...mePayload(req.user.id), loaded: counts });
});

router.post('/demo/remove', (req, res) => {
  const removed = removeDemoData(req.businessId);
  res.json({ ...mePayload(req.user.id), removed });
});

export default router;
