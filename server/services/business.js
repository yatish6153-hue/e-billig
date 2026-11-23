import { get, all } from '../db.js';
import * as v from '../util.js';
import { EXPENSE_CATEGORIES } from '../../shared/format.js';

// ---- Checks for the business's settings, used when they're saved in Settings and when a backup is restored ----

export function billColor(value) {
  const s = String(value || '#f26b1d').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) throw v.badRequest('Choose a bill colour like #f26b1d.', 'bill_color');
  return s.toLowerCase();
}

export function invoicePrefix(value) {
  const prefix = v.text(value, 'invoice_prefix', 'Invoice prefix', { max: 12 });
  if (prefix && !/^[A-Za-z0-9/_#.-]+$/.test(prefix)) {
    throw v.badRequest('Invoice prefix can use letters, numbers and - / _ # . only.', 'invoice_prefix');
  }
  return prefix;
}

/** The UPI ID customers pay the balance to, like yourname@okaxis. */
export function upiId(value) {
  const s = v.text(value, 'upi_id', 'UPI ID', { max: 100 }).replace(/\s/g, '').toLowerCase();
  if (s && !/^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,63}$/.test(s)) throw v.badRequest('Enter a UPI ID like yourname@okaxis.', 'upi_id');
  return s;
}

/** A website like www.deveshstudio.com (https:// is optional and dropped); the bill links it over https. */
export function website(value) {
  const s = v.text(value, 'website', 'Website', { max: 120 }).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (s && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24}(\/[^\s<>"']*)?$/i.test(s)) {
    throw v.badRequest('Enter a website like www.yourstudio.com.', 'website');
  }
  // The domain in lower case; a path keeps its case.
  const slash = s.indexOf('/');
  return slash < 0 ? s.toLowerCase() : s.slice(0, slash).toLowerCase() + s.slice(slash);
}

/**
 * The link customers review the business at (Google's "share" or g.page link, say), printed on bills with a
 * QR code. https:// is added when left off; anything but an http(s) web address is refused.
 */
export function reviewUrl(value) {
  let s = v.text(value, 'review_url', 'Review link', { max: 300 });
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let url = null;
  try {
    url = new URL(s);
  } catch {
    // Not a web address; refused below.
  }
  if (!url || /[\s<>"'`\\]/.test(s) || url.username || url.password || !/^[a-z0-9.-]+\.[a-z]{2,24}$/i.test(url.hostname)) {
    throw v.badRequest('Enter your review link, like https://g.page/r/…/review.', 'review_url');
  }
  return s;
}

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
