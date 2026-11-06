// Bill page: the bill itself, its work (the customer's photos and the stage), Total / Advance / Balance, and a few actions.
import { api } from '../lib/api.js';
import { html, setHtml, raw, on } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast, toastError, confirmDialog, openModal, busy, statusBadge, demoBadge } from '../lib/ui.js';
import { navigate } from '../lib/router.js';
import { openPaymentForm } from '../components/payment-form.js';
import { shareOnWhatsApp, copyShareLink, isLocalUrl, statusMessage, payableBalance } from '../components/share.js';
import { stageLabel, STAGE_KEYS, PHOTO_SOURCES } from '/shared/tracking.js';
import { stageButtons } from '../components/stages.js';
import { photoStrip, openPhotos } from '../components/job-photos.js';
import { renderInvoiceHtml } from '/shared/invoice-html.js';
import { formatDate, formatDateTime, formatMoney, isoDate, PAYMENT_METHODS } from '/shared/format.js';

export default async function billView(el, { app, params }) {
  let data = await api(`/bills/${params.id}`);
  let warnedLocal = false;
  let toldUpi = false;

  /** A balance is due but there's no UPI ID yet, so shared bills can't carry a Pay now link — say so once. */
  function noteNoUpi() {
    const bill = data.bill;
    if (toldUpi || app.business.upi_id || bill.status !== 'finalized' || bill.balance <= 0) return;
    toldUpi = true;
    toast('Add your UPI ID in Settings → Bills & payments, and shared bills will include a Pay now link for the balance.', 'info', { timeout: 9000 });
  }

  /** Customers can't open links to this computer — say so once. */
  function noteIfLocal(url) {
    if (!warnedLocal && url && isLocalUrl(url)) {
      warnedLocal = true;
      toast('Note: this link points to this computer, so customers can only open it once the app is online.', 'info');
    }
  }

  function render() {
    const { bill, payments } = data;
    const money = (v) => formatMoney(v, bill.currency);
    const title = bill.invoice_no || `Draft #${bill.id}`;
    const isDraft = bill.status === 'draft';
    const isFinal = bill.status === 'finalized';
    const isCancelled = bill.status === 'cancelled';
    app.setTitle(title);

    const pdfHref = `/api/bills/${bill.id}/pdf`;
    const actions = isDraft
      ? html`
        <a class="btn btn-primary" href="/bills/${bill.id}/edit">${icon('edit')}Continue bill</a>
        <button type="button" class="btn btn-danger" data-action="delete">${icon('trash')}Delete draft</button>`
      : html`
        <button type="button" class="btn btn-whatsapp" data-action="whatsapp">${icon('message')}WhatsApp</button>
        <a class="btn" href="${pdfHref}" download>${icon('download')}PDF</a>
        <button type="button" class="btn" data-action="print">${icon('printer')}Print</button>
        <details class="menu">
          <summary class="btn btn-icon" aria-label="More actions">${icon('more')}</summary>
          <div class="menu-items">
            <button type="button" data-action="copy">${icon('link')}Copy bill link</button>
            ${isFinal && bill.balance > 0 ? html`<button type="button" data-action="copy-pay">${icon('wallet')}Copy payment link</button>` : ''}
            ${data.share_url ? html`
              <button type="button" data-action="regenerate">${icon('refresh')}Make a new link</button>
              <button type="button" data-action="revoke">${icon('ban')}Turn off the link</button>` : ''}
            <button type="button" data-action="duplicate">${icon('copy')}Duplicate as new bill</button>
            ${isFinal ? html`<hr><button type="button" class="danger" data-action="cancel">${icon('x')}Cancel bill</button>` : ''}
          </div>
        </details>`;

    const workCard = isCancelled || isDraft ? '' : html`
      <section class="card"><div class="card-body track-card">
        <div class="label" style="margin-bottom:8px">Work</div>
        <div class="tc-photo"><label for="photo_source">${icon('camera', 'sm')}Photo received</label>
          <select class="input input-sm" id="photo_source" data-photo-source>
            <option value="">Not set</option>${Object.entries(PHOTO_SOURCES).map(([key, label]) => html`
            <option value="${key}" ${bill.photo_source === key ? 'selected' : ''}>${label}</option>`)}</select></div>
        <div class="tc-pics"><div class="tc-pics-head">${icon('image', 'sm')}Customer’s photo${data.photos.length > 1 ? 's' : ''}
          ${data.photos.length ? '' : html`<span class="muted small">· add it so you remember which one it was</span>`}</div>
          ${photoStrip(data.photos)}</div>
        ${bill.work_stage ? html`
          ${stageButtons(bill.work_stage)}
          <div class="tc-actions">
            ${bill.work_stage === 'final' ? html`<span class="tr-done">${icon('check', 'sm')}Done</span>` : ''}
            <button type="button" class="btn btn-sm tr-wa" data-action="track-wa">${icon('share', 'sm')}Send status</button>
          </div>
          ${data.stage_history.length ? html`<details><summary>History</summary>
            <ul class="history">${data.stage_history.slice().reverse().map((h) => html`
              <li><span class="h-dot"></span><span><strong>${stageLabel(h.stage)}</strong>
                <span class="muted"> · ${formatDateTime(h.created_at)}</span>${h.note ? html`<div class="small">${h.note}</div>` : ''}</span></li>`)}</ul>
            <button type="button" class="inline-link small" style="margin-top:10px" data-action="track-stop">Stop tracking</button>
          </details>` : ''}`
        : html`<button type="button" class="btn btn-sm" data-action="track-start">${icon('kanban', 'sm')}Track this job</button>`}
      </div></section>`;

    const moneyCard = isDraft ? '' : html`
      <section class="card">
        <div class="card-body">
          <dl class="kv">
            <dt>Total</dt><dd>${money(bill.total)}</dd>
            <dt>Advance</dt><dd class="text-good">${money(bill.amount_paid)}</dd>
            <dt class="strong">Balance</dt><dd class="total ${bill.balance > 0 ? 'text-bad' : ''}">${money(bill.balance)}</dd>
          </dl>
          ${bill.settle_discount > 0 ? html`<p class="muted small" style="margin:8px 0 0">${money(bill.settle_discount)} was let go as a discount at payment.</p>` : ''}
          ${payments.length ? html`<hr class="divider">${payments.map((p) => html`
            <div class="payment-row">
              <div><div class="strong">${money(p.amount)} · ${PAYMENT_METHODS[p.method] || p.method}</div>
                <div class="muted small">${formatDate(p.paid_on)}${p.reference ? ` · ${p.reference}` : ''}</div></div>
              <button type="button" class="btn btn-ghost btn-icon btn-sm btn-danger" data-delete-payment="${p.id}" aria-label="Delete payment">${icon('trash')}</button>
            </div>`)}` : ''}
          ${isFinal && bill.balance > 0 ? html`<button type="button" class="btn btn-primary btn-block" style="margin-top:14px" data-action="pay">${icon('wallet')}Receive balance</button>` : ''}
        </div>
      </section>`;

    setHtml(el, html`
      <a class="back-link" href="/bills">${icon('arrowLeft', 'sm')}Bills</a>
      <div class="page-header">
        <div>
          <div class="row" style="gap:10px"><h1>${title}</h1>${statusBadge(bill)}${demoBadge(bill.is_demo)}</div>
          <div class="subtitle">${bill.customer_name || 'Walk-in customer'}${bill.customer_phone ? ` · ${bill.customer_phone}` : ''} · ${formatDate(bill.bill_date)}</div>
        </div>
        <div class="page-actions bill-actions">${actions}</div>
      </div>
      ${isDraft ? html`<div class="alert alert-info" style="margin-bottom:16px">${icon('info')}<div class="alert-body">
        This is a <strong>draft</strong> — it has no number yet and hasn't changed stock.</div></div>` : ''}
      ${isCancelled ? html`<div class="alert alert-danger" style="margin-bottom:16px">${icon('ban')}<div class="alert-body">
        Cancelled${bill.cancelled_at ? ` on ${formatDateTime(bill.cancelled_at)}` : ''}; its stock went back to inventory.
        ${bill.amount_paid > 0 ? html`<strong>${money(bill.amount_paid)}</strong> was received — settle any refund with the customer.` : ''}</div></div>` : ''}
      <div class="split">
        <div class="view-invoice print-area">${raw(renderInvoiceHtml({ ...data, logoUrl: data.business.logo_url }))}</div>
        <div class="stack">${workCard}${moneyCard}</div>
      </div>`);
  }

  async function setStage(stage) {
    try {
      const shareUrl = data.share_url;
      data = await api(`/bills/${data.bill.id}/stage`, { method: 'PUT', body: { stage } });
      data.share_url = data.share_url || shareUrl;
      render();
      toast(stage ? `${data.bill.invoice_no} → ${stageLabel(stage)}` : 'Tracking stopped.');
    } catch (err) {
      toastError(err);
      render();
    }
  }

  on(el, 'click', '[data-photos], [data-photo-at]', (e, b) => {
    openPhotos({
      bill: data.bill,
      photos: data.photos,
      start: Number(b.dataset.photoAt || 0),
      onChange: (photos) => {
        data.photos = photos;
        render();
      },
    });
  });

  on(el, 'click', '[data-action]', async (e, b) => {
    const action = b.dataset.action;
    const bill = data.bill;
    b.closest('details.menu')?.removeAttribute('open');
    switch (action) {
      case 'print':
        window.print();
        break;
      case 'pay': {
        const res = await openPaymentForm(bill);
        if (res) {
          data = res;
          render();
        }
        break;
      }
      case 'copy':
        await busy(b, async () => {
          try {
            data.share_url = await copyShareLink({ ...bill, share_url: data.share_url });
            render();
            noteIfLocal(data.share_url);
          } catch (err) {
            toastError(err);
          }
        });
        break;
      case 'copy-pay':
        if (!payableBalance(app.business, bill)) {
          toastError(new Error('Add your UPI ID in Settings → Bills & payments first, so customers can pay by UPI.'));
          break;
        }
        try {
          data.share_url = await copyShareLink({ ...bill, share_url: data.share_url }, { pay: true });
          render();
          noteIfLocal(data.share_url);
        } catch (err) {
          toastError(err);
        }
        break;
      case 'whatsapp':
      case 'track-wa':
        try {
          data.share_url = await shareOnWhatsApp(app.business, { ...bill, share_url: data.share_url }, {
            customerIsDemo: data.customer_is_demo, message: action === 'track-wa' ? statusMessage : undefined,
          });
          render();
          if (data.customer_is_demo) toast('Demo customer numbers are samples, so choose who to send it to in WhatsApp.', 'info');
          noteIfLocal(data.share_url);
          noteNoUpi();
        } catch (err) {
          toastError(err);
        }
        break;
      case 'regenerate': {
        const ok = await confirmDialog({
          title: 'Make a new link?', message: 'The old link stops working straight away. Anyone you sent it to will need the new one.', confirmText: 'Make new link',
        });
        if (!ok) return;
        try {
          const res = await api(`/bills/${bill.id}/share`, { method: 'POST', body: { regenerate: true } });
          data.share_url = res.share_url;
          render();
          await copyShareLink({ ...bill, share_url: res.share_url });
        } catch (err) {
          toastError(err);
        }
        break;
      }
      case 'revoke': {
        const ok = await confirmDialog({
          title: 'Turn off the bill link?', message: 'Anyone with the link will no longer be able to open this bill.', confirmText: 'Turn off link', danger: true,
        });
        if (!ok) return;
        try {
          await api(`/bills/${bill.id}/share`, { method: 'DELETE' });
          data.share_url = null;
          render();
          toast('Link turned off.');
        } catch (err) {
          toastError(err);
        }
        break;
      }
      case 'duplicate':
        try {
          const res = await api(`/bills/${bill.id}/duplicate`, { method: 'POST', body: { bill_date: isoDate() } });
          toast('Copied into a new bill. Check it and create it when ready.');
          navigate(`/bills/${res.bill.id}/edit`);
        } catch (err) {
          toastError(err);
        }
        break;
      case 'delete': {
        const ok = await confirmDialog({ title: 'Delete this draft?', message: 'This removes the draft. Stock is not affected.', confirmText: 'Delete draft', danger: true });
        if (!ok) return;
        try {
          await api(`/bills/${bill.id}`, { method: 'DELETE' });
          toast('Draft deleted.');
          navigate('/bills');
        } catch (err) {
          toastError(err);
        }
        break;
      }
      case 'cancel':
        openCancelDialog();
        break;
      case 'track-start':
        await setStage(STAGE_KEYS[0]);
        break;
      case 'track-stop': {
        const ok = await confirmDialog({
          title: 'Stop tracking this bill?', message: 'It leaves the Tracking page. Its history is kept.', confirmText: 'Stop tracking',
        });
        if (ok) await setStage(null);
        break;
      }
      default:
    }
  });

  function openCancelDialog() {
    const bill = data.bill;
    const money = (v) => formatMoney(v, bill.currency);
    openModal({
      title: `Cancel ${bill.invoice_no}?`,
      form: true,
      body: html`
        <p>The bill is marked <strong>Cancelled</strong> and everything on it goes back into stock. To bill again, duplicate it.</p>
        ${bill.amount_paid > 0 ? html`<div class="alert alert-warn" style="margin-bottom:12px">${icon('alert')}<div>${money(bill.amount_paid)} has been received on this bill. Cancelling doesn't refund it — settle that with the customer.</div></div>` : ''}
        <div class="field"><label>Reason <span class="muted">(shown on the bill)</span></label>
          <textarea class="input" name="reason" rows="2" maxlength="300" placeholder="e.g. Customer changed the order"></textarea></div>`,
      footer: html`<button type="button" class="btn" data-close>Keep bill</button>
        <button type="submit" class="btn btn-danger-solid">Cancel bill</button>`,
      onSubmit: async (form, m, submitter) => {
        await busy(submitter, async () => {
          try {
            const res = await api(`/bills/${bill.id}/cancel`, { method: 'POST', body: { reason: form.elements.namedItem('reason').value } });
            data = res;
            m.close();
            render();
            toast(`${bill.invoice_no} cancelled. Stock restored for ${res.restored_products} item${res.restored_products === 1 ? '' : 's'}.`);
          } catch (err) {
            toastError(err);
          }
        });
      },
    });
  }

  on(el, 'change', '[data-photo-source]', async (e, select) => {
    try {
      const shareUrl = data.share_url;
      data = await api(`/bills/${data.bill.id}/photo-source`, { method: 'PUT', body: { photo_source: select.value } });
      data.share_url = data.share_url || shareUrl;
      render();
      toast(select.value ? `Photo received: ${PHOTO_SOURCES[select.value]}` : 'Photo received cleared.');
    } catch (err) {
      toastError(err);
      render();
    }
  });

  on(el, 'click', '[data-set-stage]', (e, b) => {
    if (b.dataset.setStage === data.bill.work_stage) return;
    b.closest('.stages').classList.add('is-busy');
    setStage(b.dataset.setStage);
  });

  on(el, 'click', '[data-delete-payment]', async (e, b) => {
    const ok = await confirmDialog({
      title: 'Delete this payment?', message: 'Use this to fix a payment entered by mistake. The balance will update.', confirmText: 'Delete payment', danger: true,
    });
    if (!ok) return;
    try {
      data = await api(`/bills/${data.bill.id}/payments/${b.dataset.deletePayment}`, { method: 'DELETE' });
      render();
      toast('Payment deleted.');
    } catch (err) {
      toastError(err);
    }
  });

  const closeMenus = (e) => {
    el.querySelectorAll('details.menu[open]').forEach((d) => {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  };
  document.addEventListener('click', closeMenus);

  render();
  return () => document.removeEventListener('click', closeMenus);
}
