import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBill, computeLine, splitTax, paymentStatus } from '../shared/calc.js';
import { formatMoney, toMinor, invoiceNumber } from '../shared/format.js';
import { renderInvoiceHtml, invoiceTotals, billContacts } from '../shared/invoice-html.js';
import {
  dayWindow, windowsOverlap, clashDay, scheduleOf, servicesOf, bookingTotals, weekStart, daysBetween, shootState, deliveryState,
  progressSteps, matchesQuick, sectionsFor, deliverablesFor, formatTime, bookingReminders,
} from '../shared/bookings.js';
import { layoutSpans, widthLabel } from '../shared/dashboard.js';

test('dashboard layout: set widths, rows filled by boxes without one, tablets and phones', () => {
  const box = (key, w = null) => ({ key, w });
  // At first: wide boxes take the row, the others go two to a row.
  assert.deepEqual(layoutSpans([box('actions'), box('calendar'), box('shoots'), box('summary'), box('bills'), box('stock')]),
    [12, 6, 6, 12, 6, 6]);
  // A half-width box left alone in its row fills it.
  assert.deepEqual(layoutSpans([box('calendar'), box('summary')]), [12, 12]);
  // A box with a set width keeps it; one without grows into the space left.
  assert.deepEqual(layoutSpans([box('calendar', 4), box('shoots'), box('summary')]), [4, 8, 12]);
  assert.deepEqual(layoutSpans([box('calendar', 4), box('shoots', 4), box('bills', 4), box('stock', 3)]), [4, 4, 4, 3], 'set widths leave a gap if they must');
  assert.deepEqual(layoutSpans([box('calendar', 8), box('shoots')]), [8, 12], 'a box that doesn’t fit starts a new row');
  // Tablet: half or full, and the last box of a row fills it. Phone: one per row.
  assert.deepEqual(layoutSpans([box('calendar', 4), box('shoots', 4), box('bills', 4)], 'medium'), [6, 6, 12]);
  assert.deepEqual(layoutSpans([box('calendar', 9), box('shoots', 3)], 'medium'), [12, 12]);
  assert.deepEqual(layoutSpans([box('calendar', 3), box('shoots')], 'narrow'), [12, 12]);
  assert.equal(widthLabel(4), '⅓');
  assert.equal(widthLabel(12), 'Full');
  assert.equal(widthLabel(5), '5/12');
});

test('bookings: dates, shoot times, clashes, states and reminders', () => {
  const on = (...days) => ({ schedule: days.map(([date, start = '', end = '', venue = '']) => ({ date, start, end, venue })) });
  assert.deepEqual(dayWindow({ date: '2026-11-12', start: '10:00', end: '14:00' }), { start: '2026-11-12T10:00', end: '2026-11-12T14:00' });
  assert.equal(dayWindow({ date: '2026-11-12', start: '20:00', end: '02:00' }).end, '2026-11-13T02:00', 'ends after midnight');
  assert.deepEqual(dayWindow({ date: '2026-11-12' }), { start: '2026-11-12T00:00', end: '2026-11-12T23:59' }, 'no times: the whole day');
  assert.equal(windowsOverlap(on(['2026-11-12', '10:00', '14:00']), on(['2026-11-12', '14:00', '18:00'])), false, 'back to back');
  assert.equal(windowsOverlap(on(['2026-11-12', '10:00', '14:00']), on(['2026-11-12', '13:59', '18:00'])), true);
  // Dates apart: only the dates themselves hold the team, each with its own times.
  const wedding = on(['2026-11-10', '10:00', '13:00', 'Home'], ['2026-11-12', '16:00', '23:00', 'Hotel']);
  assert.equal(windowsOverlap(wedding, on(['2026-11-11', '10:00', '20:00'])), false);
  assert.equal(windowsOverlap(wedding, on(['2026-11-12', '09:00', '12:00'])), false);
  assert.deepEqual(clashDay(on(['2026-11-12', '22:00', '23:30']), wedding), { date: '2026-11-12', start: '16:00', end: '23:00', venue: 'Hotel' });
  // Bookings saved before dates could differ: one date, a number of days, one time and venue.
  assert.deepEqual(scheduleOf({ event_date: '2026-11-04', days: 2, start_time: '23:03', end_time: '', venue: 'Garden' }).map((d) => [d.date, d.start, d.venue]),
    [['2026-11-04', '23:03', 'Garden'], ['2026-11-05', '23:03', 'Garden']]);
  assert.equal(weekStart('2026-11-08'), '2026-11-02', 'weeks start on Monday');
  assert.equal(daysBetween('2026-11-04', '2026-11-01'), -3);
  assert.equal(formatTime('17:30'), '5:30 pm');

  // Services are bill lines. Older bookings (services without prices, one package amount) keep their total.
  const lines = [{ name: 'Candid photography', qty: 2, rate: 1500000, amount: 3000000 }, { name: 'Album', qty: 1, rate: 1000000, amount: 1000000 }];
  assert.deepEqual(bookingTotals(lines, 500000), { subtotal: 4000000, discount: 500000, total: 3500000 });
  assert.deepEqual(servicesOf({ services: lines, total: 3500000, discount: 500000 }), lines, 'lines that add up stay as they are');
  assert.deepEqual(servicesOf({ services: [{ key: 'drone', qty: 1 }, { key: 'other', qty: 2, name: 'LED wall' }], total: 10000000, package_name: '' }), [
    { name: 'Drone', qty: 1, rate: 0, amount: 0 }, { name: 'LED wall', qty: 2, rate: 0, amount: 0 }, { name: 'Package', qty: 1, rate: 10000000, amount: 10000000 },
  ]);

  const today = '2026-11-04';
  const b = { status: 'confirmed', event_date: '2026-11-03', days: 1, total: 100, amount_paid: 40, services: [], checklist: {}, tasks: {}, delivery: {} };
  assert.equal(shootState(b, today), 'past');
  assert.equal(shootState({ ...b, event_date: today }, today), 'today');
  assert.equal(shootState({ ...b, ...on(['2026-11-01'], ['2026-11-08']) }, today), 'upcoming', 'between two dates there is more to come');
  assert.equal(matchesQuick({ ...b, ...on(['2026-11-01'], ['2026-11-04']) }, 'today', today), true);
  assert.equal(shootState({ ...b, status: 'editing' }, today), 'done');
  assert.equal(deliveryState({ ...b, status: 'editing' }), 'in_progress');
  assert.equal(deliveryState({ ...b, status: 'editing', delivery: { photos: true } }), 'partial');
  assert.deepEqual(progressSteps({ ...b, status: 'editing', checklist: { backup: '2026-11-04' } }).map((s) => s.done), [true, true, true, false, false, false]);
  assert.equal(progressSteps({ ...b, status: 'on_hold', prev_status: 'shot' })[2].current, true, 'on hold keeps its step');
  assert.equal(matchesQuick({ ...b, status: 'on_hold' }, 'upcoming', today), false);
  assert.equal(matchesQuick({ ...b, status: 'on_hold' }, 'payment', today), true, 'money due still shows');
  assert.equal(matchesQuick({ ...b, status: 'new', amount_paid: 0 }, 'payment', today), false);
  // Post-production and deliverables follow the services' names.
  assert.deepEqual(sectionsFor([{ name: 'Candid Photography (Full Day)' }, { name: 'Drone' }]), ['photo', 'video']);
  assert.deepEqual(sectionsFor([{ name: 'Gold package' }]), ['photo', 'video', 'album'], 'nothing to go on: all of them');
  assert.deepEqual(deliverablesFor([{ name: 'Album (40 pages)' }, { name: 'Reels / short videos' }]).map((d) => d.key), ['video', 'album', 'reels']);
  const reminders = bookingReminders([
    { ...b, id: 1, event_date: '2026-11-05' },
    { ...b, id: 2, status: 'editing', deadlines: { video_cut: '2026-11-01' } },
  ], today).map((r) => r.type);
  assert.deepEqual(reminders, ['overdue', 'tomorrow', 'payment']);
});

test('line maths in minor units', () => {
  assert.deepEqual(computeLine({ quantity: 3, unit_price: 3333, discount_pct: 0, tax_rate: 5 }), {
    gross: 9999, discount: 0, taxable: 9999, tax: 500, total: 10499,
  });
  // Inclusive: the line total always equals qty x price less discount.
  const incl = computeLine({ quantity: 3, unit_price: 9900, discount_pct: 10, tax_rate: 18 }, true);
  assert.equal(incl.total, 26730);
  assert.equal(incl.taxable + incl.tax, incl.total);
  assert.equal(incl.gross - incl.discount, incl.taxable);
  // Fractional quantities (kg).
  assert.equal(computeLine({ quantity: 2.5, unit_price: 4600, tax_rate: 0 }).total, 11500);
});

test('bill totals with round-off', () => {
  const r = computeBill([{ quantity: 1, unit_price: 10050, tax_rate: 0 }], { roundOff: true });
  assert.equal(r.total, 10100);
  assert.equal(r.round_off, 50);
  const n = computeBill([{ quantity: 1, unit_price: 10049, tax_rate: 0 }], { roundOff: true });
  assert.equal(n.total, 10000);
  assert.equal(n.round_off, -49);
});

test('bill discount: a percentage off the whole bill, shown with its rate', () => {
  const lines = [{ quantity: 1, unit_price: 30000 }, { quantity: 2, unit_price: 12550 }];
  const r = computeBill(lines, { discountPct: 10, roundOff: true });
  assert.equal(r.subtotal, 55100);
  assert.equal(r.bill_discount, 5510);
  assert.equal(r.discount_total, 5510);
  assert.equal(r.total, 49600, '₹495.90 rounds to ₹496');
  assert.equal(r.round_off, 10);
  assert.equal(computeBill(lines, { discountPct: 0 }).total, 55100);
  const { rows } = invoiceTotals({ with_gst: false, discount_pct: 10, ...r }, lines);
  assert.deepEqual(rows.map(([label]) => label), ['Subtotal', 'Discount (10%)', 'Round off', 'Total']);

  // ₹11 let go when the customer paid: its own line, apart from the bill's discount.
  const settled = invoiceTotals({ with_gst: false, discount_pct: 10, ...r, settle_discount: 1100, discount_total: r.discount_total + 1100, total: r.total - 1100 }, lines);
  assert.deepEqual(settled.rows.map(([label, amount]) => [label, amount]), [
    ['Subtotal', 55100], ['Discount (10%)', -5510], ['Discount at payment', -1100], ['Round off', 10], ['Total', 48500],
  ]);
});

test('helpers', () => {
  assert.deepEqual(splitTax(2593), [1296, 1297]);
  assert.equal(paymentStatus(100, 0), 'unpaid');
  assert.equal(paymentStatus(100, 40), 'partial');
  assert.equal(paymentStatus(100, 100), 'paid');
  assert.equal(formatMoney(12345678, 'INR'), '₹1,23,456.78');
  assert.equal(formatMoney(-500, 'USD'), '-$5.00');
  assert.equal(toMinor('1,234.5'), 123450);
  assert.ok(Number.isNaN(toMinor('12.345')));
  assert.equal(invoiceNumber('INV-', 7), 'INV-0007');
});

test('simple invoice: total, advance and balance; GST only when chosen', () => {
  const business = { name: 'Studio', gstin: '08ABCDE1234F1Z5', address: '', phone: '', email: '' };
  const items = [{ name: 'Pre-Wedding Shoot', quantity: 1, unit: 'shoot', unit_price: 3000000, discount_pct: 0, tax_rate: 0,
    gross: 3000000, discount: 0, taxable: 3000000, tax: 0, total: 3000000, hsn: '998383' }];
  const bill = {
    id: 1, invoice_no: 'INV-0001', status: 'finalized', payment_status: 'partial', bill_date: '2026-11-03', currency: 'INR',
    with_gst: false, customer_name: 'Ananya', customer_phone: '+91 90000 00001', subtotal: 3000000, discount_total: 0,
    taxable_total: 3000000, tax_total: 0, round_off: 0, total: 3000000, amount_paid: 1000000,
  };
  const html = renderInvoiceHtml({ business, bill, items });
  assert.match(html, /<span>Total|Total<\/td><td class="r">₹30,000\.00/);
  assert.match(html, /Advance<\/span><span>₹10,000\.00/);
  assert.match(html, /inv-pay-balance"><span>Balance<\/span><span>₹20,000\.00/);
  assert.match(html, /<span>\+91 90000 00001<\/span>/);
  assert.match(html, /inv-stamp-due">Balance due/);
  assert.match(html, /class="inv-title">Bill</);
  assert.doesNotMatch(html, /GSTIN|CGST|HSN|Due date|Tax Invoice/);

  const paidHtml = renderInvoiceHtml({ business, bill: { ...bill, payment_status: 'paid', amount_paid: 3000000 }, items });
  assert.match(paidHtml, /inv-stamp-paid">Paid/);

  const gstItems = [{ ...items[0], tax_rate: 18, tax: 540000, total: 3540000 }];
  const gstBill = { ...bill, with_gst: true, split_tax: true, tax_label: 'GST', tax_total: 540000, total: 3540000 };
  const gstHtml = renderInvoiceHtml({ business: { ...business, bill_color: '#7c3aed', bill_header: 'light' }, bill: gstBill, items: gstItems });
  assert.match(gstHtml, /Tax Invoice/);
  assert.match(gstHtml, /CGST @ 9%/);
  assert.match(gstHtml, /GSTIN 08ABCDE1234F1Z5/);
  assert.match(gstHtml, /inv-light/);
  assert.match(gstHtml, /--accent:#7c3aed/);

  // A colour that isn't a plain hex value never reaches the page.
  const unsafe = renderInvoiceHtml({ business: { ...business, bill_color: 'red;background:url(x)' }, bill, items });
  assert.match(unsafe, /--accent:#f26b1d/);

  // The footer's film strip carries the business's phone, email, website and address (on one line), as links.
  const contact = { ...business, phone: '+91 97990 16153', email: 'devesh.paota@gmail.com', website: 'www.deveshstudio.com',
    address: 'Devesh Studio, B L Jangid Market\nPaota, Jaipur, Rajasthan 303106' };
  assert.deepEqual(billContacts(contact).map((c) => [c.key, c.href]), [
    ['phone', 'tel:+919799016153'], ['mail', 'mailto:devesh.paota@gmail.com'], ['globe', 'https://www.deveshstudio.com'], ['pin', null]]);
  const footer = renderInvoiceHtml({ business: contact, bill, items }).split('<footer')[1];
  assert.match(footer, /href="tel:\+919799016153"/);
  assert.match(footer, /href="https:\/\/www\.deveshstudio\.com"/);
  assert.match(footer, /Devesh Studio, B L Jangid Market, Paota, Jaipur, Rajasthan 303106/);
  assert.match(html, /inv-reel inv-reel-empty/, 'no contact details: a plain film strip');
  assert.match(renderInvoiceHtml({ business: { ...contact, address: '<script>x</script>' }, bill, items }), /&lt;script&gt;x/);
});
