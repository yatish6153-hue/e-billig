// Simple billing: customer name + WhatsApp number, items, a discount %, advance -> Total / Advance / Balance.
// No GST. Drafts don't touch stock; "Create bill" numbers the bill, deducts stock once and records the advance.
import { api } from '../lib/api.js';
import { html, setHtml, on, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast, toastError, confirmDialog, busy, qtyUnit, demoBadge } from '../lib/ui.js';
import { navigate, setLeaveGuard, clearLeaveGuard } from '../lib/router.js';
import { moneyInput } from '../components/product-form.js';
import { methodButtons } from '../components/payment-form.js';
import { MAX_PHOTOS, hasCamera, onlyImages, pickPhotos, preparePhoto } from '../components/job-photos.js';
import { computeBill } from '/shared/calc.js';
import { WORK_STAGES, PHOTO_SOURCES } from '/shared/tracking.js';
import { invoiceTotals } from '/shared/invoice-html.js';
import { fromMinor, toMinor, isoDate, formatMoney, formatQty, roundQty, currencyInfo } from '/shared/format.js';

let keySeq = 0;
const newKey = () => `k${++keySeq}`;
const phoneKey = (p) => String(p || '').replace(/\D/g, '').slice(-10);

function itemFromProduct(p) {
  return {
    key: newKey(), product_id: p.id, name: p.name, sku: p.sku, unit: p.unit,
    qty: '1', price: fromMinor(p.selling_price), disc: '0',
    available: p.is_service ? null : p.quantity, service: !!p.is_service, custom: false,
  };
}

function itemFromBill(i) {
  return {
    key: newKey(), product_id: i.product_id, name: i.name, sku: i.sku, unit: i.unit,
    qty: formatQty(i.quantity), price: fromMinor(i.unit_price), disc: String(i.discount_pct || 0),
    available: i.available, service: !!i.is_service, custom: !i.product_id,
  };
}

/** A percentage typed by the user: 0 when empty, NaN unless 0–100. */
function parsePct(value) {
  const s = String(value).trim();
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : NaN;
}

function parseItem(it) {
  const quantity = Number(it.qty);
  const unitPrice = toMinor(it.price);
  const disc = parsePct(it.disc);
  return {
    quantity: Number.isFinite(quantity) ? quantity : 0,
    unit_price: Number.isNaN(unitPrice) ? 0 : unitPrice,
    discount_pct: Number.isNaN(disc) ? 0 : disc,
    tax_rate: 0,
    errors: {
      name: it.custom && !it.name.trim() ? 'Enter a description for this item.' : null,
      quantity: !(Number.isFinite(quantity) && quantity > 0 && quantity <= 1e7 && roundQty(quantity) === quantity)
        ? 'Quantity must be more than 0.' : null,
      unit_price: Number.isNaN(unitPrice) || unitPrice < 0 ? 'Enter a valid price.' : null,
      discount_pct: Number.isNaN(disc) ? 'Discount must be between 0 and 100%.' : null,
    },
  };
}

export default async function billEditor(el, { app, params, query }) {
  const biz = app.business;
  const cur = biz.currency;
  const sym = currencyInfo(cur).symbol.trim();
  const money = (v) => formatMoney(v, cur);
  el.classList.add('editor-page');

  const state = {
    id: null,
    customerId: null, customerName: '', customerPhone: '', customerIsDemo: false, customerInfo: null,
    bill_date: isoDate(), notes: '', photoSource: '',
    // The customer's photos: ones already on the draft, and new ones sent once the bill is saved.
    photos: [], newPhotos: [],
    discount: '',
    items: [],
    advance: '', method: 'cash', reference: '',
    track: true,
    showDiscount: false,
  };
  let dirty = false;

  if (params.id) {
    const data = await api(`/bills/${params.id}`);
    if (data.bill.status !== 'draft') {
      toast('Only drafts can be edited — showing the bill instead.', 'info');
      navigate(`/bills/${params.id}`, { replace: true, force: true });
      return undefined;
    }
    const b = data.bill;
    Object.assign(state, {
      id: b.id, bill_date: b.bill_date, notes: b.notes, photoSource: b.photo_source || '', photos: data.photos || [],
      discount: b.discount_pct > 0 ? String(b.discount_pct) : '',
      items: data.items.map(itemFromBill),
      customerId: b.customer_id, customerName: b.customer_name, customerPhone: b.customer_phone, customerIsDemo: data.customer_is_demo,
    });
  } else if (query.customer_id) {
    try {
      const { customer, stats } = await api(`/customers/${query.customer_id}`);
      Object.assign(state, {
        customerId: customer.id, customerName: customer.name, customerPhone: customer.phone,
        customerIsDemo: customer.is_demo, customerInfo: { outstanding: stats.outstanding },
      });
    } catch {
      // Ignore a stale customer link; the bill starts as walk-in.
    }
  }
  // Left while loading: the page on screen now is another view's, so this one does nothing.
  if (!el.isConnected) return undefined;
  state.showDiscount = state.items.some((it) => Number(it.disc) > 0);
  app.setTitle(state.id ? `Edit draft #${state.id}` : 'New bill');

  const guard = (opts) => !dirty || (!opts?.silent && window.confirm('You have unsaved changes on this bill. Leave without saving?'));
  setLeaveGuard(guard);
  const markDirty = () => {
    dirty = true;
  };

  setHtml(el, html`
    <a class="back-link" href="${state.id ? `/bills/${state.id}` : '/bills'}">${icon('arrowLeft', 'sm')}${state.id ? 'Back to draft' : 'Bills'}</a>
    <div class="page-header">
      <div><h1>${state.id ? `Edit draft #${state.id}` : 'New bill'}</h1>
        <div class="subtitle">Add items, note the advance, and create the bill.</div></div>
    </div>
    <div class="editor">
      <div class="stack">
        <section class="card meta-card"><div class="card-body editor-meta">
          <div class="field em-name"><label for="customer_name">Customer name</label>
            <div class="combo" data-customer-combo>
              <div class="input-group">${icon('users')}<input class="input" id="customer_name" name="customer_name" data-customer-name
                autocomplete="off" maxlength="120" placeholder="Walk-in customer" value="${state.customerName}" role="combobox" aria-expanded="false"></div>
              <div class="combo-list hidden" role="listbox"></div>
            </div>
            <div class="field-hint" data-customer-hint></div></div>
          <div class="field em-phone"><label for="customer_phone">WhatsApp number</label>
            <div class="input-group">${icon('message')}<input class="input" id="customer_phone" name="customer_phone" data-customer-phone
              type="tel" inputmode="tel" autocomplete="off" maxlength="20" placeholder="98765 43210" value="${state.customerPhone}"></div>
            <div class="field-hint" data-phone-hint>The bill can be sent to this number.</div></div>
          <div class="field em-date"><label for="bill_date">Date</label>
            <input class="input" type="date" id="bill_date" name="bill_date" value="${state.bill_date}" required></div>
          <div class="field em-photo"><span class="label">Photo received</span>
            <div class="segmented" role="radiogroup" aria-label="Photo received">${Object.entries(PHOTO_SOURCES).map(([key, label]) => html`
              <button type="button" role="radio" data-photo="${key}" class="${state.photoSource === key ? 'active' : ''}" aria-checked="${state.photoSource === key}">${label}</button>`)}</div></div>
          <div class="field em-pics"><span class="label">Customer’s photo <span class="muted small">· so you remember which one it was</span></span>
            <div class="ed-photos" data-ed-photos></div></div>
        </div></section>

        <section class="card">
          <div class="card-header"><h2>Items</h2></div>
          <div class="card-body">
            <div class="scan-bar"><div class="combo" data-product-combo>
              <div class="input-group">${icon('search')}<input class="input" data-product-search autocomplete="off" spellcheck="false"
                placeholder="Type an item or scan a barcode, then press Enter" aria-label="Add item" role="combobox" aria-expanded="false"></div>
              <div class="combo-list hidden" role="listbox"></div>
            </div>
            <button type="button" class="btn" data-add-custom title="Add an item that isn't saved">${icon('plus')}Custom</button></div>
          </div>
          <div class="lines-wrap ${state.showDiscount ? '' : 'no-disc'}">
            <div class="lines-head">
              <span>#</span><span>Item</span><span>Qty</span><span class="r">Price</span><span class="r h-disc">Disc %</span><span class="r">Amount</span><span></span>
            </div>
            <div class="lines" data-lines></div>
          </div>
        </section>

        <div>
          <button type="button" class="inline-link ${state.notes ? 'hidden' : ''}" data-show-notes>${icon('plus', 'sm')} Add a note</button>
          <section class="card ${state.notes ? '' : 'hidden'}" data-notes-card><div class="card-body">
            <div class="field"><label for="notes">Note on bill</label>
              <textarea class="input" id="notes" name="notes" maxlength="1000" rows="2" placeholder="e.g. Wedding on 12 Dec · album delivery in 15 days">${state.notes}</textarea></div>
          </div></section>
        </div>
      </div>

      <aside class="editor-side">
        <section class="card">
          <div class="card-header"><h2>Bill summary</h2><span class="hint" data-count></span></div>
          <div class="bill-disc"><label for="bill_discount">Discount</label>
            <div class="input-affix suffix"><input class="input r" id="bill_discount" name="discount_pct" data-bill-disc inputmode="decimal"
              autocomplete="off" placeholder="0" value="${state.discount}"><span class="affix">%</span></div></div>
          <div class="totals" data-totals></div>
          <div class="advance-box">
            <div class="field"><label for="advance">Advance received</label>
              <div class="adv-row">
                <div class="input-affix"><span class="affix">${sym}</span>
                  <input class="input" id="advance" data-advance inputmode="decimal" autocomplete="off" placeholder="0.00"></div>
                <button type="button" class="btn" data-full>Full amount</button>
              </div></div>
            <div class="stack hidden" data-method-wrap style="gap:8px">
              ${methodButtons(state.method)}
              <input class="input input-sm hidden" data-reference maxlength="100" placeholder="UPI / card / bank reference (optional)">
            </div>
            <div class="t-balance"><span>Balance</span><span data-balance></span></div>
          </div>
          <label class="check track-box"><input type="checkbox" data-track ${state.track ? 'checked' : ''}>
            <span>Track this job<div class="check-desc">${WORK_STAGES.map((s) => s.label).join(' → ')}</div></span></label>
        </section>
        <div class="stack side-actions" style="gap:8px">
          <button type="button" class="btn btn-primary btn-lg btn-block" data-create>${icon('check')}Create bill</button>
          <button type="button" class="btn btn-block" data-save>Save draft</button>
          ${state.id ? html`<button type="button" class="btn btn-ghost btn-danger btn-block" data-delete>${icon('trash')}Delete draft</button>` : ''}
          <p class="muted small" style="margin:4px 2px 0">Creating the bill gives it a number and updates stock. A draft changes nothing.</p>
        </div>
      </aside>
    </div>
    <div class="view-bottom-space"></div>
    <div class="mobile-bar">
      <div><div class="mb-label" data-mb-label></div><div class="mb-total" data-mb-total>${money(0)}</div></div>
      <div class="row" style="gap:6px"><button type="button" class="btn" data-save>Save</button>
        <button type="button" class="btn btn-primary" data-create>Create bill</button></div>
    </div>`);

  const linesEl = el.querySelector('[data-lines]');
  const totalsEl = el.querySelector('[data-totals]');
  const nameInput = el.querySelector('[data-customer-name]');
  const phoneInput = el.querySelector('[data-customer-phone]');
  const custList = el.querySelector('[data-customer-combo] .combo-list');
  const searchInput = el.querySelector('[data-product-search]');
  const comboList = el.querySelector('[data-product-combo] .combo-list');
  const advanceInput = el.querySelector('[data-advance]');

  // ---- Customer: name (with suggestions) + WhatsApp number ------------------
  function renderCustomerHint() {
    const hint = el.querySelector('[data-customer-hint]');
    if (state.customerId) {
      const due = state.customerInfo?.outstanding;
      setHtml(hint, html`<span class="text-good">${icon('checkCircle', 'sm')} Saved customer</span> ${demoBadge(state.customerIsDemo)}
        ${due > 0 ? html` · <span class="text-bad">${money(due)} balance on earlier bills</span>` : ''}`);
    } else if (state.customerName.trim()) {
      hint.textContent = 'New customer — saved with this bill.';
    } else {
      hint.textContent = 'Leave empty for a walk-in customer.';
    }
  }

  let custResults = [];
  let custActive = 0;
  function closeCustomerList() {
    custList.classList.add('hidden');
    nameInput.setAttribute('aria-expanded', 'false');
  }
  function renderCustomerOptions() {
    if (!custResults.length) {
      closeCustomerList();
      return;
    }
    setHtml(custList, html`${custResults.map((c, i) => html`
      <div class="combo-option ${i === custActive ? 'active' : ''}" data-customer-index="${i}" role="option">
        <div class="co-main"><div class="co-title">${c.name} ${demoBadge(c.is_demo)}</div><div class="co-sub">${c.phone || 'No WhatsApp number'}</div></div>
        ${c.outstanding > 0 ? html`<div class="co-side text-bad">${money(c.outstanding)} balance</div>` : ''}</div>`)}`);
    custList.classList.remove('hidden');
    nameInput.setAttribute('aria-expanded', 'true');
  }
  let custSeq = 0;
  const searchCustomers = debounce(async (q) => {
    const mySeq = ++custSeq;
    if (!q) {
      custResults = [];
      closeCustomerList();
      return;
    }
    try {
      const { customers } = await api('/customers', { query: { q, limit: 6 } });
      if (mySeq !== custSeq || document.activeElement !== nameInput) return;
      custResults = customers;
      custActive = 0;
      renderCustomerOptions();
    } catch (err) {
      toastError(err);
    }
  }, 150);

  function selectCustomer(c) {
    Object.assign(state, {
      customerId: c.id, customerName: c.name, customerPhone: c.phone || state.customerPhone,
      customerIsDemo: !!c.is_demo, customerInfo: { outstanding: c.outstanding || 0 },
    });
    nameInput.value = state.customerName;
    phoneInput.value = state.customerPhone;
    nameInput.classList.remove('is-invalid');
    phoneInput.classList.remove('is-invalid');
    el.querySelector('[data-phone-hint]').textContent = 'The bill can be sent to this number.';
    custResults = [];
    closeCustomerList();
    markDirty();
    renderCustomerHint();
  }

  nameInput.addEventListener('input', () => {
    state.customerName = nameInput.value;
    if (state.customerId) {
      // Editing the name means a different customer.
      Object.assign(state, { customerId: null, customerIsDemo: false, customerInfo: null });
    }
    markDirty();
    renderCustomerHint();
    searchCustomers(nameInput.value.trim());
  });
  nameInput.addEventListener('keydown', (e) => {
    if (custList.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      custActive = (custActive + (e.key === 'ArrowDown' ? 1 : custResults.length - 1)) % custResults.length;
      renderCustomerOptions();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectCustomer(custResults[custActive]);
      phoneInput.focus();
    } else if (e.key === 'Escape') closeCustomerList();
  });
  nameInput.addEventListener('blur', () => setTimeout(closeCustomerList, 150));
  on(custList, 'mousedown', '[data-customer-index]', (e, opt) => {
    e.preventDefault();
    selectCustomer(custResults[Number(opt.dataset.customerIndex)]);
  });

  // Typing a known WhatsApp number offers (or fills in) the saved customer.
  let phoneMatch = null;
  const lookupPhone = debounce(async (value) => {
    const key = phoneKey(value);
    const hint = el.querySelector('[data-phone-hint]');
    phoneMatch = null;
    if (state.customerId) {
      hint.textContent = 'The customer’s saved number will be updated.';
      return;
    }
    if (key.length < 10) {
      hint.textContent = 'The bill can be sent to this number.';
      return;
    }
    try {
      const { customers } = await api('/customers', { query: { q: key, limit: 5 } });
      const match = customers.find((c) => phoneKey(c.phone) === key);
      if (!match || phoneKey(phoneInput.value) !== key) return;
      if (!state.customerName.trim()) {
        selectCustomer(match);
        toast(`Saved customer found: ${match.name}.`, 'info');
      } else if (match.name.trim().toLowerCase() !== state.customerName.trim().toLowerCase()) {
        phoneMatch = match;
        setHtml(hint, html`This number is saved for <strong>${match.name}</strong>.
          <button type="button" class="inline-link" data-use-match>Use ${match.name}</button>`);
      }
    } catch {
      // A failed suggestion is harmless.
    }
  }, 300);
  phoneInput.addEventListener('input', () => {
    state.customerPhone = phoneInput.value;
    phoneInput.classList.remove('is-invalid');
    markDirty();
    lookupPhone(phoneInput.value);
  });
  on(el, 'click', '[data-use-match]', () => {
    if (phoneMatch) selectCustomer(phoneMatch);
  });

  // ---- Product search / barcode -----------------------------------------------
  let productResults = [];
  let productActive = 0;
  let productQuery = '';

  function renderProductOptions() {
    const q = searchInput.value.trim();
    if (!q) {
      comboList.classList.add('hidden');
      return;
    }
    const options = productResults.map((p, i) => html`
      <div class="combo-option ${i === productActive ? 'active' : ''}" data-product-index="${i}" role="option">
        <div class="co-main"><div class="co-title">${p.name} ${demoBadge(p.is_demo)}</div>
          <div class="co-sub">${[p.sku, p.barcode, p.category].filter(Boolean).join(' · ')}</div></div>
        <div class="co-side"><div class="strong">${money(p.selling_price)}</div>
          ${p.is_service ? html`<div class="muted">Service · per ${p.unit}</div>`
            : html`<div class="${p.quantity <= 0 ? 'text-bad' : p.is_low ? 'text-warn' : 'muted'}">${p.quantity <= 0 ? 'Out of stock' : `${qtyUnit(p.quantity, p.unit)} in stock`}</div>`}</div>
      </div>`);
    options.push(html`<div class="combo-option ${productActive === productResults.length ? 'active' : ''}" data-custom-from-search role="option">
      <div class="co-main"><div class="co-title">${icon('plus', 'sm')} Add “${q}” as a custom item</div>
      <div class="co-sub">Type the price yourself — not tracked in stock</div></div></div>`);
    setHtml(comboList, html`${productResults.length ? '' : html`<div class="combo-empty">Nothing saved matches “${q}”.</div>`}${options}`);
    comboList.classList.remove('hidden');
    searchInput.setAttribute('aria-expanded', 'true');
  }

  let searchSeq = 0;
  async function searchProducts(q) {
    const mySeq = ++searchSeq;
    const { products } = await api('/products', { query: { q, limit: 8, status: 'active' } });
    if (mySeq !== searchSeq) return null;
    productResults = products;
    productQuery = q;
    productActive = 0;
    renderProductOptions();
    return products;
  }
  const searchDebounced = debounce((q) => searchProducts(q).catch(toastError), 140);

  function closeProductList() {
    comboList.classList.add('hidden');
    searchInput.setAttribute('aria-expanded', 'false');
  }

  function addProduct(p) {
    const existing = state.items.find((it) => it.product_id === p.id);
    if (existing) {
      const q = Number(existing.qty);
      existing.qty = formatQty((Number.isFinite(q) ? q : 0) + 1);
      existing.available = p.is_service ? null : p.quantity;
    } else {
      state.items.push(itemFromProduct(p));
    }
    markDirty();
    searchInput.value = '';
    productResults = [];
    closeProductList();
    renderLines(existing ? existing.key : state.items[state.items.length - 1].key);
    if (!p.is_service && p.quantity <= 0) toast(`${p.name} is out of stock. You can still bill it — you'll be asked to confirm.`, 'info');
    searchInput.focus();
  }

  function addCustom(name = '') {
    state.items.push({
      key: newKey(), product_id: null, name, sku: '', unit: '', qty: '1', price: '', disc: '0', available: null, custom: true,
    });
    markDirty();
    searchInput.value = '';
    closeProductList();
    const key = state.items[state.items.length - 1].key;
    renderLines(key);
    linesEl.querySelector(`[data-key="${key}"]`)?.querySelector(name ? '[data-f=price]' : '[data-f=name]')?.focus();
  }

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    if (!q) {
      closeProductList();
      return;
    }
    searchDebounced(q);
  });
  searchInput.addEventListener('keydown', async (e) => {
    const count = productResults.length + 1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (comboList.classList.contains('hidden')) return;
      productActive = (productActive + (e.key === 'ArrowDown' ? 1 : count - 1)) % count;
      renderProductOptions();
    } else if (e.key === 'Escape') {
      closeProductList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = searchInput.value.trim();
      if (!q) return;
      searchDebounced.cancel();
      // 1) Exact barcode / SKU match — the scanner path.
      try {
        const { product } = await api('/products/lookup', { query: { code: q } });
        if (product) {
          addProduct(product);
          return;
        }
      } catch (err) {
        toastError(err);
        return;
      }
      // 2) The highlighted suggestion for this query.
      if (productQuery === q && !comboList.classList.contains('hidden')) {
        if (productActive < productResults.length) addProduct(productResults[productActive]);
        else addCustom(q);
        return;
      }
      // 3) Fresh search: add if there is exactly one match, otherwise offer the list.
      const results = await searchProducts(q).catch((err) => {
        toastError(err);
        return null;
      });
      if (results && results.length === 1) addProduct(results[0]);
    }
  });
  searchInput.addEventListener('blur', () => setTimeout(closeProductList, 150));
  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim() && productResults.length) renderProductOptions();
  });
  on(comboList, 'mousedown', '[data-product-index]', (e, opt) => {
    e.preventDefault();
    addProduct(productResults[Number(opt.dataset.productIndex)]);
  });
  on(comboList, 'mousedown', '[data-custom-from-search]', (e) => {
    e.preventDefault();
    addCustom(searchInput.value.trim());
  });
  el.querySelector('[data-add-custom]').addEventListener('click', () => addCustom(''));

  // ---- Lines ------------------------------------------------------------------
  function stockNeeds() {
    const needs = new Map();
    for (const it of state.items) {
      if (!it.product_id || it.service) continue;
      const q = Number(it.qty);
      needs.set(it.product_id, roundQty((needs.get(it.product_id) || 0) + (Number.isFinite(q) ? q : 0)));
    }
    return needs;
  }

  function lineMeta(it, needs) {
    if (it.custom) return html`<div class="item-meta">Custom item</div>`;
    if (it.service) return html`<div class="item-meta">Service</div>`;
    const avail = it.available;
    const need = needs.get(it.product_id) || 0;
    const short = avail !== null && avail !== undefined && need > avail;
    return html`<div class="item-meta">${avail === null || avail === undefined ? 'No longer in inventory' : `${qtyUnit(avail, it.unit)} in stock`}</div>
      ${short ? html`<div class="item-warn">${icon('alert', 'sm')} Only ${qtyUnit(Math.max(0, avail), it.unit)} available</div>` : ''}`;
  }

  function renderLines(flashKey) {
    const needs = stockNeeds();
    if (!state.items.length) {
      setHtml(linesEl, html`<div class="lines-empty">${icon('scan')}<div class="strong" style="color:var(--text);margin-top:6px">No items yet</div>
        <div>Search above, scan a barcode, or add a custom item.</div></div>`);
      renderTotals();
      return;
    }
    setHtml(linesEl, html`${state.items.map((it, i) => html`
      <div class="line" data-key="${it.key}">
        <div class="l-num">${i + 1}</div>
        <div class="l-item">
          ${it.custom
            ? html`<input class="input" data-f="name" value="${it.name}" maxlength="200" placeholder="Item or service, e.g. Photo frame 8x10" aria-label="Item description">`
            : html`<div class="item-name">${it.name}</div>`}
          <div data-meta>${lineMeta(it, needs)}</div>
        </div>
        <div class="l-qty"><div class="l-label">Qty${it.unit ? ` (${it.unit})` : ''}</div>
          <div class="qty-stepper"><button type="button" data-step="-1" aria-label="Decrease quantity">${icon('minus')}</button>
            <input class="input" data-f="qty" inputmode="decimal" value="${it.qty}" aria-label="Quantity">
            <button type="button" data-step="1" aria-label="Increase quantity">${icon('plus')}</button></div></div>
        <div class="l-price"><div class="l-label">Price</div>
          ${moneyInput('', it.price, cur, 'data-f="price" aria-label="Price" placeholder="0.00"')}</div>
        <div class="l-disc"><div class="l-label">Disc %</div>
          <input class="input r" data-f="disc" inputmode="decimal" value="${it.disc}" aria-label="Discount percent"></div>
        <div class="l-amt"><div class="l-label">Amount</div><span data-amt></span></div>
        <div class="l-rm"><button type="button" class="btn btn-ghost btn-icon btn-sm btn-danger" data-remove aria-label="Remove ${it.name || 'item'}">${icon('trash')}</button></div>
      </div>`)}`);
    linesEl.querySelectorAll('.line .input-affix .input').forEach((input) => input.classList.add('r'));
    renderTotals();
    if (flashKey) {
      const row = linesEl.querySelector(`[data-key="${flashKey}"]`);
      if (row) {
        row.style.transition = 'background 0.6s';
        row.style.background = 'var(--primary-soft)';
        setTimeout(() => {
          row.style.background = '';
        }, 500);
        row.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function computed() {
    const parsed = state.items.map(parseItem);
    const discountPct = parsePct(state.discount);
    const calc = computeBill(parsed, { roundOff: biz.round_off, discountPct: Number.isNaN(discountPct) ? 0 : discountPct });
    return { parsed, calc, discountPct };
  }

  /** Advance in minor units: 0 when empty, NaN when not a valid amount. */
  function parseAdvance() {
    if (!state.advance.trim()) return 0;
    const n = toMinor(state.advance);
    return Number.isNaN(n) || n < 0 ? NaN : n;
  }

  function renderTotals() {
    const { parsed, calc, discountPct } = computed();
    const needs = stockNeeds();
    el.querySelector('[data-bill-disc]').classList.toggle('is-invalid', Number.isNaN(discountPct));
    state.items.forEach((it, i) => {
      const row = linesEl.querySelector(`[data-key="${it.key}"]`);
      if (!row) return;
      row.querySelector('[data-amt]').textContent = money(calc.lines[i].total);
      for (const [f, errKey] of [['qty', 'quantity'], ['price', 'unit_price'], ['disc', 'discount_pct'], ['name', 'name']]) {
        row.querySelector(`[data-f="${f}"]`)?.classList.toggle('is-invalid', !!parsed[i].errors[errKey]);
      }
      setHtml(row.querySelector('[data-meta]'), lineMeta(it, needs));
    });
    const items = parsed.map((p, i) => ({ ...p, ...calc.lines[i] }));
    const pseudoBill = {
      with_gst: false, discount_pct: Number.isNaN(discountPct) ? 0 : discountPct, subtotal: calc.subtotal,
      discount_total: calc.discount_total, taxable_total: calc.taxable_total, tax_total: 0, round_off: calc.round_off, total: calc.total,
    };
    const { rows, included } = invoiceTotals(pseudoBill, items);
    setHtml(totalsEl, html`
      ${rows.map(([label, value, opt = {}]) => html`<div class="t-row ${opt.strong ? 't-total' : ''}"><span>${label}</span><span>${money(value)}</span></div>`)}
      ${included.length ? html`<div class="t-sub" style="margin-top:6px">Includes ${included.slice(1).map(([l, v]) => `${l} ${money(v)}`).join(', ')}</div>` : ''}`);

    const advance = parseAdvance();
    const badAdvance = Number.isNaN(advance) || advance > calc.total;
    advanceInput.classList.toggle('is-invalid', badAdvance && state.advance.trim() !== '');
    const balance = calc.total - (badAdvance ? 0 : advance);
    el.querySelector('[data-balance]').textContent = money(balance);
    el.querySelector('[data-method-wrap]').classList.toggle('hidden', !(advance > 0));

    const count = state.items.length;
    el.querySelector('[data-count]').textContent = `${count} item${count === 1 ? '' : 's'}`;
    el.querySelector('[data-mb-label]').textContent = `Total · Balance ${money(balance)}`;
    el.querySelector('[data-mb-total]').textContent = money(calc.total);
    return calc;
  }

  function itemByRow(target) {
    const row = target.closest('.line');
    return row ? state.items.find((it) => it.key === row.dataset.key) : null;
  }

  on(linesEl, 'input', '[data-f]', (e, input) => {
    const it = itemByRow(input);
    if (!it) return;
    it[input.dataset.f] = input.value;
    markDirty();
    renderTotals();
  });
  on(linesEl, 'focusout', '[data-f=price]', (e, input) => {
    const it = itemByRow(input);
    const minor = toMinor(input.value);
    if (it && !Number.isNaN(minor) && minor >= 0) {
      it.price = fromMinor(minor);
      input.value = it.price;
    }
  });
  on(linesEl, 'click', '[data-step]', (e, b) => {
    const it = itemByRow(b);
    if (!it) return;
    const q = Number(it.qty);
    const next = roundQty((Number.isFinite(q) ? q : 0) + Number(b.dataset.step));
    if (next <= 0) return;
    it.qty = formatQty(next);
    b.parentElement.querySelector('[data-f=qty]').value = it.qty;
    markDirty();
    renderTotals();
  });
  on(linesEl, 'click', '[data-remove]', (e, b) => {
    const it = itemByRow(b);
    state.items = state.items.filter((x) => x !== it);
    markDirty();
    renderLines();
  });

  // The customer's photos: shown small with a × to remove; new ones are sent when the bill is saved.
  const photosEl = el.querySelector('[data-ed-photos]');
  function renderPhotos() {
    const count = state.photos.length + state.newPhotos.length;
    setHtml(photosEl, html`
      ${state.photos.map((p) => html`<span class="ed-photo"><img src="${p.thumb_url}" alt="">
        <button type="button" class="ed-x" data-pic-remove="${p.id}" aria-label="Remove photo">${icon('x')}</button></span>`)}
      ${state.newPhotos.map((p, i) => html`<span class="ed-photo"><img src="${p.thumb}" alt="">
        <button type="button" class="ed-x" data-pic-drop="${i}" aria-label="Remove photo">${icon('x')}</button></span>`)}
      ${count < MAX_PHOTOS ? html`${hasCamera() ? html`<button type="button" class="btn btn-sm" data-pic-add="camera">${icon('camera', 'sm')}Take photo</button>` : ''}
        <button type="button" class="btn btn-sm" data-pic-add="files">${icon('imagePlus', 'sm')}${hasCamera() ? 'Gallery' : 'Add photo'}</button>
        ${hasCamera() ? '' : html`<span class="muted small">or paste one (Ctrl+V)</span>`}` : ''}`);
  }
  async function addPhotos(files) {
    const images = onlyImages(files).slice(0, Math.max(0, MAX_PHOTOS - state.photos.length - state.newPhotos.length));
    for (const file of images) {
      try {
        state.newPhotos.push(await preparePhoto(file));
        markDirty();
        renderPhotos();
      } catch (err) {
        toastError(err);
      }
    }
  }
  /** Send the new photos to the saved bill. A photo that fails stays here and goes with the next save. */
  async function sendPhotos() {
    while (state.newPhotos.length) {
      const res = await api(`/bills/${state.id}/photos`, { method: 'POST', body: state.newPhotos[0] });
      state.photos = res.photos;
      state.newPhotos.shift();
      renderPhotos();
    }
  }
  on(el, 'click', '[data-pic-add]', async (e, b) => addPhotos(await pickPhotos({ camera: b.dataset.picAdd === 'camera' })));
  on(el, 'click', '[data-pic-drop]', (e, b) => {
    state.newPhotos.splice(Number(b.dataset.picDrop), 1);
    renderPhotos();
  });
  on(el, 'click', '[data-pic-remove]', async (e, b) => {
    const ok = await confirmDialog({ title: 'Remove this photo?', message: 'It will be deleted from this bill.', confirmText: 'Remove photo', danger: true });
    if (!ok) return;
    try {
      state.photos = (await api(`/bills/${state.id}/photos/${b.dataset.picRemove}`, { method: 'DELETE' })).photos;
      renderPhotos();
    } catch (err) {
      toastError(err);
    }
  });
  // On a computer a copied photo (from WhatsApp Web, say) can be pasted straight onto the bill.
  const onPaste = (e) => {
    const files = onlyImages(e.clipboardData?.files);
    if (!files.length || document.querySelector('dialog[open]')) return;
    // Text copied from Excel or Word brings a picture of itself along; pasted into a field, it's the text that's meant.
    if (e.target.closest?.('input, textarea, [contenteditable]') && e.clipboardData.types.includes('text/plain')) return;
    e.preventDefault();
    addPhotos(files);
  };
  document.addEventListener('paste', onPaste);
  renderPhotos();

  // How the photo came in; tapping the chosen one again clears it.
  on(el, 'click', '[data-photo]', (e, b) => {
    state.photoSource = state.photoSource === b.dataset.photo ? '' : b.dataset.photo;
    el.querySelectorAll('[data-photo]').forEach((x) => {
      x.classList.toggle('active', x.dataset.photo === state.photoSource);
      x.setAttribute('aria-checked', String(x.dataset.photo === state.photoSource));
    });
    markDirty();
  });
  el.querySelector('[data-bill-disc]').addEventListener('input', (e) => {
    state.discount = e.target.value;
    markDirty();
    renderTotals();
  });
  el.querySelector('[data-show-notes]').addEventListener('click', (e) => {
    e.currentTarget.classList.add('hidden');
    el.querySelector('[data-notes-card]').classList.remove('hidden');
    el.querySelector('#notes').focus();
  });
  el.querySelector('#bill_date').addEventListener('change', (e) => {
    state.bill_date = e.target.value;
    markDirty();
  });
  el.querySelector('#notes').addEventListener('input', (e) => {
    state.notes = e.target.value;
    markDirty();
  });

  // ---- Advance --------------------------------------------------------------
  advanceInput.addEventListener('input', () => {
    state.advance = advanceInput.value;
    renderTotals();
  });
  el.querySelector('[data-full]').addEventListener('click', () => {
    const { calc } = computed();
    state.advance = fromMinor(calc.total);
    advanceInput.value = state.advance;
    renderTotals();
  });
  on(el, 'click', '[data-method]', (e, b) => {
    state.method = b.dataset.method;
    el.querySelectorAll('[data-method]').forEach((x) => x.classList.toggle('active', x === b));
    el.querySelector('[data-reference]').classList.toggle('hidden', state.method !== 'online');
  });
  el.querySelector('[data-reference]').addEventListener('input', (e) => {
    state.reference = e.target.value;
  });
  el.querySelector('[data-track]').addEventListener('change', (e) => {
    state.track = e.target.checked;
  });

  // ---- Save / create --------------------------------------------------------
  function validate({ requireItems }) {
    el.querySelectorAll('.is-invalid').forEach((x) => x.classList.remove('is-invalid'));
    if (!state.bill_date) {
      el.querySelector('#bill_date').classList.add('is-invalid');
      return 'Choose the bill date.';
    }
    const phone = state.customerPhone.trim();
    if (phone) {
      const digits = phone.replace(/\D/g, '').length;
      if (!/^\+?[\d\s\-()]+$/.test(phone) || digits < 7 || digits > 15) {
        phoneInput.classList.add('is-invalid');
        phoneInput.focus();
        return 'Enter a valid WhatsApp number, e.g. 98765 43210.';
      }
    }
    if (requireItems && !state.items.length) {
      searchInput.focus();
      return 'Add at least one item.';
    }
    if (Number.isNaN(parsePct(state.discount))) {
      const input = el.querySelector('[data-bill-disc]');
      input.classList.add('is-invalid');
      input.focus();
      return 'Discount must be between 0 and 100%.';
    }
    for (let i = 0; i < state.items.length; i++) {
      const errs = parseItem(state.items[i]).errors;
      const [errKey, message] = Object.entries(errs).find(([, val]) => val) || [];
      if (message) {
        const f = { quantity: 'qty', unit_price: 'price', discount_pct: 'disc', name: 'name' }[errKey];
        const input = linesEl.querySelector(`[data-key="${state.items[i].key}"] [data-f="${f}"]`);
        input?.classList.add('is-invalid');
        input?.focus();
        return `Item ${i + 1}: ${message}`;
      }
    }
    return null;
  }

  function payload() {
    return {
      customer_id: state.customerId,
      customer_name: state.customerName.trim(),
      customer_phone: state.customerPhone.trim(),
      bill_date: state.bill_date,
      notes: state.notes,
      photo_source: state.photoSource,
      discount_pct: parsePct(state.discount),
      items: state.items.map((it) => {
        const p = parseItem(it);
        return {
          product_id: it.product_id, name: it.name, quantity: p.quantity, unit_price: p.unit_price,
          discount_pct: p.discount_pct, unit: it.unit,
        };
      }),
    };
  }

  function showServerError(err) {
    const m = /^items\.(\d+)\.(\w+)$/.exec(err.field || '');
    if (m) {
      const it = state.items[Number(m[1])];
      const f = { quantity: 'qty', unit_price: 'price', discount_pct: 'disc', name: 'name' }[m[2]];
      const input = it && linesEl.querySelector(`[data-key="${it.key}"] [data-f="${f}"]`);
      input?.classList.add('is-invalid');
      input?.focus();
    } else if (err.field) {
      el.querySelector(`[name="${err.field}"]`)?.classList.add('is-invalid');
    }
    toastError(err);
  }

  async function save() {
    const body = payload();
    const res = state.id
      ? await api(`/bills/${state.id}`, { method: 'PUT', body })
      : await api('/bills', { method: 'POST', body });
    if (!state.id) {
      state.id = res.bill.id;
      history.replaceState(null, '', `/bills/${state.id}/edit`);
      el.querySelector('h1').textContent = `Edit draft #${state.id}`;
      app.setTitle(`Edit draft #${state.id}`);
    }
    // The server may have created or matched the customer; reuse it from now on.
    if (res.bill.customer_id && res.bill.customer_id !== state.customerId) {
      state.customerId = res.bill.customer_id;
      state.customerIsDemo = res.customer_is_demo;
      renderCustomerHint();
    }
    res.items.forEach((serverItem, i) => {
      if (state.items[i] && serverItem.product_id) state.items[i].available = serverItem.available;
    });
    dirty = false;
    try {
      await sendPhotos();
    } catch (err) {
      dirty = true;
      toast(`The bill is saved, but a photo couldn’t be added: ${err.message}`, 'error');
    }
    return res;
  }

  async function saveDraft(button) {
    const problem = validate({ requireItems: false });
    if (problem) {
      toast(problem, 'error');
      return;
    }
    await busy(button, async () => {
      try {
        await save();
        renderTotals();
        toast(state.advance.trim() ? 'Draft saved. The advance is recorded when you create the bill.' : 'Draft saved.');
      } catch (err) {
        showServerError(err);
      }
    });
  }

  async function createBill(button) {
    const problem = validate({ requireItems: true });
    if (problem) {
      toast(problem, 'error');
      return;
    }
    const { calc } = computed();
    const advance = parseAdvance();
    if (Number.isNaN(advance) || advance > calc.total) {
      advanceInput.classList.add('is-invalid');
      advanceInput.focus();
      toast(Number.isNaN(advance) ? 'Enter the advance as an amount, e.g. 5000.' : `Advance can't be more than the total (${money(calc.total)}).`, 'error');
      return;
    }
    const payment = advance > 0
      ? { amount: advance, method: state.method, reference: state.method === 'online' ? state.reference.trim() : '', paid_on: state.bill_date }
      : null;
    await busy(button, async () => {
      try {
        await save();
        // A photo that couldn't be sent stays here, and the bill stays a draft until it's sent or removed.
        if (state.newPhotos.length) {
          toast('The bill is still a draft. Tap Create bill again to send the photo, or remove it (×) to create the bill without it.', 'info', { timeout: 9000 });
          return;
        }
        let res;
        try {
          res = await api(`/bills/${state.id}/finalize`, { method: 'POST', body: { payment, track: state.track } });
        } catch (err) {
          if (err.code !== 'INSUFFICIENT_STOCK') throw err;
          const ok = await confirmDialog({
            title: 'Not enough stock',
            body: html`<ul class="shortage-list">${err.details.map((s) => html`<li>${s.name}: need ${qtyUnit(s.required, s.unit)}, only ${qtyUnit(Math.max(0, s.available), s.unit)} in stock</li>`)}</ul>
              <p style="margin-top:10px">Create the bill anyway? Stock will go below zero — add stock later to correct it.</p>`,
            confirmText: 'Create bill anyway',
            danger: true,
          });
          if (!ok) return;
          res = await api(`/bills/${state.id}/finalize`, { method: 'POST', body: { payment, track: state.track, allow_insufficient: true } });
        }
        dirty = false;
        toast(`Bill ${res.bill.invoice_no} created.`);
        navigate(`/bills/${state.id}`, { force: true });
      } catch (err) {
        if (err.code === 'ALREADY_FINALIZED') {
          dirty = false;
          toast(err.message, 'info');
          navigate(`/bills/${state.id}`, { force: true });
        } else {
          showServerError(err);
        }
      }
    });
  }

  el.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', () => saveDraft(b)));
  el.querySelectorAll('[data-create]').forEach((b) => b.addEventListener('click', () => createBill(b)));
  el.querySelector('[data-delete]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete this draft?', message: 'The draft will be removed. Stock is not affected.', confirmText: 'Delete draft', danger: true,
    });
    if (!ok) return;
    try {
      await api(`/bills/${state.id}`, { method: 'DELETE' });
      dirty = false;
      toast('Draft deleted.');
      navigate('/bills', { force: true });
    } catch (err) {
      toastError(err);
    }
  });

  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveDraft(el.querySelector('.side-actions [data-save]'));
    }
  };
  document.addEventListener('keydown', onKey);

  renderCustomerHint();
  renderLines();
  setTimeout(() => (state.customerName ? searchInput : nameInput).focus(), 50);

  return () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('paste', onPaste);
    searchDebounced.cancel();
    searchCustomers.cancel();
    lookupPhone.cancel();
    clearLeaveGuard(guard);
  };
}
