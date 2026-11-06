// The day book: what the bills don't cover — sales without a bill, money that came in, and expenses —
// plus each day's closing, which adds the bills (sales), their payments and booking payments (money received).
import express from 'express';
import { get, all, run, nowIso } from '../db.js';
import * as v from '../util.js';
import { addDays, DAY_ENTRY_KINDS } from '../../shared/format.js';
import { bookingNumber } from '../../shared/bookings.js';

const router = express.Router();

function readEntry(body) {
  const kind = v.oneOf(body.kind, Object.keys(DAY_ENTRY_KINDS), 'kind', 'Entry');
  return {
    entry_date: v.date(body.entry_date, 'entry_date', 'Date'),
    kind,
    // Only expenses have a type (rent, salary, lab prints...).
    category: kind === 'expense' ? v.text(body.category, 'category', 'Type', { max: 40 }) || 'Other' : '',
    details: v.text(body.details, 'details', 'Details', { max: 120 }),
    amount: v.money(body.amount, 'amount', 'Amount', { min: 1 }),
    method: v.oneOf(body.method || 'cash', ['cash', 'online'], 'method', 'Cash or online'),
  };
}

const serializeEntry = (x) => ({ ...x, is_demo: !!x.is_demo });

function ownedEntry(req) {
  const id = v.id(req.params.id, 'Entry');
  const x = get('SELECT * FROM day_entries WHERE id = ? AND business_id = ?', id, req.businessId);
  if (!x) throw v.notFound('Entry');
  return x;
}

function dayRange(query) {
  const from = v.optionalDate(query.from);
  const to = v.optionalDate(query.to);
  if (!from || !to) throw v.badRequest('Choose the days to show.', 'from');
  if (from > to) throw v.badRequest('The start date must be before the end date.', 'from');
  return { from, to };
}

/** Entries between two dates (newest first), and the bill and booking payments received on those days. */
router.get('/', (req, res) => {
  const { from, to } = dayRange(req.query);
  const entries = all(
    `SELECT * FROM day_entries WHERE business_id = ? AND entry_date BETWEEN ? AND ?
      ORDER BY entry_date DESC, id DESC LIMIT 1000`,
    req.businessId, from, to,
  );
  const payments = all(
    `SELECT p.id, p.paid_on, p.amount, p.method, p.reference, b.id AS bill_id, b.invoice_no, b.customer_name, b.is_demo
       FROM payments p JOIN bills b ON b.id = p.bill_id
      WHERE p.business_id = ? AND b.status = 'finalized' AND p.paid_on BETWEEN ? AND ?
      ORDER BY p.paid_on DESC, p.id DESC LIMIT 1000`,
    req.businessId, from, to,
  );
  const bookingPayments = all(
    `SELECT p.id, p.paid_on, p.amount, p.method, p.note, k.id AS booking_id, k.booking_no, k.client_name, k.event_type, k.event_name, k.is_demo
       FROM booking_payments p JOIN bookings k ON k.id = p.booking_id
      WHERE p.business_id = ? AND p.paid_on BETWEEN ? AND ?
      ORDER BY p.paid_on DESC, p.id DESC LIMIT 1000`,
    req.businessId, from, to,
  );
  res.json({
    entries: entries.map(serializeEntry),
    payments: payments.map((p) => ({ ...p, is_demo: !!p.is_demo })),
    booking_payments: bookingPayments.map((p) => ({ ...p, number: bookingNumber(p.booking_no), is_demo: !!p.is_demo })),
  });
});

/**
 * The closing for every day in the range, newest first. sales = bills created + sales added here
 * (sales_added); money received = bill payments + booking payments + sales added + money received added here;
 * spent = expenses.
 */
router.get('/days', (req, res) => {
  const { from, to } = dayRange(req.query);
  const biz = req.businessId;
  const days = new Map();
  for (let d = to; d >= from && days.size < 400; d = addDays(d, -1)) {
    days.set(d, {
      date: d, bills: 0, sales: 0, sales_added: 0, received_cash: 0, received_online: 0, spent_cash: 0, spent_online: 0,
    });
  }
  for (const r of all(
    `SELECT bill_date AS day, COUNT(*) AS bills, SUM(total) AS sales FROM bills
      WHERE business_id = ? AND status = 'finalized' AND bill_date BETWEEN ? AND ? GROUP BY bill_date`,
    biz, from, to,
  )) {
    const day = days.get(r.day);
    if (day) Object.assign(day, { bills: r.bills, sales: r.sales });
  }
  for (const r of all(
    `SELECT p.paid_on AS day, p.method, SUM(p.amount) AS amount FROM payments p JOIN bills b ON b.id = p.bill_id
      WHERE p.business_id = ? AND b.status = 'finalized' AND p.paid_on BETWEEN ? AND ? GROUP BY p.paid_on, p.method`,
    biz, from, to,
  )) {
    const day = days.get(r.day);
    if (day) day[`received_${r.method}`] += r.amount;
  }
  // Booking payments: cash is cash; UPI, bank transfer, card and other count as online.
  for (const r of all(
    `SELECT paid_on AS day, method, SUM(amount) AS amount FROM booking_payments
      WHERE business_id = ? AND paid_on BETWEEN ? AND ? GROUP BY paid_on, method`,
    biz, from, to,
  )) {
    const day = days.get(r.day);
    if (day) day[r.method === 'cash' ? 'received_cash' : 'received_online'] += r.amount;
  }
  for (const r of all(
    `SELECT entry_date AS day, kind, method, SUM(amount) AS amount FROM day_entries
      WHERE business_id = ? AND entry_date BETWEEN ? AND ? GROUP BY entry_date, kind, method`,
    biz, from, to,
  )) {
    const day = days.get(r.day);
    if (!day) continue;
    if (r.kind === 'expense') {
      day[`spent_${r.method}`] += r.amount;
    } else {
      day[`received_${r.method}`] += r.amount;
      if (r.kind === 'sale') {
        day.sales += r.amount;
        day.sales_added += r.amount;
      }
    }
  }
  res.json({ days: [...days.values()] });
});

router.post('/', (req, res) => {
  const d = readEntry(req.body || {});
  const r = run(
    `INSERT INTO day_entries (business_id, entry_date, kind, category, details, amount, method, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    req.businessId, d.entry_date, d.kind, d.category, d.details, d.amount, d.method, req.user.id,
  );
  res.status(201).json({ entry: serializeEntry(get('SELECT * FROM day_entries WHERE id = ?', Number(r.lastInsertRowid))) });
});

router.put('/:id', (req, res) => {
  const x = ownedEntry(req);
  const d = readEntry(req.body || {});
  run(
    'UPDATE day_entries SET entry_date = ?, kind = ?, category = ?, details = ?, amount = ?, method = ?, updated_at = ? WHERE id = ?',
    d.entry_date, d.kind, d.category, d.details, d.amount, d.method, nowIso(), x.id,
  );
  res.json({ entry: serializeEntry(get('SELECT * FROM day_entries WHERE id = ?', x.id)) });
});

router.delete('/:id', (req, res) => {
  const x = ownedEntry(req);
  run('DELETE FROM day_entries WHERE id = ?', x.id);
  res.json({ ok: true });
});

export default router;
