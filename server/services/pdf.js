// Studio-style A4 bill PDF (pdfkit + bundled Inter, which has the ₹ glyph).
// Mirrors the HTML bill: a warm-black header band with a glow and lens rings, accent bar, "● LABEL" eyebrows,
// the customer in viewfinder corners, numbered items, stamp, Total / Advance / Balance, the "Review us on
// Google." card with its button, and on every page a film strip carrying the business's phone, email,
// website and address.
import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatMoney, formatQty, formatDate } from '../../shared/format.js';
import {
  invoiceTitle, invoiceTotals, paymentRows, stampFor, billColor, onAccent, billContacts, reviewLink, reviewCopy, frameNo,
  BILL_ICONS, BILL_STAR, STAR_COLOR,
} from '../../shared/invoice-html.js';
import { upiPayment, qrMatrix } from './upi.js';

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fonts');
const INK = '#16181d';
const MUTED = '#6b7280';
const LINE = '#e3e3e3';
const BAND = '#0d0a08';
const BAND_LIGHT_REEL = '#261e19';
// Amounts use tabular figures, as on screen: Inter's kerning otherwise tucks the decimal point of 7.14 under the digits.
const TNUM = ['tnum'];
const STAMP_COLORS = { paid: '#15803d', cancelled: '#dc2626', draft: '#94a3b8' };

/** Blend two #rrggbb colours; t is the share of `other`. */
function mix(hex, other, t) {
  const a = hex.match(/\w\w/g).map((h) => parseInt(h, 16));
  const b = other.match(/\w\w/g).map((h) => parseInt(h, 16));
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** One of the bill's 24×24 line icons, `size` points square with its top-left at x, y. */
function drawIcon(doc, key, x, y, size, color) {
  doc.save();
  doc.translate(x, y).scale(size / 24);
  doc.lineWidth(2).lineCap('round').lineJoin('round').strokeColor(color);
  for (const d of BILL_ICONS[key]) doc.path(d).stroke();
  doc.restore();
}

/** The filled review star, `size` points square with its top-left at x, y. */
function drawStar(doc, x, y, size) {
  doc.save();
  doc.translate(x, y).scale(size / 24);
  doc.path(BILL_STAR).fill(STAR_COLOR);
  doc.restore();
}

const FRAME_H = 20;
const FRAME_GAP = 6;
const REEL_PAD = 17;

/**
 * Where the film strip's contact frames go: phone, email and website as frames in centred rows, then
 * the address on its own line(s). Returns the rows, the address height and the strip's total height.
 */
function reelLayout(doc, contacts, maxW) {
  const frames = contacts.filter((c) => c.key !== 'pin');
  const address = contacts.find((c) => c.key === 'pin');
  doc.font('S').fontSize(8.5);
  const rows = [];
  let row = [];
  let rowW = 0;
  for (const c of frames) {
    const w = Math.min(23 + doc.widthOfString(c.text) + 9, maxW);
    if (row.length && rowW + FRAME_GAP + w > maxW) {
      rows.push({ items: row, w: rowW });
      row = [];
      rowW = 0;
    }
    row.push({ ...c, w });
    rowW += (row.length > 1 ? FRAME_GAP : 0) + w;
  }
  if (row.length) rows.push({ items: row, w: rowW });
  doc.font('R').fontSize(8);
  const addrW = address ? Math.min(doc.widthOfString(address.text), maxW - 16) : 0;
  const addrH = address ? doc.heightOfString(address.text, { width: addrW + 1 }) : 0;
  if (!contacts.length) return { rows, address, addrW, addrH, height: 30 };
  const framesH = rows.length * FRAME_H + Math.max(0, rows.length - 1) * FRAME_GAP;
  return { rows, address, addrW, addrH, height: REEL_PAD * 2 + framesH + (address ? (rows.length ? 7 : 0) + addrH : 0) };
}

export function renderInvoicePdf({ business, bill, items }, logo) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: {
    Title: `${bill.invoice_no || `Draft ${bill.id}`} — ${business.name}`, Author: business.name,
  } });
  doc.registerFont('R', path.join(FONT_DIR, 'Inter-Regular.ttf'));
  doc.registerFont('S', path.join(FONT_DIR, 'Inter-SemiBold.ttf'));
  doc.registerFont('B', path.join(FONT_DIR, 'Inter-Bold.ttf'));

  const accent = billColor(business);
  const accentSoft = mix(accent, '#ffffff', 0.9);
  const dark = business.bill_header !== 'light';
  const money = (v) => formatMoney(v, bill.currency);
  const gst = !!bill.with_gst;
  const incl = gst && !!bill.prices_include_tax;
  const PW = doc.page.width;
  const PH = doc.page.height;
  const M = 40;
  const W = PW - 2 * M;
  const contacts = billContacts(business);
  const reel = reelLayout(doc, contacts, W);
  const bottom = () => PH - reel.height - 50; // room for the thank-you line and film strip

  /** "● LABEL": a dot, then the label in capitals, in the business colour (right-aligned within width if asked). */
  const eyebrow = (text, x, y, { size = 7.5, spacing = 1.3, color = accent, right = false, width = 0 } = {}) => {
    const label = text.toUpperCase();
    doc.font('B').fontSize(size);
    const tw = doc.widthOfString(label, { characterSpacing: spacing });
    const r = size * 0.27;
    const tx = right ? x + width - tw : x + 2 * r + 5;
    doc.circle(tx - 5 - r, y + size * 0.6, r).fill(color);
    doc.fillColor(color).text(label, tx, y, { characterSpacing: spacing, lineBreak: false });
  };

  // ---- Header band ------------------------------------------------------------
  const bandH = 108;
  doc.rect(0, 0, PW, bandH).fill(dark ? BAND : '#ffffff');
  // A glow of the business colour from the top right, like a studio light.
  const glow = doc.radialGradient(PW, 0, 0, PW, 0, PW * 0.66);
  glow.stop(0, accent, dark ? 0.4 : 0.13).stop(1, accent, 0);
  doc.rect(0, 0, PW, bandH).fill(glow);
  // Faint lens rings in the business colour, behind the bill number.
  doc.save();
  doc.rect(0, 0, PW, bandH).clip();
  doc.lineWidth(1.1).strokeColor(accent).strokeOpacity(dark ? 0.2 : 0.13);
  for (let r = 14; r <= 112; r += 14) doc.circle(PW - 56, 30, r).stroke();
  doc.restore();
  if (!dark) doc.moveTo(0, bandH - 0.5).lineTo(PW, bandH - 0.5).lineWidth(1).strokeColor(LINE).stroke();
  let x = M;
  if (logo?.logo_data) {
    try {
      const img = doc.openImage(Buffer.from(logo.logo_data));
      const s = Math.min(112 / img.width, 66 / img.height);
      doc.image(img, M, (bandH - img.height * s) / 2, { width: img.width * s, height: img.height * s });
      x = M + img.width * s + 14;
    } catch {
      // Unsupported image — skip the logo rather than failing the bill.
    }
  }
  const nameW = PW * 0.62 - x;
  doc.font('B').fontSize(18);
  const nameH = doc.heightOfString(business.name, { width: nameW });
  const tagH = business.tagline ? 14 : 0;
  const ny = (bandH - nameH - tagH) / 2;
  doc.fillColor(dark ? '#ffffff' : INK).text(business.name, x, ny, { width: nameW });
  if (business.tagline) {
    // On the dark band the tagline is marigold, a warmer shade of the business colour.
    doc.font('S').fontSize(7.5).fillColor(dark ? mix(accent, '#ffc857', 0.45) : accent)
      .text(business.tagline.toUpperCase(), x, ny + nameH + 3, { width: nameW, characterSpacing: 1.6 });
  }
  const rw = 170;
  const rx = PW - M - rw;
  const ry = (bandH - 50) / 2;
  eyebrow(invoiceTitle(bill, business), rx, ry, { size: 8.5, spacing: 2.2, right: true, width: rw });
  doc.font('B').fontSize(19).fillColor(dark ? '#ffffff' : INK).text(bill.invoice_no || `#${bill.id}`, rx, ry + 12.5, { width: rw, align: 'right' });
  doc.font('R').fontSize(9).fillColor(dark ? '#a3a3a3' : MUTED).text(formatDate(bill.bill_date), rx, ry + 37, { width: rw, align: 'right' });
  doc.rect(0, bandH, PW, 5).fill(accent);

  // ---- Billed to / from: the customer in a camera's viewfinder ----------------
  let y = bandH + 5 + 22;
  const VF_X = 13;
  const VF_Y = 11;
  const toName = bill.customer_name || 'Walk-in customer';
  const toLines = [bill.customer_phone && `WhatsApp: ${bill.customer_phone}`, bill.customer_address, bill.customer_email,
    gst && bill.customer_gstin && `GSTIN ${bill.customer_gstin}`].filter(Boolean);
  const toMaxW = (gst && business.gstin ? W * 0.52 : W * 0.6) - 2 * VF_X; // clear of the GSTIN on the right
  doc.font('B').fontSize(13);
  let toW = doc.widthOfString(toName);
  doc.font('R').fontSize(9);
  for (const line of toLines) toW = Math.max(toW, ...String(line).split(/\r?\n/).map((l) => doc.widthOfString(l)));
  const boxW = Math.min(Math.max(toW, 170), toMaxW) + 2 * VF_X;
  const toX = M + VF_X;
  const toInnerW = boxW - 2 * VF_X + 1;
  eyebrow('Billed to', toX, y + VF_Y);
  doc.font('B').fontSize(13).fillColor(INK).text(toName, toX, y + VF_Y + 13, { width: toInnerW });
  doc.font('R').fontSize(9).fillColor('#374151');
  for (const line of toLines) doc.text(line, toX, doc.y + 1, { width: toInnerW });
  const toBottom = doc.y + VF_Y;
  // Four corner marks, inset by half the line width.
  {
    const L = 11;
    const t = 0.8;
    const [x1, y1, x2, y2] = [M + t, y + t, M + boxW - t, toBottom - t];
    doc.save().lineWidth(2 * t).lineCap('butt').lineJoin('miter').strokeColor(mix(accent, '#ffffff', 0.25));
    doc.moveTo(x1, y1 + L).lineTo(x1, y1).lineTo(x1 + L, y1).stroke();
    doc.moveTo(x2 - L, y1).lineTo(x2, y1).lineTo(x2, y1 + L).stroke();
    doc.moveTo(x1, y2 - L).lineTo(x1, y2).lineTo(x1 + L, y2).stroke();
    doc.moveTo(x2 - L, y2).lineTo(x2, y2).lineTo(x2, y2 - L).stroke();
    doc.restore();
  }
  let fy = y;
  // The business's address, phone, email and website are in the film strip; only a GST bill's GSTIN stays here.
  if (gst && business.gstin) {
    doc.font('R').fontSize(8.5).fillColor(MUTED).text(`GSTIN ${business.gstin}`, M + W * 0.55, fy, { width: W * 0.45, align: 'right' });
    fy = doc.y + 1;
  }
  y = Math.max(toBottom, fy) + 22;

  // ---- Items ----------------------------------------------------------------
  const showDisc = items.some((i) => Number(i.discount_pct) > 0);
  const showTax = gst && items.some((i) => Number(i.tax_rate) > 0);
  const cols = [
    { key: 'no', label: '#', w: 24 },
    { key: 'item', label: 'Item', w: 0 },
    { key: 'qty', label: 'Qty', w: 60, align: 'right' },
    { key: 'rate', label: incl ? 'Rate (incl. GST)' : 'Rate', w: 84, align: 'right' },
    ...(showDisc ? [{ key: 'disc', label: 'Disc.', w: 44, align: 'right' }] : []),
    ...(showTax ? [{ key: 'tax', label: bill.tax_label || 'GST', w: 44, align: 'right' }] : []),
    { key: 'amount', label: 'Amount', w: 88, align: 'right' },
  ];
  const itemCol = cols[1];
  itemCol.w = W - cols.reduce((a, c) => a + c.w, 0);
  const PAD = 6;
  const pct = (r) => `${Math.round(Number(r) * 100) / 100}%`;
  const cellX = (i) => M + cols.slice(0, i).reduce((a, c) => a + c.w, 0);
  const padL = (i) => (i === 0 ? 0 : PAD);
  const padR = (i) => (i === cols.length - 1 ? 0 : PAD);

  const drawHead = () => {
    doc.font('B').fontSize(7.5).fillColor(MUTED);
    cols.forEach((c, i) => {
      doc.text(c.label.toUpperCase(), cellX(i) + padL(i), y, {
        width: c.w - padL(i) - padR(i), align: c.align || 'left', lineBreak: false, characterSpacing: 1,
      });
    });
    y += 14;
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(1.5).strokeColor(INK).stroke();
  };

  drawHead();
  for (const [index, item] of items.entries()) {
    const cells = {
      qty: `${formatQty(item.quantity)} ${item.unit || ''}`.trim(),
      rate: money(item.unit_price),
      disc: Number(item.discount_pct) > 0 ? pct(item.discount_pct) : '–',
      tax: pct(item.tax_rate),
      amount: money(incl ? item.total : item.taxable),
    };
    doc.font('S').fontSize(10);
    const nameH2 = doc.heightOfString(item.name, { width: itemCol.w - 2 * PAD });
    const showHsn = gst && item.hsn;
    const rowH = nameH2 + (showHsn ? 11 : 0) + 18;
    if (y + rowH > bottom()) {
      doc.addPage();
      y = M;
      drawHead();
    }
    cols.forEach((c, i) => {
      const cx = cellX(i) + padL(i);
      const cw = c.w - padL(i) - padR(i);
      if (c.key === 'no') {
        // 01, 02 … like the frame numbers on a contact sheet.
        doc.font('B').fontSize(8.5).fillColor(accent).text(frameNo(index), cx, y + 10.5, { width: cw, characterSpacing: 0.5, lineBreak: false });
      } else if (c.key === 'item') {
        doc.font('S').fontSize(10).fillColor(INK).text(item.name, cx, y + 9, { width: cw });
        if (showHsn) doc.font('R').fontSize(7.5).fillColor(MUTED).text(`HSN/SAC ${item.hsn}`, cx, y + 9 + nameH2 + 1, { width: cw });
      } else {
        doc.font(c.key === 'amount' ? 'B' : 'R').fontSize(9.5).fillColor(INK)
          .text(cells[c.key], cx, y + 10, { width: cw, align: c.align || 'left', features: TNUM });
      }
    });
    y += rowH;
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.6).dash(2, { space: 2 }).strokeColor('#d4d4d4').stroke().undash();
  }

  // ---- Totals, advance and balance, stamp ------------------------------------
  const { rows, included } = invoiceTotals(bill, items);
  const pay = paymentRows(bill);
  const upi = upiPayment(business, bill);
  if (y + Math.max(rows.length * 18 + pay.length * 26 + 70, upi ? 180 : 0) > bottom()) {
    doc.addPage();
    y = M;
  }
  y += 16;
  const tW = 230;
  const tX = M + W - tW;
  let ty = y;
  for (const [label, value, opt = {}] of rows) {
    if (opt.strong) {
      ty += 4;
      doc.moveTo(tX, ty).lineTo(tX + tW, ty).lineWidth(1.5).strokeColor(INK).stroke();
      ty += 7;
      doc.font('B').fontSize(15).fillColor(INK).text(label, tX, ty, { width: tW / 2 });
      doc.text(money(value), tX + tW / 2, ty, { width: tW / 2, align: 'right', features: TNUM });
      ty += 23;
    } else {
      doc.font('R').fontSize(9.5).fillColor('#4b5563').text(label, tX, ty, { width: tW / 2 });
      doc.fillColor(INK).text(money(value), tX + tW / 2, ty, { width: tW / 2, align: 'right', features: TNUM });
      ty += 17;
    }
  }
  if (pay.length) {
    const rowH = 25;
    const by = ty + 6;
    doc.save();
    doc.roundedRect(tX, by, tW, rowH * pay.length, 9).clip();
    pay.forEach(([, , opt = {}], i) => doc.rect(tX, by + i * rowH, tW, rowH).fill(opt.balance ? accent : accentSoft));
    doc.restore();
    pay.forEach(([label, value, opt = {}], i) => {
      const rowY = by + i * rowH + (opt.balance ? 6 : 7.5);
      doc.font(opt.balance ? 'B' : 'R').fontSize(opt.balance ? 12 : 9.5).fillColor(opt.balance ? '#ffffff' : INK);
      doc.text(label, tX + 12, rowY, { width: tW / 2 - 12 });
      doc.text(money(value), tX + tW / 2, rowY, { width: tW / 2 - 12, align: 'right', features: TNUM });
    });
    ty = by + rowH * pay.length;
  }

  // Rubber stamp on the left.
  const stamp = stampFor(bill);
  const stampColor = STAMP_COLORS[stamp.key] || accent;
  const label = stamp.text.toUpperCase();
  doc.font('B').fontSize(13);
  const sw = doc.widthOfString(label, { characterSpacing: 2.4 }) + 32;
  const sh = 32;
  const sx = M + 8;
  const sy = y + 8;
  doc.save();
  doc.rotate(-7, { origin: [sx + sw / 2, sy + sh / 2] });
  doc.opacity(0.85);
  doc.roundedRect(sx, sy, sw, sh, 8).lineWidth(2).strokeColor(stampColor).stroke();
  doc.roundedRect(sx + 3.5, sy + 3.5, sw - 7, sh - 7, 5).lineWidth(0.8).strokeColor(stampColor).stroke();
  doc.fillColor(stampColor).text(label, sx, sy + 9, { width: sw, align: 'center', characterSpacing: 2.4, lineBreak: false });
  doc.restore();
  let leftY = sy + sh + 16;
  if (included.length) {
    eyebrow('GST included', M, leftY);
    leftY += 12;
    for (const [l, v] of included) {
      doc.font('R').fontSize(8.5).fillColor(MUTED).text(l, M, leftY, { width: 110 });
      doc.fillColor(INK).text(money(v), M + 110, leftY, { width: 80, align: 'right', features: TNUM });
      leftY += 12;
    }
  }
  // Scan to pay the balance by UPI.
  if (upi) {
    const { size, dark } = qrMatrix(upi.link);
    const qs = 96;
    const cell = qs / (size + 8);
    eyebrow('Scan to pay', M, leftY);
    const qy = leftY + 12;
    doc.rect(M, qy, qs, qs).fill('#ffffff');
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) if (dark(r, c)) doc.rect(M + (c + 4) * cell, qy + (r + 4) * cell, cell + 0.05, cell + 0.05);
    }
    doc.fill('#000000');
    const tx = M + qs + 10;
    doc.font('B').fontSize(13).fillColor(INK).text(money(upi.amount), tx, qy + 18, { width: 150, features: TNUM });
    doc.font('R').fontSize(8.5).fillColor(MUTED).text('Balance, by any UPI app', tx, qy + 38, { width: 150 });
    doc.font('S').fontSize(8.5).fillColor(INK).text(business.upi_id, tx, qy + 52, { width: 150 });
    leftY = qy + qs + 4;
  }
  y = Math.max(ty, leftY) + 22;

  // ---- Notes, payment details, terms ------------------------------------------
  const section = (title, body, { muted = false } = {}) => {
    doc.font('R').fontSize(muted ? 8 : 9);
    const h = doc.heightOfString(body, { width: W }) + 20;
    if (y + h > bottom()) {
      doc.addPage();
      y = M;
    }
    eyebrow(title, M, y);
    doc.font('R').fontSize(muted ? 8 : 9).fillColor(muted ? MUTED : INK).text(body, M, y + 12, { width: W });
    y = doc.y + 14;
  };
  if (bill.status === 'cancelled' && bill.cancel_reason) section('Cancellation reason', bill.cancel_reason);
  if (bill.notes) section('Notes', bill.notes);
  if (business.payment_details) section('Payment details', business.payment_details);
  if (business.invoice_terms) section('Terms', business.invoice_terms, { muted: true });

  // ---- "Review us on Google." card: stars and a "Write a review" button --------
  const review = bill.status === 'cancelled' ? null : reviewLink(business);
  if (review) {
    const words = reviewCopy(review);
    const PADX = 18;
    // The button: a pill in the business colour, like the website's.
    doc.font('B').fontSize(10.5);
    const btnTextW = doc.widthOfString(words.button);
    const BTN_H = 32;
    const btnW = 18 + btnTextW + 6 + 10 + 18;
    const textW = W - 3 * PADX - btnW;
    doc.font('R').fontSize(8.5);
    const noteH = doc.heightOfString(words.note, { width: textW });
    const textH = 12 + 21 + 17 + noteH;
    const cardH = Math.max(BTN_H, textH) + 32;
    if (y + 4 + cardH > bottom()) {
      doc.addPage();
      y = M;
    }
    const cy = y + 4;
    const cream = mix(accent, '#fffaf4', 0.94);
    doc.roundedRect(M, cy, W, cardH, 12).fill(cream);
    // A faint lens in the corner behind the button.
    doc.save();
    doc.roundedRect(M, cy, W, cardH, 12).clip();
    doc.lineWidth(0.8).strokeColor(accent).strokeOpacity(0.16);
    for (let r = 16; r <= 116; r += 17) doc.circle(M + W + 10, cy + cardH + 38, r).stroke();
    doc.restore();
    doc.roundedRect(M + 0.4, cy + 0.4, W - 0.8, cardH - 0.8, 12).lineWidth(0.8).strokeColor(mix(accent, '#ffffff', 0.8)).stroke();

    let cardY = cy + (cardH - textH) / 2;
    const cardX = M + PADX;
    eyebrow(words.label, cardX, cardY);
    cardY += 12;
    doc.font('B').fontSize(16).fillColor(INK).text(words.title, cardX, cardY, { lineBreak: false, continued: true })
      .fillColor(accent).text('.', { lineBreak: false });
    cardY += 21;
    for (let s = 0; s < 5; s++) drawStar(doc, cardX - 1 + s * 14, cardY, 13);
    cardY += 17;
    doc.font('R').fontSize(8.5).fillColor('#57534e').text(words.note, cardX, cardY, { width: textW });

    const bx = M + W - PADX - btnW;
    const by = cy + (cardH - BTN_H) / 2;
    const ink = onAccent(accent);
    doc.roundedRect(bx, by, btnW, BTN_H, BTN_H / 2).fill(accent);
    doc.font('B').fontSize(10.5).fillColor(ink).text(words.button, bx + 18, by + 9.6, { lineBreak: false });
    drawIcon(doc, 'external', bx + 18 + btnTextW + 6, by + 11, 10, ink);
    // The whole card opens the review page.
    doc.link(M, cy, W, cardH, review.url);
    y = cy + cardH + 14;
  }

  // ---- Every page: watermark, thank-you line, film strip with page numbers ----
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    if (stamp.key === 'cancelled' || stamp.key === 'draft') {
      doc.save();
      doc.rotate(-30, { origin: [PW / 2, PH / 2] });
      doc.font('B').fontSize(84).fillColor(stamp.key === 'draft' ? '#94a3b8' : '#dc2626').fillOpacity(0.08)
        .text(label, 0, PH / 2 - 50, { width: PW, align: 'center', lineBreak: false });
      doc.restore();
      doc.fillOpacity(1);
    }
    const stripY = PH - reel.height;
    if (i === range.start + range.count - 1) drawThanks(stripY - 30);
    drawReel(stripY);
    if (range.count > 1) {
      doc.font('R').fontSize(6.5).fillColor(MUTED)
        .text(`Page ${i - range.start + 1} of ${range.count}`, M, stripY - 12, { width: W, align: 'right', lineBreak: false });
    }
  }

  /** — 📷 Thank you for choosing <name> — with lines fading in from both sides. */
  function drawThanks(ty) {
    const prefix = 'Thank you for choosing ';
    doc.font('R').fontSize(9);
    const w1 = doc.widthOfString(prefix);
    doc.font('B').fontSize(9);
    const w2 = Math.min(doc.widthOfString(business.name), W - w1 - 80);
    const total = 13 + 7 + w1 + w2;
    const tx = (PW - total) / 2;
    const lineColor = mix(accent, '#ffffff', 0.4);
    const fade = (x1, x2) => {
      if (x2 - x1 < 12) return;
      const g = doc.linearGradient(x1, 0, x2, 0);
      g.stop(0, x1 < tx ? '#ffffff' : lineColor).stop(1, x1 < tx ? lineColor : '#ffffff');
      doc.rect(x1, ty + 5.5, x2 - x1, 0.8).fill(g);
    };
    fade(M, tx - 12);
    fade(tx + total + 12, PW - M);
    drawIcon(doc, 'camera', tx, ty, 13, accent);
    doc.font('R').fontSize(9).fillColor(MUTED).text(prefix, tx + 20, ty + 1, { lineBreak: false });
    doc.font('B').fontSize(9).fillColor(INK).text(business.name, tx + 20 + w1, ty + 1, { width: w2 + 1, lineBreak: false, ellipsis: true });
  }

  /** The film strip: sprocket holes along both edges, the contact details in its frames. */
  function drawReel(sy) {
    doc.rect(0, sy, PW, reel.height).fill(dark ? BAND : BAND_LIGHT_REEL);
    doc.save();
    doc.fillColor('#ffffff').fillOpacity(0.78);
    for (let hx = 6; hx < PW; hx += 20) {
      doc.rect(hx, sy + 5, 9, 5).fill();
      doc.rect(hx, sy + reel.height - 10, 9, 5).fill();
    }
    doc.restore();
    let ry = sy + REEL_PAD;
    for (const row of reel.rows) {
      let fx = (PW - row.w) / 2;
      for (const c of row.items) {
        doc.save();
        doc.roundedRect(fx, ry, c.w, FRAME_H, 4).lineWidth(0.6)
          .fillColor('#ffffff').fillOpacity(0.05).strokeColor('#ffffff').strokeOpacity(0.18).fillAndStroke();
        doc.restore();
        doc.circle(fx + 10, ry + FRAME_H / 2, 7).fill(accent);
        drawIcon(doc, c.key, fx + 5.5, ry + FRAME_H / 2 - 4.5, 9, '#ffffff');
        doc.font('S').fontSize(8.5).fillColor('#ffffff')
          .text(c.text, fx + 23, ry + 5.2, { width: c.w - 30, lineBreak: false, ellipsis: true });
        if (c.href) doc.link(fx, ry, c.w, FRAME_H, c.href);
        fx += c.w + FRAME_GAP;
      }
      ry += FRAME_H + FRAME_GAP;
    }
    if (reel.address) {
      const ay = reel.rows.length ? ry + 1 : ry;
      const ax = (PW - (16 + reel.addrW)) / 2;
      drawIcon(doc, 'pin', ax, ay - 0.5, 11, accent);
      doc.font('R').fontSize(8).fillColor('#d4d4d4').text(reel.address.text, ax + 16, ay, { width: reel.addrW + 1, align: 'center' });
    }
  }

  doc.end();
  return doc;
}

export function pdfFilename(bill) {
  const base = bill.invoice_no || `draft-${bill.id}`;
  return `${base.replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf`;
}
