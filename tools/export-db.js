// Makes one self-contained copy of the database, ready to upload to the live server:
//   npm run export-db          reads DB_PATH (default data/ebilling.db), writes data/ebilling-upload.db
//   npm run export-db -- x.db  writes x.db instead
// It only reads the database (a consistent snapshot, so the app may keep running) and never changes it.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifyPassword } from '../server/auth.js';
import { DEMO_ACCOUNT } from '../server/seed.js';

const source = process.env.DB_PATH || 'data/ebilling.db';
const target = path.resolve(process.argv[2] || path.join(path.dirname(source), 'ebilling-upload.db'));

if (!fs.existsSync(source)) {
  console.error(`No database found at ${source}`);
  process.exit(1);
}
if (path.resolve(source) === target) {
  console.error('The copy must go to a different file than the database itself.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.rmSync(target, { force: true });
const db = new DatabaseSync(source);
db.exec('PRAGMA busy_timeout = 5000');
db.prepare('VACUUM INTO ?').run(target);

const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM businesses) AS businesses, (SELECT COUNT(*) FROM users) AS logins,
  (SELECT COUNT(*) FROM bills) AS bills, (SELECT COUNT(*) FROM customers) AS customers`).get();
const demo = db.prepare('SELECT password_hash FROM users WHERE email = ?').get(DEMO_ACCOUNT.email);
db.close();

// The copy is one file (no -wal/-shm beside it), so it can be uploaded on its own.
const copy = new DatabaseSync(target);
copy.exec('PRAGMA journal_mode = DELETE');
copy.close();

console.log(`Saved ${target}`);
console.log(`  ${counts.businesses} businesses, ${counts.logins} logins, ${counts.bills} bills, ${counts.customers} customers`);
if (demo && (await verifyPassword(DEMO_ACCOUNT.password, demo.password_hash))) {
  console.log(`\nWARNING: the login ${DEMO_ACCOUNT.email} still has the public demo password.`);
  console.log('Online it will not open. Sign in here, change it in Settings → Account, then run this again.');
}
