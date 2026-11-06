// Add / edit product dialog.
import { api } from '../lib/api.js';
import { html, raw, formData } from '../lib/dom.js';
import { openModal, toast, busy, showFormError, clearErrors, showFieldError } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import { currencyInfo, fromMinor, toMinor, formatMoney } from '/shared/format.js';

const COMMON_UNITS = ['pcs', 'set', 'pack', 'box', 'kg', 'g', 'L', 'ml', 'm', 'sq ft', 'dozen', 'pair',
  'job', 'hr', 'day', 'shoot', 'event', 'session', 'post', 'month'];

/** attrs is a trusted, developer-written attribute string. */
export function moneyInput(name, value, currency, attrs = '') {
  const sym = currencyInfo(currency).symbol.trim();
  return html`<div class="input-affix"><span class="affix">${sym}</span>
    <input class="input" name="${name}" inputmode="decimal" autocomplete="off" value="${value}" ${raw(attrs)}></div>`;
}

/** Opens the dialog; resolves with the saved product (or null if dismissed). */
export function openProductForm(app, { product = null, kind: initialKind = 'goods' } = {}) {
  const biz = app.business;
  const editing = !!product;
  const p = product || {
    kind: initialKind, name: '', sku: '', barcode: '', category: '', unit: initialKind === 'service' ? 'job' : 'pcs',
    purchase_price: '', selling_price: '', low_stock_threshold: 5, quantity: '',
  };
  const price = (v) => (v === '' || v === null || v === undefined ? '' : fromMinor(v));
  let kind = p.kind || 'goods';

  return new Promise((resolve) => {
    let saved = null;
    const modal = openModal({
      title: editing ? `Edit ${p.name}` : 'Add product or service',
      size: 'lg',
      form: true,
      body: html`
        <div class="segmented" style="margin-bottom:16px" role="radiogroup" aria-label="Item type">
          <button type="button" data-kind="goods" class="${kind === 'goods' ? 'active' : ''}">${icon('package', 'sm')} Product — track stock</button>
          <button type="button" data-kind="service" class="${kind === 'service' ? 'active' : ''}">${icon('clock', 'sm')} Service — no stock</button>
        </div>
        <div class="form-grid">
          <div class="field span-all"><label data-name-label>${kind === 'service' ? 'Service name' : 'Product name'} <span class="req">*</span></label>
            <input class="input" name="name" value="${p.name}" maxlength="160" required autofocus placeholder="e.g. Photo Frame 8x10 or Wedding Photography"></div>
          <div class="field"><label>SKU</label>
            <input class="input" name="sku" value="${p.sku}" maxlength="60" placeholder="Your item code"></div>
          <div class="field" data-goods-only><label>Barcode</label>
            <input class="input" name="barcode" value="${p.barcode}" maxlength="60" placeholder="Scan or type" inputmode="numeric">
            <span class="field-hint">Used for scanner entry while billing.</span></div>
          <div class="field"><label>Category</label>
            <input class="input" name="category" value="${p.category}" maxlength="60" list="dl-categories" placeholder="e.g. Frames, Photography">
            <datalist id="dl-categories"></datalist></div>
          <div class="field"><label>Unit</label>
            <input class="input" name="unit" value="${p.unit}" maxlength="20" list="dl-units" required>
            <datalist id="dl-units">${COMMON_UNITS.map((u) => html`<option value="${u}">`)}</datalist></div>
          <div class="field"><label>Purchase price</label>${moneyInput('purchase_price', price(p.purchase_price), biz.currency, 'placeholder="0.00"')}
            <span class="field-hint" data-cost-hint>${kind === 'service' ? 'Optional — your cost, for margin.' : 'Cost per unit — used for stock value.'}</span></div>
          <div class="field"><label>Selling price <span class="req">*</span></label>${moneyInput('selling_price', price(p.selling_price), biz.currency, 'placeholder="0.00" required')}
            <span class="field-hint" data-margin></span></div>
          ${editing ? html`
            <div class="field" data-goods-only><label>Current stock</label>
              <input class="input" value="${p.quantity} ${p.unit}" readonly>
              <span class="field-hint">Use “Adjust stock” on the product page to change quantity.</span></div>`
          : html`
            <div class="field" data-goods-only><label>Opening stock</label>
              <input class="input" name="quantity" inputmode="decimal" value="${p.quantity}" placeholder="0"></div>`}
          <div class="field" data-goods-only><label>Low-stock alert at</label>
            <input class="input" name="low_stock_threshold" inputmode="decimal" value="${p.low_stock_threshold}">
            <span class="field-hint">Alert when stock falls to this level.</span></div>
          <p class="muted small span-all ${kind === 'service' ? '' : 'hidden'}" data-service-note style="margin:0">
            Services (shoots, editing, design work) can be billed like products but never change stock.</p>
        </div>`,
      footer: html`<button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">${editing ? 'Save changes' : 'Save'}</button>`,
      onClose: () => resolve(saved),
      onSubmit: async (form, m, submitter) => {
        clearErrors(form);
        const d = formData(form);
        const body = {
          kind,
          name: d.name,
          sku: d.sku,
          barcode: kind === 'service' ? '' : d.barcode,
          category: d.category,
          unit: d.unit,
          low_stock_threshold: d.low_stock_threshold,
        };
        for (const key of ['purchase_price', 'selling_price']) {
          if (d[key].trim() === '') {
            if (key === 'selling_price') return showFieldError(form, key, 'Selling price is required.');
            body[key] = 0;
            continue;
          }
          const minor = toMinor(d[key]);
          if (Number.isNaN(minor) || minor < 0) return showFieldError(form, key, 'Enter a valid amount, e.g. 120 or 99.50');
          body[key] = minor;
        }
        if (!editing && kind === 'goods') body.quantity = d.quantity;
        await busy(submitter, async () => {
          try {
            const res = editing
              ? await api(`/products/${product.id}`, { method: 'PUT', body })
              : await api('/products', { method: 'POST', body });
            saved = res.product;
            toast(editing ? `${saved.is_service ? 'Service' : 'Product'} updated.` : `“${saved.name}” added${saved.is_service ? ' as a service' : ' to inventory'}.`);
            m.close();
          } catch (err) {
            showFormError(form, err);
          }
        });
        return undefined;
      },
    });

    const form = modal.form;
    const marginEl = form.querySelector('[data-margin]');
    const updateMargin = () => {
      const cost = toMinor(form.purchase_price.value);
      const sell = toMinor(form.selling_price.value);
      if (Number.isNaN(sell) || Number.isNaN(cost) || cost <= 0) {
        marginEl.textContent = '';
        return;
      }
      const margin = sell - cost;
      marginEl.textContent = margin < 0
        ? `Below cost by ${formatMoney(-margin, biz.currency)}`
        : `Margin ${formatMoney(margin, biz.currency)} (${Math.round((margin / cost) * 1000) / 10}%)`;
      marginEl.className = margin < 0 ? 'field-hint text-bad' : 'field-hint';
    };
    form.addEventListener('input', (e) => {
      if (e.target.name === 'purchase_price' || e.target.name === 'selling_price') updateMargin();
    });
    updateMargin();

    const applyKind = () => {
      const service = kind === 'service';
      form.querySelectorAll('[data-kind]').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
      form.querySelectorAll('[data-goods-only]').forEach((f) => f.classList.toggle('hidden', service));
      form.querySelector('[data-service-note]').classList.toggle('hidden', !service);
      form.querySelector('[data-name-label]').firstChild.textContent = service ? 'Service name ' : 'Product name ';
      form.querySelector('[data-cost-hint]').textContent = service ? 'Optional — your cost, for margin.' : 'Cost per unit — used for stock value.';
      const unit = form.elements.namedItem('unit');
      if (service && unit.value === 'pcs') unit.value = 'job';
      if (!service && unit.value === 'job') unit.value = 'pcs';
    };
    form.addEventListener('click', (e) => {
      const b = e.target.closest('[data-kind]');
      if (!b || b.dataset.kind === kind) return;
      if (editing && product.kind === 'goods' && b.dataset.kind === 'service' && product.quantity !== 0) {
        toast(`Adjust stock to 0 before turning “${product.name}” into a service.`, 'info');
        return;
      }
      kind = b.dataset.kind;
      applyKind();
    });
    applyKind();

    api('/products/categories').then(({ categories, units }) => {
      const dl = form.querySelector('#dl-categories');
      if (dl) dl.innerHTML = String(html`${categories.map((c) => html`<option value="${c}">`)}`);
      const du = form.querySelector('#dl-units');
      if (du) du.innerHTML = String(html`${[...new Set([...COMMON_UNITS, ...units])].map((u) => html`<option value="${u}">`)}`);
    }).catch(() => {});
  });
}
