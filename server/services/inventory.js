import { get, run, nowIso } from '../db.js';
import { roundQty } from '../../shared/format.js';
import { notFound } from '../util.js';

export const MOVEMENT_TYPES = ['opening', 'purchase', 'adjustment', 'sale', 'sale_cancel'];

/**
 * Change a product's stock and record the movement. Must run inside tx().
 * delta is signed: positive adds stock, negative removes it.
 */
export function applyStockChange(businessId, productId, delta, type, { billId = null, userId = null, note = '', unitCost = null, at = null } = {}) {
  const when = at || nowIso();
  const change = roundQty(delta);
  const res = run(
    'UPDATE products SET quantity = ROUND(quantity + ?, 3), updated_at = ? WHERE id = ? AND business_id = ?',
    change, when, productId, businessId,
  );
  if (res.changes !== 1) throw notFound('Product');
  const { quantity } = get('SELECT quantity FROM products WHERE id = ?', productId);
  run(
    `INSERT INTO stock_movements (business_id, product_id, type, quantity, balance_after, unit_cost, bill_id, note, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    businessId, productId, type, change, quantity, unitCost, billId, note, userId, when,
  );
  return quantity;
}

export function serializeProduct(p) {
  const isService = p.kind === 'service';
  return {
    ...p,
    archived: !!p.archived,
    is_demo: !!p.is_demo,
    is_service: isService,
    // Oversold (negative) stock has no value, matching the dashboard total.
    stock_value: isService ? 0 : Math.round(Math.max(0, p.quantity) * p.purchase_price),
    is_low: !isService && !p.archived && p.quantity <= p.low_stock_threshold,
  };
}

// SQL fragment for "goods at or below their alert level" (services never run low).
export const LOW_STOCK_SQL = "kind = 'goods' AND archived = 0 AND quantity <= low_stock_threshold";
