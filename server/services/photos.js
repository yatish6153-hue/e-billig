// Photos of a job (bill): the customer's photo, so it's clear later which one the job is for. The browser makes each
// photo smaller before sending it (up to about 1600 px) together with a small copy for lists; both are kept in the
// database, and only the business's own logins can see them (never the customer's bill link).
import { get, all, run, tx, nowIso } from '../db.js';
import * as v from '../util.js';

export const MAX_PHOTOS = 20;
// The upload is JSON, so both copies (as base64) have to fit in the 2 MB a request may carry.
const MAX_BYTES = 1200 * 1024;
const MAX_THUMB_BYTES = 150 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** What the bytes really are, whatever the upload says: JPEG, PNG or WebP, else null. */
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(PNG)) return 'image/png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function readImage(value, field, maxBytes) {
  const m = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]+={0,2})$/.exec(typeof value === 'string' ? value : '');
  if (!m) throw v.badRequest('Choose a photo (JPEG, PNG or WebP).', field);
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > maxBytes) throw v.badRequest(`That photo is too large (${Math.round(maxBytes / 1024)} KB at most).`, field);
  const mime = imageType(buf);
  if (!mime) throw v.badRequest('That file is not a JPEG, PNG or WebP photo.', field);
  return { mime, buf };
}

const pixels = (n) => (Number.isInteger(n) && n > 0 && n <= 20_000 ? n : 0);

export const photoUrls = (billId, photoId) => ({
  url: `/api/bills/${billId}/photos/${photoId}`,
  thumb_url: `/api/bills/${billId}/photos/${photoId}/thumb`,
});

/** A bill's photos, oldest first. */
export function listPhotos(businessId, billId) {
  return all(
    'SELECT id, width, height, bytes, created_at FROM bill_photos WHERE bill_id = ? AND business_id = ? ORDER BY id',
    billId, businessId,
  ).map((p) => ({ ...p, ...photoUrls(billId, p.id) }));
}

/** The photos of several bills (for a list of jobs): bill id -> [{ id, url, thumb_url }]. */
export function photosByBill(businessId, billIds) {
  const out = new Map(billIds.map((id) => [id, []]));
  if (!billIds.length) return out;
  for (const p of all(
    `SELECT id, bill_id FROM bill_photos
      WHERE business_id = ? AND bill_id IN (SELECT value FROM json_each(?)) ORDER BY bill_id, id`,
    businessId, JSON.stringify(billIds),
  )) out.get(p.bill_id).push({ id: p.id, ...photoUrls(p.bill_id, p.id) });
  return out;
}

/** Add one photo ({ image, thumb } as data URLs, with the big one's width and height) to a bill that isn't cancelled. */
export function addPhoto(businessId, userId, billId, body) {
  const image = readImage(body.image, 'image', MAX_BYTES);
  const thumb = readImage(body.thumb, 'thumb', MAX_THUMB_BYTES);
  return tx(() => {
    const bill = get('SELECT status FROM bills WHERE id = ? AND business_id = ?', billId, businessId);
    if (!bill) throw v.notFound('Bill');
    if (bill.status === 'cancelled') throw v.conflict('This bill is cancelled, so photos can’t be added.');
    const { n } = get('SELECT COUNT(*) AS n FROM bill_photos WHERE bill_id = ?', billId);
    if (n >= MAX_PHOTOS) throw v.conflict(`A job can have up to ${MAX_PHOTOS} photos. Remove one to add another.`);
    const res = run(
      `INSERT INTO bill_photos (business_id, bill_id, mime, data, thumb_mime, thumb, width, height, bytes, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      businessId, billId, image.mime, image.buf, thumb.mime, thumb.buf, pixels(body.width), pixels(body.height),
      image.buf.length, userId, nowIso(),
    );
    return Number(res.lastInsertRowid);
  });
}

export function deletePhoto(businessId, billId, photoId) {
  const res = run('DELETE FROM bill_photos WHERE id = ? AND bill_id = ? AND business_id = ?', photoId, billId, businessId);
  if (!res.changes) throw v.notFound('Photo');
}

/** Send a photo. It never changes under its id (ids aren't used twice), so the browser can keep it. */
export function sendPhoto(res, photo) {
  res.setHeader('Content-Type', photo.mime);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(photo.data);
}

/** The photo's bytes (or its small copy's) and type. */
export function photoFile(businessId, billId, photoId, { thumb = false } = {}) {
  const row = get(
    `SELECT ${thumb ? 'thumb_mime AS mime, thumb AS data' : 'mime, data'} FROM bill_photos WHERE id = ? AND bill_id = ? AND business_id = ?`,
    photoId, billId, businessId,
  );
  if (!row) throw v.notFound('Photo');
  return { mime: row.mime, data: Buffer.from(row.data) };
}
