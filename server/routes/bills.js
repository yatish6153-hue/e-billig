import express from 'express';
import { get, all, run, nowIso } from '../db.js';
import * as v from '../util.js';
import {
  saveDraft, finalizeBill, cancelBill, deleteDraft, duplicateBill, addPayment, deletePayment,
  enableShare, revokeShare, loadInvoice, getLogo, serializeBill, readPhotoSource,
} from '../services/billing.js';
import { renderInvoicePdf, pdfFilename } from '../services/pdf.js';
import { setStage, stageHistory } from '../services/tracking.js';
import { listPhotos, addPhoto, deletePhoto, photoFile, sendPhoto } from '../services/photos.js';
import { shareUrl } from '../public-url.js';
import { isoDate } from '../../shared/format.js';
import { STAGE_KEYS } from '../../shared/tracking.js';

const router = express.Router();

function ownedBill(req) {
  const id = v.id(req.params.id, 'Bill');
  const bill = get('SELECT * FROM bills WHERE id = ? AND business_id = ?', id, req.businessId);
  if (!bill) throw v.notFound('Bill');
  return bill;
}

function billDetail(req, billId) {
  const bill = get('SELECT * FROM bills WHERE id = ? AND business_id = ?', billId, req.businessId);
  if (!bill) throw v.notFound('Bill');
  const data = loadInvoice(bill);
  data.items = data.items.map((item) => {
    if (!item.product_id) return { ...item, available: null, is_service: false };
    const p = get('SELECT quantity, kind FROM products WHERE id = ?', item.product_id);
    const isService = p?.kind === 'service';
    return { ...item, available: p && !isService ? p.quantity : null, is_service: isService };
  });
  const customer = bill.customer_id ? get('SELECT is_demo FROM customers WHERE id = ?', bill.customer_id) : null;
  data.customer_is_demo = !!customer?.is_demo;
  data.stage_history = stageHistory(bill.id);
  data.photos = listPhotos(req.businessId, bill.id);
  data.share_url = bill.share_token ? shareUrl(req, bill.share_token) : null;
  delete data.bill.share_token;
  return data;
}

router.get('/', (req, res) => {
  const { limit, offset } = v.paging(req.query, { defaultLimit: 25 });
  const where = ['business_id = ?'];
  const params = [req.businessId];
  const status = req.query.status;
  if (['draft', 'finalized', 'cancelled'].includes(status)) {
    where.push('status = ?');
    params.push(status);
  }
  const payment = req.query.payment;
  if (['unpaid', 'partial', 'paid'].includes(payment)) {
    where.push("status = 'finalized' AND payment_status = ?");
    params.push(payment);
  } else if (payment === 'due') {
    where.push("status = 'finalized' AND payment_status <> 'paid'");
  }
  const q = String(req.query.q || '').trim();
  if (q) {
    // Mobile numbers match on their last 10 digits, so "+91 98290 12345" finds "98290 12345".
    where.push(`(invoice_no LIKE ? ESCAPE '\\' OR customer_name LIKE ? ESCAPE '\\' OR ${v.PHONE_DIGITS_SQL('customer_phone')} LIKE ?)`);
    const p = v.likePattern(q);
    params.push(p, p, v.digitsPattern(q.replace(/\D/g, '').slice(-10)));
  }
  const from = v.optionalDate(req.query.from);
  const to = v.optionalDate(req.query.to);
  if (from) { where.push('bill_date >= ?'); params.push(from); }
  if (to) { where.push('bill_date <= ?'); params.push(to); }
  if (req.query.customer_id) {
    where.push('customer_id = ?');
    params.push(v.id(req.query.customer_id, 'Customer'));
  }
  if (v.bool(req.query.untracked)) where.push("status = 'finalized' AND work_stage IS NULL");
  const whereSql = where.join(' AND ');
  const rows = all(
    `SELECT id, invoice_no, status, payment_status, bill_date, customer_id, customer_name, customer_phone,
            with_gst, total, amount_paid, work_stage, is_demo, created_at,
            (SELECT COUNT(*) FROM bill_items i WHERE i.bill_id = bills.id) AS items_count
       FROM bills WHERE ${whereSql}
      ORDER BY bill_date DESC, id DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  );
  const summary = get(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN status = 'finalized' THEN total END), 0) AS total,
            COALESCE(SUM(CASE WHEN status = 'finalized' THEN total - amount_paid END), 0) AS outstanding
       FROM bills WHERE ${whereSql}`,
    ...params,
  );
  res.json({ bills: rows.map(serializeBill), total: summary.count, summary, limit, offset });
});

router.post('/', (req, res) => {
  const id = saveDraft(req.businessId, req.user.id, null, req.body || {});
  res.status(201).json(billDetail(req, id));
});

router.get('/:id', (req, res) => {
  res.json(billDetail(req, ownedBill(req).id));
});

router.put('/:id', (req, res) => {
  const bill = ownedBill(req);
  saveDraft(req.businessId, req.user.id, bill.id, req.body || {});
  res.json(billDetail(req, bill.id));
});

router.delete('/:id', (req, res) => {
  deleteDraft(req.businessId, ownedBill(req).id);
  res.json({ ok: true });
});

router.post('/:id/finalize', (req, res) => {
  const bill = ownedBill(req);
  const b = req.body || {};
  const result = finalizeBill(req.businessId, req.user.id, bill.id, {
    allowInsufficient: v.bool(b.allow_insufficient),
    payment: b.payment && typeof b.payment === 'object' ? b.payment : null,
  });
  // "Track this job" starts the work at the first stage.
  if (v.bool(b.track)) setStage(req.businessId, req.user.id, bill.id, STAGE_KEYS[0]);
  res.json({ ...billDetail(req, bill.id), negative_stock: result.shortages });
});

router.put('/:id/stage', (req, res) => {
  const bill = ownedBill(req);
  const b = req.body || {};
  setStage(req.businessId, req.user.id, bill.id, b.stage ?? null, { note: b.note });
  res.json(billDetail(req, bill.id));
});

/** How the photo came in can be set or corrected after the bill is created. */
router.put('/:id/photo-source', (req, res) => {
  const bill = ownedBill(req);
  if (bill.status === 'cancelled') throw v.conflict('This bill is cancelled.');
  run('UPDATE bills SET photo_source = ?, updated_at = ? WHERE id = ?', readPhotoSource((req.body || {}).photo_source), nowIso(), bill.id);
  res.json(billDetail(req, bill.id));
});

// The customer's photos for the job, so it's clear later which photo it was (see services/photos.js).
router.get('/:id/photos', (req, res) => {
  res.json({ photos: listPhotos(req.businessId, ownedBill(req).id) });
});

router.post('/:id/photos', (req, res) => {
  const bill = ownedBill(req);
  addPhoto(req.businessId, req.user.id, bill.id, req.body || {});
  res.status(201).json({ photos: listPhotos(req.businessId, bill.id) });
});

router.delete('/:id/photos/:photoId', (req, res) => {
  const bill = ownedBill(req);
  deletePhoto(req.businessId, bill.id, v.id(req.params.photoId, 'Photo'));
  res.json({ photos: listPhotos(req.businessId, bill.id) });
});

const photoRoute = (thumb) => (req, res) => {
  const bill = ownedBill(req);
  const photoId = v.id(req.params.photoId, 'Photo');
  const photo = photoFile(req.businessId, bill.id, photoId, { thumb });
  if (v.bool(req.query.download)) {
    const name = `${(bill.invoice_no || `draft-${bill.id}`).replace(/[^A-Za-z0-9_-]+/g, '-')}-photo-${photoId}`;
    res.setHeader('Content-Disposition', `attachment; filename="${name}.${photo.mime.split('/')[1].replace('jpeg', 'jpg')}"`);
  }
  sendPhoto(res, photo);
};
router.get('/:id/photos/:photoId', photoRoute(false));
router.get('/:id/photos/:photoId/thumb', photoRoute(true));

router.post('/:id/cancel', (req, res) => {
  const bill = ownedBill(req);
  const result = cancelBill(req.businessId, req.user.id, bill.id, { reason: (req.body || {}).reason });
  res.json({ ...billDetail(req, bill.id), restored_products: result.restored });
});

router.post('/:id/duplicate', (req, res) => {
  const bill = ownedBill(req);
  const billDate = v.date((req.body || {}).bill_date || isoDate(), 'bill_date', 'Bill date');
  const id = duplicateBill(req.businessId, req.user.id, bill.id, billDate);
  res.status(201).json(billDetail(req, id));
});

router.post('/:id/payments', (req, res) => {
  const bill = ownedBill(req);
  addPayment(req.businessId, req.user.id, bill.id, req.body || {});
  res.status(201).json(billDetail(req, bill.id));
});

router.delete('/:id/payments/:paymentId', (req, res) => {
  const bill = ownedBill(req);
  deletePayment(req.businessId, bill.id, v.id(req.params.paymentId, 'Payment'));
  res.json(billDetail(req, bill.id));
});

router.post('/:id/share', (req, res) => {
  const bill = ownedBill(req);
  const token = enableShare(req.businessId, bill.id, { regenerate: v.bool((req.body || {}).regenerate) });
  res.json({ share_url: shareUrl(req, token) });
});

router.delete('/:id/share', (req, res) => {
  revokeShare(req.businessId, ownedBill(req).id);
  res.json({ share_url: null });
});

router.get('/:id/pdf', (req, res) => {
  const bill = ownedBill(req);
  const data = loadInvoice(bill);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${pdfFilename(bill)}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  renderInvoicePdf(data, getLogo(req.businessId)).pipe(res);
});

export default router;
