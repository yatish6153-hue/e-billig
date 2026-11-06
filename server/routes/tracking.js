import express from 'express';
import { all } from '../db.js';
import * as v from '../util.js';
import { serializeBill } from '../services/billing.js';
import { photosByBill } from '../services/photos.js';
import { STAGE_KEYS } from '../../shared/tracking.js';

const router = express.Router();

/**
 * Tracked jobs with what was ordered and their photos, newest bill first. stage = all (default) | open (in progress:
 * not final yet) | a stage key. Filters: from / to (bill date), phone (digits; the last 10 are enough), name and bill
 * (bill number). The counts per stage follow the same filters. The team's view (routes/view.js) uses this too, with
 * `team`: a team login sees only a mobile's last 4 digits, so its search must not reveal more (see below).
 */
export function findJobs(businessId, query, { team = false } = {}) {
  const where = ['b.business_id = ?', "b.status = 'finalized'", 'b.work_stage IS NOT NULL'];
  const params = [businessId];
  const from = v.optionalDate(query.from);
  const to = v.optionalDate(query.to);
  if (from) {
    where.push('b.bill_date >= ?');
    params.push(from);
  }
  if (to) {
    where.push('b.bill_date <= ?');
    params.push(to);
  }
  const phone = String(query.phone || '').replace(/\D/g, '').slice(-10);
  if (phone) {
    const digits = v.PHONE_DIGITS_SQL('b.customer_phone');
    if (!team) {
      where.push(`${digits} LIKE ?`);
      params.push(`%${phone}%`);
    } else if (phone.length === 10) {
      // The team: a whole number must match exactly, and anything shorter matches on its last 4 digits only, so
      // trying digits one at a time can't uncover a number.
      where.push(`substr(${digits}, -10) = ?`);
      params.push(phone);
    } else {
      where.push(`${digits} LIKE ?`);
      params.push(`%${phone.slice(-4)}`);
    }
  }
  const name = String(query.name || '').trim();
  if (name) {
    where.push("b.customer_name LIKE ? ESCAPE '\\'");
    params.push(v.likePattern(name));
  }
  const billNo = String(query.bill || '').trim();
  if (billNo) {
    // The number printed on the bill: "21", "0021", "INV-0021" and "inv 21" all find INV-0021.
    const digits = billNo.replace(/\D/g, '');
    const match = [];
    if (digits) {
      match.push('b.invoice_no LIKE ?');
      params.push(`%${digits.padStart(4, '0')}`);
    }
    if (digits !== billNo) {
      match.push("b.invoice_no LIKE ? ESCAPE '\\'");
      params.push(v.likePattern(billNo));
    }
    where.push(`(${match.join(' OR ')})`);
  }

  const counts = Object.fromEntries(STAGE_KEYS.map((k) => [k, 0]));
  for (const r of all(`SELECT b.work_stage, COUNT(*) AS n FROM bills b WHERE ${where.join(' AND ')} GROUP BY b.work_stage`, ...params)) {
    counts[r.work_stage] = r.n;
  }

  const stage = String(query.stage || 'all');
  if (stage === 'open') {
    where.push("b.work_stage <> 'final'");
  } else if (STAGE_KEYS.includes(stage)) {
    where.push('b.work_stage = ?');
    params.push(stage);
  }
  const jobs = all(
    `SELECT b.id, b.invoice_no, b.status, b.payment_status, b.bill_date, b.customer_id, b.customer_name, b.customer_phone,
            b.total, b.amount_paid, b.currency, b.work_stage, b.work_updated_at, b.photo_source, b.is_demo
       FROM bills b WHERE ${where.join(' AND ')}
      ORDER BY b.finalized_at DESC, b.id DESC
      LIMIT 300`,
    ...params,
  ).map((b) => ({ ...serializeBill(b), items: [] }));

  const byId = new Map(jobs.map((j) => [j.id, j]));
  if (jobs.length) {
    for (const it of all(
      `SELECT bill_id, name, quantity, unit FROM bill_items
        WHERE bill_id IN (SELECT value FROM json_each(?)) ORDER BY bill_id, position`,
      JSON.stringify([...byId.keys()]),
    )) byId.get(it.bill_id).items.push({ name: it.name, quantity: it.quantity, unit: it.unit });
  }
  // The customer's photos, so each job shows which photo it is for.
  const photos = photosByBill(businessId, [...byId.keys()]);
  for (const j of jobs) j.photos = photos.get(j.id);
  return { counts, jobs };
}

router.get('/', (req, res) => {
  res.json(findJobs(req.businessId, req.query));
});

export default router;
