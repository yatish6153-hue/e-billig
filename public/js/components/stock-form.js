// Stock in / stock out / physical count dialog.
import { api } from '../lib/api.js';
import { html, setHtml, formData } from '../lib/dom.js';
import { openModal, toast, busy, showFormError, clearErrors, showFieldError, qtyUnit } from '../lib/ui.js';
import { toMinor, fromMinor, roundQty } from '/shared/format.js';
import { moneyInput } from './product-form.js';

const REMOVE_REASONS = ['Damaged', 'Expired', 'Lost or stolen', 'Returned to supplier', 'Used internally', 'Counting error'];

/** Resolves with the updated product, or null if dismissed. */
export function openStockForm(app, product, { mode: initialMode = 'add' } = {}) {
  return new Promise((resolve) => {
    let saved = null;
    let mode = initialMode;
    const modal = openModal({
      title: `Adjust stock — ${product.name}`,
      form: true,
      body: html`
        <div class="segmented" role="tablist" style="margin-bottom:16px">
          <button type="button" data-mode="add">Add stock</button>
          <button type="button" data-mode="remove">Remove stock</button>
          <button type="button" data-mode="set">Set counted stock</button>
        </div>
        <p class="muted small" style="margin-bottom:14px">Current stock: <strong>${qtyUnit(product.quantity, product.unit)}</strong></p>
        <div data-fields></div>`,
      footer: html`<button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">Save adjustment</button>`,
      onClose: () => resolve(saved),
      onSubmit: async (form, m, submitter) => {
        clearErrors(form);
        const d = formData(form);
        const body = { mode, quantity: d.quantity, note: d.note || '' };
        if (mode === 'remove') {
          if (!d.reason) return showFieldError(form, 'reason', 'Choose a reason.');
          body.note = [d.reason, d.note].filter(Boolean).join(' — ');
        }
        if (mode === 'add' && d.unit_cost && d.unit_cost.trim() !== '') {
          const cost = toMinor(d.unit_cost);
          if (Number.isNaN(cost) || cost < 0) return showFieldError(form, 'unit_cost', 'Enter a valid amount.');
          body.unit_cost = cost;
          body.update_purchase_price = d.update_purchase_price;
        }
        await busy(submitter, async () => {
          try {
            const res = await api(`/products/${product.id}/stock`, { method: 'POST', body });
            saved = res.product;
            toast(`Stock updated. ${saved.name} now has ${qtyUnit(saved.quantity, saved.unit)}.`);
            m.close();
          } catch (err) {
            showFormError(form, err.field === 'note' && mode === 'remove' ? { ...err, field: 'reason', message: err.message } : err);
          }
        });
        return undefined;
      },
    });

    const form = modal.form;
    const fieldsEl = form.querySelector('[data-fields]');
    const render = () => {
      form.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
      if (mode === 'add') {
        setHtml(fieldsEl, html`<div class="form-grid">
          <div class="field"><label>Quantity to add (${product.unit})</label>
            <input class="input" name="quantity" inputmode="decimal" required autofocus></div>
          <div class="field"><label>Cost per unit</label>${moneyInput('unit_cost', fromMinor(product.purchase_price), app.business.currency)}</div>
          <label class="check span-all"><input type="checkbox" name="update_purchase_price">
            <span>Update the product's purchase price to this cost</span></label>
          <div class="field span-all"><label>Note</label>
            <input class="input" name="note" maxlength="200" placeholder="e.g. Supplier bill #4521"></div>
        </div>`);
      } else if (mode === 'remove') {
        setHtml(fieldsEl, html`<div class="form-grid">
          <div class="field"><label>Quantity to remove (${product.unit})</label>
            <input class="input" name="quantity" inputmode="decimal" required autofocus></div>
          <div class="field"><label>Reason <span class="req">*</span></label>
            <select class="input" name="reason"><option value="">Choose…</option>${REMOVE_REASONS.map((r) => html`<option>${r}</option>`)}</select></div>
          <div class="field span-all"><label>Note</label>
            <input class="input" name="note" maxlength="150" placeholder="Optional details"></div>
        </div>`);
      } else {
        setHtml(fieldsEl, html`<div class="form-grid">
          <div class="field"><label>Counted quantity (${product.unit})</label>
            <input class="input" name="quantity" inputmode="decimal" required autofocus value="${product.quantity}">
            <span class="field-hint" data-diff></span></div>
          <div class="field"><label>Note</label>
            <input class="input" name="note" maxlength="200" placeholder="e.g. Monthly stock count"></div>
        </div>`);
      }
      setTimeout(() => form.quantity?.focus(), 20);
    };
    form.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (b) {
        mode = b.dataset.mode;
        clearErrors(form);
        render();
      }
    });
    form.addEventListener('input', (e) => {
      if (mode !== 'set' || e.target.name !== 'quantity') return;
      const diffEl = form.querySelector('[data-diff]');
      const n = Number(e.target.value);
      if (e.target.value.trim() === '' || !Number.isFinite(n)) {
        diffEl.textContent = '';
        return;
      }
      const diff = roundQty(n - product.quantity);
      diffEl.textContent = diff === 0 ? 'No change' : `${diff > 0 ? '+' : ''}${diff} ${product.unit} compared with current stock`;
    });
    render();
  });
}
