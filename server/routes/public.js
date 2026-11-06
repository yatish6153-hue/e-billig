// Public, unauthenticated invoice pages reached through an unguessable share token.
// Only the one invoice the token belongs to is ever exposed.
import express from 'express';
import { get } from '../db.js';
import { loadInvoice, getLogo } from '../services/billing.js';
import { renderInvoicePdf, pdfFilename } from '../services/pdf.js';
import { upiPayment, qrSvg } from '../services/upi.js';
import { renderInvoiceHtml } from '../../shared/invoice-html.js';
import { escapeHtml as e, formatDate, formatMoney, whatsappNumber } from '../../shared/format.js';
import { renderChain, stageInfo } from '../../shared/tracking.js';
import { billColor } from '../../shared/invoice-html.js';

const router = express.Router();
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

function billForToken(token) {
  if (!TOKEN_RE.test(token)) return null;
  return get("SELECT * FROM bills WHERE share_token = ? AND status IN ('finalized', 'cancelled')", token) || null;
}

function privateHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${e(title)}</title>
<link rel="stylesheet" href="/vendor/inter/index.css">
<link rel="stylesheet" href="/css/invoice.css">
</head>
<body class="public-page">
${body}
<script src="/js/public-invoice.js" defer></script>
</body>
</html>`;
}

function notFoundPage(res) {
  privateHeaders(res);
  res.status(404).send(page('Invoice not available', `
<main class="public-missing">
  <h1>This invoice link isn't available</h1>
  <p>The link may have been mistyped, or the business may have revoked it. Please contact the business for a new link.</p>
</main>`));
}

router.get('/:token', (req, res) => {
  const bill = billForToken(req.params.token);
  if (!bill) return notFoundPage(res);
  const data = loadInvoice(bill);
  const base = `/i/${encodeURIComponent(req.params.token)}`;
  const invoice = renderInvoiceHtml({ ...data, logoUrl: data.business.has_logo ? `${base}/logo` : null });
  // Tracked jobs show the customer where their order is.
  const stage = bill.status === 'finalized' ? stageInfo(bill.work_stage) : null;
  const status = stage ? `
<section class="public-status" style="--chain:${billColor(data.business)}">
  <div class="public-status-head"><span class="public-status-title">Order status: <strong>${e(stage.label)}</strong></span>
    ${bill.work_updated_at ? `<span class="public-status-date">Updated ${formatDate(bill.work_updated_at)}</span>` : ''}</div>
  ${renderChain(bill.work_stage)}
  <p class="public-status-text">${e(stage.customer)}</p>
</section>` : '';
  const upi = upiPayment(data.business, bill);
  const payBox = upi ? `
<section class="public-pay" style="--accent:${billColor(data.business)}">
  <div><div class="public-pay-label">Balance to pay</div><div class="public-pay-amount">${e(formatMoney(upi.amount, bill.currency))}</div></div>
  <a class="public-btn public-btn-pay" href="${base}/pay">Pay now by UPI</a>
</section>` : '';
  privateHeaders(res);
  res.send(page(`${bill.invoice_no} — ${data.business.name}`, `
<div class="public-toolbar">
  <div class="public-toolbar-inner">
    <div class="public-from">Invoice from <strong>${e(data.business.name)}</strong></div>
    <div class="public-actions">
      <button type="button" class="public-btn" data-print>Print</button>
      <a class="public-btn public-btn-primary" href="${base}/pdf?download=1">Download PDF</a>
    </div>
  </div>
</div>
<main class="public-main">${payBox}${status}${invoice}</main>`));
});

/** Pay the balance: a button that opens the customer's UPI app with the amount filled in, and a QR to scan. */
router.get('/:token/pay', (req, res) => {
  const bill = billForToken(req.params.token);
  if (!bill) return notFoundPage(res);
  const { business } = loadInvoice(bill);
  const base = `/i/${encodeURIComponent(req.params.token)}`;
  const money = (v) => e(formatMoney(v, bill.currency));
  const balance = bill.status === 'finalized' ? bill.total - bill.amount_paid : 0;
  const upi = upiPayment(business, bill);
  const wa = whatsappNumber(business.phone, business.currency);
  let body;
  if (bill.status === 'cancelled') {
    body = '<p class="pay-note">This bill was cancelled, so there is nothing to pay.</p>';
  } else if (balance <= 0) {
    body = '<p class="pay-done">This bill is fully paid. Thank you!</p>';
  } else if (!upi) {
    body = `<p class="pay-note">Please contact ${e(business.name)}${business.phone ? ` on ${e(business.phone)}` : ''} to pay the balance.</p>`;
  } else {
    const paidText = encodeURIComponent(`I have paid ${formatMoney(upi.amount, bill.currency)} for bill ${bill.invoice_no}.`);
    body = `
    <a class="pay-btn" href="${e(upi.link)}">Pay ${money(upi.amount)}</a>
    <p class="pay-apps">Opens Google Pay, PhonePe, Paytm or any UPI app with the amount filled in.</p>
    <div class="pay-or"><span>or scan with any UPI app</span></div>
    <div class="pay-qr">${qrSvg(upi.link, `QR code to pay ${money(upi.amount)} by UPI`)}</div>
    <p class="pay-upi">UPI ID: <strong>${e(business.upi_id)}</strong></p>
    ${wa ? `<p class="pay-note">After paying, send the payment screenshot on
      <a href="https://wa.me/${wa}?text=${paidText}" rel="noopener">WhatsApp to ${e(business.phone)}</a>.</p>` : ''}`;
  }
  privateHeaders(res);
  res.send(page(`Pay ${bill.invoice_no} — ${business.name}`, `
<main class="pay-page">
  <section class="pay-card" style="--accent:${billColor(business)}">
    <div class="pay-head">${business.has_logo ? `<img class="pay-logo" src="${base}/logo" alt="">` : ''}
      <div><div class="pay-biz">${e(business.name)}</div><div class="pay-bill">Bill ${e(bill.invoice_no)} · ${formatDate(bill.bill_date)}</div></div></div>
    <div class="pay-amount"><span>Balance to pay</span><strong>${money(balance)}</strong></div>
    <dl class="pay-sum"><dt>Total</dt><dd>${money(bill.total)}</dd><dt>Paid</dt><dd>${money(bill.amount_paid)}</dd></dl>
    ${body}
    <a class="pay-view" href="${base}">View the bill</a>
  </section>
</main>`));
});

router.get('/:token/pdf', (req, res) => {
  const bill = billForToken(req.params.token);
  if (!bill) return notFoundPage(res);
  const data = loadInvoice(bill);
  privateHeaders(res);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${pdfFilename(bill)}"`);
  renderInvoicePdf(data, getLogo(bill.business_id)).pipe(res);
});

router.get('/:token/logo', (req, res) => {
  const bill = billForToken(req.params.token);
  const logo = bill ? getLogo(bill.business_id) : null;
  if (!logo?.logo_mime) return res.status(404).end();
  res.setHeader('Content-Type', logo.logo_mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(logo.logo_data));
});

export default router;
