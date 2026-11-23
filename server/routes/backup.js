// Settings → Backup & restore (services/backup.js). The owner's only: mounted with ownerOnly.
import express from 'express';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createBackup, stageBackup, restoreBackup } from '../services/backup.js';
import { backupEmailSettings, saveBackupEmailSettings, sendBackupNow } from '../services/backup-email.js';
import { mePayload } from './auth.js';

const router = express.Router();

/** The backup file, to download. */
router.get('/', async (req, res) => {
  const { file, filename } = createBackup(req.businessId);
  try {
    res.setHeader('Content-Type', 'application/vnd.sqlite3');
    res.setHeader('Content-Length', fs.statSync(file).size);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await pipeline(fs.createReadStream(file), res);
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
});

/** Step 1 of restoring: upload the file (the raw bytes as the body) and see what's in it. */
router.post('/check', async (req, res) => {
  res.json(await stageBackup(req.businessId, req));
});

/** Step 2: replace everything with the checked backup. */
router.post('/restore', (req, res) => {
  const restored = restoreBackup(req.businessId, (req.body || {}).upload);
  res.json({ ...mePayload(req.user.id), restored });
});

// Backups by email (services/backup-email.js): where to, every day or not, and "Send backup now".
router.get('/email', (req, res) => {
  res.json(backupEmailSettings(req.businessId));
});

router.put('/email', (req, res) => {
  saveBackupEmailSettings(req.businessId, req.body || {});
  res.json(backupEmailSettings(req.businessId));
});

router.post('/email/send', async (req, res) => {
  const sent = await sendBackupNow(req.businessId);
  res.json({ ...backupEmailSettings(req.businessId), sent });
});

export default router;
