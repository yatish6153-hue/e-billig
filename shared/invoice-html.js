// The bill, shared by the in-app bill view and the customer's link.
// Studio style: dark (or light) header band with logo, tagline and faint lens rings, an accent bar
// in the business colour, items, then Total / Advance / Balance with a rubber-stamp status mark,
// and a film-strip footer that carries the business's phone, email, website and address.
// Styling lives in /css/invoice.css. Every value is escaped.
import { escapeHtml as e, formatMoney, formatQty, formatDate, billDisplayStatus } from './format.js';
import { taxBreakdown, splitTax } from './calc.js';

export const DEFAULT_BILL_COLOR = '#f26b1d';

export function billColor(business) {
  return /^#[0-9a-f]{6}$/i.test(business?.bill_color || '') ? business.bill_color : DEFAULT_BILL_COLOR;
}

function lines(text) {
  return e(text).replace(/\r?\n/g, '<br>');
}

function rate(r) {
  return `${Math.round(Number(r) * 100) / 100}%`;
}

export function invoiceTitle(bill, business) {
  if (bill.status === 'draft') return 'Draft';
  return bill.with_gst && business.gstin && bill.tax_total > 0 ? 'Tax Invoice' : 'Bill';
}

/** The rubber-stamp mark: paid / balance due / cancelled / draft. */
export function stampFor(bill) {
  if (bill.status === 'draft') return { key: 'draft', text: 'Draft' };
  if (bill.status === 'cancelled') return { key: 'cancelled', text: 'Cancelled' };
  if (bill.payment_status === 'paid') return { key: 'paid', text: 'Paid' };
  return { key: 'due', text: 'Balance due' };
}

/** Totals rows as [label, amountMinor, options] — shared with the PDF renderer and the bill editor. */
export function invoiceTotals(bill, items) {
  const gst = !!bill.with_gst;
  const incl = gst && !!bill.prices_include_tax;
  const rows = [];
  const taxRows = [];
  if (gst) {
    for (const t of taxBreakdown(items)) {
      if (bill.split_tax) {
        const [c, s] = splitTax(t.tax);
        taxRows.push([`CGST @ ${rate(t.rate / 2)}`, c], [`SGST @ ${rate(t.rate / 2)}`, s]);
      } else {
        taxRows.push([`${bill.tax_label || 'Tax'} @ ${rate(t.rate)}`, t.tax]);
      }
    }
  }

  if (incl) {
    const grossIncl = items.reduce((a, i) => a + Math.round(Number(i.quantity) * Number(i.unit_price)), 0);
    const net = items.reduce((a, i) => a + Number(i.total), 0);
    rows.push(['Subtotal (incl. GST)', grossIncl]);
    if (grossIncl - net > 0) rows.push(['Discount', -(grossIncl - net)]);
  } else if (gst) {
    rows.push(['Subtotal', bill.subtotal]);
    if (bill.discount_total > 0) rows.push(['Discount', -bill.discount_total]);
    if (bill.discount_total > 0 && taxRows.length) rows.push(['Taxable value', bill.taxable_total]);
    rows.push(...taxRows);
  } else if (bill.discount_total > 0 || bill.round_off) {
    // Without GST the subtotal only matters when something adjusts it.
    rows.push(['Subtotal', bill.subtotal]);
    // What was let go when the customer paid a little less shows on its own line.
    const settled = Number(bill.settle_discount) || 0;
    const discount = bill.discount_total - settled;
    if (discount > 0) rows.push([Number(bill.discount_pct) > 0 ? `Discount (${rate(bill.discount_pct)})` : 'Discount', -discount]);
    if (settled > 0) rows.push(['Discount at payment', -settled]);
  }
  if (bill.round_off) rows.push(['Round off', bill.round_off]);
  rows.push(['Total', bill.total, { strong: true }]);

  const included = incl && taxRows.length ? [['Taxable value', bill.taxable_total], ...taxRows] : [];
  return { rows, included };
}

/** Advance (everything received so far) and Balance, for created bills. */
export function paymentRows(bill) {
  if (bill.status !== 'finalized') return [];
  return [['Advance', bill.amount_paid], ['Balance', bill.total - bill.amount_paid, { strong: true, balance: true }]];
}

const WA_ICON = '<svg class="inv-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>';

/** Line icons on a 24×24 grid, as SVG path data: drawn as <path>s here and with doc.path() in the PDF. */
export const BILL_ICONS = {
  phone: ['M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z'],
  mail: ['M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M22 7l-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7'],
  globe: ['M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0', 'M12 2a14.5 14.5 0 0 0 0 20a14.5 14.5 0 0 0 0-20', 'M2 12h20'],
  pin: ['M20 10c0 4.99-5.54 10.19-7.4 11.79a1 1 0 0 1-1.2 0C9.54 20.19 4 14.99 4 10a8 8 0 0 1 16 0', 'M9 10a3 3 0 1 0 6 0a3 3 0 1 0-6 0'],
  camera: ['M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3Z', 'M9 13a3 3 0 1 0 6 0a3 3 0 1 0-6 0'],
};

const svgIcon = (key, cls = 'inv-icon') =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${BILL_ICONS[key].map((d) => `<path d="${d}"/>`).join('')}</svg>`;

/**
 * The business's contact details for the bill's footer, in order: phone, email, website, then the
 * address on one line. text is shown as is (escape it); href is a tel:, mailto: or https:// link.
 */
export function billContacts(business) {
  const list = [];
  const phone = String(business.phone || '').trim();
  if (phone) list.push({ key: 'phone', text: phone, href: `tel:${phone.replace(/[^\d+]/g, '')}` });
  const email = String(business.email || '').trim();
  if (email) list.push({ key: 'mail', text: email, href: `mailto:${email}` });
  const site = String(business.website || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (site) list.push({ key: 'globe', text: site, href: `https://${site}` });
  const address = String(business.address || '').split(/\r?\n/).map((s) => s.trim().replace(/,$/, '')).filter(Boolean).join(', ');
  if (address) list.push({ key: 'pin', text: address, href: null });
  return list;
}

export function renderInvoiceHtml({ business, bill, items, logoUrl = null }) {
  const cur = bill.currency;
  const money = (v) => formatMoney(v, cur);
  const status = billDisplayStatus(bill);
  const dark = business.bill_header !== 'light';
  const gst = !!bill.with_gst;
  const incl = gst && !!bill.prices_include_tax;
  const showDiscount = items.some((i) => Number(i.discount_pct) > 0);
  const showTax = gst && items.some((i) => Number(i.tax_rate) > 0);
  const { rows, included } = invoiceTotals(bill, items);
  const payRows = paymentRows(bill);
  const stamp = stampFor(bill);

  // The business's address, phone, email and website are in the footer; only a GST bill's GSTIN stays up here.
  const fromLines = [gst && business.gstin && `GSTIN ${e(business.gstin)}`].filter(Boolean);
  const contacts = billContacts(business);
  const contactHtml = contacts.map(({ key, text, href }) => {
    const body = `<span class="inv-contact-ic">${svgIcon(key)}</span><span class="inv-contact-text">${e(text)}</span>`;
    const cls = `inv-contact inv-contact-${key}`;
    return href ? `<a class="${cls}" href="${e(href)}"${key === 'globe' ? ' target="_blank" rel="noopener"' : ''}>${body}</a>`
      : `<div class="${cls}">${body}</div>`;
  }).join('');

  const itemRows = items.map((item) => {
    const amount = incl ? item.total : item.taxable;
    const qty = `${e(formatQty(item.quantity))} ${e(item.unit || '')}`.trim();
    const disc = Number(item.discount_pct) > 0 ? rate(item.discount_pct) : '';
    // Compact one-line summary used instead of the detail columns on narrow screens.
    const summary = [`${qty} &times; ${money(item.unit_price)}`, disc && `${disc} off`,
      showTax && `${e(bill.tax_label || 'GST')} ${rate(item.tax_rate)}`].filter(Boolean).join(' &middot; ');
    return `<tr>
      <td class="inv-item">
        <div class="inv-item-name">${e(item.name)}</div>
        ${gst && item.hsn ? `<div class="inv-item-meta">HSN/SAC ${e(item.hsn)}</div>` : ''}
        <div class="inv-item-mobile">${summary}</div>
      </td>
      <td class="r inv-col-detail">${qty}</td>
      <td class="r inv-col-detail">${money(item.unit_price)}</td>
      ${showDiscount ? `<td class="r inv-col-detail">${disc || '&ndash;'}</td>` : ''}
      ${showTax ? `<td class="r inv-col-detail">${rate(item.tax_rate)}</td>` : ''}
      <td class="r inv-amount">${money(amount)}</td>
    </tr>`;
  }).join('');

  const totalRows = rows.map(([label, value, opt = {}]) =>
    `<tr class="${opt.strong ? 'inv-grand' : ''}"><td>${e(label)}</td><td class="r">${money(value)}</td></tr>`).join('');
  const payBlock = payRows.length
    ? `<div class="inv-pay">${payRows.map(([label, value, opt = {}]) =>
      `<div class="inv-pay-row${opt.balance ? ' inv-pay-balance' : ''}"><span>${e(label)}</span><span>${money(value)}</span></div>`).join('')}</div>`
    : '';
  const includedBlock = included.length
    ? `<div class="inv-included"><div class="inv-label">GST included</div>
        ${included.map(([l, v]) => `<div><span>${e(l)}</span><span>${money(v)}</span></div>`).join('')}</div>`
    : '';

  const section = (label, body, cls = '') => `<div class="inv-section ${cls}"><div class="inv-label">${e(label)}</div><div>${body}</div></div>`;

  return `<article class="invoice ${dark ? 'inv-dark' : 'inv-light'} inv-status-${status}" style="--accent:${billColor(business)}">
  ${status === 'cancelled' || status === 'draft' ? `<div class="inv-watermark">${status === 'draft' ? 'DRAFT' : 'CANCELLED'}</div>` : ''}
  <header class="inv-band">
    <div class="inv-brand">
      ${logoUrl ? `<img class="inv-logo" src="${e(logoUrl)}" alt="">` : ''}
      <div class="inv-brand-text">
        <div class="inv-business">${e(business.name)}</div>
        ${business.tagline ? `<div class="inv-tagline">${e(business.tagline)}</div>` : ''}
      </div>
    </div>
    <div class="inv-doc">
      <div class="inv-title">${e(invoiceTitle(bill, business))}</div>
      <div class="inv-number">${bill.invoice_no ? e(bill.invoice_no) : `#${e(bill.id)}`}</div>
      <div class="inv-date">${formatDate(bill.bill_date)}</div>
    </div>
  </header>
  <div class="inv-accent"></div>

  <section class="inv-info">
    <div class="inv-to">
      <div class="inv-label">Billed to</div>
      <div class="inv-to-name">${bill.customer_name ? e(bill.customer_name) : 'Walk-in customer'}</div>
      ${bill.customer_phone ? `<div class="inv-to-line">${WA_ICON}<span>${e(bill.customer_phone)}</span></div>` : ''}
      ${bill.customer_address ? `<div class="inv-to-line">${lines(bill.customer_address)}</div>` : ''}
      ${bill.customer_email ? `<div class="inv-to-line">${e(bill.customer_email)}</div>` : ''}
      ${gst && bill.customer_gstin ? `<div class="inv-to-line">GSTIN ${e(bill.customer_gstin)}</div>` : ''}
    </div>
    ${fromLines.length ? `<div class="inv-from">${fromLines.map((l) => `<div>${l}</div>`).join('')}</div>` : ''}
  </section>

  <div class="inv-table-wrap">
    <table class="inv-items">
      <thead><tr>
        <th>Item</th><th class="r inv-col-detail">Qty</th>
        <th class="r inv-col-detail">Rate${incl ? ' (incl. GST)' : ''}</th>
        ${showDiscount ? '<th class="r inv-col-detail">Disc.</th>' : ''}
        ${showTax ? `<th class="r inv-col-detail">${e(bill.tax_label || 'GST')}</th>` : ''}
        <th class="r">Amount</th>
      </tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
  </div>

  <section class="inv-summary">
    <div class="inv-summary-left">
      <div class="inv-stamp inv-stamp-${stamp.key}">${e(stamp.text)}</div>
      ${includedBlock}
    </div>
    <div class="inv-summary-right">
      <table class="inv-totals">${totalRows}</table>
      ${payBlock}
    </div>
  </section>

  ${bill.status === 'cancelled' && bill.cancel_reason ? section('Cancellation reason', lines(bill.cancel_reason)) : ''}
  ${bill.notes ? section('Notes', lines(bill.notes)) : ''}
  ${business.payment_details ? section('Payment details', lines(business.payment_details)) : ''}
  ${business.invoice_terms ? section('Terms', lines(business.invoice_terms), 'inv-terms') : ''}

  <footer class="inv-foot">
    <div class="inv-thanks"><span class="inv-thanks-text">${svgIcon('camera')}<span>Thank you for choosing <b>${e(business.name)}</b></span></span></div>
    <div class="inv-reel${contacts.length ? '' : ' inv-reel-empty'}">
      ${contacts.length ? `<div class="inv-contacts">${contactHtml}</div>` : ''}
    </div>
  </footer>
</article>`;
}
