// Bill lifecycle: draft -> finalized (stock deducted once) -> cancelled (stock restored once).
import crypto from 'node:crypto';
import { get, all, run, tx, nowIso } from '../db.js';
import { computeBill, paymentStatus } from '../../shared/calc.js';
import { roundQty, formatMoney, formatQty, PAYMENT_METHODS, billDisplayStatus } from '../../shared/format.js';
import { PHOTO_SOURCES } from '../../shared/tracking.js';
import { applyStockChange } from './inventory.js';
import { getBusiness, invoiceNumber, serializeBusiness } from './business.js';
import * as v from '../util.js';

const MAX_ITEMS = 300;

export function serializeBill(b) {
  return {
    ...b,
    split_tax: !!b.split_tax,
    with_gst: !!b.with_gst,
    prices_include_tax: !!b.prices_include_tax,
    round_off_enabled: !!b.round_off_enabled,
    stock_applied: !!b.stock_applied,
    is_demo: !!b.is_demo,
    balance: b.status === 'finalized' ? b.total - b.amount_paid : 0,
    display_status: billDisplayStatus(b),
  };
}

function optionalId(value, label) {
  return value === null || value === undefined || value === '' ? null : v.id(value, label);
}

/** Bills are made without GST: no tax on any line, and one optional discount % for the whole bill. */
export function validateBillInput(body) {
  const billDate = v.date(body.bill_date, 'bill_date', 'Bill date');
  if (!Array.isArray(body.items)) throw v.badRequest('Items are required.', 'items');
  if (body.items.length > MAX_ITEMS) throw v.badRequest(`A bill can have at most ${MAX_ITEMS} items.`, 'items');

  const items = body.items.map((raw, i) => {
    const n = i + 1;
    const f = (k) => `items.${i}.${k}`;
    const productId = optionalId(raw.product_id, 'Product');
    return {
      product_id: productId,
      name: v.text(raw.name, f('name'), `Item ${n} name`, { max: 200, required: !productId }),
      quantity: v.number(raw.quantity, f('quantity'), `Quantity for item ${n}`, { min: 0.001, max: 10_000_000, decimals: 3 }),
      unit_price: v.money(raw.unit_price, f('unit_price'), `Price for item ${n}`),
      discount_pct: v.number(raw.discount_pct, f('discount_pct'), `Discount for item ${n}`, { min: 0, max: 100, decimals: 2, required: false }),
      tax_rate: 0,
      unit: v.text(raw.unit, f('unit'), `Unit for item ${n}`, { max: 20 }),
      hsn: '',
    };
  });

  return {
    customer: {
      id: optionalId(body.customer_id, 'Customer'),
      name: v.text(body.customer_name, 'customer_name', 'Customer name', { max: 120 }),
      phone: v.phone(body.customer_phone, 'customer_phone', 'WhatsApp number'),
    },
    billDate,
    notes: v.text(body.notes, 'notes', 'Notes', { max: 1000, multiline: true }),
    discountPct: v.number(body.discount_pct, 'discount_pct', 'Discount', { min: 0, max: 100, decimals: 2, required: false }),
    photoSource: readPhotoSource(body.photo_source),
    items,
  };
}

/** How the customer's photo came in: '' (not set) or a key of PHOTO_SOURCES. */
export function readPhotoSource(value) {
  return v.oneOf(value || '', ['', ...Object.keys(PHOTO_SOURCES)], 'photo_source', 'Photo received');
}

const phoneKey = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

/**
 * The bill form takes a customer name and WhatsApp number directly.
 * A picked customer is reused (and their number updated if it changed); a new name
 * becomes a saved customer, unless one with the same name and number already exists.
 * A number with no name stays on the bill only (walk-in). Bookings save their client the same way.
 */
export function resolveCustomer(businessId, c) {
  if (c.id) {
    const existing = get('SELECT * FROM customers WHERE id = ? AND business_id = ?', c.id, businessId);
    if (!existing) throw v.badRequest('That customer no longer exists — type their name again.', 'customer_name');
    if (c.phone && c.phone !== existing.phone) {
      run('UPDATE customers SET phone = ?, updated_at = ? WHERE id = ?', c.phone, nowIso(), existing.id);
      return { ...existing, phone: c.phone };
    }
    return existing;
  }
  if (!c.name) return null;
  const key = phoneKey(c.phone);
  const sameName = all('SELECT * FROM customers WHERE business_id = ? AND name = ? COLLATE NOCASE', businessId, c.name);
  const match = sameName.find((x) => phoneKey(x.phone) === key) || (key ? sameName.find((x) => !x.phone) : null);
  if (match) {
    if (key && !match.phone) {
      run('UPDATE customers SET phone = ?, updated_at = ? WHERE id = ?', c.phone, nowIso(), match.id);
      return { ...match, phone: c.phone };
    }
    return match;
  }
  const r = run('INSERT INTO customers (business_id, name, phone) VALUES (?, ?, ?)', businessId, c.name, c.phone);
  return get('SELECT * FROM customers WHERE id = ?', Number(r.lastInsertRowid));
}

function customerSnapshot(c) {
  return {
    customer_name: c?.name || '',
    customer_phone: c?.phone || '',
    customer_email: c?.email || '',
    customer_address: c?.address || '',
    customer_gstin: c?.gstin || '',
  };
}

function totalsFields(calc) {
  return {
    subtotal: calc.subtotal,
    discount_total: calc.discount_total,
    taxable_total: calc.taxable_total,
    tax_total: calc.tax_total,
    round_off: calc.round_off,
    total: calc.total,
  };
}

function updateBill(billId, fields) {
  const keys = Object.keys(fields);
  run(`UPDATE bills SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), billId);
}

/** Create (billId = null) or update a draft. Returns the bill id. */
export function saveDraft(businessId, userId, billId, body, { isDemo = false, at = null } = {}) {
  const business = getBusiness(businessId);
  const input = validateBillInput(body);

  return tx(() => {
    if (billId) {
      const existing = get('SELECT status FROM bills WHERE id = ? AND business_id = ?', billId, businessId);
      if (!existing) throw v.notFound('Bill');
      if (existing.status !== 'draft') {
        throw v.conflict('Only draft bills can be edited. Cancel this bill and duplicate it to make changes.');
      }
    }

    const customer = resolveCustomer(businessId, input.customer);
    const snapshot = customer ? customerSnapshot(customer) : { ...customerSnapshot(null), customer_phone: input.customer.phone };

    const items = input.items.map((item) => {
      if (!item.product_id) return { ...item, sku: '' };
      const p = get('SELECT name, sku, unit FROM products WHERE id = ? AND business_id = ?', item.product_id, businessId);
      if (!p) throw v.badRequest(`"${item.name || 'An item'}" is no longer in your inventory. Remove it and add it again.`, 'items');
      return { ...item, name: p.name, sku: p.sku, unit: item.unit || p.unit };
    });

    const calc = computeBill(items, { roundOff: !!business.round_off, discountPct: input.discountPct });
    const when = at || nowIso();
    const fields = {
      customer_id: customer?.id ?? null,
      ...snapshot,
      bill_date: input.billDate,
      due_date: null,
      notes: input.notes,
      currency: business.currency,
      tax_label: business.tax_label,
      split_tax: business.split_tax,
      with_gst: 0,
      prices_include_tax: 0,
      discount_pct: input.discountPct,
      photo_source: input.photoSource,
      round_off_enabled: business.round_off,
      ...totalsFields(calc),
      updated_at: when,
    };

    let id = billId;
    if (id) {
      updateBill(id, fields);
      run('DELETE FROM bill_items WHERE bill_id = ?', id);
    } else {
      const res = run(
        'INSERT INTO bills (business_id, bill_date, created_by, is_demo, created_at) VALUES (?, ?, ?, ?, ?)',
        businessId, input.billDate, userId, isDemo ? 1 : 0, when,
      );
      id = Number(res.lastInsertRowid);
      updateBill(id, fields);
    }

    items.forEach((item, i) => {
      const line = calc.lines[i];
      run(
        `INSERT INTO bill_items (bill_id, product_id, position, name, sku, hsn, unit, quantity, unit_price, discount_pct,
           tax_rate, gross, discount, taxable, tax, total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, item.product_id, i + 1, item.name, item.sku, item.hsn, item.unit, item.quantity, item.unit_price,
        item.discount_pct, item.tax_rate, line.gross, line.discount, line.taxable, line.tax, line.total,
      );
    });
    return id;
  });
}

function validatePayment(body, balance, currency, defaultDate) {
  if (balance <= 0) throw v.conflict('This bill is already fully paid.');
  const amount = v.money(body.amount, 'amount', 'Amount', { min: 1 });
  if (amount > balance) {
    throw v.badRequest(`Amount cannot be more than the balance (${formatMoney(balance, currency)}).`, 'amount');
  }
  return {
    amount,
    method: v.oneOf(body.method, Object.keys(PAYMENT_METHODS), 'method', 'Payment method'),
    paid_on: v.date(body.paid_on || defaultDate, 'paid_on', 'Payment date'),
    reference: v.text(body.reference, 'reference', 'Reference', { max: 100 }),
    note: v.text(body.note, 'note', 'Note', { max: 300 }),
  };
}

function insertPayment(businessId, userId, billId, p, at) {
  run(
    `INSERT INTO payments (business_id, bill_id, amount, method, reference, note, paid_on, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    businessId, billId, p.amount, p.method, p.reference, p.note, p.paid_on, userId, at || nowIso(),
  );
  refreshPaymentTotals(billId);
}

function refreshPaymentTotals(billId) {
  const bill = get('SELECT total FROM bills WHERE id = ?', billId);
  const { paid } = get('SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE bill_id = ?', billId);
  run('UPDATE bills SET amount_paid = ?, payment_status = ?, updated_at = ? WHERE id = ?',
    paid, paymentStatus(bill.total, paid), nowIso(), billId);
}

function shortageMessage(shortages) {
  const list = shortages.slice(0, 3)
    .map((s) => `${s.name} (need ${formatQty(s.required)}, have ${formatQty(s.available)})`).join('; ');
  const more = shortages.length > 3 ? ` and ${shortages.length - 3} more` : '';
  return `Not enough stock: ${list}${more}.`;
}

/**
 * Finalize a draft: assigns the invoice number and deducts stock exactly once.
 * The status guard in the UPDATE plus the unique movement index make a repeated
 * request (double click, retry) harmless.
 */
export function finalizeBill(businessId, userId, billId, { allowInsufficient = false, payment = null, at = null } = {}) {
  return tx(() => {
    const bill = get('SELECT * FROM bills WHERE id = ? AND business_id = ?', billId, businessId);
    if (!bill) throw v.notFound('Bill');
    if (bill.status === 'finalized') {
      throw v.conflict(`This bill is already finalized as ${bill.invoice_no}. Stock was not deducted again.`, { code: 'ALREADY_FINALIZED' });
    }
    if (bill.status === 'cancelled') throw v.conflict('A cancelled bill cannot be finalized.');

    const items = all('SELECT * FROM bill_items WHERE bill_id = ? ORDER BY position', billId);
    if (!items.length) throw v.badRequest('Add at least one item before finalizing the bill.', 'items');
    const calc = computeBill(items, {
      pricesIncludeTax: !!bill.prices_include_tax, roundOff: !!bill.round_off_enabled, discountPct: bill.discount_pct,
    });

    // Total quantity needed per stocked product (a product may appear on several lines).
    // Services and custom lines don't touch stock.
    const needed = new Map();
    for (const item of items) {
      if (!item.product_id) continue;
      const kind = get('SELECT kind FROM products WHERE id = ? AND business_id = ?', item.product_id, businessId)?.kind;
      if (kind === 'goods') needed.set(item.product_id, roundQty((needed.get(item.product_id) || 0) + item.quantity));
    }
    const shortages = [];
    for (const [productId, qty] of needed) {
      const p = get('SELECT name, unit, quantity FROM products WHERE id = ? AND business_id = ?', productId, businessId);
      if (p && p.quantity < qty) {
        shortages.push({ product_id: productId, name: p.name, unit: p.unit, available: p.quantity, required: qty });
      }
    }
    if (shortages.length && !allowInsufficient) {
      throw v.conflict(shortageMessage(shortages), { code: 'INSUFFICIENT_STOCK', details: shortages });
    }

    const pay = payment && payment.amount ? validatePayment(payment, calc.total, bill.currency, bill.bill_date) : null;
    const customer = bill.customer_id
      ? get('SELECT * FROM customers WHERE id = ? AND business_id = ?', bill.customer_id, businessId)
      : null;

    const biz = get('SELECT invoice_prefix, next_invoice_no FROM businesses WHERE id = ?', businessId);
    let n = biz.next_invoice_no;
    let invoiceNo;
    do {
      invoiceNo = invoiceNumber(biz.invoice_prefix, n);
      n++;
    } while (get('SELECT 1 FROM bills WHERE business_id = ? AND invoice_no = ?', businessId, invoiceNo));
    run('UPDATE businesses SET next_invoice_no = ? WHERE id = ?', n, businessId);

    const when = at || nowIso();
    const fields = {
      ...totalsFields(calc),
      ...(customer ? customerSnapshot(customer) : {}),
      payment_status: paymentStatus(calc.total, 0),
    };
    const keys = Object.keys(fields);
    const res = run(
      `UPDATE bills SET status = 'finalized', invoice_no = ?, stock_applied = 1, finalized_at = ?, updated_at = ?,
         ${keys.map((k) => `${k} = ?`).join(', ')}
       WHERE id = ? AND business_id = ? AND status = 'draft' AND stock_applied = 0`,
      invoiceNo, when, when, ...keys.map((k) => fields[k]), billId, businessId,
    );
    if (res.changes !== 1) throw v.conflict('This bill was already finalized.', { code: 'ALREADY_FINALIZED' });

    for (const [productId, qty] of needed) {
      if (!get('SELECT 1 FROM products WHERE id = ? AND business_id = ?', productId, businessId)) continue;
      applyStockChange(businessId, productId, -qty, 'sale', { billId, userId, note: `Invoice ${invoiceNo}`, at: when });
    }
    if (pay) insertPayment(businessId, userId, billId, pay, when);
    return { invoice_no: invoiceNo, shortages };
  });
}

/** Cancel a finalized bill and put back exactly the stock its sale removed. */
export function cancelBill(businessId, userId, billId, { reason = '' } = {}) {
  const cancelReason = v.text(reason, 'reason', 'Reason', { max: 300, multiline: true });
  return tx(() => {
    const bill = get('SELECT * FROM bills WHERE id = ? AND business_id = ?', billId, businessId);
    if (!bill) throw v.notFound('Bill');
    if (bill.status === 'draft') throw v.conflict('Drafts are not invoices yet — delete the draft instead.');
    if (bill.status === 'cancelled') throw v.conflict('This bill is already cancelled.');

    const when = nowIso();
    const res = run(
      `UPDATE bills SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ?
       WHERE id = ? AND business_id = ? AND status = 'finalized'`,
      when, cancelReason, when, billId, businessId,
    );
    if (res.changes !== 1) throw v.conflict('This bill is already cancelled.');

    let restored = 0;
    if (bill.stock_applied) {
      const sales = all("SELECT product_id, quantity FROM stock_movements WHERE bill_id = ? AND type = 'sale'", billId);
      for (const s of sales) {
        applyStockChange(businessId, s.product_id, -s.quantity, 'sale_cancel', {
          billId, userId, note: `Invoice ${bill.invoice_no} cancelled`, at: when,
        });
        restored++;
      }
      run('UPDATE bills SET stock_applied = 0 WHERE id = ?', billId);
    }
    return { restored };
  });
}

export function deleteDraft(businessId, billId) {
  return tx(() => {
    const bill = get('SELECT status FROM bills WHERE id = ? AND business_id = ?', billId, businessId);
    if (!bill) throw v.notFound('Bill');
    if (bill.status !== 'draft') throw v.conflict('Only drafts can be deleted. Cancel a finalized bill instead.');
    run('DELETE FROM bills WHERE id = ?', billId);
  });
}

export function duplicateBill(businessId, userId, billId, billDate) {
  const bill = get('SELECT * FROM bills WHERE id = ? AND business_id = ?', billId, businessId);
  if (!bill) throw v.notFound('Bill');
  const items = all('SELECT * FROM bill_items WHERE bill_id = ? ORDER BY position', billId);
  const customerExists = bill.customer_id
    && get('SELECT 1 FROM customers WHERE id = ? AND business_id = ?', bill.customer_id, businessId);
  return saveDraft(businessId, userId, null, {
    // A saved customer is reused as-is; otherwise carry over the name / WhatsApp number typed on the bill.
    ...(customerExists
      ? { customer_id: bill.customer_id }
      : { customer_name: bill.customer_name, customer_phone: bill.customer_phone }),
    bill_date: billDate,
    notes: bill.notes,
    discount_pct: bill.discount_pct,
    photo_source: bill.photo_source,
    items: items.map((i) => {
      const productExists = i.product_id && get('SELECT 1 FROM products WHERE id = ? AND business_id = ?', i.product_id, businessId);
      return {
        product_id: productExists ? i.product_id : null,
        name: i.name, quantity: i.quantity, unit_price: i.unit_price, discount_pct: i.discount_pct, unit: i.unit,
      };
    }),
  });
}

/**
 * Record a payment on a created bill. With settle, the customer paid less and the rest is let go: it becomes a
 * discount at payment (settle_discount) that lowers the total, so the bill is fully paid. The amount may then be 0.
 */
export function addPayment(businessId, userId, billId, body, { at = null } = {}) {
  return tx(() => {
    const bill = get('SELECT * FROM bills WHERE id = ? AND business_id = ?', billId, businessId);
    if (!bill) throw v.notFound('Bill');
    if (bill.status === 'draft') throw v.conflict('Finalize the bill before recording a payment.');
    if (bill.status === 'cancelled') throw v.conflict('Payments cannot be recorded on a cancelled bill.');
    const balance = bill.total - bill.amount_paid;
    const settle = v.bool(body.settle);
    if (settle && balance <= 0) throw v.conflict('This bill is already fully paid.');
    const p = settle && !Number(body.amount) ? null : validatePayment(body, balance, bill.currency, bill.bill_date);
    const rest = settle ? balance - (p ? p.amount : 0) : 0;
    if (rest > 0) {
      run(
        `UPDATE bills SET settle_discount = settle_discount + ?, discount_total = discount_total + ?,
           taxable_total = taxable_total - ?, total = total - ?, updated_at = ? WHERE id = ?`,
        rest, rest, rest, rest, nowIso(), billId,
      );
    }
    if (p) insertPayment(businessId, userId, billId, p, at);
    else refreshPaymentTotals(billId);
  });
}

export function deletePayment(businessId, billId, paymentId) {
  return tx(() => {
    const res = run('DELETE FROM payments WHERE id = ? AND bill_id = ? AND business_id = ?', paymentId, billId, businessId);
    if (res.changes !== 1) throw v.notFound('Payment');
    refreshPaymentTotals(billId);
  });
}

export function enableShare(businessId, billId, { regenerate = false } = {}) {
  return tx(() => {
    const bill = get('SELECT status, share_token FROM bills WHERE id = ? AND business_id = ?', billId, businessId);
    if (!bill) throw v.notFound('Bill');
    if (bill.status === 'draft') throw v.conflict('Finalize the bill before sharing it.');
    if (bill.share_token && !regenerate) return bill.share_token;
    const token = crypto.randomBytes(24).toString('base64url');
    run('UPDATE bills SET share_token = ?, share_created_at = ? WHERE id = ?', token, nowIso(), billId);
    return token;
  });
}

export function revokeShare(businessId, billId) {
  const res = run('UPDATE bills SET share_token = NULL, share_created_at = NULL WHERE id = ? AND business_id = ?', billId, businessId);
  if (res.changes !== 1) throw v.notFound('Bill');
}

/** Everything needed to render an invoice (HTML or PDF). */
export function loadInvoice(billRow) {
  const business = serializeBusiness(getBusiness(billRow.business_id));
  const items = all('SELECT * FROM bill_items WHERE bill_id = ? ORDER BY position', billRow.id);
  const payments = all('SELECT id, amount, method, reference, note, paid_on, created_at FROM payments WHERE bill_id = ? ORDER BY paid_on, id', billRow.id);
  return { business, bill: serializeBill(billRow), items, payments };
}

export function getLogo(businessId) {
  return get('SELECT logo_mime, logo_data FROM businesses WHERE id = ?', businessId);
}
