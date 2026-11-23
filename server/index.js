import './env.js'; // first: settings from .env, before anything reads them
import { openDb } from './db.js';
import { createApp } from './app.js';
import { ensureDemoAccount, demoAccountEnabled, DEMO_ACCOUNT } from './seed.js';
import { startBackupEmails } from './services/backup-email.js';
import { mailReady } from './services/mail.js';

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || 'data/ebilling.db';

openDb(DB_PATH);
await ensureDemoAccount();

createApp().listen(PORT, () => {
  console.log(`eBilling is running at http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  if (demoAccountEnabled()) {
    console.log(`Demo login: ${DEMO_ACCOUNT.email} / ${DEMO_ACCOUNT.password}  (set DEMO_ACCOUNT=false to disable; off by default when NODE_ENV=production)`);
  }
  console.log(mailReady() ? 'Backup emails: on (SMTP in .env)' : 'Backup emails: off until an email account is set in .env (see .env.example)');
});
startBackupEmails();
