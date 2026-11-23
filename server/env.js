// Settings from a .env file in the app folder (git-ignored; see .env.example), loaded before anything reads them:
// the email account backups are sent from (SMTP_*), PORT, DB_PATH … A value already set in the environment wins.
// Imported first by index.js.
import fs from 'node:fs';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
