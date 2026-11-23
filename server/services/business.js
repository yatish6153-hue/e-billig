import { get, all } from '../db.js';
import { EXPENSE_CATEGORIES } from '../../shared/format.js';

/**
 * The product categories: the owner's list (in their order), then any other category an item uses, A to Z.
 * Names match without regard to case. counts: how many items (archived too) are in each.
 */
export function productCategories(businessId) {
  let saved = [];
  try {
    const list = JSON.parse(get('SELECT product_categories FROM businesses WHERE id = ?', businessId)?.product_categories || '[]');
    if (Array.isArray(list)) saved = list.map(String);
  } catch {
    // A broken value: the categories the items use.
  }
  const used = all(
    `SELECT category, COUNT(*) AS n FROM products WHERE business_id = ? AND category <> ''
      GROUP BY category COLLATE NOCASE ORDER BY category COLLATE NOCASE`,
    businessId,
  );
  const count = new Map(used.map((r) => [r.category.toLowerCase(), r.n]));
  const seen = new Set(saved.map((c) => c.toLowerCase()));
  const categories = [...saved, ...used.map((r) => r.category).filter((c) => !seen.has(c.toLowerCase()))];
  return { categories, counts: Object.fromEntries(categories.map((c) => [c, count.get(c.toLowerCase()) || 0])) };
}

// Everything except the logo blob.
export const BUSINESS_COLUMNS = `id, name, address, phone, email, website, review_url, gstin, logo_mime, logo_updated_at, currency,
  invoice_prefix, next_invoice_no, tax_label, default_tax_rate, tax_rates, prices_include_tax, split_tax,
  round_off, default_with_gst, payment_details, upi_id, invoice_terms, tagline, bill_color, bill_header, expense_types,
  created_at, updated_at`;

/** The day book's expense types: the owner's own list, or the standard one until they change it. */
export function parseExpenseTypes(value) {
  try {
    const list = JSON.parse(value || 'null');
    if (Array.isArray(list) && list.length) return list.map(String);
  } catch {
    // A broken value falls back to the standard list.
  }
  return EXPENSE_CATEGORIES.slice();
}

export function getBusiness(businessId) {
  return get(`SELECT ${BUSINESS_COLUMNS} FROM businesses WHERE id = ?`, businessId);
}

export function parseRates(value) {
  const rates = String(value || '')
    .split(',')
    .filter((s) => s.trim() !== '')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
  return [...new Set(rates)].sort((a, b) => a - b);
}

export function serializeBusiness(b) {
  return {
    ...b,
    prices_include_tax: !!b.prices_include_tax,
    split_tax: !!b.split_tax,
    round_off: !!b.round_off,
    default_with_gst: !!b.default_with_gst,
    tax_rates: parseRates(b.tax_rates),
    expense_types: parseExpenseTypes(b.expense_types),
    has_logo: !!b.logo_mime,
    logo_url: b.logo_mime ? `/api/settings/logo?v=${encodeURIComponent(b.logo_updated_at || '')}` : null,
  };
}

export { invoiceNumber } from '../../shared/format.js';
