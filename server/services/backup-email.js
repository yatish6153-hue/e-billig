// Backups by email (Settings → Backup & restore). The backup file (services/backup.js) is gzipped so it fits in an
// email and sent to the business's backup address through services/mail.js: every day from SEND_HOUR when that's
// switched on, and whenever the owner taps "Send backup now". Restoring takes the gzipped file as it is.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { get, all, run, nowIso } from '../db.js';
import * as v from '../util.js';
import { createBackup } from './backup.js';
import { sendMail, mailReady, mailFrom, mailNotSetUp, mailError } from './mail.js';
import { isoDate, addDays, formatDateTime } from '../../shared/format.js';

/** From this hour (the server's clock) the day's backup goes out. */
export const SEND_HOUR = 21;
/** A bigger file isn't attached: Gmail takes 25 MB a message, and an attachment grows by a third on the way. */
export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;
const CHECK_MINUTES = 15;
const RETRY_MINUTES = 60;
const MANUAL_GAP_SECONDS = 60;

export function backupEmailSettings(businessId) {
  const b = get('SELECT backup_email, backup_daily, backup_emailed_at, backup_email_error FROM businesses WHERE id = ?', businessId);
  return {
    email: b.backup_email,
    daily: !!b.backup_daily,
    emailed_at: b.backup_emailed_at,
    error: b.backup_email_error,
    ready: mailReady(),
    from: mailFrom(),
    send_hour: SEND_HOUR,
  };
}

export function saveBackupEmailSettings(businessId, body) {
  const email = v.email(body.email, 'email', 'Backup email');
  const daily = v.bool(body.daily);
  if (daily && !email) throw v.badRequest('Enter the email address to send the backups to.', 'email');
  // A new address starts without the old one's error.
  const before = get('SELECT backup_email, backup_email_error FROM businesses WHERE id = ?', businessId);
  const error = before.backup_email === email ? before.backup_email_error : '';
  run('UPDATE businesses SET backup_email = ?, backup_daily = ?, backup_email_error = ?, updated_at = ? WHERE id = ?',
    email, daily ? 1 : 0, error, nowIso(), businessId);
}

/**
 * Whether a business's daily backup is due: once a day from SEND_HOUR. The first one, and one for a day that was
 * missed (eBilling wasn't running that evening), go at once.
 */
export function backupEmailDue({ daily, email, emailedAt }, now = new Date()) {
  if (!daily || !email) return false;
  const today = isoDate(now);
  const last = emailedAt ? isoDate(new Date(emailedAt)) : null;
  if (last === today) return false;
  return now.getHours() >= SEND_HOUR || last === null || last < addDays(today, -1);
}

const lastManual = new Map(); // businessId -> when "Send backup now" last sent one

/** "Send backup now": at most one a minute, so the button can't flood an inbox. */
export async function sendBackupNow(businessId) {
  if (Date.now() - (lastManual.get(businessId) || 0) < MANUAL_GAP_SECONDS * 1000) {
    throw new v.HttpError(429, 'A backup was emailed a moment ago. Wait a minute before sending another.');
  }
  const sent = await emailBackup(businessId);
  lastManual.set(businessId, Date.now());
  return sent;
}

/** Make the backup and email it. Returns { to, attached, bytes }; a failure is kept to show in Settings. */
export async function emailBackup(businessId) {
  const biz = get('SELECT name, backup_email FROM businesses WHERE id = ?', businessId);
  if (!biz.backup_email) throw v.badRequest('Enter the email address to send the backups to, and save it.', 'email');
  if (!mailReady()) throw mailNotSetUp();
  const { file, filename } = createBackup(businessId);
  const packed = `${file}.gz`;
  try {
    await pipeline(fs.createReadStream(file), zlib.createGzip({ level: 9 }), fs.createWriteStream(packed));
    const bytes = fs.statSync(packed).size;
    const attached = bytes <= MAX_ATTACHMENT_BYTES;
    await sendMail(backupMessage(businessId, biz, { filename: `${filename}.gz`, path: packed, bytes, attached }));
    const note = attached ? '' : `The last backup was ${megabytes(bytes)}, too large to attach, so the email only says so. Download it here instead.`;
    run('UPDATE businesses SET backup_emailed_at = ?, backup_email_error = ? WHERE id = ?', nowIso(), note, businessId);
    return { to: biz.backup_email, attached, bytes };
  } catch (err) {
    const message = mailError(err);
    run('UPDATE businesses SET backup_email_error = ? WHERE id = ?', message, businessId);
    throw err instanceof v.HttpError ? err : new v.HttpError(502, message, { code: 'MAIL_FAILED' });
  } finally {
    fs.rm(file, { force: true }, () => {});
    fs.rm(packed, { force: true }, () => {});
  }
}

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function backupMessage(businessId, biz, { filename, path, bytes, attached }) {
  const count = (table) => get(`SELECT COUNT(*) AS n FROM ${table} WHERE business_id = ?`, businessId).n;
  const parts = [['bills', 'bill'], ['customers', 'customer'], ['bookings', 'booking'],
    ['day_entries', 'day book entry', 'day book entries'], ['bill_photos', 'photo']]
    .map(([table, one, many = `${one}s`]) => {
      const n = count(table);
      return `${n} ${n === 1 ? one : many}`;
    });
  const lines = [
    'Hello,',
    '',
    `Here is the eBilling backup of ${biz.name}, made on ${formatDateTime(nowIso())}:`,
    `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}.`,
    '',
    ...(attached
      ? ['Keep this email. To bring everything back as it was, open eBilling → Settings → Backup & restore →',
        'Restore from a backup, and choose the attached file as it is (there is no need to unzip it).']
      : [`This backup is ${megabytes(bytes)}, too large to attach to an email. Download it in eBilling → Settings →`,
        'Backup & restore → Download backup, and keep it on Google Drive or a pen drive.']),
    '',
    '— eBilling',
  ];
  return {
    to: biz.backup_email,
    subject: `eBilling backup · ${biz.name} · ${isoDate()}`,
    text: lines.join('\n'),
    attachments: attached ? [{ filename, path, contentType: 'application/gzip' }] : [],
  };
}

const lastTry = new Map(); // businessId -> when the daily backup was last tried

/** Look for daily backups that are due every 15 minutes (index.js starts this; tests don't). */
export function startBackupEmails() {
  const check = async () => {
    if (!mailReady()) return;
    const due = all("SELECT id, backup_email, backup_daily, backup_emailed_at FROM businesses WHERE backup_daily = 1 AND backup_email <> ''")
      .filter((b) => backupEmailDue({ daily: b.backup_daily, email: b.backup_email, emailedAt: b.backup_emailed_at }));
    for (const b of due) {
      // After a failure, try again an hour later, not every 15 minutes.
      if (Date.now() - (lastTry.get(b.id) || 0) < RETRY_MINUTES * 60_000) continue;
      lastTry.set(b.id, Date.now());
      try {
        const sent = await emailBackup(b.id);
        console.log(`Backup of business ${b.id} emailed to ${sent.to}${sent.attached ? '' : ' (too large to attach)'}.`);
      } catch (err) {
        console.error(`Backup email for business ${b.id} failed: ${err.message}`);
      }
    }
  };
  const tick = () => check().catch((err) => console.error('Backup emails:', err.message));
  setTimeout(tick, 60_000).unref();
  setInterval(tick, CHECK_MINUTES * 60_000).unref();
}
