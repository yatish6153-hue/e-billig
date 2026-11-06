// Password hashing, cookie sessions, CSRF guard and the requireAuth middleware.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { get, run } from './db.js';
import { HttpError } from './util.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'eb_sid';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function cookieOptions(req, maxAgeSeconds) {
  const secure = req.secure || process.env.COOKIE_SECURE === 'true';
  return [`Path=/`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`, secure ? 'Secure' : ''].filter(Boolean).join('; ');
}

export function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  run("DELETE FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  run('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, expires);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieOptions(req, SESSION_DAYS * 86400)}`);
}

export function endSession(req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) run('DELETE FROM sessions WHERE id = ?', sha256(token));
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieOptions(req, 0)}`);
}

export function sessionUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token || token.length > 100) return null;
  return get(
    `SELECT u.id, u.name, u.email, u.business_id, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    sha256(token),
  ) || null;
}

export function requireAuth(req, res, next) {
  const user = sessionUser(req);
  if (!user) return next(new HttpError(401, 'Please sign in to continue.', { code: 'UNAUTHENTICATED' }));
  req.user = user;
  req.businessId = user.business_id;
  next();
}

/** Everything but the team's view of the jobs (routes/view.js) is for the owner's login; a team login gets 403. */
export function ownerOnly(req, res, next) {
  if (req.user.role !== 'owner') return next(new HttpError(403, 'This login can only see the jobs in Tracking.', { code: 'TEAM_LOGIN' }));
  next();
}

/**
 * State-changing API calls must carry a custom header. Browsers refuse to send
 * custom headers cross-site without a CORS preflight (which we never approve),
 * so this blocks cross-site request forgery.
 */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'fetch') {
    return next(new HttpError(403, 'Request blocked for security reasons. Please reload the page.', { code: 'CSRF' }));
  }
  next();
}

// Simple in-memory brute-force protection for sign-in.
const failures = new Map();
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;

export function checkLoginAllowed(key) {
  const entry = failures.get(key);
  if (entry && entry.count >= MAX_FAILURES && Date.now() - entry.first < WINDOW_MS) {
    const minutes = Math.ceil((WINDOW_MS - (Date.now() - entry.first)) / 60_000);
    throw new HttpError(429, `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }
}

export function recordLoginFailure(key) {
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.first >= WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
  else entry.count++;
  if (failures.size > 10_000) failures.clear();
}

export function clearLoginFailures(key) {
  failures.delete(key);
}
