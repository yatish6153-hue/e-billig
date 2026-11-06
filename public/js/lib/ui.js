// UI primitives: toasts, modal dialogs, confirmations, form errors, badges.
import { html, setHtml, $$ } from './dom.js';
import { icon } from './icons.js';
import { DISPLAY_STATUS_LABELS, billDisplayStatus, formatQty } from '/shared/format.js';

// ---- Toasts ----------------------------------------------------------------
let toastHost;
export function toast(message, type = 'success', { timeout } = {}) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.append(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const iconName = type === 'error' ? 'alert' : type === 'info' ? 'info' : 'checkCircle';
  setHtml(el, html`${icon(iconName)}<div>${message}</div><button class="toast-close" aria-label="Dismiss">&times;</button>`);
  const remove = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector('.toast-close').addEventListener('click', remove);
  toastHost.append(el);
  setTimeout(remove, timeout ?? (type === 'error' ? 7000 : 3500));
}

export const toastError = (err) => toast(err?.message || String(err), 'error');

// ---- Modals ----------------------------------------------------------------
/**
 * Open a dialog. `body` and `footer` are html`` content. With `form: true`
 * the content is wrapped in a <form> and onSubmit(form, modal) is called on submit.
 */
export function openModal({ title, body, footer = '', size = '', form = false, onSubmit, onClose, dismissible = true }) {
  const dlg = document.createElement('dialog');
  dlg.className = `modal ${size ? `modal-${size}` : ''}`;
  const inner = html`
    <div class="modal-header"><h2>${title}</h2>
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-close aria-label="Close">${icon('x')}</button>
    </div>
    <div class="modal-body">${body}</div>
    ${footer ? html`<div class="modal-footer">${footer}</div>` : ''}`;
  setHtml(dlg, form ? html`<form novalidate>${inner}</form>` : inner);
  document.body.append(dlg);

  let closed = false;
  const modal = {
    el: dlg,
    form: dlg.querySelector('form'),
    close() {
      if (closed) return;
      closed = true;
      dlg.close();
    },
  };
  dlg.addEventListener('close', () => {
    closed = true;
    dlg.remove();
    onClose?.();
  });
  dlg.addEventListener('cancel', (e) => {
    if (!dismissible) e.preventDefault();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) modal.close();
    else if (e.target === dlg && dismissible) {
      // Click on the backdrop (outside the dialog box).
      const r = dlg.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) modal.close();
    }
  });
  if (modal.form && onSubmit) {
    modal.form.addEventListener('submit', (e) => {
      e.preventDefault();
      onSubmit(modal.form, modal, e.submitter);
    });
  }
  dlg.showModal();
  const first = dlg.querySelector('[autofocus], .modal-body input:not([type=hidden]):not([disabled]), .modal-body select, .modal-body textarea');
  if (first) setTimeout(() => first.focus(), 30);
  return modal;
}

export function confirmDialog({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', danger = false, body = '' }) {
  return new Promise((resolve) => {
    let result = false;
    const modal = openModal({
      title,
      size: 'sm',
      body: html`${message ? html`<p>${message}</p>` : ''}${body}`,
      footer: html`
        <button type="button" class="btn" data-close>${cancelText}</button>
        <button type="button" class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-confirm>${confirmText}</button>`,
      onClose: () => resolve(result),
    });
    modal.el.querySelector('[data-confirm]').addEventListener('click', () => {
      result = true;
      modal.close();
    });
    setTimeout(() => modal.el.querySelector('[data-confirm]').focus(), 30);
  });
}

// ---- Forms -----------------------------------------------------------------
export function clearErrors(root) {
  $$('.field-error', root).forEach((e) => e.remove());
  $$('.is-invalid', root).forEach((e) => e.classList.remove('is-invalid'));
}

export function showFieldError(root, field, message) {
  if (!field) return false;
  const input = root.querySelector(`[name="${CSS.escape(field)}"]`);
  if (!input) return false;
  input.classList.add('is-invalid');
  const msg = document.createElement('div');
  msg.className = 'field-error';
  msg.textContent = message;
  (input.closest('.field') || input.parentElement).append(msg);
  input.focus();
  return true;
}

/** Show an API error next to its field when possible, otherwise as a toast. */
export function showFormError(root, err) {
  clearErrors(root);
  if (!showFieldError(root, err.field, err.message)) toastError(err);
}

/** Disable a button and show a spinner while fn runs. */
export async function busy(button, fn) {
  if (!button) return fn();
  if (button.classList.contains('is-busy')) return undefined;
  const original = button.innerHTML;
  button.classList.add('is-busy');
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span>${original}`;
  try {
    return await fn();
  } finally {
    button.classList.remove('is-busy');
    button.disabled = false;
    button.innerHTML = original;
  }
}

// ---- Small renderers -------------------------------------------------------
export const loading = (text = 'Loading…') => html`<div class="loading"><span class="spinner"></span>${text}</div>`;

export function errorBlock(err) {
  return html`<div class="card"><div class="empty">${icon('alert')}<h3>Couldn't load this page</h3><p>${err.message}</p>
    <button class="btn" data-action="reload">${icon('refresh')}Try again</button></div></div>`;
}

export function statusBadge(bill) {
  const s = bill.display_status || billDisplayStatus(bill);
  return html`<span class="badge badge-${s}">${DISPLAY_STATUS_LABELS[s]}</span>`;
}

export const demoBadge = (isDemo) => (isDemo ? html`<span class="badge badge-demo" title="Sample data for testing — remove it any time in Settings">Demo</span>` : '');

export function stockBadge(p) {
  if (p.archived) return html`<span class="badge badge-archived">Archived</span>`;
  if (p.is_service || p.kind === 'service') return html`<span class="badge badge-service badge-plain">Service</span>`;
  if (p.quantity <= 0) return html`<span class="badge badge-out">Out of stock</span>`;
  if (p.quantity <= p.low_stock_threshold) return html`<span class="badge badge-low">Low stock</span>`;
  return html`<span class="badge badge-ok">In stock</span>`;
}

export const qtyUnit = (qty, unit) => `${formatQty(qty)} ${unit || ''}`.trim();

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function pager(total, limit, offset) {
  if (total <= limit && offset === 0) return '';
  const from = total ? offset + 1 : 0;
  const to = Math.min(offset + limit, total);
  return html`<div class="pager"><span>Showing ${from}–${to} of ${total}</span>
    <div class="row">
      <button class="btn btn-sm" data-page="${Math.max(0, offset - limit)}" ${offset === 0 ? 'disabled' : ''}>Previous</button>
      <button class="btn btn-sm" data-page="${offset + limit}" ${to >= total ? 'disabled' : ''}>Next</button>
    </div></div>`;
}
