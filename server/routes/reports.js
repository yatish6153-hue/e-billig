import express from 'express';
import { get, all } from '../db.js';
import * as v from '../util.js';
import { serializeBill } from '../services/billing.js';
import { serializeProduct, LOW_STOCK_SQL } from '../services/inventory.js';
import { stageCounts } from '../services/tracking.js';
import { getBusiness } from '../services/business.js';
import { isoDate, addDays, PAYMENT_METHODS, DISPLAY_STATUS_LABELS, DAY_ENTRY_KINDS, billDisplayStatus } from '../../shared/format.js';
import { BOOKING_PAY_METHODS, bookingNumber } from '../../shared/bookings.js';

export const dashboardRouter = express.Router();
const router = express.Router();

function dateRange(query) {
  const from = v.optionalDate(query.from);
  const to = v.optionalDate(query.to);
  if (from && to && from > to) throw v.badRequest('The start date must be before the end date.', 'from');
  const sql = [];
  const params = [];
  if (from) { sql.push('b.bill_date >= ?'); params.push(from); }
  if (to) { sql.push('b.bill_date <= ?'); params.push(to); }
  return { from, to, sql: sql.length ? ` AND ${sql.join(' AND ')}` : '', params };
}

/** WHERE clause for the day book (sales without a bill, money received, expenses) in the same range. */
function entryRange(businessId, range) {
  const sql = ['business_id = ?'];
  const params = [businessId];
  if (range.from) { sql.push('entry_date >= ?'); params.push(range.from); }
  if (range.to) { sql.push('entry_date <= ?'); params.push(range.to); }
  return { where: sql.join(' AND '), params };
}

/** WHERE clause for booking payments received in the range; `p` is the table alias, if any. */
function bookingPayRange(businessId, range, p = '') {
  const sql = [`${p}business_id = ?`];
  const params = [businessId];
  if (range.from) { sql.push(`${p}paid_on >= ?`); params.push(range.from); }
  if (range.to) { sql.push(`${p}paid_on <= ?`); params.push(range.to); }
  return { where: sql.join(' AND '), params };
}

function lowStock(businessId, limit) {
  const rows = all(
    `SELECT * FROM products WHERE business_id = ? AND ${LOW_STOCK_SQL}
      ORDER BY (quantity - low_stock_threshold) ASC, name COLLATE NOCASE LIMIT ?`,
    businessId, limit,
  );
  const { n } = get(`SELECT COUNT(*) AS n FROM products WHERE business_id = ? AND ${LOW_STOCK_SQL}`, businessId);
  return { count: n, items: rows.map(serializeProduct) };
}

dashboardRouter.get('/', (req, res) => {
  const biz = req.businessId;
  const range = dateRange(req.query);
  const F = `FROM bills b WHERE b.business_id = ? AND b.status = 'finalized'${range.sql}`;
  const P = [biz, ...range.params];

  const sales = get(`SELECT COUNT(*) AS count, COALESCE(SUM(b.total), 0) AS total, COALESCE(SUM(b.amount_paid), 0) AS collected ${F}`, ...P);
  const E = entryRange(biz, range);
  sales.added = get(`SELECT COALESCE(SUM(amount), 0) AS n FROM day_entries WHERE ${E.where} AND kind = 'sale'`, ...E.params).n;
  const paid = get(`SELECT COUNT(*) AS count, COALESCE(SUM(b.total), 0) AS amount ${F} AND b.payment_status = 'paid'`, ...P);
  const unpaid = get(
    `SELECT COUNT(*) AS count, COALESCE(SUM(b.total - b.amount_paid), 0) AS amount,
            COUNT(CASE WHEN b.payment_status = 'partial' THEN 1 END) AS partial_count
       ${F} AND b.payment_status <> 'paid'`,
    ...P,
  );
  const inventory = get(
    `SELECT COUNT(*) AS products,
            COALESCE(ROUND(SUM(CASE WHEN quantity > 0 THEN quantity * purchase_price END)), 0) AS cost_value,
            COALESCE(ROUND(SUM(CASE WHEN quantity > 0 THEN quantity * selling_price END)), 0) AS retail_value
       FROM products WHERE business_id = ? AND archived = 0 AND kind = 'goods'`,
    biz,
  );
  const { n: drafts } = get("SELECT COUNT(*) AS n FROM bills WHERE business_id = ? AND status = 'draft'", biz);
  const recent = all(
    `SELECT id, invoice_no, status, payment_status, bill_date, customer_name, total, amount_paid, is_demo
       FROM bills WHERE business_id = ? ORDER BY created_at DESC, id DESC LIMIT 6`,
    biz,
  );

  res.json({
    period: { from: range.from, to: range.to },
    sales, paid, unpaid, inventory, drafts,
    work: stageCounts(biz),
    low_stock: lowStock(biz, 8),
    recent_bills: recent.map(serializeBill),
  });
});

/** Give the trend an even time axis: every day (or month) in the range, zero when there were no sales. */
function fillPeriods(rows, range, bucket) {
  const start = range.from || rows[0]?.period;
  const end = range.to || rows[rows.length - 1]?.period;
  if (!start || !end) return rows;
  const byPeriod = new Map(rows.map((r) => [r.period, r]));
  const out = [];
  if (bucket === 'day') {
    for (let d = start; d <= end && out.length < 400; d = addDays(d, 1)) {
      out.push(byPeriod.get(d) || { period: d, total: 0, count: 0 });
    }
  } else {
    let [y, m] = start.slice(0, 7).split('-').map(Number);
    const last = end.slice(0, 7);
    for (let p = start.slice(0, 7); p <= last && out.length < 600; ) {
      out.push(byPeriod.get(p) || { period: p, total: 0, count: 0 });
      m += 1;
      if (m > 12) { m = 1; y += 1; }
      p = `${y}-${String(m).padStart(2, '0')}`;
    }
  }
  return out;
}

function salesData(businessId, query) {
  const range = dateRange(query);
  const F = `FROM bills b WHERE b.business_id = ? AND b.status = 'finalized'${range.sql}`;
  const P = [businessId, ...range.params];

  const summary = get(
    `SELECT COUNT(*) AS bills, COALESCE(SUM(b.total), 0) AS sales, COALESCE(SUM(b.subtotal), 0) AS subtotal,
            COALESCE(SUM(b.discount_total), 0) AS discount, COALESCE(SUM(b.taxable_total), 0) AS taxable,
            COALESCE(SUM(b.tax_total), 0) AS tax, COALESCE(SUM(b.total - b.amount_paid), 0) AS outstanding
       ${F}`,
    ...P,
  );
  summary.average = summary.bills ? Math.round(summary.sales / summary.bills) : 0;

  const payRange = [];
  const payParams = [businessId];
  if (range.from) { payRange.push('p.paid_on >= ?'); payParams.push(range.from); }
  if (range.to) { payRange.push('p.paid_on <= ?'); payParams.push(range.to); }
  const payWhere = `p.business_id = ? AND b.status = 'finalized'${payRange.length ? ` AND ${payRange.join(' AND ')}` : ''}`;
  const methods = all(
    `SELECT p.method, COUNT(*) AS count, SUM(p.amount) AS amount FROM payments p JOIN bills b ON b.id = p.bill_id
      WHERE ${payWhere} GROUP BY p.method ORDER BY amount DESC`,
    ...payParams,
  );
  summary.collected = methods.reduce((a, m) => a + m.amount, 0);

  // The day book: sales without a bill, other money received, and expenses.
  const E = entryRange(businessId, range);
  const added = get(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'sale' THEN amount END), 0) AS sales,
            COALESCE(SUM(CASE WHEN kind <> 'expense' THEN amount END), 0) AS received,
            COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount END), 0) AS spent
       FROM day_entries WHERE ${E.where}`,
    ...E.params,
  );
  summary.sales_added = added.sales;
  summary.received_added = added.received;
  summary.expenses = added.spent;
  const addMethod = (method, count, amount) => {
    const m = methods.find((x) => x.method === method);
    if (m) {
      m.count += count;
      m.amount += amount;
    } else {
      methods.push({ method, count, amount });
    }
  };
  for (const r of all(
    `SELECT method, COUNT(*) AS count, SUM(amount) AS amount FROM day_entries WHERE ${E.where} AND kind <> 'expense' GROUP BY method`,
    ...E.params,
  )) addMethod(r.method, r.count, r.amount);
  // Booking payments are money received too: cash is cash; UPI, bank transfer, card and other count as online.
  const K = bookingPayRange(businessId, range);
  summary.received_bookings = 0;
  for (const r of all(`SELECT method, COUNT(*) AS count, SUM(amount) AS amount FROM booking_payments WHERE ${K.where} GROUP BY method`, ...K.params)) {
    summary.received_bookings += r.amount;
    addMethod(r.method === 'cash' ? 'cash' : 'online', r.count, r.amount);
  }
  methods.sort((a, b) => b.amount - a.amount);

  const cancelled = get(
    `SELECT COUNT(*) AS count, COALESCE(SUM(b.total), 0) AS total FROM bills b
      WHERE b.business_id = ? AND b.status = 'cancelled'${range.sql}`,
    ...P,
  );

  const days = range.from && range.to ? (Date.parse(range.to) - Date.parse(range.from)) / 86400_000 : Infinity;
  const bucket = days <= 62 ? 'b.bill_date' : 'substr(b.bill_date, 1, 7)';
  const rows = all(`SELECT ${bucket} AS period, SUM(b.total) AS total, COUNT(*) AS count ${F} GROUP BY period ORDER BY period`, ...P);
  const byPeriod = new Map(rows.map((r) => [r.period, r]));
  for (const r of all(
    `SELECT ${days <= 62 ? 'entry_date' : 'substr(entry_date, 1, 7)'} AS period, SUM(amount) AS total
       FROM day_entries WHERE ${E.where} AND kind = 'sale' GROUP BY period`,
    ...E.params,
  )) {
    if (byPeriod.has(r.period)) byPeriod.get(r.period).total += r.total;
    else rows.push({ period: r.period, total: r.total, count: 0 });
  }
  rows.sort((a, b) => (a.period < b.period ? -1 : 1));
  const trend = fillPeriods(rows, range, days <= 62 ? 'day' : 'month');

  const topProducts = all(
    `SELECT i.product_id, i.name, i.unit, SUM(i.quantity) AS quantity, SUM(i.taxable) AS revenue, SUM(i.total) AS total,
            COUNT(DISTINCT b.id) AS bills
       FROM bill_items i JOIN bills b ON b.id = i.bill_id
      WHERE b.business_id = ? AND b.status = 'finalized'${range.sql}
      GROUP BY COALESCE(CAST(i.product_id AS TEXT), 'custom:' || i.name)
      ORDER BY total DESC LIMIT 100`,
    ...P,
  );

  return { range, summary, methods, cancelled, trend, bucket: days <= 62 ? 'day' : 'month', topProducts };
}

router.get('/sales', (req, res) => {
  const d = salesData(req.businessId, req.query);
  res.json({
    period: { from: d.range.from, to: d.range.to },
    summary: d.summary,
    cancelled: d.cancelled,
    payment_methods: d.methods,
    trend: d.trend,
    trend_bucket: d.bucket,
    top_products: d.topProducts.slice(0, 20),
    low_stock: lowStock(req.businessId, 50),
  });
});

router.get('/export', (req, res) => {
  const type = v.oneOf(req.query.type || 'bills', ['bills', 'items', 'inventory', 'payments', 'daybook'], 'type', 'Export type');
  const business = getBusiness(req.businessId);
  const range = dateRange(req.query);
  const m = v.major;
  let header;
  let rows;

  if (type === 'bills') {
    header = ['Invoice No', 'Bill Date', 'Customer', 'WhatsApp', 'Status', 'Payment Status',
      'Subtotal', 'Discount', 'Round Off', 'Total', 'Advance / Paid', 'Balance', 'Currency'];
    const bills = all(
      `SELECT * FROM bills b WHERE b.business_id = ? AND b.status <> 'draft'${range.sql} ORDER BY b.bill_date, b.id`,
      req.businessId, ...range.params,
    );
    rows = bills.map((b) => [
      b.invoice_no, b.bill_date, b.customer_name || 'Walk-in customer', b.customer_phone,
      b.status === 'cancelled' ? 'Cancelled' : 'Finalized', DISPLAY_STATUS_LABELS[billDisplayStatus(b)],
      m(b.subtotal), m(b.discount_total), m(b.round_off), m(b.total),
      m(b.amount_paid), b.status === 'finalized' ? m(b.total - b.amount_paid) : 0, b.currency,
    ]);
  } else if (type === 'items') {
    header = ['Product', 'Unit', 'Quantity Sold', 'Bills', 'Amount'];
    rows = salesData(req.businessId, req.query).topProducts.map((p) => [p.name, p.unit, p.quantity, p.bills, m(p.total)]);
  } else if (type === 'payments') {
    header = ['Payment Date', 'Bill / Booking', 'Customer', 'Method', 'Reference', 'Amount'];
    const params = [req.businessId];
    const conds = [];
    if (range.from) { conds.push('p.paid_on >= ?'); params.push(range.from); }
    if (range.to) { conds.push('p.paid_on <= ?'); params.push(range.to); }
    const payments = all(
      `SELECT p.*, b.invoice_no, b.customer_name FROM payments p JOIN bills b ON b.id = p.bill_id
        WHERE p.business_id = ?${conds.length ? ` AND ${conds.join(' AND ')}` : ''} ORDER BY p.paid_on, p.id`,
      ...params,
    );
    rows = payments.map((p) => [p.paid_on, p.invoice_no, p.customer_name || 'Walk-in customer',
      PAYMENT_METHODS[p.method] || p.method, p.reference, m(p.amount)]);
    const K = bookingPayRange(req.businessId, range, 'p.');
    for (const p of all(
      `SELECT p.*, k.booking_no, k.client_name FROM booking_payments p JOIN bookings k ON k.id = p.booking_id
        WHERE ${K.where} ORDER BY p.paid_on, p.id`,
      ...K.params,
    )) rows.push([p.paid_on, bookingNumber(p.booking_no), p.client_name, BOOKING_PAY_METHODS[p.method] || p.method, p.note, m(p.amount)]);
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  } else if (type === 'daybook') {
    header = ['Date', 'Entry', 'Details', 'Expense Type', 'Cash / Online', 'Money In', 'Money Out'];
    const E = entryRange(req.businessId, range);
    rows = all(`SELECT * FROM day_entries WHERE ${E.where} ORDER BY entry_date, id`, ...E.params).map((x) => [
      x.entry_date, DAY_ENTRY_KINDS[x.kind], x.details, x.category, PAYMENT_METHODS[x.method] || x.method,
      x.kind === 'expense' ? '' : m(x.amount), x.kind === 'expense' ? m(x.amount) : '',
    ]);
  } else {
    header = ['Item', 'Type', 'SKU', 'Barcode', 'Category', 'Unit', 'Quantity', 'Low-stock Level', 'Purchase Price',
      'Selling Price', 'Stock Value (cost)', 'Status'];
    const products = all("SELECT * FROM products WHERE business_id = ? ORDER BY kind, name COLLATE NOCASE", req.businessId);
    rows = products.map((p) => {
      const service = p.kind === 'service';
      const status = p.archived ? 'Archived' : service ? 'Service' : p.quantity <= 0 ? 'Out of stock'
        : p.quantity <= p.low_stock_threshold ? 'Low stock' : 'In stock';
      return [p.name, service ? 'Service' : 'Product', p.sku, p.barcode, p.category, p.unit,
        service ? '' : p.quantity, service ? '' : p.low_stock_threshold, m(p.purchase_price), m(p.selling_price),
        service ? '' : m(Math.round(Math.max(0, p.quantity) * p.purchase_price)), status];
    });
  }

  const span = type === 'inventory' ? isoDate() : `${range.from || 'start'}_to_${range.to || isoDate()}`;
  const slug = business.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'business';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-${type}-${span}.csv"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(v.toCsv(header, rows));
});

export default router;
