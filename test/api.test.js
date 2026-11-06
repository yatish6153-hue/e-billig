// End-to-end API tests against an in-memory database: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, get as dbGet, run as dbRun } from '../server/db.js';
import { createApp } from '../server/app.js';
import { ensureDemoAccount, DEMO_ACCOUNT } from '../server/seed.js';
import { hashPassword } from '../server/auth.js';

let server;
let base;

before(async () => {
  openDb(':memory:');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  closeDb();
});

function client() {
  let cookie = '';
  const call = async (method, path, body, { csrf = true } = {}) => {
    const headers = { cookie };
    if (csrf) headers['X-Requested-With'] = 'fetch';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}, o) => call('POST', p, b, o),
    put: (p, b = {}) => call('PUT', p, b),
    del: (p) => call('DELETE', p),
    raw: (p) => fetch(base + p, { headers: { cookie } }), // files, read as bytes
  };
}

let seq = 0;
async function newBusiness(extra = {}) {
  const c = client();
  seq++;
  const r = await c.post('/api/auth/register', {
    business_name: `Test Shop ${seq}`, name: 'Owner', email: `owner${seq}@test.example`, password: 'password123', ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return c;
}

async function newProduct(c, overrides = {}) {
  seq++;
  const r = await c.post('/api/products', {
    // 999… barcodes never clash with the demo catalog's 890… ones.
    name: `Widget ${seq}`, sku: `SKU-${seq}`, barcode: `999${String(seq).padStart(10, '0')}`, selling_price: 10000,
    purchase_price: 7000, tax_rate: 18, quantity: 10, low_stock_threshold: 2, unit: 'pcs', ...overrides,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.product;
}

const today = new Date().toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.parse(today) + n * 86400_000).toISOString().slice(0, 10);
const line =(p, quantity = 1, extra = {}) => ({ product_id: p.id, quantity, unit_price: p.selling_price, discount_pct: 0, tax_rate: p.tax_rate, ...extra });

async function stockOf(c, productId) {
  const r = await c.get(`/api/products/${productId}`);
  return r.data.product.quantity;
}

test('auth: registration, validation, sessions and CSRF', async () => {
  const anon = client();
  assert.equal((await anon.get('/api/products')).status, 401);
  const weak = await anon.post('/api/auth/register', { business_name: 'X', name: 'Y', email: 'weak@test.example', password: 'short' });
  assert.equal(weak.status, 400);
  assert.equal(weak.data.error.field, 'password');

  const c = await newBusiness();
  const me = await c.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.business.currency, 'INR');
  assert.equal(me.data.has_demo_data, false);

  const dup = await client().post('/api/auth/register', { business_name: 'Z', name: 'Z', email: me.data.user.email, password: 'password123' });
  assert.equal(dup.status, 409);

  const noCsrf = await c.post('/api/customers', { name: 'Blocked' }, { csrf: false });
  assert.equal(noCsrf.status, 403);

  const login = client();
  assert.equal((await login.post('/api/auth/login', { email: me.data.user.email, password: 'wrong-password' })).status, 401);
  assert.equal((await login.post('/api/auth/login', { email: me.data.user.email, password: 'password123' })).status, 200);
  assert.equal((await login.post('/api/auth/logout')).status, 200);
  assert.equal((await login.get('/api/auth/me')).status, 401);
});

test('dashboard choices: saved per login, only what the app knows', async () => {
  const c = await newBusiness();
  const start = (await c.get('/api/auth/me')).data.user.preferences.dashboard;
  assert.equal(start.widgets.length, 10);
  assert.equal(start.widgets.find((w) => w.key === 'calendar').show, true);
  assert.equal(start.widgets.find((w) => w.key === 'reminders').show, false, 'reminders start hidden');
  assert.deepEqual(start.actions, ['bill', 'booking', 'daybook', 'product']);
  assert.equal((await c.put('/api/auth/preferences', {})).status, 400);

  assert.deepEqual(start.widgets.find((w) => w.key === 'bills'), { key: 'bills', show: true, w: null, h: null }, 'no size set at first');

  const saved = (await c.put('/api/auth/preferences', {
    dashboard: {
      widgets: [
        { key: 'calendar', show: true, w: 4, h: 333 }, { key: 'stock', show: false, w: 40, h: 5 },
        { key: 'weather', show: true }, { key: 'calendar', show: false }, { key: 'bills', w: 'wide', h: '300' },
      ],
      actions: ['booking', 'bill', 'teleport'],
      stats: ['booking_due'],
    },
  })).data.user.preferences.dashboard;
  assert.deepEqual(saved.widgets.slice(0, 3), [
    { key: 'calendar', show: true, w: 4, h: 340 }, // heights go in steps of 20 px
    { key: 'stock', show: false, w: 12, h: 120 }, // at most the full width, at least 120 px tall
    { key: 'bills', show: true, w: null, h: null }, // only numbers are sizes
  ]);
  assert.equal(saved.widgets.length, 10, 'every widget once; the ones not sent follow');
  assert.deepEqual(saved.actions, ['booking', 'bill']);
  assert.deepEqual(saved.stats, ['booking_due']);
  assert.deepEqual((await c.get('/api/auth/me')).data.user.preferences.dashboard, saved, 'kept for next time');

  const other = await newBusiness();
  assert.deepEqual((await other.get('/api/auth/me')).data.user.preferences.dashboard, start, 'each login has its own');
  assert.equal((await client().put('/api/auth/preferences', { dashboard: {} })).status, 401);
});

test('bill maths: item discount, no GST', async () => {
  const c = await newBusiness();
  const p = await newProduct(c, { selling_price: 10000, tax_rate: 18 });
  const r = await c.post('/api/bills', { bill_date: today, items: [line(p, 2, { discount_pct: 10 })] });
  assert.equal(r.status, 201);
  const b = r.data.bill;
  assert.equal(b.subtotal, 20000);
  assert.equal(b.discount_total, 2000);
  assert.equal(b.tax_total, 0, 'no GST, whatever rate the product had');
  assert.equal(b.total, 18000);
  assert.equal(b.status, 'draft');
  assert.equal(b.invoice_no, null);
});

test('no GST on any bill, even when asked for', async () => {
  const c = await newBusiness();
  const p = await newProduct(c, { selling_price: 10000, tax_rate: 18 });
  const r = await c.post('/api/bills', { bill_date: today, with_gst: true, prices_include_tax: true, items: [line(p, 2, { tax_rate: 18 })] });
  assert.equal(r.status, 201);
  assert.equal(r.data.bill.with_gst, false);
  assert.equal(r.data.bill.prices_include_tax, false);
  assert.equal(r.data.bill.tax_total, 0);
  assert.equal(r.data.bill.total, 20000);
  assert.equal(r.data.items[0].tax_rate, 0);
});

test('bill discount: one percentage off the whole bill', async () => {
  const c = await newBusiness();
  const a = await newProduct(c, { selling_price: 30000, tax_rate: 0 });
  const b = await newProduct(c, { selling_price: 12500, tax_rate: 0 });
  assert.equal((await c.post('/api/bills', { bill_date: today, discount_pct: 101, items: [line(a, 1)] })).status, 400);

  // ₹300 + 2 × ₹125 = ₹550, less 10% = ₹495.
  const r = await c.post('/api/bills', { bill_date: today, discount_pct: 10, items: [line(a, 1), line(b, 2)] });
  assert.equal(r.data.bill.subtotal, 55000);
  assert.equal(r.data.bill.discount_pct, 10);
  assert.equal(r.data.bill.discount_total, 5500);
  assert.equal(r.data.bill.total, 49500);

  // Creating the bill keeps that total; the advance can't be more than it.
  assert.equal((await c.post(`/api/bills/${r.data.bill.id}/finalize`, { payment: { amount: 50000, method: 'cash' } })).status, 400);
  const fin = await c.post(`/api/bills/${r.data.bill.id}/finalize`, { payment: { amount: 20000, method: 'cash' } });
  assert.equal(fin.data.bill.total, 49500);
  assert.equal(fin.data.bill.balance, 29500);
  const dup = await c.post(`/api/bills/${r.data.bill.id}/duplicate`, { bill_date: today });
  assert.equal(dup.data.bill.discount_pct, 10, 'a copy keeps the discount');
  assert.equal(dup.data.bill.total, 49500);
});

test('customer name and WhatsApp number typed on the bill', async () => {
  const c = await newBusiness();
  const p = await newProduct(c, { selling_price: 50000, tax_rate: 0 });
  const bad = await c.post('/api/bills', { bill_date: today, customer_name: 'Ravi', customer_phone: 'call me', items: [line(p, 1)] });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.field, 'customer_phone');

  // A new name becomes a saved customer with that WhatsApp number.
  const first = await c.post('/api/bills', { bill_date: today, customer_name: 'Ravi Kumar', customer_phone: '98765 43210', items: [line(p, 1)] });
  const ravi = first.data.bill.customer_id;
  assert.ok(ravi);
  assert.equal(first.data.bill.customer_phone, '98765 43210');
  const saved = (await c.get(`/api/customers/${ravi}`)).data.customer;
  assert.equal(saved.name, 'Ravi Kumar');
  assert.equal(saved.phone, '98765 43210');

  // Same name and number again: reuse, don't duplicate (number formatting doesn't matter).
  const again = await c.post('/api/bills', { bill_date: today, customer_name: 'ravi kumar', customer_phone: '+91 98765-43210', items: [line(p, 1)] });
  assert.equal(again.data.bill.customer_id, ravi);
  assert.equal((await c.get('/api/customers')).data.total, 1);
  // Searching by digits finds the customer whatever the spacing.
  assert.equal((await c.get('/api/customers?q=9876543210')).data.customers[0].id, ravi);

  // Picking the saved customer with a new number updates their number.
  const updated = await c.post('/api/bills', { bill_date: today, customer_id: ravi, customer_phone: '91234 56789', items: [line(p, 1)] });
  assert.equal(updated.data.bill.customer_phone, '91234 56789');
  assert.equal((await c.get(`/api/customers/${ravi}`)).data.customer.phone, '91234 56789');

  // A number without a name stays on the bill only (walk-in).
  const walkIn = await c.post('/api/bills', { bill_date: today, customer_phone: '90000 11111', items: [line(p, 1)] });
  assert.equal(walkIn.data.bill.customer_id, null);
  assert.equal(walkIn.data.bill.customer_phone, '90000 11111');
  const fin = await c.post(`/api/bills/${walkIn.data.bill.id}/finalize`, { payment: { amount: 20000, method: 'cash' } });
  assert.equal(fin.data.bill.customer_phone, '90000 11111');
  assert.equal(fin.data.bill.amount_paid, 20000);
  assert.equal(fin.data.bill.balance, 30000);

  // The Bills list finds a bill by mobile number, with or without +91.
  for (const q of ['90000 11111', '+91 90000 11111']) {
    assert.deepEqual((await c.get(`/api/bills?q=${encodeURIComponent(q)}`)).data.bills.map((b) => b.id), [walkIn.data.bill.id]);
  }
});

test('pay the balance by UPI from the bill link', async () => {
  const c = await newBusiness();
  const p = await newProduct(c, { selling_price: 500000, tax_rate: 0 });
  const draft = (await c.post('/api/bills', { bill_date: today, customer_name: 'Asha', items: [line(p, 1)] })).data.bill;
  await c.post(`/api/bills/${draft.id}/finalize`, { payment: { amount: 100000, method: 'cash' } });
  const path = new URL((await c.post(`/api/bills/${draft.id}/share`, {})).data.share_url).pathname;
  const page = async (suffix = '') => (await fetch(`${base}${path}${suffix}`)).text();

  // No UPI ID yet: the customer is asked to contact the business.
  assert.match(await page('/pay'), /contact Test Shop/);
  assert.doesNotMatch(await page(), /Pay now by UPI/);

  const settings = (await c.get('/api/settings')).data.business;
  await c.put('/api/settings', { ...settings, upi_id: 'studio@okaxis', phone: '97990 16153' });
  const pay = await page('/pay');
  assert.match(pay, /href="upi:\/\/pay\?pa=studio@okaxis&amp;pn=Test%20Shop%20\d+&amp;am=4000\.00&amp;cu=INR&amp;tn=Bill%20INV-0001"/);
  assert.match(pay, /<svg[^>]+aria-label="QR code to pay ₹4,000\.00 by UPI"/, 'a QR code to scan');
  assert.match(pay, /wa\.me\/919799016153\?text=/, 'send the payment screenshot on WhatsApp');
  assert.match(await page(), new RegExp(`<a class="public-btn public-btn-pay" href="${path}/pay">Pay now by UPI</a>`));
  const pdf = await fetch(`${base}${path}/pdf`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.ok((await pdf.arrayBuffer()).byteLength > 5000);

  // Paid in full: nothing is left to pay.
  await c.post(`/api/bills/${draft.id}/payments`, { amount: 400000, method: 'online', paid_on: today });
  assert.match(await page('/pay'), /fully paid/);
  assert.doesNotMatch(await page(), /Pay now by UPI/);
  assert.equal((await fetch(`${base}/i/${'x'.repeat(32)}/pay`)).status, 404);
});

test('inventory: drafts never touch stock; finalize deducts exactly once', async () => {
  const c = await newBusiness();
  const p = await newProduct(c, { quantity: 10 });
  const draft = (await c.post('/api/bills', { bill_date: today, items: [line(p, 3), line(p, 1)] })).data.bill;
  assert.equal(await stockOf(c, p.id), 10, 'draft must not change stock');

  const edited = await c.put(`/api/bills/${draft.id}`, { bill_date: today, items: [line(p, 4)] });
  assert.equal(edited.status, 200);
  assert.equal(await stockOf(c, p.id), 10, 'editing a draft must not change stock');

  // Two finalize requests at the same time (double click / retry).
  const [a, b] = await Promise.all([
    c.post(`/api/bills/${draft.id}/finalize`, {}),
    c.post(`/api/bills/${draft.id}/finalize`, {}),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const conflict = a.status === 409 ? a : b;
  assert.equal(conflict.data.error.code, 'ALREADY_FINALIZED');
  assert.equal(await stockOf(c, p.id), 6, 'stock deducted exactly once');

  const again = await c.post(`/api/bills/${draft.id}/finalize`, {});
  assert.equal(again.status, 409);
  assert.equal(await stockOf(c, p.id), 6);

  const detail = await c.get(`/api/bills/${draft.id}`);
  assert.equal(detail.data.bill.invoice_no, 'INV-0001');
  assert.equal(detail.data.bill.status, 'finalized');

  const moves = await c.get(`/api/stock/movements?product_id=${p.id}`);
  const sales = moves.data.movements.filter((m) => m.type === 'sale');
  assert.equal(sales.length, 1);
  assert.equal(sales[0].quantity, -4);
  assert.equal(sales[0].balance_after, 6);

  assert.equal((await c.put(`/api/bills/${draft.id}`, { bill_date: today, items: [line(p, 1)] })).status, 409, 'finalized bills are read-only');
  assert.equal((await c.del(`/api/bills/${draft.id}`)).status, 409, 'finalized bills cannot be deleted');
});

test('inventory: insufficient stock warns, and can be overridden explicitly', async () => {
  const c = await newBusiness();
  const p = await newProduct(c, { quantity: 2 });
  const draft = (await c.post('/api/bills', { bill_date: today, items: [line(p, 5)] })).data.bill;
  const warn = await c.post(`/api/bills/${draft.id}/finalize`, {});
  assert.equal(warn.status, 409);
  assert.equal(warn.data.error.code, 'INSUFFICIENT_STOCK');
  assert.equal(warn.data.error.details[0].available, 2);
  assert.equal(warn.data.error.details[0].required, 5);
  assert.equal(await stockOf(c, p.id), 2, 'a rejected finalize leaves stock alone');
  assert.equal((await c.get(`/api/bills/${draft.id}`)).data.bill.status, 'draft');

  const ok = await c.post(`/api/bills/${draft.id}/finalize`, { allow_insufficient: true });
  assert.equal(ok.status, 200);
  assert.equal(await stockOf(c, p.id), -3);
});

test('cancelling a finalized bill restores stock once', async () => {
  const c = await newBusiness();
  const p = await newProduct(c, { quantity: 10 });
  const q = await newProduct(c, { quantity: 5 });
  const draft = (await c.post('/api/bills', { bill_date: today, items: [line(p, 4), line(q, 2)] })).data.bill;
  await c.post(`/api/bills/${draft.id}/finalize`, {});
  assert.equal(await stockOf(c, p.id), 6);
  assert.equal(await stockOf(c, q.id), 3);

  const cancel = await c.post(`/api/bills/${draft.id}/cancel`, { reason: 'Returned' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.bill.status, 'cancelled');
  assert.equal(cancel.data.restored_products, 2);
  assert.equal(await stockOf(c, p.id), 10);
  assert.equal(await stockOf(c, q.id), 5);

  assert.equal((await c.post(`/api/bills/${draft.id}/cancel`, {})).status, 409);
  assert.equal(await stockOf(c, p.id), 10, 'second cancel does not restore again');
  assert.equal((await c.post(`/api/bills/${draft.id}/payments`, { amount: 100, method: 'cash', paid_on: today })).status, 409);

  const draftOnly = (await c.post('/api/bills', { bill_date: today, items: [line(p, 1)] })).data.bill;
  assert.equal((await c.post(`/api/bills/${draftOnly.id}/cancel`, {})).status, 409, 'drafts are deleted, not cancelled');
});

test('payments: partial, full, overpayment and deletion', async () => {
  const c = await newBusiness();
  const p = await newProduct(c, { selling_price: 10000, tax_rate: 0 });
  const draft = (await c.post('/api/bills', { bill_date: today, items: [line(p, 1)] })).data.bill;
  assert.equal((await c.post(`/api/bills/${draft.id}/payments`, { amount: 100, method: 'cash' })).status, 409, 'no payments on drafts');

  const fin = await c.post(`/api/bills/${draft.id}/finalize`, { payment: { amount: 4000, method: 'online', reference: 'UPI123' } });
  assert.equal(fin.data.bill.payment_status, 'partial');
  assert.equal(fin.data.bill.amount_paid, 4000);

  const over = await c.post(`/api/bills/${draft.id}/payments`, { amount: 7000, method: 'cash', paid_on: today });
  assert.equal(over.status, 400);
  assert.equal(over.data.error.field, 'amount');
  const badMethod = await c.post(`/api/bills/${draft.id}/payments`, { amount: 100, method: 'cheque', paid_on: today });
  assert.equal(badMethod.status, 400);

  const rest = await c.post(`/api/bills/${draft.id}/payments`, { amount: 6000, method: 'online', paid_on: today });
  assert.equal(rest.status, 201);
  assert.equal(rest.data.bill.payment_status, 'paid');
  assert.equal(rest.data.bill.balance, 0);

  const paymentId = rest.data.payments.find((x) => x.method === 'online' && x.amount === 6000).id;
  const removed = await c.del(`/api/bills/${draft.id}/payments/${paymentId}`);
  assert.equal(removed.data.bill.payment_status, 'partial');
  assert.equal(removed.data.bill.balance, 6000);
});

test('paid less: the rest can be let go as a discount at payment', async () => {
  const c = await newBusiness();
  const p = await newProduct(c, { selling_price: 71100, tax_rate: 0 });
  const pay = (id, body) => c.post(`/api/bills/${id}/payments`, { method: 'cash', paid_on: today, ...body });
  // A ₹711 bill with ₹100 advance: ₹611 due.
  const bill = (await c.post('/api/bills', { bill_date: today, items: [line(p, 1)] })).data.bill;
  await c.post(`/api/bills/${bill.id}/finalize`, { payment: { amount: 10000, method: 'cash' } });

  // The customer pays ₹600 and the last ₹11 is let go: the bill is paid, its total is now ₹700.
  const settled = await pay(bill.id, { amount: 60000, method: 'online', settle: true });
  assert.equal(settled.status, 201);
  assert.deepEqual(
    ['payment_status', 'total', 'amount_paid', 'balance', 'settle_discount', 'discount_total'].map((k) => settled.data.bill[k]),
    ['paid', 70000, 70000, 0, 1100, 1100],
  );
  assert.equal((await pay(bill.id, { amount: 0, settle: true })).status, 409, 'nothing left to let go');

  // Sales count what was actually charged; money received is what came in.
  const summary = (await c.get(`/api/reports/sales?from=${today}&to=${today}`)).data.summary;
  assert.deepEqual([summary.sales, summary.collected], [70000, 70000]);

  // Without settle, paying less keeps the rest due; with settle and no amount, all of it is let go.
  const second = (await c.post('/api/bills', { bill_date: today, items: [line(p, 1)] })).data.bill;
  await c.post(`/api/bills/${second.id}/finalize`, {});
  assert.equal((await pay(second.id, { amount: 70000 })).data.bill.balance, 1100);
  assert.equal((await pay(second.id, { amount: 0 })).status, 400, 'an amount is needed unless the rest is let go');
  const letGo = await pay(second.id, { settle: true });
  assert.deepEqual([letGo.data.bill.payment_status, letGo.data.bill.total, letGo.data.payments.length], ['paid', 70000, 1]);
});

test('tenant isolation: one business can never see or use another business’s data', async () => {
  const a = await newBusiness();
  const b = await newBusiness();
  const pa = await newProduct(a);
  const ca = (await a.post('/api/customers', { name: 'Alice', phone: '+91 98765 00000' })).data.customer;
  const billA = (await a.post('/api/bills', { bill_date: today, customer_id: ca.id, items: [line(pa, 1)] })).data.bill;
  await a.post(`/api/bills/${billA.id}/finalize`, {});

  assert.equal((await b.get(`/api/products/${pa.id}`)).status, 404);
  assert.equal((await b.put(`/api/products/${pa.id}`, { name: 'Hacked', selling_price: 1 })).status, 404);
  assert.equal((await b.post(`/api/products/${pa.id}/stock`, { mode: 'add', quantity: 5 })).status, 404);
  assert.equal((await b.get(`/api/customers/${ca.id}`)).status, 404);
  assert.equal((await b.get(`/api/bills/${billA.id}`)).status, 404);
  assert.equal((await b.get(`/api/bills/${billA.id}/pdf`)).status, 404);
  assert.equal((await b.post(`/api/bills/${billA.id}/cancel`, {})).status, 404);
  assert.equal((await b.post(`/api/bills/${billA.id}/share`, {})).status, 404);
  assert.equal((await b.post(`/api/bills/${billA.id}/payments`, { amount: 1, method: 'cash' })).status, 404);

  const products = await b.get('/api/products?status=all');
  assert.equal(products.data.total, 0);
  assert.equal((await b.get('/api/bills')).data.total, 0);
  assert.equal((await b.get('/api/customers')).data.total, 0);
  assert.equal((await b.get(`/api/stock/movements?product_id=${pa.id}`)).data.total, 0);

  const steal = await b.post('/api/bills', { bill_date: today, items: [line(pa, 1)] });
  assert.equal(steal.status, 400, 'cannot bill another business’s product');
  const stealCustomer = await b.post('/api/bills', { bill_date: today, customer_id: ca.id, items: [{ name: 'Thing', quantity: 1, unit_price: 100 }] });
  assert.equal(stealCustomer.status, 400, 'cannot bill another business’s customer');
  assert.equal(await stockOf(a, pa.id), 9);
});

test('share links: unguessable, scoped to one invoice, revocable', async () => {
  const c = await newBusiness();
  const p = await newProduct(c);
  const mk = async () => {
    const d = (await c.post('/api/bills', { bill_date: today, items: [line(p, 1)] })).data.bill;
    return (await c.post(`/api/bills/${d.id}/finalize`, {})).data.bill;
  };
  const one = await mk();
  const two = await mk();
  const draft = (await c.post('/api/bills', { bill_date: today, items: [line(p, 1)] })).data.bill;
  assert.equal((await c.post(`/api/bills/${draft.id}/share`, {})).status, 409, 'drafts cannot be shared');

  const share = await c.post(`/api/bills/${one.id}/share`, {});
  const url = new URL(share.data.share_url);
  const token = url.pathname.split('/').pop();
  assert.ok(token.length >= 32, 'token is long and random');
  assert.equal((await c.post(`/api/bills/${one.id}/share`, {})).data.share_url, share.data.share_url, 'stable until regenerated');

  const page = await fetch(`${base}${url.pathname}`);
  const htmlText = await page.text();
  assert.equal(page.status, 200);
  assert.match(htmlText, new RegExp(one.invoice_no));
  assert.doesNotMatch(htmlText, new RegExp(two.invoice_no), 'only the shared invoice is visible');
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  const pdf = await fetch(`${base}${url.pathname}/pdf`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal((await fetch(`${base}/i/not-a-real-token-at-all-0000000`)).status, 404);

  const regen = await c.post(`/api/bills/${one.id}/share`, { regenerate: true });
  assert.notEqual(regen.data.share_url, share.data.share_url);
  assert.equal((await fetch(`${base}${url.pathname}`)).status, 404, 'old link stops working');
  const newPath = new URL(regen.data.share_url).pathname;
  assert.equal((await fetch(`${base}${newPath}`)).status, 200);

  await c.del(`/api/bills/${one.id}/share`);
  assert.equal((await fetch(`${base}${newPath}`)).status, 404, 'revoked link stops working');
  assert.equal((await fetch(`${base}${newPath}/pdf`)).status, 404);
});

test('products: unique SKU/barcode, lookup and stock adjustments', async () => {
  const c = await newBusiness();
  const p = await newProduct(c, { sku: 'ABC-1', barcode: '1234567890123', quantity: 5 });
  const dup = await c.post('/api/products', { name: 'Other', sku: 'abc-1', selling_price: 100 });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.field, 'sku');
  assert.equal((await c.post('/api/products', { name: 'No price' })).data.error.field, 'selling_price');

  assert.equal((await c.get('/api/products/lookup?code=1234567890123')).data.product.id, p.id);
  assert.equal((await c.get('/api/products/lookup?code=ABC-1')).data.product.id, p.id);
  assert.equal((await c.get('/api/products/lookup?code=nope')).data.product, null);

  assert.equal((await c.post(`/api/products/${p.id}/stock`, { mode: 'add', quantity: 10, unit_cost: 6500, update_purchase_price: true })).data.product.quantity, 15);
  assert.equal((await c.get(`/api/products/${p.id}`)).data.product.purchase_price, 6500);
  assert.equal((await c.post(`/api/products/${p.id}/stock`, { mode: 'remove', quantity: 2 })).status, 400, 'reason required');
  assert.equal((await c.post(`/api/products/${p.id}/stock`, { mode: 'remove', quantity: 99, note: 'Damaged' })).status, 400, 'cannot remove more than available');
  assert.equal((await c.post(`/api/products/${p.id}/stock`, { mode: 'remove', quantity: 2, note: 'Damaged' })).data.product.quantity, 13);
  assert.equal((await c.post(`/api/products/${p.id}/stock`, { mode: 'set', quantity: 20, note: 'Count' })).data.product.quantity, 20);

  const types = (await c.get(`/api/stock/movements?product_id=${p.id}`)).data.movements.map((m) => m.type).reverse();
  assert.deepEqual(types, ['opening', 'purchase', 'adjustment', 'adjustment']);

  const updated = await c.put(`/api/products/${p.id}`, { name: 'Renamed', selling_price: 12345, quantity: 999 });
  assert.equal(updated.data.product.name, 'Renamed');
  assert.equal(updated.data.product.quantity, 20, 'editing a product cannot change stock directly');
});

test('services are billable but never touch stock', async () => {
  const c = await newBusiness();
  const shoot = await newProduct(c, { kind: 'service', name: 'Wedding Photography', sku: 'SVC-WED', barcode: '', unit: 'day', selling_price: 4000000, quantity: 99, low_stock_threshold: 9 });
  assert.equal(shoot.is_service, true);
  assert.equal(shoot.quantity, 0, 'services ignore opening stock');
  assert.equal(shoot.is_low, false);
  const frame = await newProduct(c, { quantity: 1 });

  assert.equal((await c.post(`/api/products/${shoot.id}/stock`, { mode: 'add', quantity: 5 })).status, 400);
  const low = (await c.get('/api/products?status=low')).data.products;
  assert.deepEqual(low.map((p) => p.id), [frame.id], 'services never show as low stock');
  assert.equal((await c.get('/api/products?kind=service')).data.total, 1);

  const draft = (await c.post('/api/bills', { bill_date: today, items: [line(shoot, 2), line(frame, 1)] })).data.bill;
  const fin = await c.post(`/api/bills/${draft.id}/finalize`, {});
  assert.equal(fin.status, 200, 'no insufficient-stock warning for services');
  assert.equal(fin.data.items.find((i) => i.product_id === shoot.id).is_service, true);
  assert.equal(await stockOf(c, shoot.id), 0);
  assert.equal(await stockOf(c, frame.id), 0);
  assert.equal((await c.get(`/api/stock/movements?product_id=${shoot.id}`)).data.total, 0);

  const cancel = await c.post(`/api/bills/${draft.id}/cancel`, {});
  assert.equal(cancel.data.restored_products, 1, 'only the stocked product is restored');
  assert.equal(await stockOf(c, frame.id), 1);

  const tooMuch = await newProduct(c, { quantity: 3 });
  const toService = await c.put(`/api/products/${tooMuch.id}`, { kind: 'service', name: tooMuch.name, selling_price: 100 });
  assert.equal(toService.status, 400, 'cannot turn a stocked product into a service while it has stock');
});

test('customers: invoice history, outstanding balance and protected delete', async () => {
  const c = await newBusiness();
  const p = await newProduct(c, { selling_price: 5000, tax_rate: 0 });
  const bad = await c.post('/api/customers', { name: 'Bad', gstin: 'NOTAGSTIN' });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.field, 'gstin');
  const cust = (await c.post('/api/customers', { name: 'Ravi', phone: '9876543210', email: 'ravi@example.com', address: 'Pune' })).data.customer;
  const d = (await c.post('/api/bills', { bill_date: today, customer_id: cust.id, items: [line(p, 2)] })).data.bill;
  await c.post(`/api/bills/${d.id}/finalize`, { payment: { amount: 3000, method: 'cash' } });
  const detail = await c.get(`/api/customers/${cust.id}`);
  assert.equal(detail.data.stats.total_billed, 10000);
  assert.equal(detail.data.stats.outstanding, 7000);
  assert.equal(detail.data.bills.length, 1);
  assert.equal((await c.get('/api/customers?filter=outstanding')).data.customers[0].outstanding, 7000);
  assert.equal((await c.del(`/api/customers/${cust.id}`)).status, 409);
  const spare = (await c.post('/api/customers', { name: 'Spare' })).data.customer;
  assert.equal((await c.del(`/api/customers/${spare.id}`)).status, 200);
});

test('reports, dashboard and CSV export', async () => {
  const c = await newBusiness();
  // 50 in stock, 3 sold below -> 47 left, which is under the alert level of 48.
  const p = await newProduct(c, { selling_price: 10000, tax_rate: 0, quantity: 50, low_stock_threshold: 48 });
  const cust = (await c.post('/api/customers', { name: '=HYPERLINK("http://evil")' })).data.customer;
  for (const qty of [1, 2]) {
    const d = (await c.post('/api/bills', { bill_date: today, customer_id: cust.id, items: [line(p, qty)] })).data.bill;
    await c.post(`/api/bills/${d.id}/finalize`, { payment: { amount: qty * 10000, method: qty === 1 ? 'cash' : 'online' } });
  }
  const r = await c.get(`/api/reports/sales?from=${today}&to=${today}`);
  assert.equal(r.data.summary.bills, 2);
  assert.equal(r.data.summary.sales, 30000);
  assert.equal(r.data.summary.collected, 30000);
  assert.equal(r.data.top_products[0].quantity, 3);
  assert.equal(r.data.low_stock.count, 1);
  assert.equal(r.data.payment_methods.length, 2);

  const dash = await c.get(`/api/dashboard?from=${today}&to=${today}&today=${today}`);
  assert.equal(dash.data.sales.total, 30000);
  assert.equal(dash.data.paid.count, 2);
  assert.equal(dash.data.inventory.cost_value, 47 * 7000);

  const csv = await c.get(`/api/reports/export?type=bills&from=${today}&to=${today}`);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /Invoice No,Bill Date/);
  assert.match(csv.data, /INV-0002/);
  assert.match(csv.data, /"'=HYPERLINK\(""http:\/\/evil""\)"/, 'formula cells are neutralised');
  for (const type of ['items', 'payments', 'inventory', 'daybook']) {
    assert.equal((await c.get(`/api/reports/export?type=${type}`)).status, 200);
  }
  assert.equal((await c.get('/api/reports/sales?from=2026-12-01&to=2026-01-01')).status, 400);
});

test('settings: business details, numbering, UPI ID and logo validation', async () => {
  const c = await newBusiness();
  const base = (await c.get('/api/settings')).data.business;
  const bad = await c.put('/api/settings', { ...base, upi_id: 'not a upi id' });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.field, 'upi_id');
  const saved = await c.put('/api/settings', {
    ...base, upi_id: ' DeveshStudio@OKAXIS ', invoice_prefix: 'SHOP/', next_invoice_no: 41, currency: 'USD', round_off: false,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.business.upi_id, 'deveshstudio@okaxis');

  // Website: https:// and a trailing slash are dropped, the domain is lower-cased; junk is refused.
  const site = await c.put('/api/settings', { ...saved.data.business, website: ' https://WWW.DeveshStudio.com/ ' });
  assert.equal(site.status, 200);
  assert.equal(site.data.business.website, 'www.deveshstudio.com');
  for (const website of ['not a site', 'javascript:alert(1)', 'www.example.com/<b>']) {
    const r = await c.put('/api/settings', { ...saved.data.business, website });
    assert.equal(r.status, 400, website);
    assert.equal(r.data.error.field, 'website');
  }

  // Bill design: tagline, colour and header style.
  assert.equal(base.bill_color, '#f26b1d');
  assert.equal(base.bill_header, 'dark');
  const design = await c.put('/api/settings', { ...saved.data.business, tagline: 'Photos that last', bill_color: '#7C3AED', bill_header: 'light' });
  assert.equal(design.data.business.bill_color, '#7c3aed');
  assert.equal(design.data.business.bill_header, 'light');
  assert.equal(design.data.business.tagline, 'Photos that last');
  const badColor = await c.put('/api/settings', { ...design.data.business, bill_color: 'url(javascript:x)' });
  assert.equal(badColor.status, 400);
  assert.equal(badColor.data.error.field, 'bill_color');
  assert.equal((await c.put('/api/settings', { ...design.data.business, bill_header: 'neon' })).status, 400);

  const p = await newProduct(c, { selling_price: 1000, tax_rate: 7 });
  const d = (await c.post('/api/bills', { bill_date: today, items: [line(p, 1)] })).data.bill;
  const fin = await c.post(`/api/bills/${d.id}/finalize`, {});
  assert.equal(fin.data.bill.invoice_no, 'SHOP/0041');
  assert.equal(fin.data.bill.currency, 'USD');
  assert.equal(fin.data.bill.total, 1000, 'no tax is added');

  assert.equal((await c.post('/api/settings/logo', { data_url: 'data:text/html;base64,PGgxPg==' })).status, 400);
  assert.equal((await c.post('/api/settings/logo', { data_url: 'data:image/png;base64,PGgxPg==' })).status, 400, 'content must really be PNG');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const logo = await c.post('/api/settings/logo', { data_url: `data:image/png;base64,${png}` });
  assert.equal(logo.data.business.has_logo, true);
  assert.equal((await c.get(logo.data.business.logo_url)).status, 200);
});

test('demo data is flagged and removable without touching real data', async () => {
  const c = await newBusiness({ load_demo: true });
  const me = await c.get('/api/auth/me');
  assert.equal(me.data.has_demo_data, true);
  const products = (await c.get('/api/products')).data.products;
  assert.ok(products.length >= 10);
  assert.ok(products.every((p) => p.is_demo));
  assert.ok((await c.get('/api/customers')).data.customers.every((x) => x.is_demo));

  const real = await newProduct(c);
  const demoProduct = products[0];
  const d = (await c.post('/api/bills', { bill_date: today, items: [line(real, 1), line(demoProduct, 1)] })).data.bill;
  await c.post(`/api/bills/${d.id}/finalize`, {});

  const removed = await c.post('/api/settings/demo/remove', {});
  assert.equal(removed.status, 200);
  assert.equal(removed.data.has_demo_data, false);
  const left = (await c.get('/api/products?status=all')).data.products;
  assert.deepEqual(left.map((p) => p.id), [real.id]);
  const bill = (await c.get(`/api/bills/${d.id}`)).data;
  assert.equal(bill.items.length, 2, 'real invoices keep their lines');
  assert.equal(bill.bill.invoice_no, 'INV-0001');
});

test('demo account: studio catalog, bills, stock alerts and logo', async () => {
  await ensureDemoAccount();
  await ensureDemoAccount(); // idempotent
  const c = client();
  const login = await c.post('/api/auth/login', DEMO_ACCOUNT);
  assert.equal(login.status, 200);
  assert.match(login.data.business.name, /Devesh Digital Studio/);
  assert.equal(login.data.business.has_logo, true);
  assert.equal((await c.get(login.data.business.logo_url)).headers.get('content-type'), 'image/png');

  const bills = (await c.get('/api/bills?limit=50')).data;
  assert.equal(bills.total, 15);
  assert.equal(bills.bills.filter((b) => b.status === 'draft').length, 1);
  assert.equal(bills.bills.filter((b) => b.status === 'cancelled').length, 1);
  assert.ok((await c.get('/api/products?kind=service')).data.total >= 10);
  const low = (await c.get('/api/products?status=low')).data.products.map((p) => p.name).sort();
  assert.deepEqual(low, ['Canvas Print 16x20', 'Memory Card 64 GB', 'Photo Frame 12x18 (Premium)', 'Photo Mug (Custom Print)']);

  const pdf = await fetch(`${base}/api/bills/${bills.bills[1].id}/pdf`, { headers: { cookie: login.headers.get('set-cookie').split(';')[0] } });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');

  const work = (await c.get('/api/tracking')).data;
  assert.deepEqual(work.counts, { received: 1, design: 1, review: 2, print: 2, frame: 1, final: 1 });
  assert.equal(work.jobs.length, 8, 'All lists every tracked job, Final included');
  assert.ok(work.jobs.every((j) => j.photo_source), 'sample jobs say how the photo came in');
  const dates = work.jobs.map((j) => j.bill_date);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'newest jobs first');
  assert.ok(work.jobs.every((j) => j.items.length > 0), 'each job shows what was ordered');

  const dayBook = (await c.get('/api/day-book?from=2000-01-01&to=2100-12-31')).data;
  const book = dayBook.entries;
  assert.deepEqual(['sale', 'received', 'expense'].map((k) => book.filter((x) => x.kind === k).length), [3, 1, 8]);
  assert.ok(book.every((x) => x.is_demo), 'sample day book entries are marked Demo');
  assert.equal(dayBook.booking_payments.length, 12, 'booking payments show in the day book');

  // Sample bookings at every step, with a team; removing demo data takes them all away.
  const bookings = (await c.get('/api/bookings')).data;
  assert.equal(bookings.total, 10);
  assert.ok(bookings.bookings.every((b) => b.is_demo));
  const statuses = bookings.bookings.map((b) => b.status).sort();
  assert.deepEqual(statuses, ['cancelled', 'closed', 'confirmed', 'editing', 'new', 'on_hold', 'ready', 'review', 'scheduled', 'scheduled']);
  const overview = (await c.get('/api/bookings/overview')).data;
  assert.equal(overview.summary.cancelled, 1);
  assert.equal(overview.today_shoots.length, 1);
  const kinds = new Set(overview.reminders.map((r) => r.type));
  for (const k of ['overdue', 'tomorrow', 'review', 'payment']) assert.ok(kinds.has(k), `a ${k} reminder`);
  assert.equal((await c.get('/api/team')).data.members.length, 6);
  const removed = (await c.post('/api/settings/demo/remove', {})).data;
  assert.deepEqual([removed.removed.bookings, removed.removed.team, removed.has_demo_data], [10, 6, false]);
  assert.equal((await c.get('/api/bookings')).data.total, 0);
});

test('bookings: create, booking numbers, the advance, search and filters', async () => {
  const c = await newBusiness();
  const ravi = (await c.post('/api/team', { name: 'Ravi', role: 'Photographer', phone: '90000 11111' })).data.member;
  const neha = (await c.post('/api/team', { name: 'Neha', role: 'Editor' })).data.member;
  assert.equal((await c.post('/api/team', { name: '' })).status, 400);

  const bad = async (body) => (await c.post('/api/bookings', { client_name: 'X', schedule: [{ date: today }], ...body })).data.error?.field;
  assert.equal((await c.post('/api/bookings', { schedule: [{ date: today }] })).data.error.field, 'client_name');
  assert.equal(await bad({ schedule: [] }), 'schedule.0.date');
  assert.equal(await bad({ schedule: [{ date: today }, { date: 'tomorrow' }] }), 'schedule.1.date');
  assert.equal(await bad({ schedule: [{ date: today, start: '25:00' }] }), 'schedule.0.start');
  assert.equal(await bad({ services: [{ qty: 1, rate: 100 }] }), 'services.0.name');
  assert.equal(await bad({ services: [{ name: 'Album', rate: 1.5 }] }), 'services.0.rate');
  assert.equal(await bad({ services: [{ name: 'Album', rate: 1000 }], discount: 2000 }), 'discount');
  assert.equal(await bad({ services: [{ name: 'Album', rate: 1000000 }], advance: { amount: 2000000 } }), 'advance_amount');
  assert.equal(await bad({ team: [{ member_id: 999999 }] }), 'team');

  // A studio service from Inventory can be linked to a line; its price is whatever the line says.
  const candid = (await c.post('/api/products', { kind: 'service', name: 'Candid Photography', selling_price: 2500000, unit: 'day' })).data.product;
  const created = await c.post(`/api/bookings?today=${today}`, {
    client_name: 'Rahul & Priya', client_whatsapp: '98290 11111', client_address: '12 Vaishali Nagar\nJaipur', event_type: 'Wedding',
    event_name: 'Rahul & Priya',
    // Dates can be apart, each with its own times and venue (sent in any order).
    schedule: [
      { date: inDays(12), start: '16:00', end: '23:00', venue: 'Hotel Clarks Amer' },
      { date: inDays(10), start: '10:00', end: '13:00', venue: 'Verma House' },
    ],
    services: [
      { name: 'Candid Photography', qty: 2, rate: 2500000, product_id: candid.id },
      { name: 'Cinematic video', qty: 1, rate: 4500000 },
      { name: 'Album', qty: 1.5, rate: 1000000 },
    ],
    discount: 1000000, package_name: 'Gold',
    team: [{ member_id: ravi.id }, { member_id: neha.id }, { member_id: ravi.id, role: 'Assistant' }],
    advance: { amount: 5000000, method: 'upi', paid_on: today, note: 'Advance' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const b = created.data.booking;
  assert.equal(b.number, 'BK-0001');
  assert.deepEqual(b.schedule.map((d) => [d.date, d.start, d.venue]), [[inDays(10), '10:00', 'Verma House'], [inDays(12), '16:00', 'Hotel Clarks Amer']]);
  assert.deepEqual([b.event_date, b.end_date, b.days], [inDays(10), inDays(12), 2]);
  assert.equal(b.client_address, '12 Vaishali Nagar\nJaipur');
  assert.deepEqual(b.services.map((s) => [s.name, s.amount, s.product_id]), [
    ['Candid Photography', 5000000, candid.id], ['Cinematic video', 4500000, undefined], ['Album', 1500000, undefined],
  ]);
  assert.deepEqual([b.subtotal, b.discount, b.total], [11000000, 1000000, 10000000], 'the total is the services less the discount');
  assert.deepEqual([b.amount_paid, b.balance, b.payment_status], [5000000, 5000000, 'partial']);
  assert.deepEqual(b.team.map((t) => [t.name, t.role]), [['Ravi', 'Photographer'], ['Neha', 'Editor']], 'one role per person');
  assert.ok(b.checklist.team && b.checklist.editor, 'assigning the team ticks Team assigned and Editor assigned');
  assert.equal(created.data.payments[0].method, 'upi');
  const log = created.data.activity.map((a) => a.text);
  assert.ok(log.includes('Booking created · New booking'));
  assert.ok(log.includes('Assigned: Ravi (Photographer), Neha (Editor)'));
  assert.ok(log.some((t) => t.startsWith('₹50,000.00 advance received · UPI')));
  // The client is saved as a customer, like a bill's.
  const saved = (await c.get('/api/customers?q=98290')).data.customers;
  assert.deepEqual(saved.map((x) => x.name), ['Rahul & Priya']);

  // Sent the old way, one event_date with a number of days is still read: consecutive dates with the same times.
  const second = (await c.post('/api/bookings', {
    client_name: 'Kavita Meena', event_type: 'Birthday', event_date: today, days: 2, start_time: '18:00', venue: 'Shree Ram Banquet',
    services: [{ name: 'Photography', rate: 1800000 }],
  })).data.booking;
  assert.equal(second.number, 'BK-0002');
  assert.deepEqual(second.schedule.map((d) => [d.date, d.start, d.venue]), [[today, '18:00', 'Shree Ram Banquet'], [inDays(1), '18:00', 'Shree Ram Banquet']]);
  const find = async (qs) => (await c.get(`/api/bookings?today=${today}&${qs}`)).data.bookings.map((x) => x.number);
  assert.deepEqual(await find(''), ['BK-0002', 'BK-0001'], 'soonest first');
  assert.deepEqual(await find('q=bk-0001'), ['BK-0001']);
  assert.deepEqual(await find('q=0002'), ['BK-0002']);
  assert.deepEqual(await find('q=shree'), ['BK-0002'], 'venue');
  assert.deepEqual(await find('q=clarks'), ['BK-0001'], 'the venue of any date');
  assert.deepEqual(await find('q=11111'), ['BK-0001'], 'WhatsApp number');
  assert.deepEqual(await find('q=wedding'), ['BK-0001'], 'event');
  assert.deepEqual(await find('type=Birthday'), ['BK-0002']);
  assert.deepEqual(await find(`member=${ravi.id}`), ['BK-0001']);
  assert.deepEqual(await find('payment=partial'), ['BK-0001']);
  assert.deepEqual(await find('status=new&payment=unpaid'), ['BK-0002']);
  assert.deepEqual(await find('quick=today'), ['BK-0002']);
  assert.deepEqual(await find(`from=${inDays(12)}&to=${inDays(12)}`), ['BK-0001'], 'listed on each of its dates');
  assert.deepEqual(await find(`from=${inDays(11)}&to=${inDays(11)}`), [], 'but not on the days between them');
  assert.deepEqual(await find('quick=payment'), ['BK-0001'], 'an enquiry with nothing paid is not owed yet');

  const overview = (await c.get(`/api/bookings/overview?today=${today}`)).data;
  assert.deepEqual([overview.summary.total, overview.summary.upcoming, overview.summary.payment, overview.summary.due], [2, 2, 1, 5000000]);
  assert.deepEqual(overview.today_shoots.map((x) => [x.number, x.day.date]), [['BK-0002', today]]);
  assert.deepEqual(overview.upcoming_shoots.map((x) => [x.number, x.day.date]), [['BK-0002', inDays(1)], ['BK-0001', inDays(10)]],
    'each with its next date');

  // Editing leaves out phone and email (not on the form any more): a booking keeps what it had.
  await c.put(`/api/bookings/${second.id}`, { ...second, client_phone: '90000 33333' });
  const edited = await c.put(`/api/bookings/${second.id}`, {
    client_name: 'Kavita Meena', schedule: second.schedule, services: second.services, client_address: 'Paota, Jaipur',
  });
  assert.deepEqual([edited.data.booking.client_phone, edited.data.booking.client_address], ['90000 33333', 'Paota, Jaipur']);
});

test('bookings: closing, coming back from cancelled, the client’s customer and sample team members', async () => {
  const c = await newBusiness();
  const ravi = (await c.post('/api/team', { name: 'Ravi', role: 'Photographer' })).data.member;
  const add = (body) => c.post(`/api/bookings?today=${today}`, {
    client_name: 'Client', event_date: inDays(5), services: [{ name: 'Shoot', rate: 100000 }], ...body,
  });
  const setStatus = (b, body) => c.put(`/api/bookings/${b.id}/status?today=${today}`, body);

  // Delivered and paid in full closes, whether set at the start or later; closing needs the full amount.
  assert.equal((await add({ status: 'delivered', advance: { amount: 100000 } })).data.booking.status, 'closed');
  const notPaid = await add({ status: 'closed', advance: { amount: 40000 } });
  assert.equal(notPaid.status, 400);
  assert.equal(notPaid.data.error.field, 'status');
  const paid = (await add({ status: 'editing', advance: { amount: 100000, method: 'upi' } })).data.booking;
  assert.equal((await setStatus(paid, { status: 'delivered' })).data.booking.status, 'closed');
  const due = (await add({ status: 'ready', advance: { amount: 40000 } })).data.booking;
  const closing = await setStatus(due, { status: 'closed' });
  assert.equal(closing.status, 400);
  assert.match(closing.data.error.message, /still due/);

  // A cancelled booking holds no one, so bringing it back checks its team again.
  const a = (await add({ client_name: 'A', team: [{ member_id: ravi.id }] })).data.booking;
  await setStatus(a, { status: 'cancelled', reason: 'Date moved' });
  assert.equal((await add({ client_name: 'B', team: [{ member_id: ravi.id }] })).status, 201);
  const back = await setStatus(a, { status: 'confirmed' });
  assert.equal(back.status, 409);
  assert.equal(back.data.error.code, 'TEAM_CONFLICT');
  assert.equal((await setStatus(a, { status: 'confirmed', allow_conflicts: true })).data.booking.status, 'confirmed');

  // Correcting the client's number updates their saved customer instead of adding another one.
  const k = (await add({ client_name: 'Asha Verma', client_whatsapp: '90000 11111' })).data.booking;
  const fixed = (await c.put(`/api/bookings/${k.id}`, { ...k, client_whatsapp: '90000 22222' })).data.booking;
  assert.equal(fixed.customer_id, k.customer_id);
  const ashas = (await c.get('/api/customers?q=Asha')).data.customers.filter((x) => x.name === 'Asha Verma');
  assert.deepEqual(ashas.map((x) => x.phone), ['90000 22222']);

  // Removing the sample data keeps sample team members the owner put on their own bookings; the rest go.
  const sample = (await c.post('/api/team', { name: 'Sample Aman', role: 'Videographer' })).data.member;
  const unused = (await c.post('/api/team', { name: 'Sample Neha', role: 'Editor' })).data.member;
  dbRun('UPDATE team_members SET is_demo = 1 WHERE id IN (?, ?)', sample.id, unused.id);
  const real = (await c.post(`/api/bookings?today=${today}`, { client_name: 'Real client', event_date: inDays(9), team: [{ member_id: sample.id }] })).data.booking;
  assert.equal((await c.post('/api/settings/demo/remove', {})).status, 200);
  assert.deepEqual((await c.get(`/api/bookings/${real.id}?today=${today}`)).data.booking.team.map((t) => t.name), ['Sample Aman']);
  const members = (await c.get('/api/team')).data.members.map((m) => m.name);
  assert.ok(members.includes('Sample Aman') && !members.includes('Sample Neha'), members.join(', '));
  assert.equal((await c.get('/api/auth/me')).data.has_demo_data, false, 'and no sample data is left');
});

test('bookings: team clashes, the workflow, payments and the day book', async () => {
  const c = await newBusiness();
  const ravi = (await c.post('/api/team', { name: 'Ravi', role: 'Photographer' })).data.member;
  const day = inDays(3);
  const add = (body) => c.post(`/api/bookings?today=${today}`, { client_name: 'Client', event_date: day, team: [{ member_id: ravi.id }], ...body });
  const first = (await add({
    client_name: 'Asha', start_time: '10:00', end_time: '14:00', venue: 'Clarks Amer', services: [{ name: 'Wedding package', rate: 2000000 }],
  })).data.booking;

  // The same person at an overlapping time is refused with the clash, unless saved anyway.
  const clash = await add({ start_time: '13:00', end_time: '18:00' });
  assert.equal(clash.status, 409);
  assert.equal(clash.data.error.code, 'TEAM_CONFLICT');
  assert.equal(clash.data.error.details[0].number, first.number);
  assert.equal((await add({ start_time: '14:00', end_time: '18:00' })).status, 201, 'back to back is fine');
  // Any date of a booking can clash; the warning says which date, time and venue.
  const later = await add({ schedule: [{ date: inDays(1), start: '09:00', end: '10:00' }, { date: day, start: '12:00', end: '13:00' }] });
  assert.equal(later.status, 409);
  assert.deepEqual(later.data.error.details.map((x) => [x.number, x.event_date, x.time, x.venue]), [[first.number, day, '10:00 am – 2:00 pm', 'Clarks Amer']]);
  assert.equal((await add({ schedule: [{ date: inDays(1), start: '09:00' }, { date: day, start: '19:00', end: '22:00' }] })).status, 201);
  assert.equal((await add({ event_date: inDays(2), days: 2 })).status, 409, 'a two-day booking holds the person both days');
  const forced = await add({ event_date: inDays(2), days: 2, allow_conflicts: true });
  assert.equal(forced.status, 201);
  assert.equal(forced.data.conflicts.length, 3, 'the booking page shows each clash');
  await c.put(`/api/bookings/${forced.data.booking.id}/status`, { status: 'cancelled', reason: 'Postponed' });
  assert.equal((await c.get(`/api/bookings/${first.id}`)).data.conflicts.length, 0, 'cancelled bookings hold no one');

  const id = first.id;
  const url = (path = '') => `/api/bookings/${id}${path}?today=${today}`;
  const status = async (s) => (await c.put(url('/status'), { status: s })).data.booking;
  assert.equal((await c.put(url('/status'), { status: 'partying' })).status, 400);
  // Mark the shoot complete, then the first post-production step moves it to Editing.
  let bk = await status('shot');
  assert.equal(bk.status, 'shot');
  assert.ok(bk.checklist.shoot, 'Shoot completed is ticked');
  bk = (await c.put(url('/tasks'), { key: 'photo.editing', done: true })).data.booking;
  assert.equal(bk.status, 'editing');
  assert.equal((await c.put(url('/tasks'), { key: 'photo.dancing', done: true })).status, 400);
  assert.equal((await c.put(url('/checklist'), { key: 'equipment', done: true })).data.booking.checklist.equipment, today);

  // Deadlines are overdue until the work behind them is done.
  bk = (await c.put(url('/deadlines'), { deadlines: { photo_edit: inDays(-2), final_delivery: inDays(5) } })).data.booking;
  assert.deepEqual(bk.deadline_states.map((d) => [d.key, d.state, d.days]), [['photo_edit', 'overdue', -2], ['final_delivery', 'later', 5]]);
  assert.equal((await c.get(`/api/bookings/overview?today=${today}`)).data.reminders[0].type, 'overdue');
  bk = (await c.put(url('/tasks'), { key: 'photo.edited', done: true })).data.booking;
  assert.equal(bk.deadline_states[0].state, 'done');

  // Payments: never more than the balance; the package can't drop below what came in.
  const pay = (body) => c.post(url('/payments'), { method: 'cash', paid_on: today, ...body });
  assert.equal((await pay({ amount: 3000000 })).status, 400);
  assert.equal((await pay({ amount: 500000, method: 'cheque' })).status, 400);
  assert.equal((await pay({ amount: 500000, method: 'upi', note: 'Advance' })).status, 201);
  const edit = await c.put(url(), {
    client_name: 'Asha', event_date: day, start_time: '10:00', end_time: '14:00', services: [{ name: 'Wedding package', rate: 100000 }],
    team: [{ member_id: ravi.id }],
  });
  assert.equal(edit.data.error.field, 'services');

  // Links: http(s) only.
  assert.equal((await c.post(url('/links'), { type: 'raw', url: 'ftp://example.com/x' })).status, 400);
  const linked = (await c.post(url('/links'), { type: 'raw', url: 'https://drive.google.com/raw', label: 'Raw footage' })).data.booking;
  assert.equal((await c.del(`/api/bookings/${id}/links/${linked.links[0].id}`)).data.booking.links.length, 0);

  // Everything booked delivered (no services chosen = photos, video and album): Delivered. Paid in full: Closed.
  bk = (await c.put(url('/delivery'), { delivery: { photos: true, video: true, album: true, method: 'Google Drive', drive: 'drive.google.com/final' } })).data.booking;
  assert.equal(bk.status, 'delivered');
  assert.equal(bk.delivery.drive, 'https://drive.google.com/final');
  bk = (await pay({ amount: 1500000 })).data.booking;
  assert.deepEqual([bk.status, bk.balance, bk.payment_status], ['closed', 0, 'paid']);
  assert.equal((await pay({ amount: 100 })).status, 409, 'nothing left to pay');
  const page = (await c.get(url())).data;
  const log = page.activity.map((a) => a.text);
  for (const text of ['Shoot completed', 'Editing started', 'Photography: Editing completed', 'Delivered', 'Project closed · delivered and paid']) {
    assert.ok(log.includes(text), text);
  }

  // Booking payments count in the day book (cash as cash, UPI as online), the reports and the payments export.
  const dayBook = (await c.get(`/api/day-book?from=${today}&to=${today}`)).data;
  assert.deepEqual(dayBook.booking_payments.map((p) => [p.number, p.amount, p.method]), [[first.number, 1500000, 'cash'], [first.number, 500000, 'upi']]);
  const [closing] = (await c.get(`/api/day-book/days?from=${today}&to=${today}`)).data.days;
  assert.deepEqual([closing.received_cash, closing.received_online], [1500000, 500000]);
  const report = (await c.get(`/api/reports/sales?from=${today}&to=${today}`)).data;
  assert.equal(report.summary.received_bookings, 2000000);
  assert.deepEqual(report.payment_methods.map((m) => [m.method, m.amount]), [['cash', 1500000], ['online', 500000]]);
  const csv = await c.get(`/api/reports/export?type=payments&from=${today}&to=${today}`);
  assert.match(csv.data, new RegExp(`${today},${first.number},Asha,UPI,Advance,5000`));

  // Money due again re-opens a closed project; on hold remembers where it was.
  bk = (await c.del(`/api/bookings/${id}/payments/${page.payments[0].id}?today=${today}`)).data.booking;
  assert.equal(bk.status, 'delivered');
  bk = await status('on_hold');
  assert.equal(bk.prev_status, 'delivered');
  assert.equal((await c.get(`/api/bookings?quick=completed&today=${today}`)).data.total, 0, 'on hold is off the work lists');
  assert.equal((await status('delivered')).status, 'delivered');

  // The team list: someone who worked on bookings leaves the list but stays on those bookings.
  assert.ok((await c.del(`/api/team/${ravi.id}`)).data.kept_on_bookings > 0);
  assert.equal((await c.get('/api/team')).data.members.length, 0);
  assert.deepEqual((await c.get(url())).data.booking.team.map((t) => t.name), ['Ravi']);

  // Another business can't see or change any of it.
  const other = await newBusiness();
  assert.equal((await other.get(url())).status, 404);
  assert.equal((await other.put(url('/status'), { status: 'new' })).status, 404);
  assert.equal((await other.post(url('/payments'), { amount: 100 })).status, 404);
  assert.equal((await other.del(`/api/bookings/${id}`)).status, 404);
  assert.equal((await other.get('/api/bookings')).data.total, 0);
  assert.equal((await other.post('/api/bookings', { client_name: 'X', event_date: today, team: [{ member_id: ravi.id }] })).data.error.field, 'team');
  assert.equal((await other.put(`/api/team/${ravi.id}`, { name: 'Someone' })).status, 404);
  assert.equal((await other.get(`/api/day-book?from=${today}&to=${today}`)).data.booking_payments.length, 0);

  // Deleting takes the booking's payments with it.
  assert.equal((await c.del(`/api/bookings/${id}`)).data.number, first.number);
  assert.equal((await c.get(url())).status, 404);
  assert.equal((await c.get(`/api/day-book?from=${today}&to=${today}`)).data.booking_payments.length, 0);
});

test('work tracking: stages, history, counts and the customer link', async () => {
  const c = await newBusiness();
  const p = await newProduct(c, { selling_price: 100000, tax_rate: 0 });
  assert.equal((await c.post('/api/bills', { bill_date: today, photo_source: 'email', items: [line(p, 1)] })).status, 400);
  const draft = (await c.post('/api/bills', {
    bill_date: today, customer_name: 'Meena', customer_phone: '90000 22222', photo_source: 'whatsapp', items: [line(p, 1)],
  })).data.bill;
  assert.equal(draft.photo_source, 'whatsapp');
  assert.equal((await c.put(`/api/bills/${draft.id}/stage`, { stage: 'received' })).status, 409, 'drafts are not tracked yet');

  // "Track this job" on create starts at Received.
  const created = await c.post(`/api/bills/${draft.id}/finalize`, { track: true, payment: { amount: 50000, method: 'cash' } });
  assert.equal(created.data.bill.work_stage, 'received');
  assert.equal(created.data.stage_history.length, 1);
  assert.equal((await c.put(`/api/bills/${draft.id}/stage`, { stage: 'packing' })).status, 400);

  // Jump straight to Print (skipping Design and Review is allowed), with a note.
  const moved = await c.put(`/api/bills/${draft.id}/stage`, { stage: 'print', note: 'Design approved on WhatsApp' });
  assert.equal(moved.data.bill.work_stage, 'print');
  assert.deepEqual(moved.data.stage_history.map((h) => h.stage), ['received', 'print']);
  assert.equal(moved.data.stage_history[1].note, 'Design approved on WhatsApp');

  // How the photo came in shows with the job, and can be changed after the bill is created.
  assert.equal((await c.get('/api/tracking')).data.jobs[0].photo_source, 'whatsapp');
  assert.equal((await c.put(`/api/bills/${draft.id}/photo-source`, { photo_source: 'studio' })).data.bill.photo_source, 'studio');
  assert.equal((await c.put(`/api/bills/${draft.id}/photo-source`, { photo_source: 'fax' })).status, 400);

  const list = (await c.get('/api/tracking')).data;
  assert.equal(list.counts.print, 1);
  assert.equal(list.jobs[0].invoice_no, created.data.bill.invoice_no);
  assert.equal(list.jobs[0].customer_phone, '90000 22222');
  assert.equal(list.jobs[0].balance, 50000);
  assert.deepEqual(list.jobs[0].items, [{ name: p.name, quantity: 1, unit: 'pcs' }]);

  // Filters: date, mobile number (with or without +91), name and bill number. Counts follow them.
  const find = async (qs) => (await c.get(`/api/tracking?${qs}`)).data;
  const billNo = created.data.bill.invoice_no;
  assert.equal((await find('phone=22222')).jobs.length, 1);
  assert.equal((await find(`phone=${encodeURIComponent('+91 90000 22222')}`)).jobs.length, 1);
  assert.equal((await find('phone=11111')).jobs.length, 0);
  assert.equal((await find('name=mee')).jobs.length, 1);
  assert.equal((await find(`name=${billNo}`)).jobs.length, 0, 'the name filter is for names');
  assert.equal((await find(`bill=${billNo}`)).jobs.length, 1);
  assert.equal((await find(`bill=${Number(billNo.replace(/\D/g, ''))}`)).jobs.length, 1, 'just the number works too');
  assert.equal((await find('bill=999')).jobs.length, 0);
  assert.equal((await find('name=ravi')).counts.print, 0, 'counts follow the filters');
  assert.equal((await find(`from=${today}&to=${today}`)).jobs.length, 1);
  assert.equal((await find('from=2000-01-01&to=2000-01-31')).jobs.length, 0);

  // A bill created without tracking can be picked later.
  const d2 = (await c.post('/api/bills', { bill_date: today, items: [line(p, 1)] })).data.bill;
  await c.post(`/api/bills/${d2.id}/finalize`, {});
  const untracked = (await c.get('/api/bills?untracked=1')).data.bills.map((b) => b.id);
  assert.deepEqual(untracked, [d2.id]);
  // Newest bills come first.
  await c.put(`/api/bills/${d2.id}/stage`, { stage: 'received' });
  assert.deepEqual((await c.get('/api/tracking')).data.jobs.map((j) => j.id), [d2.id, draft.id]);
  await c.put(`/api/bills/${d2.id}/stage`, { stage: null });

  // The customer's link shows where the order is.
  const share = await c.post(`/api/bills/${draft.id}/share`, {});
  const page = await (await fetch(`${base}${new URL(share.data.share_url).pathname}`)).text();
  assert.match(page, /Order status: <strong>Print<\/strong>/);

  // Final stays on the All list (and under Final, not under In progress); stopping removes it from tracking but keeps history.
  assert.equal((await c.get('/api/tracking?stage=open')).data.jobs.length, 1);
  await c.put(`/api/bills/${draft.id}/stage`, { stage: 'final' });
  assert.equal((await c.get('/api/tracking')).data.jobs.length, 1);
  assert.equal((await c.get('/api/tracking?stage=final')).data.jobs.length, 1);
  assert.equal((await c.get('/api/tracking?stage=open')).data.jobs.length, 0);
  assert.equal((await c.get('/api/tracking?stage=print')).data.jobs.length, 0);
  const stopped = await c.put(`/api/bills/${draft.id}/stage`, { stage: null });
  assert.equal(stopped.data.bill.work_stage, null);
  assert.equal(stopped.data.stage_history.length, 3);
  assert.equal(Object.values((await c.get('/api/tracking')).data.counts).reduce((a, n) => a + n, 0), 0);

  // Another business can't see or move this job.
  const other = await newBusiness();
  assert.equal((await other.put(`/api/bills/${draft.id}/stage`, { stage: 'review' })).status, 404);
  assert.equal((await other.put(`/api/bills/${draft.id}/photo-source`, { photo_source: 'other' })).status, 404);
  assert.equal((await other.get('/api/tracking?stage=final')).data.jobs.length, 0);
});

test('job photos: on the bill and the job, only photos, private, and gone with the bill', async () => {
  const c = await newBusiness();
  const p = await newProduct(c, { selling_price: 100000, tax_rate: 0 });
  const jpeg = (size, fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, fill)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, 1)]);
  const dataUrl = (buf, type = 'image/jpeg') => `data:${type};base64,${buf.toString('base64')}`;
  const photo = (extra = {}) => ({ image: dataUrl(jpeg(4000)), thumb: dataUrl(jpeg(300, 3)), width: 1600, height: 1200, ...extra });

  // Photos can go on a draft: the bill form sends them when it saves the bill.
  const draft = (await c.post('/api/bills', { bill_date: today, customer_name: 'Asha', items: [line(p, 1)] })).data.bill;
  let r = await c.post(`/api/bills/${draft.id}/photos`, photo());
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const first = r.data.photos[0];
  assert.equal(first.width, 1600);
  assert.equal(first.bytes, 4004);
  assert.equal(first.url, `/api/bills/${draft.id}/photos/${first.id}`);
  assert.equal(first.thumb_url, `${first.url}/thumb`);

  // Only photos: what the bytes are counts, not what the upload calls them.
  const bad = (extra) => c.post(`/api/bills/${draft.id}/photos`, photo(extra));
  assert.equal((await bad({ image: dataUrl(Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml') })).status, 400);
  assert.equal((await bad({ image: 'https://example.com/photo.jpg' })).status, 400);
  assert.equal((await bad({ thumb: undefined })).status, 400);
  assert.equal((await bad({ image: dataUrl(jpeg(1300 * 1024)) })).status, 400, 'too large');
  r = await bad({ image: dataUrl(png) });
  assert.equal(r.status, 201);
  const second = r.data.photos[1];

  let res = await c.raw(second.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control'), /^private/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
  res = await c.raw(first.thumb_url);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal((await res.arrayBuffer()).byteLength, 304);
  res = await c.raw(`${first.url}?download=1`);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="draft-\d+-photo-\d+\.jpg"$/);

  // The bill page and the tracking list show them.
  const created = (await c.post(`/api/bills/${draft.id}/finalize`, { track: true })).data;
  assert.deepEqual(created.photos.map((x) => x.id), [first.id, second.id]);
  const job = (await c.get('/api/tracking')).data.jobs[0];
  assert.deepEqual(job.photos, [first, second].map((x) => ({ id: x.id, url: x.url, thumb_url: x.thumb_url })));

  // Removing one; a photo id is never used again, as browsers keep photos by their address.
  r = await c.del(`/api/bills/${draft.id}/photos/${second.id}`);
  assert.deepEqual(r.data.photos.map((x) => x.id), [first.id]);
  assert.equal((await c.raw(second.url)).status, 404);
  assert.equal((await c.del(`/api/bills/${draft.id}/photos/${second.id}`)).status, 404);
  const third = (await c.post(`/api/bills/${draft.id}/photos`, photo())).data.photos[1];
  assert.ok(third.id > second.id);

  // Private: not without a login, not for another business, not under another bill, not on the customer's link.
  assert.equal((await client().raw(first.url)).status, 401);
  const other = await newBusiness();
  assert.equal((await other.raw(first.url)).status, 404);
  assert.equal((await other.get(`/api/bills/${draft.id}/photos`)).status, 404);
  assert.equal((await other.post(`/api/bills/${draft.id}/photos`, photo())).status, 404);
  assert.equal((await other.del(`/api/bills/${draft.id}/photos/${first.id}`)).status, 404);
  const d2 = (await c.post('/api/bills', { bill_date: today, items: [line(p, 1)] })).data.bill;
  assert.equal((await c.raw(`/api/bills/${d2.id}/photos/${first.id}`)).status, 404);
  const share = await c.post(`/api/bills/${draft.id}/share`, {});
  assert.doesNotMatch(await (await fetch(`${base}${new URL(share.data.share_url).pathname}`)).text(), /\/photos\//);

  // Up to 20 a job; a deleted draft takes its photos with it.
  for (let i = 0; i < 20; i++) assert.equal((await c.post(`/api/bills/${d2.id}/photos`, photo())).status, 201);
  assert.equal((await c.post(`/api/bills/${d2.id}/photos`, photo())).status, 409);
  assert.equal((await c.del(`/api/bills/${d2.id}`)).status, 200);
  assert.equal(dbGet('SELECT COUNT(*) AS n FROM bill_photos WHERE bill_id = ?', d2.id).n, 0);

  // A cancelled bill keeps its photos to look at, but takes no new ones.
  await c.post(`/api/bills/${draft.id}/cancel`, {});
  assert.equal((await c.post(`/api/bills/${draft.id}/photos`, photo())).status, 409);
  assert.equal((await c.raw(first.url)).status, 200);
});

test('team login: only the jobs, to look at, without prices; set up and ended by the owner', async () => {
  const c = await newBusiness();
  const owner = (await c.get('/api/auth/me')).data.user;
  assert.equal(owner.role, 'owner');
  const p = await newProduct(c, { name: 'Frame 12x18', selling_price: 100000, tax_rate: 0 });
  const draft = (await c.post('/api/bills', {
    bill_date: today, customer_name: 'Kavita', customer_phone: '+91 98290 12345', items: [line(p, 2)],
  })).data.bill;
  const job = (await c.post(`/api/bills/${draft.id}/finalize`, { track: true, payment: { amount: 50000, method: 'cash' } })).data.bill;
  const jpeg = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 9)]).toString('base64')}`;
  const ownerPhoto = (await c.post(`/api/bills/${job.id}/photos`, { image: jpeg, thumb: jpeg })).data.photos[0];

  // The owner sets up the team's login.
  seq++;
  const email = `team${seq}@test.example`;
  assert.equal((await c.post('/api/settings/team-logins', { name: 'Team', email, password: 'short' })).status, 400);
  const taken = await c.post('/api/settings/team-logins', { name: 'Team', email: owner.email, password: 'teampass123' });
  assert.equal(taken.status, 409);
  assert.equal(taken.data.error.field, 'email');
  let r = await c.post('/api/settings/team-logins', { name: 'Counter team', email, password: 'teampass123' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.logins.map((l) => [l.name, l.email]), [['Counter team', email]]);
  const loginId = r.data.logins[0].id;

  // Signed in, the team gets only the business's name, logo and currency.
  const t = client();
  r = await t.post('/api/auth/login', { email, password: 'teampass123' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'team');
  assert.deepEqual(Object.keys(r.data.business).sort(), ['currency', 'has_logo', 'id', 'logo_url', 'name']);

  // The jobs: bill number, name, the mobile's last 4 digits, photos, items, stage and what's due. No prices or payments.
  const seen = (await t.get('/api/view/jobs')).data;
  assert.equal(seen.counts.received, 1);
  const tj = seen.jobs[0];
  assert.deepEqual(Object.keys(tj).sort(), [
    'bill_date', 'currency', 'customer_name', 'due', 'id', 'invoice_no', 'is_demo', 'items', 'phone_last4', 'photo_source',
    'photos', 'work_stage', 'work_updated_at',
  ]);
  assert.equal(tj.invoice_no, job.invoice_no);
  assert.equal(tj.customer_name, 'Kavita');
  assert.equal(tj.phone_last4, '2345');
  assert.equal(tj.due, 150000);
  assert.deepEqual(tj.items, [{ name: 'Frame 12x18', quantity: 2, unit: 'pcs' }]);
  assert.doesNotMatch(JSON.stringify(seen), /\b(98290|100000|200000|50000)\b/, 'no full number, price, total or payment');
  // The same search as Tracking: bill number, name, mobile number.
  assert.equal((await t.get(`/api/view/jobs?bill=${job.invoice_no}`)).data.jobs.length, 1);
  assert.equal((await t.get('/api/view/jobs?name=kav')).data.jobs.length, 1);
  assert.equal((await t.get('/api/view/jobs?phone=2345')).data.jobs.length, 1);
  assert.equal((await t.get('/api/view/jobs?phone=7777')).data.jobs.length, 0);
  assert.equal((await t.get('/api/view/jobs?phone=9829012345')).data.jobs.length, 1, 'the whole number, exactly');
  assert.equal((await t.get('/api/view/jobs?phone=9829012346')).data.jobs.length, 0);
  // Trying digits in front of the last 4 can't uncover the number: anything short of the whole number counts only its last 4.
  for (const guess of ['02345', '92345', '12345', '29012345']) {
    assert.equal((await t.get(`/api/view/jobs?phone=${guess}`)).data.jobs.length, 1, guess);
  }
  assert.equal((await c.get('/api/tracking?phone=02345')).data.jobs.length, 0, 'the owner’s search is unchanged');

  // Photos through the team's own links, only for jobs on the list.
  const photo = tj.photos[0];
  assert.equal(photo.url, `/api/view/jobs/${job.id}/photos/${ownerPhoto.id}`);
  let res = await t.raw(photo.thumb_url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal((await t.raw(ownerPhoto.url)).status, 403, 'not through the owner’s links');
  const untracked = (await c.post('/api/bills', { bill_date: today, items: [line(p, 1)] })).data.bill;
  await c.post(`/api/bills/${untracked.id}/finalize`, {});
  const hidden = (await c.post(`/api/bills/${untracked.id}/photos`, { image: jpeg, thumb: jpeg })).data.photos[0];
  assert.equal((await t.raw(`/api/view/jobs/${untracked.id}/photos/${hidden.id}`)).status, 404);

  // Nothing else, and nothing can be changed.
  for (const path of ['/api/bills', `/api/bills/${job.id}`, '/api/tracking', '/api/dashboard', '/api/customers', '/api/products',
    '/api/stock', '/api/day-book', '/api/bookings', '/api/team', '/api/reports/summary', '/api/settings', '/api/settings/team-logins']) {
    assert.equal((await t.get(path)).status, 403, path);
  }
  assert.equal((await t.put(`/api/bills/${job.id}/stage`, { stage: 'final' })).status, 403);
  assert.equal((await t.post(`/api/bills/${job.id}/photos`, { image: jpeg, thumb: jpeg })).status, 403);
  assert.equal((await t.post(`/api/bills/${job.id}/payments`, { amount: 150000, method: 'cash' })).status, 403);
  assert.equal((await t.put('/api/auth/preferences', { dashboard: {} })).status, 403);
  assert.equal((await t.post('/api/auth/password', { current_password: 'teampass123', new_password: 'changed123' })).status, 403);
  assert.equal((await t.post('/api/settings/team-logins', { name: 'X', email: 'x@test.example', password: 'password123' })).status, 403);
  assert.equal((await c.get(`/api/bills/${job.id}`)).data.bill.work_stage, 'received', 'unchanged');

  // Another business's team sees none of it.
  const other = await newBusiness();
  seq++;
  const otherEmail = `team${seq}@test.example`;
  await other.post('/api/settings/team-logins', { name: 'Team', email: otherEmail, password: 'teampass123' });
  const ot = client();
  await ot.post('/api/auth/login', { email: otherEmail, password: 'teampass123' });
  assert.equal((await ot.get('/api/view/jobs')).data.jobs.length, 0);
  assert.equal((await ot.raw(photo.url)).status, 404);
  assert.equal((await other.del(`/api/settings/team-logins/${loginId}`)).status, 404, 'not another business’s login');

  // A new password signs the team out; removing the login ends it. The owner's own login isn't a team login.
  assert.equal((await c.put(`/api/settings/team-logins/${loginId}/password`, { password: 'newteam456' })).status, 200);
  assert.equal((await t.get('/api/view/jobs')).status, 401);
  assert.equal((await client().post('/api/auth/login', { email, password: 'teampass123' })).status, 401);
  const t2 = client();
  assert.equal((await t2.post('/api/auth/login', { email, password: 'newteam456' })).status, 200);
  assert.equal((await c.del(`/api/settings/team-logins/${owner.id}`)).status, 404);
  assert.deepEqual((await c.del(`/api/settings/team-logins/${loginId}`)).data.logins, []);
  assert.equal((await t2.get('/api/view/jobs')).status, 401);
  assert.equal((await client().post('/api/auth/login', { email, password: 'newteam456' })).status, 401);
  assert.equal((await c.get('/api/auth/me')).status, 200, 'the owner is still signed in');
});

test('day book: sales without a bill, money received, expenses and the closing', async () => {
  const c = await newBusiness();
  const p = await newProduct(c, { selling_price: 100000, tax_rate: 0 });
  // A ₹1,000 bill today: ₹600 advance in cash, the other ₹400 online.
  const bill = (await c.post('/api/bills', { bill_date: today, items: [line(p, 1)] })).data.bill;
  await c.post(`/api/bills/${bill.id}/finalize`, { payment: { amount: 60000, method: 'cash' } });
  await c.post(`/api/bills/${bill.id}/payments`, { amount: 40000, method: 'online', paid_on: today });

  const add = (body) => c.post('/api/day-book', { entry_date: today, method: 'cash', ...body });
  assert.equal((await add({ kind: 'sale', amount: 0 })).status, 400);
  assert.equal((await add({ kind: 'sale', amount: 100, entry_date: 'yesterday' })).status, 400);
  assert.equal((await add({ kind: 'sale', amount: 100, method: 'card' })).status, 400);
  assert.equal((await add({ kind: 'gift', amount: 100 })).status, 400);

  const sale = await add({ kind: 'sale', details: 'Passport photos', amount: 30000, category: 'Rent' });
  assert.equal(sale.status, 201);
  assert.equal(sale.data.entry.category, '', 'only expenses have a type');
  await add({ kind: 'received', details: 'Advance for a shoot', amount: 200000, method: 'online' });
  const tea = (await add({ kind: 'expense', details: 'Tea', category: 'Food & tea', amount: 5000 })).data.entry;
  const lab = (await add({ kind: 'expense', details: 'Lab prints', amount: 120000, method: 'online' })).data.entry;
  assert.equal(lab.category, 'Other', 'the expense type defaults to Other');

  // The day lists what was added and the payments on bills.
  const day = (await c.get(`/api/day-book?from=${today}&to=${today}`)).data;
  assert.deepEqual(day.entries.map((x) => x.details), ['Lab prints', 'Tea', 'Advance for a shoot', 'Passport photos']);
  assert.deepEqual(day.payments.map((x) => [x.invoice_no, x.amount]), [['INV-0001', 40000], ['INV-0001', 60000]]);

  // The closing: sales = bills + sales added; money received = bill payments + sales + money received.
  const yesterday = new Date(Date.parse(today) - 86400_000).toISOString().slice(0, 10);
  const closing = async () => (await c.get(`/api/day-book/days?from=${yesterday}&to=${today}`)).data.days;
  assert.deepEqual(await closing(), [
    { date: today, bills: 1, sales: 130000, sales_added: 30000, received_cash: 90000, received_online: 240000, spent_cash: 5000, spent_online: 120000 },
    { date: yesterday, bills: 0, sales: 0, sales_added: 0, received_cash: 0, received_online: 0, spent_cash: 0, spent_online: 0 },
  ]);
  assert.equal((await c.get('/api/day-book/days')).status, 400, 'the days to show are required');

  // Fix an entry: it was paid in cash, yesterday.
  const edited = await c.put(`/api/day-book/${lab.id}`, { entry_date: yesterday, kind: 'expense', details: 'Lab prints', category: 'Lab & printing', amount: 110000, method: 'cash' });
  assert.equal(edited.data.entry.amount, 110000);
  const after = await closing();
  assert.equal(after[0].spent_online, 0);
  assert.equal(after[1].spent_cash, 110000);
  assert.equal((await c.del(`/api/day-book/${tea.id}`)).status, 200);
  assert.equal((await c.get(`/api/day-book?from=${today}&to=${today}`)).data.entries.length, 2);

  // Dashboard and reports count the sales and money added here.
  assert.equal((await c.get(`/api/dashboard?from=${today}&to=${today}`)).data.sales.added, 30000);
  const report = (await c.get(`/api/reports/sales?from=${yesterday}&to=${today}`)).data;
  assert.deepEqual([report.summary.sales_added, report.summary.received_added, report.summary.expenses], [30000, 230000, 110000]);
  assert.equal(report.trend.find((t) => t.period === today).total, 130000);
  assert.deepEqual(report.payment_methods.map((m) => [m.method, m.amount]), [['online', 240000], ['cash', 90000]]);

  const csv = await c.get(`/api/reports/export?type=daybook&from=${yesterday}&to=${today}`);
  assert.match(csv.data, /Date,Entry,Details,Expense Type,Cash \/ Online,Money In,Money Out/);
  assert.match(csv.data, /Lab prints,Lab & printing,Cash,,1100/);
  assert.match(csv.data, /Sale,Passport photos,,Cash,300,/);

  // Another business can't see or change them.
  const other = await newBusiness();
  assert.equal((await other.get(`/api/day-book?from=${yesterday}&to=${today}`)).data.entries.length, 0);
  assert.equal((await other.get(`/api/day-book?from=${yesterday}&to=${today}`)).data.payments.length, 0);
  assert.equal((await other.put(`/api/day-book/${lab.id}`, { entry_date: today, kind: 'expense', amount: 100 })).status, 404);
  assert.equal((await other.del(`/api/day-book/${lab.id}`)).status, 404);
  assert.equal((await other.get(`/api/day-book/days?from=${yesterday}&to=${today}`)).data.days[1].spent_cash, 0);
});

test('static app shell, security headers and 404s', async () => {
  const res = await fetch(`${base}/bills/123`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<div id="app">/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(`${base}/api/nope`, { headers: { 'X-Requested-With': 'fetch' } })).status, 404);
  assert.equal((await fetch(`${base}/shared/calc.js`)).status, 200);
});

// Runs last on purpose: at the end it swaps in an empty database.
test('online: sign-up can be closed, and the public demo password never opens the demo login', async () => {
  delete process.env.DEMO_ACCOUNT;
  await ensureDemoAccount();
  process.env.ALLOW_SIGNUP = 'false';
  process.env.DEMO_ACCOUNT = 'false';
  try {
    const anon = client();
    const config = (await anon.get('/api/auth/config')).data;
    assert.equal(config.signup, false);
    assert.equal(config.demo, null);
    const closed = await anon.post('/api/auth/register', { business_name: 'Late', name: 'Late', email: 'late@test.example', password: 'password123' });
    assert.equal(closed.status, 403);
    assert.equal(closed.data.error.code, 'SIGNUP_CLOSED');

    const blocked = await client().post('/api/auth/login', DEMO_ACCOUNT);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.error.code, 'DEMO_PASSWORD');
    assert.equal((await client().post('/api/auth/login', { email: DEMO_ACCOUNT.email, password: 'not-the-password' })).status, 401);

    dbRun('UPDATE users SET password_hash = ? WHERE email = ?', await hashPassword('a-new-strong-pass'), DEMO_ACCOUNT.email);
    assert.equal((await client().post('/api/auth/login', { email: DEMO_ACCOUNT.email, password: 'a-new-strong-pass' })).status, 200);

    // A fresh server with sign-up closed still lets the owner make the first account, and only that one.
    closeDb();
    openDb(':memory:');
    const first = await client().post('/api/auth/register', { business_name: 'Studio', name: 'Owner', email: 'first@test.example', password: 'password123' });
    assert.equal(first.status, 201);
    const second = await client().post('/api/auth/register', { business_name: 'Other', name: 'Other', email: 'second@test.example', password: 'password123' });
    assert.equal(second.status, 403);
  } finally {
    delete process.env.ALLOW_SIGNUP;
    delete process.env.DEMO_ACCOUNT;
  }
});
