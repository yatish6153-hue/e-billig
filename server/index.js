import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { ensureDemoAccount, demoAccountEnabled, DEMO_ACCOUNT } from './seed.js';

// A port number, or the socket path some hosts hand over in PORT.
const PORT = process.env.PORT || 3000;
// "~/…" means the home folder, so a host's database can sit outside the app folder that each deploy replaces.
const DB_PATH = expandHome(process.env.DB_PATH || 'data/ebilling.db');

function expandHome(file) {
  return file === '~' || file.startsWith('~/') ? path.join(os.homedir(), file.slice(1)) : file;
}

openDb(DB_PATH);
await ensureDemoAccount();

createApp().listen(PORT, () => {
  console.log(`eBilling is running at http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  if (demoAccountEnabled()) {
    console.log(`Demo login: ${DEMO_ACCOUNT.email} / ${DEMO_ACCOUNT.password}  (set DEMO_ACCOUNT=false to disable; off by default when NODE_ENV=production)`);
  }
});
