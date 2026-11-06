// Receive a payment (balance) against a bill: amount, cash or online. When the customer pays a little less,
// the rest can be let go as a discount at payment, so the bill becomes paid.
import { api } from '../lib/api.js';
import { html, setHtml, formData } from '../lib/dom.js';
import { openModal, toast, busy, showFormError, clearErrors, showFieldError } from '../lib/ui.js';
import { toMinor, fromMinor, isoDate, PAYMENT_METHODS, formatMoney } from '/shared/format.js';
import { moneyInput } from './product-form.js';

export function methodButtons(selected) {
  return html`<div class="method-options" role="radiogroup" aria-label="Payment method">${Object.entries(PAYMENT_METHODS).map(([value, label]) =>
    html`<button type="button" class="pay-option ${value === selected ? 'active' : ''}" data-method="${value}">${label}</button>`)}</div>`;
}

/** Resolves with the refreshed bill detail, or null if dismissed. */
export function openPaymentForm(bill) {
  const balance = bill.total - bill.amount_paid;
  return new Promise((resolve) => {
    let result = null;
    let method = 'cash';
    const modal = openModal({
      title: `Receive payment — ${bill.invoice_no}`,
      form: true,
      body: html`
        <div class="big-total"><div class="bt-label">Balance</div><div class="bt-value">${formatMoney(balance, bill.currency)}</div></div>
        <div class="form-grid">
          <div class="field"><label>Amount received <span class="req">*</span></label>
            ${moneyInput('amount', fromMinor(balance), bill.currency, 'required autofocus')}</div>
          <div class="field"><label>Date</label>
            <input class="input" type="date" name="paid_on" value="${isoDate()}" required></div>
          <div class="field span-all"><span class="label">Paid by</span>${methodButtons(method)}<input type="hidden" name="method" value="${method}"></div>
          <div class="field span-all hidden" data-ref-field><label>Reference <span class="muted">(optional)</span></label>
            <input class="input" name="reference" maxlength="100" placeholder="UPI / card / bank reference"></div>
          <label class="check span-all settle-box hidden" data-settle-box><input type="checkbox" name="settle">
            <span data-settle-text></span></label>
        </div>`,
      footer: html`<button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">Save payment</button>`,
      onClose: () => resolve(result),
      onSubmit: async (form, m, submitter) => {
        clearErrors(form);
        const d = formData(form);
        const typed = toMinor(d.amount);
        // Letting the whole balance go needs no amount.
        const amount = d.settle && d.amount.trim() === '' ? 0 : typed;
        if (Number.isNaN(amount) || amount < 0 || (amount === 0 && !d.settle)) return showFieldError(form, 'amount', 'Enter the amount received.');
        if (amount > balance) return showFieldError(form, 'amount', `Amount can't be more than the balance (${formatMoney(balance, bill.currency)}).`);
        const rest = d.settle ? balance - amount : 0;
        await busy(submitter, async () => {
          try {
            result = await api(`/bills/${bill.id}/payments`, {
              method: 'POST', body: { ...d, amount, settle: rest > 0, reference: method === 'online' ? d.reference : '' },
            });
            const money = (v) => formatMoney(v, bill.currency);
            toast(rest > 0
              ? `${amount ? `Payment of ${money(amount)} saved. ` : ''}${money(rest)} let go: the bill is paid.`
              : `Payment of ${money(amount)} saved.`);
            m.close();
          } catch (err) {
            showFormError(form, err);
          }
        });
        return undefined;
      },
    });
    // Paying less than the balance offers to let the rest go.
    const settleBox = modal.form.querySelector('[data-settle-box]');
    const showSettle = () => {
      const typed = modal.form.elements.namedItem('amount').value;
      const amount = typed.trim() === '' ? 0 : toMinor(typed);
      const short = !Number.isNaN(amount) && amount >= 0 && amount < balance;
      settleBox.classList.toggle('hidden', !short);
      if (!short) modal.form.elements.namedItem('settle').checked = false;
      setHtml(modal.form.querySelector('[data-settle-text]'), html`Customer paid less: let the rest (<strong>${formatMoney(balance - (short ? amount : 0), bill.currency)}</strong>) go
        <div class="check-desc">It's shown as a discount at payment, and the bill becomes Paid. Leave this off to keep it due.</div>`);
    };
    modal.form.elements.namedItem('amount').addEventListener('input', showSettle);
    showSettle();
    modal.form.addEventListener('click', (e) => {
      const b = e.target.closest('[data-method]');
      if (!b) return;
      method = b.dataset.method;
      // form.method is the form's own HTTP method property, so look the input up by name.
      modal.form.elements.namedItem('method').value = method;
      modal.form.querySelectorAll('[data-method]').forEach((x) => x.classList.toggle('active', x === b));
      modal.form.querySelector('[data-ref-field]').classList.toggle('hidden', method !== 'online');
    });
  });
}
