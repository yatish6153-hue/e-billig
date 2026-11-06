import { get } from '../db.js';

// Everything except the logo blob.
export const BUSINESS_COLUMNS = `id, name, address, phone, email, website, gstin, logo_mime, logo_updated_at, currency,
  invoice_prefix, next_invoice_no, tax_label, default_tax_rate, tax_rates, prices_include_tax, split_tax,
  round_off, default_with_gst, payment_details, upi_id, invoice_terms, tagline, bill_color, bill_header, created_at, updated_at`;

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
    has_logo: !!b.logo_mime,
    logo_url: b.logo_mime ? `/api/settings/logo?v=${encodeURIComponent(b.logo_updated_at || '')}` : null,
  };
}

export { invoiceNumber } from '../../shared/format.js';
