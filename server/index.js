import { openDb } from './db.js';
import { createApp } from './app.js';
import { ensureDemoAccount, demoAccountEnabled, DEMO_ACCOUNT } from './seed.js';

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
});
