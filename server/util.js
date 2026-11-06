// Errors and input validation. Validators throw HttpError(400) with a
// human-readable message and the offending field name so the UI can highlight it.

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.field = extra.field;
    this.code = extra.code;
    this.details = extra.details;
  }
}

export const badRequest = (message, field) => new HttpError(400, message, { field });
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found.`);
export const conflict = (message, extra) => new HttpError(409, message, extra);

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

export function text(value, field, label, { max = 200, required = false, multiline = false } = {}) {
  if (isBlank(value)) {
    if (required) throw badRequest(`${label} is required.`, field);
    return '';
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw badRequest(`${label} must be text.`, field);
  let s = String(value).trim();
  if (!multiline) s = s.replace(/\s+/g, ' ');
  // Strip control characters except newlines/tabs in multiline text.
  s = s.replace(multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, '');
  if (required && !s) throw badRequest(`${label} is required.`, field);
  if (s.length > max) throw badRequest(`${label} must be ${max} characters or fewer.`, field);
  return s;
}

export function number(value, field, label, { min = -Infinity, max = Infinity, decimals = 3, required = true, fallback = 0 } = {}) {
  if (isBlank(value)) {
    if (required) throw badRequest(`${label} is required.`, field);
    return fallback;
  }
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(n)) throw badRequest(`${label} must be a number.`, field);
  const factor = 10 ** decimals;
  const rounded = Math.round(n * factor) / factor;
  if (Math.abs(rounded - n) > 1e-9) throw badRequest(`${label} can have at most ${decimals} decimal places.`, field);
  if (rounded < min) throw badRequest(min === 0 ? `${label} cannot be negative.` : `${label} must be at least ${min}.`, field);
  if (rounded > max) throw badRequest(`${label} must be at most ${max}.`, field);
  return rounded;
}

export function integer(value, field, label, opts = {}) {
  return number(value, field, label, { ...opts, decimals: 0 });
}

/** Money arrives in minor units (integer paise). */
export function money(value, field, label, { required = true, min = 0, max = 1e12 } = {}) {
  if (isBlank(value)) {
    if (required) throw badRequest(`${label} is required.`, field);
    return 0;
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest(`${label} must be a valid amount.`, field);
  if (n < min) throw badRequest(min === 0 ? `${label} cannot be negative.` : `${label} must be greater than zero.`, field);
  if (n > max) throw badRequest(`${label} is too large.`, field);
  return n;
}

export function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

export function oneOf(value, options, field, label) {
  if (!options.includes(value)) throw badRequest(`${label} is not valid.`, field);
  return value;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function email(value, field, label = 'Email', { required = false } = {}) {
  const s = text(value, field, label, { max: 254, required }).toLowerCase();
  if (s && !EMAIL_RE.test(s)) throw badRequest(`${label} is not a valid email address.`, field);
  return s;
}

export function phone(value, field, label = 'Phone', { required = false } = {}) {
  const s = text(value, field, label, { max: 20, required });
  if (!s) return s;
  if (!/^\+?[\d\s\-()]{7,20}$/.test(s)) throw badRequest(`${label} should contain only digits, spaces, + or -.`, field);
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) throw badRequest(`${label} should have 7 to 15 digits.`, field);
  return s;
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export function gstin(value, field, label = 'GSTIN') {
  const s = text(value, field, label, { max: 15 }).toUpperCase().replace(/\s/g, '');
  if (s && !GSTIN_RE.test(s)) throw badRequest(`${label} must be a valid 15-character GSTIN (e.g. 27ABCDE1234F1Z5).`, field);
  return s;
}

export function date(value, field, label, { required = true } = {}) {
  if (isBlank(value)) {
    if (required) throw badRequest(`${label} is required.`, field);
    return null;
  }
  const s = String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw badRequest(`${label} must be a valid date.`, field);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw badRequest(`${label} must be a valid date.`, field);
  }
  if (+m[1] < 2000 || +m[1] > 2100) throw badRequest(`${label} must be between 2000 and 2100.`, field);
  return s;
}

export function id(value, label = 'Record') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw notFound(label);
  return n;
}

/** Pagination from query string. */
export function paging(query, { defaultLimit = 25, maxLimit = 200 } = {}) {
  let limit = Number.parseInt(query.limit, 10);
  let offset = Number.parseInt(query.offset, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = defaultLimit;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit: Math.min(limit, maxLimit), offset };
}

/** Escape LIKE wildcards; use with ESCAPE '\\'. */
export function likePattern(q) {
  return `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** SQL expression for a phone column with spaces, dashes, brackets and + removed. */
export const PHONE_DIGITS_SQL = (col) =>
  `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${col}, ' ', ''), '-', ''), '+', ''), '(', ''), ')', '')`;

/** LIKE pattern on the digits of a search term; matches nothing when the term has no digits. */
export function digitsPattern(q) {
  const digits = String(q).replace(/\D/g, '');
  return digits ? `%${digits}%` : '\u0000';
}

export function optionalDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null;
}

/** CSV cell: quote, and neutralise spreadsheet formulas in text cells. */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header, rows) {
  return `﻿${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export const major = (minor) => Math.round(Number(minor) || 0) / 100;
