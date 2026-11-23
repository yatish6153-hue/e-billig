// Sending email (backups: services/backup-email.js) through a mailbox set up on the server, in .env:
//   SMTP_HOST  smtp.gmail.com (Gmail, with an App password) or smtp.hostinger.com (a Hostinger mailbox)
//   SMTP_PORT  465 (SSL, the default) or 587
//   SMTP_USER  the mailbox's address
//   SMTP_PASS  its password (for Gmail, an App password: Google Account → Security → App passwords)
//   MAIL_FROM  optional, e.g. "Devesh Studio eBilling <yourname@gmail.com>" (else SMTP_USER)
import nodemailer from 'nodemailer';
import { HttpError } from '../util.js';

let transport = null;
let transportKey = '';
let testTransport = null;

/** The mailbox from .env, or null while it isn't set up. */
export function mailConfig() {
  const host = (process.env.SMTP_HOST || '').trim();
  const user = (process.env.SMTP_USER || '').trim();
  const pass = process.env.SMTP_PASS || '';
  if (!host || !user || !pass) return null;
  const port = Number(process.env.SMTP_PORT) || 465;
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465;
  return { host, port, secure, user, pass, from: (process.env.MAIL_FROM || '').trim() || user };
}

/** Whether the server can send email. */
export const mailReady = () => !!(testTransport || mailConfig());

/** The address emails come from (shown in Settings). */
export const mailFrom = () => (testTransport ? 'backups@test.example' : mailConfig()?.from || '');

export const mailNotSetUp = () => new HttpError(503,
  'Email isn’t set up on the server yet: add the email account (SMTP_HOST, SMTP_USER, SMTP_PASS) to the .env file and restart eBilling.',
  { code: 'MAIL_NOT_SET_UP' });

/** Send one email ({ to, subject, text, attachments }), from MAIL_FROM. */
export async function sendMail(message) {
  let t = testTransport;
  if (!t) {
    const c = mailConfig();
    if (!c) throw mailNotSetUp();
    const key = JSON.stringify([c.host, c.port, c.secure, c.user, c.pass]);
    if (!transport || key !== transportKey) {
      transport = nodemailer.createTransport({
        host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.pass },
        connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 120_000,
      });
      transportKey = key;
    }
    t = transport;
  }
  return t.sendMail({ from: mailFrom(), ...message });
}

/** What a failed send means, in plain words. */
export function mailError(err) {
  if (err instanceof HttpError) return err.message;
  if (err?.code === 'EAUTH') {
    return 'The email account’s login was refused. Check SMTP_USER and SMTP_PASS in .env (for Gmail, use an App password, not the normal one).';
  }
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED'].includes(err?.code)) {
    return 'The email server couldn’t be reached. Check SMTP_HOST and SMTP_PORT in .env, and the internet connection.';
  }
  return `The email couldn’t be sent: ${String(err?.message || err).slice(0, 200)}`;
}

/** Tests: send through this ({ sendMail(message) }) instead of the real mailbox; null goes back. */
export function setMailTransport(t) {
  testTransport = t;
}
