// The team's view: all a team login can reach (Settings → Team login). It shows the jobs in Tracking with just what's
// needed to find one and say where it is: the bill number, the customer's name and the last 4 digits of their mobile,
// the photos, what was ordered, the stage and what is still due. No prices, totals or payments, and nothing can be
// changed from here. The search and filters are Tracking's own (routes/tracking.js#findJobs).
import express from 'express';
import { get } from '../db.js';
import * as v from '../util.js';
import { findJobs } from './tracking.js';
import { photoFile, sendPhoto } from '../services/photos.js';
import { getLogo } from '../services/billing.js';

const router = express.Router();

/** A job as the team sees it. */
function teamJob(j) {
  const digits = String(j.customer_phone || '').replace(/\D/g, '');
  const photos = `/api/view/jobs/${j.id}/photos`;
  return {
    id: j.id,
    invoice_no: j.invoice_no,
    bill_date: j.bill_date,
    customer_name: j.customer_name,
    phone_last4: digits.length >= 4 ? digits.slice(-4) : '',
    photo_source: j.photo_source,
    work_stage: j.work_stage,
    work_updated_at: j.work_updated_at,
    due: Math.max(0, j.balance),
    currency: j.currency,
    is_demo: j.is_demo,
    items: j.items,
    photos: j.photos.map((p) => ({ id: p.id, url: `${photos}/${p.id}`, thumb_url: `${photos}/${p.id}/thumb` })),
  };
}

router.get('/jobs', (req, res) => {
  const { counts, jobs } = findJobs(req.businessId, req.query, { team: true });
  res.json({ counts, jobs: jobs.map(teamJob) });
});

/** Only the photos of a job the team can see: a created bill that is being tracked. */
function trackedJob(req) {
  const bill = get(
    "SELECT id FROM bills WHERE id = ? AND business_id = ? AND status = 'finalized' AND work_stage IS NOT NULL",
    v.id(req.params.id, 'Job'), req.businessId,
  );
  if (!bill) throw v.notFound('Job');
  return bill.id;
}

const photoRoute = (thumb) => (req, res) => {
  sendPhoto(res, photoFile(req.businessId, trackedJob(req), v.id(req.params.photoId, 'Photo'), { thumb }));
};
router.get('/jobs/:id/photos/:photoId', photoRoute(false));
router.get('/jobs/:id/photos/:photoId/thumb', photoRoute(true));

// The business's logo, for the team's menu.
router.get('/logo', (req, res) => {
  const row = getLogo(req.businessId);
  if (!row?.logo_mime) throw v.notFound('Logo');
  res.setHeader('Content-Type', row.logo_mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(Buffer.from(row.logo_data));
});

export default router;
