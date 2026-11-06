// SQLite access via Node's built-in node:sqlite (no native build step).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

let db = null;
const statements = new Map();
let txDepth = 0;

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

const MIGRATIONS = [
  // v1 — initial schema
  `
  CREATE TABLE businesses (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    gstin TEXT NOT NULL DEFAULT '',
    logo_mime TEXT,
    logo_data BLOB,
    logo_updated_at TEXT,
    currency TEXT NOT NULL DEFAULT 'INR',
    invoice_prefix TEXT NOT NULL DEFAULT 'INV-',
    next_invoice_no INTEGER NOT NULL DEFAULT 1,
    tax_label TEXT NOT NULL DEFAULT 'GST',
    default_tax_rate REAL NOT NULL DEFAULT 18,
    tax_rates TEXT NOT NULL DEFAULT '0,5,18,40',
    prices_include_tax INTEGER NOT NULL DEFAULT 0,
    split_tax INTEGER NOT NULL DEFAULT 1,
    round_off INTEGER NOT NULL DEFAULT 1,
    payment_details TEXT NOT NULL DEFAULT '',
    invoice_terms TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX ix_sessions_user ON sessions(user_id);

  CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sku TEXT NOT NULL DEFAULT '',
    barcode TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    hsn TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT 'pcs',
    purchase_price INTEGER NOT NULL DEFAULT 0,
    selling_price INTEGER NOT NULL DEFAULT 0,
    tax_rate REAL NOT NULL DEFAULT 0,
    quantity REAL NOT NULL DEFAULT 0,
    low_stock_threshold REAL NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX ix_products_business ON products(business_id, archived, name);
  CREATE UNIQUE INDEX ux_products_sku ON products(business_id, sku COLLATE NOCASE) WHERE sku <> '';
  CREATE UNIQUE INDEX ux_products_barcode ON products(business_id, barcode COLLATE NOCASE) WHERE barcode <> '';

  CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    gstin TEXT NOT NULL DEFAULT '',
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX ix_customers_business ON customers(business_id, name);

  CREATE TABLE bills (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    invoice_no TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized', 'cancelled')),
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    customer_name TEXT NOT NULL DEFAULT '',
    customer_phone TEXT NOT NULL DEFAULT '',
    customer_email TEXT NOT NULL DEFAULT '',
    customer_address TEXT NOT NULL DEFAULT '',
    customer_gstin TEXT NOT NULL DEFAULT '',
    bill_date TEXT NOT NULL,
    due_date TEXT,
    notes TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'INR',
    tax_label TEXT NOT NULL DEFAULT 'GST',
    split_tax INTEGER NOT NULL DEFAULT 1,
    prices_include_tax INTEGER NOT NULL DEFAULT 0,
    round_off_enabled INTEGER NOT NULL DEFAULT 1,
    subtotal INTEGER NOT NULL DEFAULT 0,
    discount_total INTEGER NOT NULL DEFAULT 0,
    taxable_total INTEGER NOT NULL DEFAULT 0,
    tax_total INTEGER NOT NULL DEFAULT 0,
    round_off INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    amount_paid INTEGER NOT NULL DEFAULT 0,
    payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'partial', 'paid')),
    stock_applied INTEGER NOT NULL DEFAULT 0,
    share_token TEXT UNIQUE,
    share_created_at TEXT,
    cancel_reason TEXT NOT NULL DEFAULT '',
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    finalized_at TEXT,
    cancelled_at TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE UNIQUE INDEX ux_bills_invoice_no ON bills(business_id, invoice_no) WHERE invoice_no IS NOT NULL;
  CREATE INDEX ix_bills_business_date ON bills(business_id, bill_date);
  CREATE INDEX ix_bills_customer ON bills(customer_id);

  CREATE TABLE bill_items (
    id INTEGER PRIMARY KEY,
    bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    sku TEXT NOT NULL DEFAULT '',
    hsn TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT '',
    quantity REAL NOT NULL,
    unit_price INTEGER NOT NULL,
    discount_pct REAL NOT NULL DEFAULT 0,
    tax_rate REAL NOT NULL DEFAULT 0,
    gross INTEGER NOT NULL DEFAULT 0,
    discount INTEGER NOT NULL DEFAULT 0,
    taxable INTEGER NOT NULL DEFAULT 0,
    tax INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX ix_bill_items_bill ON bill_items(bill_id);
  CREATE INDEX ix_bill_items_product ON bill_items(product_id);

  CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL CHECK (method IN ('cash', 'upi', 'card', 'bank_transfer')),
    reference TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    paid_on TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX ix_payments_bill ON payments(bill_id);
  CREATE INDEX ix_payments_business_date ON payments(business_id, paid_on);

  CREATE TABLE stock_movements (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('opening', 'purchase', 'adjustment', 'sale', 'sale_cancel')),
    quantity REAL NOT NULL,
    balance_after REAL NOT NULL,
    unit_cost INTEGER,
    bill_id INTEGER REFERENCES bills(id) ON DELETE SET NULL,
    note TEXT NOT NULL DEFAULT '',
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX ix_movements_product ON stock_movements(product_id, id);
  CREATE INDEX ix_movements_business ON stock_movements(business_id, created_at);
  -- A bill can deduct (and restore) stock for a product only once.
  CREATE UNIQUE INDEX ux_movements_sale_once ON stock_movements(bill_id, product_id, type)
    WHERE type IN ('sale', 'sale_cancel') AND bill_id IS NOT NULL;
  `,
  // v2 — services (shoots, editing, design work) are billable items without stock.
  `
  ALTER TABLE products ADD COLUMN kind TEXT NOT NULL DEFAULT 'goods' CHECK (kind IN ('goods', 'service'));
  `,
  // v3 — simpler bills: GST on/off per bill, no due dates, payments are just cash or online.
  `
  ALTER TABLE bills ADD COLUMN with_gst INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE businesses ADD COLUMN default_with_gst INTEGER NOT NULL DEFAULT 1;
  UPDATE bills SET due_date = NULL;

  CREATE TABLE payments_v3 (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL CHECK (method IN ('cash', 'online')),
    reference TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    paid_on TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  -- Older UPI / card / bank payments become "online", keeping the channel in the reference.
  INSERT INTO payments_v3 (id, business_id, bill_id, amount, method, reference, note, paid_on, created_by, created_at)
    SELECT id, business_id, bill_id, amount,
           CASE WHEN method = 'cash' THEN 'cash' ELSE 'online' END,
           CASE WHEN method = 'cash' THEN reference
                ELSE (CASE method WHEN 'upi' THEN 'UPI' WHEN 'card' THEN 'Card' ELSE 'Bank transfer' END)
                     || CASE WHEN reference <> '' THEN ' · ' || reference ELSE '' END
           END,
           note, paid_on, created_by, created_at
      FROM payments;
  DROP TABLE payments;
  ALTER TABLE payments_v3 RENAME TO payments;
  CREATE INDEX ix_payments_bill ON payments(bill_id);
  CREATE INDEX ix_payments_business_date ON payments(business_id, paid_on);
  `,
  // v4 — work tracking per job: Design -> Review -> Print -> Frame -> Final, with a history.
  `
  ALTER TABLE bills ADD COLUMN work_stage TEXT CHECK (work_stage IN ('design', 'review', 'print', 'frame', 'final'));
  ALTER TABLE bills ADD COLUMN work_updated_at TEXT;
  CREATE INDEX ix_bills_work_stage ON bills(business_id, work_stage);
  CREATE TABLE bill_stages (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX ix_bill_stages_bill ON bill_stages(bill_id, id);
  `,
  // v5 — bill design: a tagline under the name, an accent colour and a dark or light header.
  `
  ALTER TABLE businesses ADD COLUMN tagline TEXT NOT NULL DEFAULT '';
  ALTER TABLE businesses ADD COLUMN bill_color TEXT NOT NULL DEFAULT '#f26b1d';
  ALTER TABLE businesses ADD COLUMN bill_header TEXT NOT NULL DEFAULT 'dark' CHECK (bill_header IN ('dark', 'light'));
  `,
  // v6 — expenses: where money was paid out each day (lab prints, frames, rent, salary, tea...).
  `
  CREATE TABLE expenses (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    spent_on TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Other',
    paid_to TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'online')),
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX ix_expenses_day ON expenses(business_id, spent_on);
  `,
  // v7 — no GST: one discount % for the whole bill, and a UPI ID so customers can pay the balance from the bill link.
  `
  ALTER TABLE bills ADD COLUMN discount_pct REAL NOT NULL DEFAULT 0;
  ALTER TABLE businesses ADD COLUMN upi_id TEXT NOT NULL DEFAULT '';
  UPDATE businesses SET default_with_gst = 0, prices_include_tax = 0;
  `,
  // v8 — the day book: sales without a bill and money received are kept with the expenses, one list per day.
  `
  CREATE TABLE day_entries (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    entry_date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('sale', 'received', 'expense')),
    category TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'online')),
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX ix_day_entries_day ON day_entries(business_id, entry_date);
  INSERT INTO day_entries (business_id, entry_date, kind, category, details, amount, method, is_demo, created_by, created_at, updated_at)
    SELECT business_id, spent_on, 'expense', category, paid_to, amount, method, is_demo, created_by, created_at, updated_at
      FROM expenses ORDER BY id;
  DROP TABLE expenses;
  `,
  // v9 — a "Received" stage before Design, and how the customer's photo came in. SQLite can't change a
  // column's CHECK, so work_stage is moved aside, recreated with the new stage allowed, and copied back.
  `
  ALTER TABLE bills ADD COLUMN work_stage_v8 TEXT;
  UPDATE bills SET work_stage_v8 = work_stage;
  DROP INDEX ix_bills_work_stage;
  ALTER TABLE bills DROP COLUMN work_stage;
  ALTER TABLE bills ADD COLUMN work_stage TEXT CHECK (work_stage IN ('received', 'design', 'review', 'print', 'frame', 'final'));
  UPDATE bills SET work_stage = work_stage_v8;
  ALTER TABLE bills DROP COLUMN work_stage_v8;
  CREATE INDEX ix_bills_work_stage ON bills(business_id, work_stage);
  ALTER TABLE bills ADD COLUMN photo_source TEXT NOT NULL DEFAULT '' CHECK (photo_source IN ('', 'whatsapp', 'photo', 'studio', 'other'));
  `,
  // v10 — when a customer pays a little less, the rest can be let go: a discount at payment that lowers the total.
  `
  ALTER TABLE bills ADD COLUMN settle_discount INTEGER NOT NULL DEFAULT 0;
  `,
  // v11 — Bookings & Shoots: photo / video bookings from the first call to the final delivery, with the team on
  // each shoot, payments and an activity log. Small per-booking records (services, checklist, post-production
  // steps, deadlines, delivery, links) are JSON text.
  `
  ALTER TABLE businesses ADD COLUMN next_booking_no INTEGER NOT NULL DEFAULT 1;

  CREATE TABLE team_members (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX ix_team_members_business ON team_members(business_id, active, name);

  CREATE TABLE bookings (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    booking_no INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
      'new', 'confirmed', 'scheduled', 'shot', 'editing', 'review', 'ready', 'delivered', 'closed', 'on_hold', 'cancelled')),
    prev_status TEXT,
    cancel_reason TEXT NOT NULL DEFAULT '',
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    client_name TEXT NOT NULL,
    client_phone TEXT NOT NULL DEFAULT '',
    client_whatsapp TEXT NOT NULL DEFAULT '',
    client_email TEXT NOT NULL DEFAULT '',
    client_alt TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL DEFAULT '',
    event_name TEXT NOT NULL DEFAULT '',
    event_date TEXT NOT NULL,
    start_time TEXT NOT NULL DEFAULT '',
    end_time TEXT NOT NULL DEFAULT '',
    days INTEGER NOT NULL DEFAULT 1,
    venue TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    maps_link TEXT NOT NULL DEFAULT '',
    event_notes TEXT NOT NULL DEFAULT '',
    services TEXT NOT NULL DEFAULT '[]',
    package_name TEXT NOT NULL DEFAULT '',
    total INTEGER NOT NULL DEFAULT 0,
    amount_paid INTEGER NOT NULL DEFAULT 0,
    payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'partial', 'paid')),
    checklist TEXT NOT NULL DEFAULT '{}',
    tasks TEXT NOT NULL DEFAULT '{}',
    deadlines TEXT NOT NULL DEFAULT '{}',
    delivery TEXT NOT NULL DEFAULT '{}',
    links TEXT NOT NULL DEFAULT '[]',
    internal_notes TEXT NOT NULL DEFAULT '',
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE UNIQUE INDEX ux_bookings_no ON bookings(business_id, booking_no);
  CREATE INDEX ix_bookings_date ON bookings(business_id, event_date);

  CREATE TABLE booking_team (
    id INTEGER PRIMARY KEY,
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX ix_booking_team_booking ON booking_team(booking_id);
  CREATE INDEX ix_booking_team_member ON booking_team(member_id);

  CREATE TABLE booking_payments (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL CHECK (method IN ('cash', 'upi', 'bank', 'card', 'other')),
    note TEXT NOT NULL DEFAULT '',
    paid_on TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX ix_booking_payments_booking ON booking_payments(booking_id);
  CREATE INDEX ix_booking_payments_day ON booking_payments(business_id, paid_on);

  CREATE TABLE booking_activity (
    id INTEGER PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX ix_booking_activity_booking ON booking_activity(booking_id, id);
  `,
  // v12 — a booking's dates can differ, each with its own times and venue (schedule, JSON); the address is the
  // client's; services carry prices (JSON lines) and the total is their sum less a discount. Older bookings are read
  // as before (one date, a number of days, one time and venue) until they're saved again.
  `
  ALTER TABLE bookings RENAME COLUMN address TO client_address;
  ALTER TABLE bookings ADD COLUMN schedule TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE bookings ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;
  `,
  // v13 — each login's own choices (JSON), for now how the dashboard is laid out (see shared/dashboard.js).
  `
  ALTER TABLE users ADD COLUMN preferences TEXT NOT NULL DEFAULT '{}';
  `,
  // v14 — photos of a job (bill): the customer's photo, so it's clear later which one the job is for. The browser makes
  // each one smaller before sending it, with a small copy for lists. AUTOINCREMENT so an id is never used twice: a
  // photo is cached by its id. A bill's photos go with it.
  `
  CREATE TABLE bill_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    thumb_mime TEXT NOT NULL,
    thumb BLOB NOT NULL,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX ix_bill_photos_bill ON bill_photos(bill_id, id);
  `,
  // v15 — team logins: besides the owner, a business can give its team logins that only see the jobs in Tracking
  // (bill number, name, the mobile's last 4 digits, photos, items, the stage and what's due), view only.
  `
  ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'team'));
  `,
  // v16 — the business's website, shown with its phone, email and address in the bill's footer.
  `
  ALTER TABLE businesses ADD COLUMN website TEXT NOT NULL DEFAULT '';
  `,
];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new DatabaseSync(file);
  statements.clear();
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate();
  return db;
}

export function closeDb() {
  if (db) db.close();
  db = null;
  statements.clear();
}

function migrate() {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function prepare(sql) {
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    statements.set(sql, stmt);
  }
  return stmt;
}

function bind(params) {
  return params.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });
}

export function get(sql, ...params) {
  return prepare(sql).get(...bind(params));
}

export function all(sql, ...params) {
  return prepare(sql).all(...bind(params));
}

export function run(sql, ...params) {
  return prepare(sql).run(...bind(params));
}

/** Run fn inside a write transaction. Nested calls join the outer transaction. fn must be synchronous. */
export function tx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth--;
  }
}

export function nowIso() {
  return new Date().toISOString();
}
