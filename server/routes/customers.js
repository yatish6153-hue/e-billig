import express from 'express';
import { get, all, run, nowIso } from '../db.js';
import * as v from '../util.js';
import { serializeBill } from '../services/billing.js';

const router = express.Router();

function readCustomer(body) {
  return {
    name: v.text(body.name, 'name', 'Customer name', { max: 120, required: true }),
    phone: v.phone(body.phone, 'phone', 'WhatsApp number'),
    email: v.email(body.email, 'email', 'Email'),
    address: v.text(body.address, 'address', 'Billing address', { max: 500, multiline: true }),
    gstin: v.gstin(body.gstin, 'gstin', 'Customer GSTIN'),
  };
}

const serializeCustomer = (c) => ({ ...c, is_demo: !!c.is_demo });

const AGGREGATES = `
  COALESCE(SUM(CASE WHEN b.status = 'finalized' THEN b.total END), 0) AS total_billed,
  COALESCE(SUM(CASE WHEN b.status = 'finalized' THEN b.amount_paid END), 0) AS total_paid,
  COALESCE(SUM(CASE WHEN b.status = 'finalized' THEN b.total - b.amount_paid END), 0) AS outstanding,
  COUNT(CASE WHEN b.status = 'finalized' THEN 1 END) AS bills_count,
  MAX(CASE WHEN b.status = 'finalized' THEN b.bill_date END) AS last_bill_date`;

function ownedCustomer(req) {
  const id = v.id(req.params.id, 'Customer');
  const c = get('SELECT * FROM customers WHERE id = ? AND business_id = ?', id, req.businessId);
  if (!c) throw v.notFound('Customer');
  return c;
}

router.get('/', (req, res) => {
  const { limit, offset } = v.paging(req.query, { defaultLimit: 50 });
  const where = ['c.business_id = ?'];
  const params = [req.businessId];
  const q = String(req.query.q || '').trim();
  if (q) {
    // Numbers match whatever spacing they were saved with ("98765 43210" finds "+91 98765-43210").
    where.push(`(c.name LIKE ? ESCAPE '\\' OR ${v.PHONE_DIGITS_SQL('c.phone')} LIKE ? OR c.email LIKE ? ESCAPE '\\')`);
    const p = v.likePattern(q);
    params.push(p, v.digitsPattern(q), p);
  }
  const having = req.query.filter === 'outstanding' ? 'HAVING outstanding > 0' : '';
  const base = `SELECT c.*, ${AGGREGATES}
      FROM customers c LEFT JOIN bills b ON b.customer_id = c.id AND b.business_id = c.business_id
     WHERE ${where.join(' AND ')} GROUP BY c.id ${having}`;
  const sort = req.query.sort === 'outstanding' ? 'outstanding DESC, name COLLATE NOCASE' : 'name COLLATE NOCASE';
  const rows = all(`${base} ORDER BY ${sort} LIMIT ? OFFSET ?`, ...params, limit, offset);
  const { n } = get(`SELECT COUNT(*) AS n FROM (${base})`, ...params);
  res.json({ customers: rows.map(serializeCustomer), total: n, limit, offset });
});

router.post('/', (req, res) => {
  const d = readCustomer(req.body || {});
  const r = run(
    'INSERT INTO customers (business_id, name, phone, email, address, gstin) VALUES (?, ?, ?, ?, ?, ?)',
    req.businessId, d.name, d.phone, d.email, d.address, d.gstin,
  );
  res.status(201).json({ customer: serializeCustomer(get('SELECT * FROM customers WHERE id = ?', Number(r.lastInsertRowid))) });
});

router.get('/:id', (req, res) => {
  const c = ownedCustomer(req);
  const stats = get(
    `SELECT ${AGGREGATES} FROM bills b WHERE b.customer_id = ? AND b.business_id = ?`,
    c.id, req.businessId,
  );
  const bills = all(
    `SELECT id, invoice_no, status, payment_status, bill_date, total, amount_paid, customer_name, is_demo, created_at
       FROM bills WHERE customer_id = ? AND business_id = ? ORDER BY bill_date DESC, id DESC LIMIT 500`,
    c.id, req.businessId,
  );
  res.json({ customer: serializeCustomer(c), stats, bills: bills.map(serializeBill) });
});

router.put('/:id', (req, res) => {
  const c = ownedCustomer(req);
  const d = readCustomer(req.body || {});
  run(
    'UPDATE customers SET name = ?, phone = ?, email = ?, address = ?, gstin = ?, updated_at = ? WHERE id = ?',
    d.name, d.phone, d.email, d.address, d.gstin, nowIso(), c.id,
  );
  res.json({ customer: serializeCustomer(get('SELECT * FROM customers WHERE id = ?', c.id)) });
});

router.delete('/:id', (req, res) => {
  const c = ownedCustomer(req);
  const { n } = get('SELECT COUNT(*) AS n FROM bills WHERE customer_id = ?', c.id);
  if (n > 0) {
    throw v.conflict(`${c.name} has ${n} bill${n === 1 ? '' : 's'} and can't be deleted. Their invoice history must be kept.`);
  }
  run('DELETE FROM customers WHERE id = ?', c.id);
  res.json({ ok: true });
});

export default router;
