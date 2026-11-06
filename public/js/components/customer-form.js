// Add / edit customer dialog.
import { api } from '../lib/api.js';
import { html, formData } from '../lib/dom.js';
import { openModal, toast, busy, showFormError, clearErrors } from '../lib/ui.js';

/** Resolves with the saved customer, or null if dismissed. */
export function openCustomerForm({ customer = null, initialName = '' } = {}) {
  const editing = !!customer;
  const c = customer || { name: initialName, phone: '', email: '', address: '' };
  return new Promise((resolve) => {
    let saved = null;
    openModal({
      title: editing ? `Edit ${c.name}` : 'Add customer',
      form: true,
      body: html`
        <div class="form-grid">
          <div class="field span-all"><label>Customer name <span class="req">*</span></label>
            <input class="input" name="name" value="${c.name}" maxlength="120" required autofocus></div>
          <div class="field"><label>WhatsApp number</label>
            <input class="input" name="phone" type="tel" value="${c.phone}" maxlength="20" placeholder="98765 43210">
            <span class="field-hint">Bills are sent to this number on WhatsApp.</span></div>
          <div class="field"><label>Email</label>
            <input class="input" name="email" type="email" value="${c.email}" maxlength="254"></div>
          <div class="field span-all"><label>Billing address</label>
            <textarea class="input" name="address" maxlength="500" rows="3">${c.address}</textarea></div>
        </div>`,
      footer: html`<button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">${editing ? 'Save changes' : 'Add customer'}</button>`,
      onClose: () => resolve(saved),
      onSubmit: async (form, modal, submitter) => {
        clearErrors(form);
        const body = formData(form);
        await busy(submitter, async () => {
          try {
            const res = editing
              ? await api(`/customers/${customer.id}`, { method: 'PUT', body })
              : await api('/customers', { method: 'POST', body });
            saved = res.customer;
            toast(editing ? 'Customer updated.' : `${saved.name} added.`);
            modal.close();
          } catch (err) {
            showFormError(form, err);
          }
        });
      },
    });
  });
}
