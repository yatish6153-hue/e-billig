// Settings → Backup & restore (services/backup.js). The owner's only: mounted with ownerOnly.
import express from 'express';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createBackup, stageBackup, restoreBackup } from '../services/backup.js';
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

export default router;
