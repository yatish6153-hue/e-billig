// Formatting helpers shared by the server and the browser.
// Money is always handled in minor units (paise/cents) as integers.

export const CURRENCIES = {
  INR: { symbol: '₹', locale: 'en-IN', name: 'Indian Rupee', major: ['Rupee', 'Rupees'], minor: ['Paisa', 'Paise'], indian: true },
  USD: { symbol: '$', locale: 'en-US', name: 'US Dollar', major: ['Dollar', 'Dollars'], minor: ['Cent', 'Cents'] },
  EUR: { symbol: '€', locale: 'en-IE', name: 'Euro', major: ['Euro', 'Euros'], minor: ['Cent', 'Cents'] },
  GBP: { symbol: '£', locale: 'en-GB', name: 'British Pound', major: ['Pound', 'Pounds'], minor: ['Penny', 'Pence'] },
  AED: { symbol: 'AED ', locale: 'en-US', name: 'UAE Dirham', major: ['Dirham', 'Dirhams'], minor: ['Fils', 'Fils'] },
  SGD: { symbol: 'S$', locale: 'en-SG', name: 'Singapore Dollar', major: ['Dollar', 'Dollars'], minor: ['Cent', 'Cents'] },
  AUD: { symbol: 'A$', locale: 'en-AU', name: 'Australian Dollar', major: ['Dollar', 'Dollars'], minor: ['Cent', 'Cents'] },
  CAD: { symbol: 'C$', locale: 'en-CA', name: 'Canadian Dollar', major: ['Dollar', 'Dollars'], minor: ['Cent', 'Cents'] },
  NPR: { symbol: 'Rs ', locale: 'en-IN', name: 'Nepalese Rupee', major: ['Rupee', 'Rupees'], minor: ['Paisa', 'Paisa'], indian: true },
  LKR: { symbol: 'Rs ', locale: 'en-US', name: 'Sri Lankan Rupee', major: ['Rupee', 'Rupees'], minor: ['Cent', 'Cents'] },
  BDT: { symbol: 'Tk ', locale: 'en-IN', name: 'Bangladeshi Taka', major: ['Taka', 'Taka'], minor: ['Poisha', 'Poisha'], indian: true },
};

export const DEFAULT_CURRENCY = 'INR';

export function currencyInfo(code) {
  return CURRENCIES[code] || CURRENCIES[DEFAULT_CURRENCY];
}

const numberFormats = new Map();
function numberFormat(locale, digits) {
  const key = `${locale}|${digits}`;
  let nf = numberFormats.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    numberFormats.set(key, nf);
  }
  return nf;
}

/** 123456 -> "1,234.56" (grouping follows the currency's locale) */
export function formatAmount(minor, currency = DEFAULT_CURRENCY) {
  const info = currencyInfo(currency);
  return numberFormat(info.locale, 2).format((Number(minor) || 0) / 100);
}

/** 123456 -> "₹1,234.56" */
export function formatMoney(minor, currency = DEFAULT_CURRENCY) {
  const value = Number(minor) || 0;
  const info = currencyInfo(currency);
  const sign = value < 0 ? '-' : '';
  return `${sign}${info.symbol}${formatAmount(Math.abs(value), currency)}`;
}

/** Parse user input like "1,234.5" into minor units (123450). Returns NaN when invalid. */
export function toMinor(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : NaN;
  const s = String(input ?? '').replace(/[,\s]/g, '').trim();
  if (s === '') return NaN;
  if (!/^-?\d*(\.\d{0,2})?$/.test(s) || s === '-' || s === '.') return NaN;
  return Math.round(Number(s) * 100);
}

/** 123450 -> "1234.50" (for input fields, no grouping) */
export function fromMinor(minor) {
  const value = Number(minor) || 0;
  return (value / 100).toFixed(2);
}

/** Quantities keep up to 3 decimals: 2 -> "2", 1.5 -> "1.5" */
export function formatQty(qty) {
  return String(Math.round((Number(qty) || 0) * 1000) / 1000);
}

export function roundQty(qty) {
  return Math.round((Number(qty) || 0) * 1000) / 1000;
}

export function formatPercent(rate) {
  const n = Math.round((Number(rate) || 0) * 100) / 100;
  return `${n}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-03" -> "03 Nov 2026" */
export function formatDate(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return String(iso);
  return `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** ISO timestamp -> "03 Nov 2026, 2:15 pm" in the viewer's local time */
export function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const date = `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  let h = d.getHours();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${date}, ${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

/** Local date as YYYY-MM-DD */
export function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return isoDate(dt);
}

/** Invoice numbers are the prefix plus a 4-digit padded counter: INV-0001. */
export function invoiceNumber(prefix, n) {
  return `${prefix}${String(n).padStart(4, '0')}`;
}

const HTML_ESCAPES ={ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Kept deliberately simple: cash in hand, or online (UPI / card / bank — noted in the reference).
export const PAYMENT_METHODS = {
  cash: 'Cash',
  online: 'Online',
};

/** WhatsApp wants international digits only; add India's code to 10-digit numbers for INR businesses. */
export function whatsappNumber(phone, currency) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10 && currency === 'INR') digits = `91${digits}`;
  return digits.length >= 8 ? digits : '';
}

// What the day book holds besides bills: sales without a bill, money that came in, and expenses.
export const DAY_ENTRY_KINDS = {
  sale: 'Sale',
  received: 'Money received',
  expense: 'Expense',
};

// Where a studio's money usually goes. "Other" plus the "paid to" note covers the rest.
export const EXPENSE_CATEGORIES = [
  'Lab & printing', 'Frames & material', 'Rent', 'Salary', 'Electricity', 'Phone & internet',
  'Travel & fuel', 'Food & tea', 'Equipment & repair', 'Marketing', 'Other',
];

export const PAYMENT_STATUS_LABELS = {
  unpaid: 'Unpaid',
  partial: 'Partially paid',
  paid: 'Paid',
};

/** Single status used for badges: draft | cancelled | unpaid | partial | paid */
export function billDisplayStatus(bill) {
  if (bill.status === 'draft') return 'draft';
  if (bill.status === 'cancelled') return 'cancelled';
  return bill.payment_status || 'unpaid';
}

export const DISPLAY_STATUS_LABELS = {
  draft: 'Draft',
  cancelled: 'Cancelled',
  unpaid: 'Unpaid',
  partial: 'Partially paid',
  paid: 'Paid',
};
