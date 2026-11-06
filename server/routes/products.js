import express from 'express';
import { get, all, run, tx, nowIso } from '../db.js';
import * as v from '../util.js';
import { applyStockChange, serializeProduct, MOVEMENT_TYPES, LOW_STOCK_SQL } from '../services/inventory.js';
import { getBusiness } from '../services/business.js';

const router = express.Router();

function readProduct(body, business, { creating }) {
  const kind = v.oneOf(body.kind || 'goods', ['goods', 'service'], 'kind', 'Item type');
  const data = {
    kind,
    name: v.text(body.name, 'name', kind === 'service' ? 'Service name' : 'Product name', { max: 160, required: true }),
    sku: v.text(body.sku, 'sku', 'SKU', { max: 60 }),
    barcode: v.text(body.barcode, 'barcode', 'Barcode', { max: 60 }).replace(/\s/g, ''),
    category: v.text(body.category, 'category', 'Category', { max: 60 }),
    hsn: v.text(body.hsn, 'hsn', 'HSN/SAC code', { max: 20 }),
    unit: v.text(body.unit, 'unit', 'Unit', { max: 20 }) || 'pcs',
    purchase_price: v.money(body.purchase_price, 'purchase_price', 'Purchase price', { required: false }),
    selling_price: v.money(body.selling_price, 'selling_price', 'Selling price'),
    tax_rate: v.number(body.tax_rate, 'tax_rate', 'Tax rate', { min: 0, max: 100, decimals: 3, required: false, fallback: business.default_tax_rate }),
    low_stock_threshold: v.number(body.low_stock_threshold, 'low_stock_threshold', 'Low-stock alert level', { min: 0, max: 10_000_000, required: false }),
  };
  if (creating) {
    data.quantity = kind === 'service' ? 0
      : v.number(body.quantity, 'quantity', 'Opening stock', { min: 0, max: 10_000_000, required: false });
  }
  if (kind === 'service') data.low_stock_threshold = 0;
  return data;
}

function assertUnique(businessId, data, exceptId = 0) {
  if (data.sku) {
    const dup = get('SELECT name FROM products WHERE business_id = ? AND sku = ? COLLATE NOCASE AND id <> ?', businessId, data.sku, exceptId);
    if (dup) throw v.conflict(`SKU "${data.sku}" is already used by "${dup.name}".`, { field: 'sku' });
  }
  if (data.barcode) {
    const dup = get('SELECT name FROM products WHERE business_id = ? AND barcode = ? COLLATE NOCASE AND id <> ?', businessId, data.barcode, exceptId);
    if (dup) throw v.conflict(`Barcode "${data.barcode}" is already used by "${dup.name}".`, { field: 'barcode' });
  }
}

function ownedProduct(req) {
  const id = v.id(req.params.id, 'Product');
  const p = get('SELECT * FROM products WHERE id = ? AND business_id = ?', id, req.businessId);
  if (!p) throw v.notFound('Product');
  return p;
}

router.get('/', (req, res) => {
  const { limit, offset } = v.paging(req.query, { defaultLimit: 50 });
  const where = ['business_id = ?'];
  const params = [req.businessId];
  const q = String(req.query.q || '').trim();
  if (q) {
    where.push("(name LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\' OR barcode LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')");
    const p = v.likePattern(q);
    params.push(p, p, p, p);
  }
  if (req.query.category) {
    where.push('category = ?');
    params.push(String(req.query.category));
  }
  if (req.query.kind === 'goods' || req.query.kind === 'service') {
    where.push('kind = ?');
    params.push(req.query.kind);
  }
  switch (req.query.status || 'active') {
    case 'archived': where.push('archived = 1'); break;
    case 'low': where.push(LOW_STOCK_SQL); break;
    case 'out': where.push("kind = 'goods' AND archived = 0 AND quantity <= 0"); break;
    case 'all': break;
    default: where.push('archived = 0');
  }
  const sorts = {
    name: 'name COLLATE NOCASE ASC',
    stock: "kind = 'service', quantity ASC, name COLLATE NOCASE",
    value: '(quantity * purchase_price) DESC',
    recent: 'updated_at DESC',
  };
  const order = sorts[req.query.sort] || sorts.name;
  const whereSql = where.join(' AND ');
  const rows = all(`SELECT * FROM products WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
  const { n } = get(`SELECT COUNT(*) AS n FROM products WHERE ${whereSql}`, ...params);
  res.json({ products: rows.map(serializeProduct), total: n, limit, offset });
});

router.get('/categories', (req, res) => {
  const rows = all("SELECT DISTINCT category FROM products WHERE business_id = ? AND category <> '' ORDER BY category COLLATE NOCASE", req.businessId);
  const units = all("SELECT DISTINCT unit FROM products WHERE business_id = ? AND unit <> '' ORDER BY unit", req.businessId);
  res.json({ categories: rows.map((r) => r.category), units: units.map((r) => r.unit) });
});

/** Exact barcode / SKU match for scanner input. No match is a normal answer: { product: null }. */
router.get('/lookup', (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!code) throw v.badRequest('Enter a barcode or SKU.', 'code');
  const p = get(
    `SELECT * FROM products WHERE business_id = ? AND archived = 0
       AND (barcode = ? COLLATE NOCASE OR sku = ? COLLATE NOCASE) LIMIT 1`,
    req.businessId, code, code,
  );
  res.json({ product: p ? serializeProduct(p) : null });
});

router.post('/', (req, res) => {
  const business = getBusiness(req.businessId);
  const data = readProduct(req.body || {}, business, { creating: true });
  assertUnique(req.businessId, data);
  const product = tx(() => {
    const r = run(
      `INSERT INTO products (business_id, kind, name, sku, barcode, category, hsn, unit, purchase_price, selling_price, tax_rate, low_stock_threshold)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      req.businessId, data.kind, data.name, data.sku, data.barcode, data.category, data.hsn, data.unit,
      data.purchase_price, data.selling_price, data.tax_rate, data.low_stock_threshold,
    );
    const id = Number(r.lastInsertRowid);
    if (data.quantity > 0) {
      applyStockChange(req.businessId, id, data.quantity, 'opening', {
        userId: req.user.id, note: 'Opening stock', unitCost: data.purchase_price,
      });
    }
    return get('SELECT * FROM products WHERE id = ?', id);
  });
  res.status(201).json({ product: serializeProduct(product) });
});

router.get('/:id', (req, res) => {
  const p = ownedProduct(req);
  const sales = get(
    `SELECT COALESCE(SUM(i.quantity), 0) AS qty, COALESCE(SUM(i.taxable), 0) AS revenue, COUNT(DISTINCT b.id) AS bills
       FROM bill_items i JOIN bills b ON b.id = i.bill_id
      WHERE i.product_id = ? AND b.business_id = ? AND b.status = 'finalized'`,
    p.id, req.businessId,
  );
  res.json({ product: serializeProduct(p), sales });
});

router.put('/:id', (req, res) => {
  const p = ownedProduct(req);
  const data = readProduct({ kind: p.kind, ...(req.body || {}) }, getBusiness(req.businessId), { creating: false });
  assertUnique(req.businessId, data, p.id);
  if (data.kind === 'service' && p.kind === 'goods' && p.quantity !== 0) {
    throw v.badRequest(`This product still has ${p.quantity} ${p.unit} in stock. Adjust stock to 0 before turning it into a service.`, 'kind');
  }
  run(
    `UPDATE products SET kind = ?, name = ?, sku = ?, barcode = ?, category = ?, hsn = ?, unit = ?, purchase_price = ?,
       selling_price = ?, tax_rate = ?, low_stock_threshold = ?, updated_at = ? WHERE id = ?`,
    data.kind, data.name, data.sku, data.barcode, data.category, data.hsn, data.unit, data.purchase_price,
    data.selling_price, data.tax_rate, data.low_stock_threshold, nowIso(), p.id,
  );
  res.json({ product: serializeProduct(get('SELECT * FROM products WHERE id = ?', p.id)) });
});

router.post('/:id/archive', (req, res) => {
  const p = ownedProduct(req);
  const archived = v.bool((req.body || {}).archived);
  run('UPDATE products SET archived = ?, updated_at = ? WHERE id = ?', archived, nowIso(), p.id);
  res.json({ product: serializeProduct(get('SELECT * FROM products WHERE id = ?', p.id)) });
});

/** Stock in / out / physical count. */
router.post('/:id/stock', (req, res) => {
  const p = ownedProduct(req);
  if (p.kind === 'service') throw v.badRequest(`${p.name} is a service, so it has no stock to adjust.`);
  const b = req.body || {};
  const mode = v.oneOf(b.mode, ['add', 'remove', 'set'], 'mode', 'Adjustment type');
  const note = v.text(b.note, 'note', 'Note', { max: 200 });
  let delta;
  let type = 'adjustment';
  let unitCost = null;
  if (mode === 'add') {
    delta = v.number(b.quantity, 'quantity', 'Quantity to add', { min: 0.001, max: 10_000_000 });
    type = 'purchase';
    if (b.unit_cost !== undefined && b.unit_cost !== null && b.unit_cost !== '') {
      unitCost = v.money(b.unit_cost, 'unit_cost', 'Cost per unit');
    }
  } else if (mode === 'remove') {
    const qty = v.number(b.quantity, 'quantity', 'Quantity to remove', { min: 0.001, max: 10_000_000 });
    if (!note) throw v.badRequest('Please give a reason for removing stock.', 'note');
    if (qty > p.quantity) {
      throw v.badRequest(`You can remove at most ${Math.max(0, p.quantity)} ${p.unit} (current stock).`, 'quantity');
    }
    delta = -qty;
  } else {
    const counted = v.number(b.quantity, 'quantity', 'Counted quantity', { min: 0, max: 10_000_000 });
    delta = Math.round((counted - p.quantity) * 1000) / 1000;
    if (delta === 0) throw v.badRequest(`Stock is already ${counted} ${p.unit}. Nothing to change.`, 'quantity');
  }

  const product = tx(() => {
    applyStockChange(req.businessId, p.id, delta, type, {
      userId: req.user.id, note: note || (mode === 'set' ? 'Stock count correction' : ''), unitCost,
    });
    if (unitCost !== null && v.bool(b.update_purchase_price)) {
      run('UPDATE products SET purchase_price = ? WHERE id = ?', unitCost, p.id);
    }
    return get('SELECT * FROM products WHERE id = ?', p.id);
  });
  res.json({ product: serializeProduct(product) });
});

export const stockRouter = express.Router();

stockRouter.get('/movements', (req, res) => {
  const { limit, offset } = v.paging(req.query, { defaultLimit: 50 });
  const where = ['m.business_id = ?'];
  const params = [req.businessId];
  if (req.query.product_id) {
    where.push('m.product_id = ?');
    params.push(v.id(req.query.product_id, 'Product'));
  }
  if (req.query.type && MOVEMENT_TYPES.includes(req.query.type)) {
    where.push('m.type = ?');
    params.push(req.query.type);
  }
  const q = String(req.query.q || '').trim();
  if (q) {
    where.push("(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\')");
    params.push(v.likePattern(q), v.likePattern(q));
  }
  const from = v.optionalDate(req.query.from);
  const to = v.optionalDate(req.query.to);
  if (from) { where.push('substr(m.created_at, 1, 10) >= ?'); params.push(from); }
  if (to) { where.push('substr(m.created_at, 1, 10) <= ?'); params.push(to); }
  const whereSql = where.join(' AND ');
  const rows = all(
    `SELECT m.*, p.name AS product_name, p.unit, p.sku, b.invoice_no, u.name AS user_name
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN bills b ON b.id = m.bill_id
       LEFT JOIN users u ON u.id = m.user_id
      WHERE ${whereSql}
      ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  );
  const { n } = get(`SELECT COUNT(*) AS n FROM stock_movements m JOIN products p ON p.id = m.product_id WHERE ${whereSql}`, ...params);
  res.json({ movements: rows, total: n, limit, offset });
});

export default router;
