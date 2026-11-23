// Backup and restore of one business (Settings → Backup & restore).
//
// A backup is an SQLite file with the app's own schema, holding the business's settings and every row of its data:
// bills, customers, inventory, bookings, the day book, photos. It holds no logins or passwords. Restoring replaces
// all of the business's data with what's in the file and leaves its logins as they are.
//
// Restoring takes the file into the business that is signed in, whichever business it was made from, so a backup
// also brings everything back into a new account (after the database itself was lost, say). Each row keeps its
// id when that id is free, and otherwise gets a new one; links between rows (a bill's items, payments, photos …)
// follow. The file comes from outside, so it is checked first, and links and pictures are checked again on the
// way in, as they are when typed into the app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { get, all, run, tx, iterate, nowIso, migrate, SCHEMA_VERSION } from '../db.js';
import * as v from '../util.js';
import { imageType } from './photos.js';
import { webLink } from './bookings.js';
import { billColor, upiId, website, reviewUrl, invoicePrefix } from './business.js';
import { CURRENCIES, isoDate } from '../../shared/format.js';

/**
 * Every table holding a business's data, parents before children. `via` reaches a table's rows through their
 * parent when it has no business_id. A new table with business data must be added here (a test checks).
 */
export const BACKUP_TABLES = [
  { name: 'customers' },
  { name: 'products' },
  { name: 'team_members' },
  { name: 'bills' },
  { name: 'bill_items', via: { column: 'bill_id', parent: 'bills' } },
  { name: 'payments' },
  { name: 'bill_stages' },
  { name: 'bill_photos' },
  { name: 'stock_movements' },
  { name: 'day_entries' },
  { name: 'bookings' },
  { name: 'booking_team', via: { column: 'booking_id', parent: 'bookings' } },
  { name: 'booking_payments' },
  { name: 'booking_activity' },
];
/** Left out of a backup: the logins and their sessions. The business's own row is its settings. */
export const NOT_IN_BACKUP = ['businesses', 'users', 'sessions'];

const META = 'ebilling_backup';
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');
export const MAX_UPLOAD_BYTES = 1024 ** 3; // 1 GB: photos make up most of a backup
const STAGED_MINUTES = 30;

const notBackup = () => v.badRequest('That file is not an eBilling backup. Choose a file made with Download backup.', 'file');
const damaged = () => v.badRequest('That backup file is damaged and can’t be restored.', 'file');

// A backup file is opened on its own, without foreign key checks: it holds no logins, which rows still name
// (created_by …); the restore checks every link itself on the way into the app's database, which does check them.
const openFile = (file) => new DatabaseSync(file, { enableForeignKeyConstraints: false });

const rowsOf = (t) => (t.via
  ? `${t.via.column} IN (SELECT id FROM ${t.via.parent} WHERE business_id = ?)`
  : 'business_id = ?');
const columnsOf = (table) => all(`PRAGMA table_info(${table})`).map((c) => c.name);
const tempFile = () => path.join(os.tmpdir(), `ebilling-${crypto.randomBytes(12).toString('hex')}.db`);
const asBuffer = (value) => (value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : null);

// ---- Making a backup ----------------------------------------------------------------------------------------

/** Write the business's backup to a temporary file. The caller sends it and then deletes it. */
export function createBackup(businessId) {
  const { name } = get('SELECT name FROM businesses WHERE id = ?', businessId);
  const file = tempFile();
  const out = openFile(file);
  let done = false;
  try {
    migrate(out);
    out.exec(`CREATE TABLE ${META} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    out.exec('BEGIN');
    // All in one synchronous pass, so nothing can change part-way: the copy is one moment's data.
    copyInto(out, 'businesses', 'SELECT * FROM businesses WHERE id = ?', businessId);
    for (const t of BACKUP_TABLES) copyInto(out, t.name, `SELECT * FROM ${t.name} WHERE ${rowsOf(t)} ORDER BY id`, businessId);
    const meta = { app: 'ebilling', format: '1', created_at: nowIso(), business_name: name };
    const put = out.prepare(`INSERT INTO ${META} (key, value) VALUES (?, ?)`);
    for (const [key, value] of Object.entries(meta)) put.run(key, value);
    out.exec('COMMIT');
    done = true;
  } finally {
    out.close();
    if (!done) fs.rmSync(file, { force: true });
  }
  return { file, filename: `ebilling-backup-${slug(name)}-${isoDate()}.db` };
}

function copyInto(out, table, sql, businessId) {
  const cols = columnsOf(table);
  const insert = out.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  for (const row of iterate(sql, businessId)) insert.run(...cols.map((c) => row[c]));
}

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'business';
}

// ---- Reading a backup file ----------------------------------------------------------------------------------

/**
 * Open an uploaded file as a backup, or throw a 400 saying why it isn't one. A backup from an older version of
 * the app is brought up to date (in the uploaded copy only). The caller closes the connection.
 */
function openBackup(file) {
  const head = Buffer.alloc(SQLITE_HEADER.length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!head.equals(SQLITE_HEADER)) throw notBackup();

  const conn = openFile(file);
  try {
    const one = (sql, ...params) => conn.prepare(sql).get(...params);
    conn.exec('PRAGMA trusted_schema = OFF');
    if (one('PRAGMA quick_check')?.quick_check !== 'ok') throw damaged();
    // The app's schema has no views or triggers; a file with them wasn't made by the app.
    if (one("SELECT 1 FROM sqlite_master WHERE type IN ('view', 'trigger')")) throw notBackup();
    if (!one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", META)) throw notBackup();
    const meta = Object.fromEntries(conn.prepare(`SELECT key, value FROM ${META}`).all().map((r) => [r.key, r.value]));
    if (meta.app !== 'ebilling') throw notBackup();
    if (one('PRAGMA user_version').user_version > SCHEMA_VERSION) {
      throw v.badRequest('This backup was made by a newer version of eBilling. Update the app, then restore it.', 'file');
    }
    try {
      migrate(conn);
    } catch {
      throw damaged();
    }
    for (const table of ['businesses', ...BACKUP_TABLES.map((t) => t.name)]) {
      const have = new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
      if (!columnsOf(table).every((c) => have.has(c))) throw damaged();
    }
    const business = one('SELECT * FROM businesses ORDER BY id LIMIT 1');
    if (!business) throw damaged();
    return { conn, meta, business };
  } catch (err) {
    conn.close();
    if (err instanceof v.HttpError) throw err;
    throw notBackup();
  }
}

/** What's in a backup, shown before restoring it. */
function describe({ conn, meta, business }) {
  const count = (table) => conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return {
    business_name: business.name,
    created_at: meta.created_at || null,
    counts: {
      bills: count('bills'), customers: count('customers'), products: count('products'),
      bookings: count('bookings'), day_entries: count('day_entries'), photos: count('bill_photos'),
    },
  };
}

// ---- Restoring ----------------------------------------------------------------------------------------------

// An uploaded backup waits here, checked, until the owner confirms the restore: one per business at a time.
const staged = new Map(); // businessId -> { token, file, expires }

function unstage(businessId) {
  const entry = staged.get(businessId);
  if (!entry) return;
  staged.delete(businessId);
  fs.rm(entry.file, { force: true }, () => {});
}

function dropExpired() {
  for (const [businessId, entry] of staged) if (entry.expires < Date.now()) unstage(businessId);
}

/**
 * Receive an uploaded backup (the raw file as the request body), check it, and keep it for restoreBackup.
 * Returns a token for the restore and what the backup holds.
 */
export async function stageBackup(businessId, req) {
  dropExpired();
  const tooLarge = () => new v.HttpError(413, 'That file is too large to be a backup (1 GB at most).');
  if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD_BYTES) throw tooLarge();
  const file = tempFile();
  let bytes = 0;
  try {
    await pipeline(req, new Transform({
      transform(chunk, _enc, done) {
        bytes += chunk.length;
        done(bytes > MAX_UPLOAD_BYTES ? tooLarge() : null, chunk);
      },
    }), fs.createWriteStream(file));
    if (!bytes) throw v.badRequest('Choose a backup file.', 'file');
    const backup = openBackup(file);
    let summary;
    try {
      summary = describe(backup);
    } finally {
      backup.conn.close();
    }
    unstage(businessId);
    const token = crypto.randomBytes(18).toString('base64url');
    staged.set(businessId, { token, file, expires: Date.now() + STAGED_MINUTES * 60_000 });
    return { upload: token, backup: summary };
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
}

/** Replace all of the business's data with the staged backup. Returns how many rows came back, per table. */
export function restoreBackup(businessId, token) {
  dropExpired();
  const entry = staged.get(businessId);
  if (!entry || typeof token !== 'string' || entry.token !== token) {
    throw v.badRequest('Choose the backup file again: it was waiting too long.', 'file');
  }
  try {
    const backup = openBackup(entry.file);
    try {
      return tx(() => replaceData(businessId, backup));
    } catch (err) {
      // Rows the database refuses (a CHECK or NOT NULL rule): the file was changed by hand or is damaged.
      if (err.code === 'ERR_SQLITE_ERROR') throw damaged();
      throw err;
    } finally {
      backup.conn.close();
    }
  } finally {
    unstage(businessId);
  }
}

function replaceData(businessId, { conn, business }) {
  // 1. The business's data now, children first.
  for (const t of [...BACKUP_TABLES].reverse()) run(`DELETE FROM ${t.name} WHERE ${rowsOf(t)}`, businessId);

  // 2. The backup's rows, parents first. A link to a login that's gone is cleared.
  const logins = new Set(all('SELECT id FROM users WHERE business_id = ?', businessId).map((u) => u.id));
  const ids = new Map(); // table -> Map(id in the backup -> id now)
  const counts = {};
  for (const t of BACKUP_TABLES) {
    const cols = columnsOf(t.name);
    const required = new Set(all(`PRAGMA table_info(${t.name})`).filter((c) => c.notnull).map((c) => c.name));
    const links = all(`PRAGMA foreign_key_list(${t.name})`).map((f) => [f.from, f.table]);
    const insert = `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    const taken = `SELECT 1 FROM ${t.name} WHERE id = ?`;
    const newIds = new Map();
    ids.set(t.name, newIds);
    let n = 0;
    for (const original of conn.prepare(`SELECT * FROM ${t.name} ORDER BY id`).iterate()) {
      const row = cleanRow(t.name, { ...original }, ids);
      if (!row) continue;
      for (const [col, parent] of links) {
        if (parent === 'businesses') row[col] = businessId;
        else if (row[col] == null) continue;
        else if (parent === 'users') row[col] = logins.has(row[col]) ? row[col] : null;
        else row[col] = ids.get(parent)?.get(row[col]) ?? null;
        if (row[col] == null && required.has(col)) throw damaged();
      }
      // Keep the id unless another business has it now (ids of deleted rows can be given out again).
      row.id = Number.isInteger(original.id) && !get(taken, original.id) ? original.id : null;
      newIds.set(original.id, Number(run(insert, ...cols.map((c) => row[c])).lastInsertRowid));
      n++;
    }
    counts[t.name] = n;
  }

  // 3. The business's settings.
  restoreSettings(businessId, business);
  return counts;
}

/** A row as it may come in: links and pictures checked as when they're entered in the app. Null skips it. */
function cleanRow(table, row, ids) {
  if (table === 'bill_photos') {
    const data = asBuffer(row.data);
    const thumb = asBuffer(row.thumb);
    const mime = data && imageType(data);
    const thumbMime = thumb && imageType(thumb);
    if (!mime || !thumbMime) return null;
    return { ...row, data, thumb, mime, thumb_mime: thumbMime, bytes: data.length };
  }
  if (table === 'bills' && row.share_token != null) {
    // Customer links are unique across all businesses.
    if (typeof row.share_token !== 'string' || get('SELECT 1 FROM bills WHERE share_token = ?', row.share_token)) {
      return { ...row, share_token: null, share_created_at: null };
    }
  }
  if (table === 'bookings') {
    const products = ids.get('products');
    const services = parseJson(row.services, []);
    if (Array.isArray(services)) {
      row.services = JSON.stringify(services.map((s) => {
        if (!s || typeof s !== 'object' || s.product_id == null) return s;
        const { product_id: productId, ...line } = s;
        return products.has(productId) ? { ...line, product_id: products.get(productId) } : line;
      }));
    }
    const links = parseJson(row.links, []);
    row.links = JSON.stringify((Array.isArray(links) ? links : [])
      .filter((l) => l && typeof l === 'object')
      .map((l) => ({ ...l, url: safeLink(l.url) }))
      .filter((l) => l.url));
    const delivery = parseJson(row.delivery, {});
    if (delivery && typeof delivery === 'object' && !Array.isArray(delivery)) {
      for (const key of ['drive', 'dropbox', 'other']) if (delivery[key]) delivery[key] = safeLink(delivery[key]);
      row.delivery = JSON.stringify(delivery);
    } else {
      row.delivery = '{}';
    }
  }
  return row;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
}

/** A web link as the app stores it, or '' for anything else. */
function safeLink(value) {
  try {
    return webLink(value, 'url', 'Link');
  } catch {
    return '';
  }
}

function restoreSettings(businessId, b) {
  const now = get('SELECT name, next_invoice_no, next_booking_no FROM businesses WHERE id = ?', businessId);
  const checked = (check, value, fallback) => {
    try {
      return check(value);
    } catch {
      return fallback;
    }
  };
  const count = (value) => (Number.isInteger(value) && value > 0 ? value : 1);
  const list = (value) => {
    const parsed = parseJson(value, null);
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? value : '';
  };
  const logo = asBuffer(b.logo_data);
  const logoMime = logo && ['image/png', 'image/jpeg'].includes(imageType(logo)) ? imageType(logo) : null;
  const when = nowIso();

  const d = {};
  for (const col of columnsOf('businesses')) if (col !== 'id' && col !== 'created_at') d[col] = b[col];
  Object.assign(d, {
    name: String(b.name ?? '').trim().slice(0, 120) || now.name,
    website: checked(website, b.website, ''),
    review_url: checked(reviewUrl, b.review_url, ''),
    upi_id: checked(upiId, b.upi_id, ''),
    bill_color: checked(billColor, b.bill_color, '#f26b1d'),
    bill_header: b.bill_header === 'light' ? 'light' : 'dark',
    currency: Object.hasOwn(CURRENCIES, b.currency) ? b.currency : 'INR',
    invoice_prefix: checked(invoicePrefix, b.invoice_prefix, 'INV-'),
    // Numbers already given out are never given out again, so a restored backup can't repeat a bill number.
    next_invoice_no: Math.max(now.next_invoice_no, count(b.next_invoice_no)),
    next_booking_no: Math.max(now.next_booking_no, count(b.next_booking_no)),
    expense_types: list(b.expense_types),
    product_categories: list(b.product_categories),
    logo_mime: logoMime,
    logo_data: logoMime ? logo : null,
    logo_updated_at: when,
    updated_at: when,
  });
  const keys = Object.keys(d);
  run(`UPDATE businesses SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => d[k]), businessId);
}
