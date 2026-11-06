// One booking, everything on one page: progress, status, the event and client, the shoot checklist, post-production
// (only for the services booked), delivery, files & links, notes and the activity history; with payments, the team
// and deadlines alongside.
import { html, setHtml, on, onDateCommit, formData } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast, toastError, confirmDialog, openModal, busy, showFormError, demoBadge } from '../lib/ui.js';
import { navigate } from '../lib/router.js';
import { formatDate, formatDateTime, formatMoney, formatQty, whatsappNumber } from '/shared/format.js';
import {
  CHECKLIST, POST_PRODUCTION, DEADLINES, DELIVERY_METHODS, LINK_TYPES, BOOKING_STATUSES, BOOKING_PAY_METHODS,
  BOOKING_PAYMENT_LABELS, sectionsFor, deliverablesFor, shootDone, eventTitle, timeRange,
} from '/shared/bookings.js';
import {
  bookingApi, statusBadge, progressBar, statusChain, clashNote, openTeamForm, openBookingPayment, openLinkForm,
  markShootDone, deleteBookingFlow, saveWithConflicts,
} from '../components/booking-ui.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
};

/**
 * Deadlines that matter for what was booked: photo, video and album ones only when those were booked. One already set
 * stays on show even when its part is no longer booked, so it can still be seen, changed or cleared.
 */
function deadlinesFor(b) {
  const sections = sectionsFor(b.services);
  const need = { photo_edit: 'photo', video_cut: 'video', album_delivery: 'album' };
  return DEADLINES.filter((d) => !need[d.key] || sections.includes(need[d.key]) || b.deadlines[d.key]);
}

const dueText = (d) => {
  if (d.state === 'done') return 'Done';
  if (d.days < 0) return `${-d.days} day${d.days === -1 ? '' : 's'} overdue`;
  if (d.days === 0) return 'Due today';
  return d.days === 1 ? 'Due tomorrow' : `Due in ${d.days} days`;
};

export default async function bookingView(el, { app, params }) {
  const currency = app.business.currency;
  const money = (v) => formatMoney(v, currency);
  let data = await bookingApi(`/bookings/${params.id}`);

  // ---- Cards ---------------------------------------------------------------------
  function eventCard(b) {
    const wa = whatsappNumber(b.client_whatsapp || b.client_phone, currency);
    const contact = [
      b.client_phone ? html`<a href="tel:${b.client_phone.replace(/[^\d+]/g, '')}">${icon('phone', 'sm')}${b.client_phone}</a>` : '',
      wa ? html`<a href="https://wa.me/${wa}" target="_blank" rel="noopener noreferrer">${icon('message', 'sm')}WhatsApp${b.client_whatsapp && b.client_whatsapp !== b.client_phone ? ` ${b.client_whatsapp}` : ''}</a>` : '',
      b.client_email ? html`<a href="mailto:${b.client_email}">${icon('file', 'sm')}${b.client_email}</a>` : '',
    ].filter(Boolean);
    return html`<section class="card"><div class="card-header"><h2>Event &amp; client</h2>
      <a class="btn btn-sm" href="/bookings/${b.id}/edit">${icon('edit', 'sm')}Edit</a></div>
      <div class="card-body"><dl class="bk-facts">
        <div><dt>Event</dt><dd>${b.event_type || '—'}${b.event_name ? html` · <strong>${b.event_name}</strong>` : ''}</dd></div>
        <div><dt>${b.schedule.length > 1 ? `Dates (${b.schedule.length})` : 'Date'}</dt><dd><ul class="bk-dates">${b.schedule.map((d) => html`
          <li><span class="bk-dates-day"><b>${formatDate(d.date)}</b> ${weekday(d.date)}</span>
            <span class="bk-dates-time">${timeRange(d) ? html`${icon('clock', 'sm')}${timeRange(d)}` : html`<span class="muted">Time not set</span>`}</span>
            <span class="bk-dates-venue">${d.venue ? html`${icon('mapPin', 'sm')}${d.venue}` : html`<span class="muted">Venue not set</span>`}</span></li>`)}</ul></dd></div>
        <div><dt>Client</dt><dd><strong>${b.client_name}</strong>${contact.length ? html`<div class="bk-contact">${contact}</div>` : ''}
          ${b.client_alt ? html`<div class="muted small">Also: ${b.client_alt}</div>` : ''}
          ${b.client_address ? html`<div class="muted bk-pre">${b.client_address}</div>` : ''}</dd></div>
        ${b.event_notes ? html`<div><dt>Notes</dt><dd class="bk-pre">${b.event_notes}</dd></div>` : ''}
      </dl></div></section>`;
  }

  function checklistCard(b) {
    const done = CHECKLIST.filter((c) => b.checklist[c.key]).length;
    return html`<section class="card"><div class="card-header"><h2>Shoot checklist</h2><span class="hint">${done} of ${CHECKLIST.length} done</span></div>
      <div class="card-body bk-checks">${CHECKLIST.map((c) => html`
        <label class="check bk-check ${b.checklist[c.key] ? 'is-done' : ''}"><input type="checkbox" data-checklist="${c.key}" ${b.checklist[c.key] ? 'checked' : ''}>
          <span>${c.label}${b.checklist[c.key] ? html`<span class="check-desc">${formatDate(b.checklist[c.key])}</span>` : ''}</span></label>`)}</div></section>`;
  }

  function postCard(b) {
    const sections = POST_PRODUCTION.filter((s) => sectionsFor(b.services).includes(s.key));
    return html`<section class="card"><div class="card-header"><h2>Post-production</h2>
      ${shootDone(b) ? '' : html`<span class="hint">Starts after the shoot</span>`}</div>
      ${sections.length ? html`<div class="card-body bk-post">${sections.map((s) => {
        const done = s.steps.filter(([k]) => b.tasks[`${s.key}.${k}`]).length;
        return html`<div class="bk-post-sec">
          <div class="bk-post-head"><span class="bk-h-icon">${icon({ photo: 'image', video: 'video', album: 'book' }[s.key], 'sm')}${s.label}</span>
            <span class="muted small">${done}/${s.steps.length}</span></div>
          <div class="meter"><span style="width:${Math.round((done / s.steps.length) * 100)}%"></span></div>
          <div class="bk-steps">${s.steps.map(([k, label]) => {
            const key = `${s.key}.${k}`;
            return html`<label class="check bk-check ${b.tasks[key] ? 'is-done' : ''}"><input type="checkbox" data-task="${key}" ${b.tasks[key] ? 'checked' : ''}>
              <span>${label}${b.tasks[key] ? html`<span class="check-desc">${formatDate(b.tasks[key])}</span>` : ''}</span></label>`;
          })}</div></div>`;
      })}</div>` : html`<p class="muted bk-none">No post-production for the services booked.</p>`}</section>`;
  }

  function deliveryCard(b) {
    const d = b.delivery;
    const items = deliverablesFor(b.services);
    const methods = d.method && !DELIVERY_METHODS.includes(d.method) ? [...DELIVERY_METHODS, d.method] : DELIVERY_METHODS;
    return html`<section class="card"><div class="card-header"><h2>Delivery</h2>
      ${items.length ? html`<span class="hint">${items.filter((x) => d[x.key]).length} of ${items.length} delivered</span>` : ''}</div>
      <form class="card-body" data-delivery-form novalidate>
        ${items.length ? html`<div class="bk-deliverables">${items.map((x) => html`
          <label class="check bk-check ${d[x.key] ? 'is-done' : ''}"><input type="checkbox" name="${x.key}" ${d[x.key] ? 'checked' : ''}><span>${x.label}</span></label>`)}</div>` : ''}
        <div class="form-grid" style="margin-top:12px">
          <div class="field"><label>Delivery date</label><input class="input" type="date" name="delivery_date" value="${d.date || ''}"></div>
          <div class="field"><label>Delivery method</label><select class="input" name="delivery_method"><option value="">Choose…</option>${methods.map((m) => html`
            <option ${m === d.method ? 'selected' : ''}>${m}</option>`)}</select></div>
          <div class="field span-all"><label>Google Drive link</label><input class="input" type="url" name="delivery_drive" value="${d.drive || ''}" placeholder="https://drive.google.com/…"></div>
          <div class="field"><label>Dropbox link</label><input class="input" type="url" name="delivery_dropbox" value="${d.dropbox || ''}" placeholder="https://www.dropbox.com/…"></div>
          <div class="field"><label>Other download link</label><input class="input" type="url" name="delivery_other" value="${d.other || ''}" placeholder="https://…"></div>
          <div class="field span-all"><label>Hard drive / pen drive</label><input class="input" name="delivery_storage" value="${d.storage || ''}" maxlength="120" placeholder="e.g. 64 GB pen drive given to the client"></div>
          <div class="field span-all"><label>Notes</label><textarea class="input" name="delivery_notes" rows="2" maxlength="1000">${d.notes || ''}</textarea></div>
        </div>
        <div class="bk-form-row">
          ${[d.drive, d.dropbox, d.other].filter(Boolean).map((url) => html`<a class="bk-ext" href="${url}" target="_blank" rel="noopener noreferrer">${icon('external', 'sm')}Open link</a>`)}
          <button type="submit" class="btn btn-primary btn-sm">${icon('check', 'sm')}Save delivery</button>
        </div>
      </form></section>`;
  }

  function linksCard(b) {
    return html`<section class="card"><div class="card-header"><h2>Files &amp; links</h2>
      <button type="button" class="btn btn-sm" data-action="add-link">${icon('plus', 'sm')}Add link</button></div>
      ${b.links.length ? html`<div class="list">${b.links.map((l) => html`
        <div class="list-item bk-link" data-link="${l.id}">
          <a class="li-main" href="${l.url}" target="_blank" rel="noopener noreferrer"><div class="li-title">${icon('link', 'sm')}${l.label || LINK_TYPES[l.type]}</div>
            <div class="li-sub">${LINK_TYPES[l.type]}${l.added_on ? ` · ${formatDate(l.added_on)}` : ''} · <span class="bk-url">${l.url}</span></div></a>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-remove-link title="Remove" aria-label="Remove link">${icon('trash', 'sm')}</button>
        </div>`)}</div>`
        : html`<p class="muted bk-none">Save Google Drive, Dropbox, WeTransfer or gallery links here: raw footage, edited photos, the final delivery.</p>`}</section>`;
  }

  function notesCard(b, activity) {
    return html`<section class="card"><div class="card-header"><h2>Notes &amp; activity</h2></div>
      <form class="card-body" data-notes-form novalidate>
        <div class="field"><label for="internal_notes">Internal notes <span class="muted">(only you see these)</span></label>
          <textarea class="input" id="internal_notes" name="internal_notes" rows="3" maxlength="5000">${b.internal_notes}</textarea></div>
        <div class="bk-form-row"><button type="submit" class="btn btn-sm">${icon('check', 'sm')}Save notes</button></div>
      </form>
      <div class="card-body bk-activity-wrap"><div class="label">Activity history</div>
        <ul class="history bk-activity">${activity.map((a) => html`<li><span class="h-dot"></span><span><span class="muted">${formatDateTime(a.created_at)}</span> – ${a.text}</span></li>`)}</ul>
      </div></section>`;
  }

  /** The bill: each service with its price, the discount, total, what came in and what's left. */
  function paymentCard(b, payments) {
    const open = b.status !== 'cancelled' && b.balance > 0;
    return html`<section class="card"><div class="card-header"><h2>Bill &amp; payment</h2>
      <span class="badge badge-${b.payment_status}">${BOOKING_PAYMENT_LABELS[b.payment_status]}</span></div>
      <div class="card-body">
        ${b.package_name ? html`<div class="bk-package">${b.package_name}</div>` : ''}
        ${b.services.length ? html`<ul class="bk-bill-lines">${b.services.map((s) => html`
          <li><span class="bk-bill-name">${s.name}<span class="muted small">${formatQty(s.qty)} × ${money(s.rate)}</span></span>
            <span class="num">${money(s.amount)}</span></li>`)}</ul>`
          : html`<p class="muted small" style="margin:0 0 10px">No services added yet (Edit).</p>`}
        <dl class="kv">
          ${b.discount ? html`<dt>Subtotal</dt><dd>${money(b.subtotal)}</dd><dt>Discount</dt><dd>−${money(b.discount)}</dd>` : ''}
          <dt class="strong">Total</dt><dd class="total">${money(b.total)}</dd>
          <dt>Received</dt><dd class="text-good">${money(b.amount_paid)}</dd>
          <dt class="strong">Remaining</dt><dd class="total ${b.balance > 0 ? 'text-bad' : ''}">${money(b.balance)}</dd>
        </dl>
        ${payments.length ? html`<hr class="divider"><div class="label">Payment history</div>${payments.map((p) => html`
          <div class="payment-row">
            <div><div class="strong">${money(p.amount)} · ${BOOKING_PAY_METHODS[p.method] || p.method}</div>
              <div class="muted small">${formatDate(p.paid_on)}${p.note ? ` · ${p.note}` : ''}</div></div>
            <button type="button" class="btn btn-ghost btn-icon btn-sm btn-danger" data-delete-payment="${p.id}" aria-label="Delete payment">${icon('trash', 'sm')}</button>
          </div>`)}` : html`<p class="muted small" style="margin:12px 0 0">No payments yet.</p>`}
        ${open ? html`<button type="button" class="btn btn-primary btn-block" style="margin-top:14px" data-action="pay">${icon('wallet')}Add payment</button>` : ''}
        ${!b.total && b.status !== 'cancelled' ? html`<p class="muted small" style="margin:10px 0 0">Add the services with their prices (Edit) to take payments.</p>` : ''}
      </div></section>`;
  }

  function teamCard(b, conflicts) {
    return html`<section class="card"><div class="card-header"><h2>Team</h2>
      <button type="button" class="btn btn-sm" data-action="team">${icon('users', 'sm')}${b.team.length ? 'Change' : 'Assign'}</button></div>
      ${b.team.length ? html`<ul class="list">${b.team.map((t) => html`<li class="list-item">
        <div class="li-main"><div class="li-title">${t.name}</div><div class="li-sub">${t.role || 'No role'}</div></div>
        ${t.phone ? html`<a class="btn btn-ghost btn-icon btn-sm" href="tel:${t.phone.replace(/[^\d+]/g, '')}" title="Call ${t.name}" aria-label="Call ${t.name}">${icon('phone', 'sm')}</a>` : ''}
      </li>`)}</ul>` : html`<p class="muted bk-none">No one assigned yet.</p>`}
      ${conflicts.length ? html`<p class="small text-warn bk-none">${icon('alert', 'sm')} Also booked elsewhere at this time (see above).</p>` : ''}</section>`;
  }

  function deadlinesCard(b) {
    const states = new Map(b.deadline_states.map((d) => [d.key, d]));
    return html`<section class="card"><div class="card-header"><h2>Deadlines</h2>
      ${b.overdue ? html`<span class="badge badge-overdue">${b.overdue} overdue</span>` : ''}</div>
      <form class="card-body bk-deadlines" data-deadlines-form novalidate>${deadlinesFor(b).map((d) => {
        const s = states.get(d.key);
        return html`<div class="bk-deadline ${s ? `is-${s.state}` : ''}">
          <label for="dl_${d.key}">${d.label}</label>
          <input class="input input-sm" type="date" id="dl_${d.key}" name="${d.key}" value="${b.deadlines[d.key] || ''}">
          <span class="bk-due">${s ? dueText(s) : ''}</span></div>`;
      })}</form></section>`;
  }

  function render() {
    const { booking: b, payments, activity, conflicts } = data;
    app.setTitle(`${b.number} · ${b.client_name}`);
    const parked = b.status === 'on_hold' || b.status === 'cancelled';
    const canShoot = !shootDone(b) && !parked;
    setHtml(el, html`
      <a class="back-link" href="/bookings">${icon('arrowLeft', 'sm')}Bookings &amp; Shoots</a>
      <div class="page-header">
        <div>
          <div class="row" style="gap:10px"><h1>${b.client_name}</h1>${statusBadge(b.status)}${demoBadge(b.is_demo)}</div>
          <div class="subtitle"><strong>${b.number}</strong> · ${eventTitle(b)} · ${formatDate(b.event_date)}</div>
        </div>
        <div class="page-actions bill-actions">
          ${canShoot ? html`<button type="button" class="btn btn-soft" data-action="shot">${icon('camera')}Mark shoot complete</button>` : ''}
          ${b.status !== 'cancelled' && b.balance > 0 ? html`<button type="button" class="btn btn-primary" data-action="pay">${icon('wallet')}Add payment</button>` : ''}
          <a class="btn" href="/bookings/${b.id}/edit">${icon('edit')}Edit</a>
          <details class="menu">
            <summary class="btn btn-icon" aria-label="More actions">${icon('more')}</summary>
            <div class="menu-items">
              <a href="/bookings/new?from=${b.id}">${icon('copy')}Duplicate</a>
              <button type="button" data-action="add-link">${icon('link')}Add Drive link</button>
              ${b.status === 'on_hold' ? html`<button type="button" data-action="resume">${icon('play')}Resume booking</button>`
                : b.status !== 'cancelled' ? html`<button type="button" data-action="hold">${icon('pause')}Put on hold</button>` : ''}
              ${b.status === 'cancelled' ? html`<button type="button" data-action="restore">${icon('refresh')}Restore booking</button>`
                : html`<button type="button" data-action="cancel">${icon('ban')}Cancel booking</button>`}
              <hr><button type="button" class="danger" data-action="delete">${icon('trash')}Delete booking</button>
            </div>
          </details>
        </div>
      </div>
      ${b.status === 'cancelled' ? html`<div class="alert alert-danger bk-alert">${icon('ban')}<div class="alert-body"><strong>Cancelled.</strong>
        ${b.cancel_reason ? ` ${b.cancel_reason}.` : ''}${b.amount_paid ? html` <strong>${money(b.amount_paid)}</strong> was received — settle any refund with the client.` : ''}
        <div class="alert-actions"><button type="button" class="btn btn-sm" data-action="restore">${icon('refresh', 'sm')}Restore booking</button></div></div></div>` : ''}
      ${b.status === 'on_hold' ? html`<div class="alert alert-warn bk-alert">${icon('pause')}<div class="alert-body"><strong>On hold.</strong>
        It was at ${BOOKING_STATUSES[b.prev_status || 'new']}. It stays off the work lists until you resume it.
        <div class="alert-actions"><button type="button" class="btn btn-sm" data-action="resume">${icon('play', 'sm')}Resume booking</button></div></div></div>` : ''}
      ${clashNote(conflicts)}
      <section class="card bk-head-card">
        ${progressBar(b)}
        <div class="bk-status-row"><span class="label">Status</span>${statusChain(b)}</div>
      </section>
      <div class="bk-page">
        <div class="stack bk-main">${eventCard(b)}${checklistCard(b)}${postCard(b)}${deliveryCard(b)}${linksCard(b)}${notesCard(b, activity)}</div>
        <div class="stack bk-side">${paymentCard(b, payments)}${teamCard(b, conflicts)}${deadlinesCard(b)}</div>
      </div>`);
  }

  // What's typed but not yet saved in the delivery and notes forms, so a redraw after another change keeps it.
  const UNSAVED = ['[data-delivery-form]', '[data-notes-form]'];
  const isChoice = (f) => f.type === 'checkbox' || f.type === 'radio';
  function unsaved() {
    return UNSAVED.flatMap((selector) => [...(el.querySelector(selector)?.elements || [])]
      .filter((f) => f.name && (isChoice(f) ? f.checked !== f.defaultChecked
        : f.tagName === 'SELECT' ? [...f.options].some((o) => o.selected !== o.defaultSelected) : f.value !== f.defaultValue))
      .map((f) => ({ selector, name: f.name, value: f.value, checked: f.checked, choice: isChoice(f) })));
  }
  function restore(typed) {
    for (const t of typed) {
      for (const f of el.querySelectorAll(`${t.selector} [name="${CSS.escape(t.name)}"]`)) {
        if (!t.choice) f.value = t.value;
        else if (f.value === t.value) f.checked = t.checked;
      }
    }
  }

  async function apply(promise, message) {
    const redraw = () => {
      const typed = unsaved();
      render();
      restore(typed);
    };
    try {
      const res = await promise;
      // Nothing changed (a dialog was closed): draw the page as it was, e.g. the status buttons no longer busy.
      if (!res) {
        redraw();
        return;
      }
      data = res;
      redraw();
      if (message) toast(message);
    } catch (err) {
      toastError(err);
      redraw();
    }
  }
  const put = (path, body) => bookingApi(`/bookings/${data.booking.id}${path}`, { method: 'PUT', body });

  function cancelBooking() {
    const b = data.booking;
    openModal({
      title: `Cancel ${b.number}?`,
      size: 'sm',
      form: true,
      body: html`<p>${eventTitle(b)} on ${formatDate(b.event_date)} will be marked Cancelled. You can restore it later.</p>
        <div class="field"><label>Reason <span class="muted">(optional)</span></label><input class="input" name="reason" maxlength="200" placeholder="e.g. Client postponed"></div>`,
      footer: html`<button type="button" class="btn" data-close>Keep booking</button><button type="submit" class="btn btn-danger-solid">Cancel booking</button>`,
      onSubmit: async (form, m, submitter) => {
        await busy(submitter, async () => {
          try {
            data = await put('/status', { status: 'cancelled', reason: formData(form).reason });
            m.close();
            render();
            toast(`${b.number} cancelled.`);
          } catch (err) {
            showFormError(form, err);
          }
        });
      },
    });
  }

  on(el, 'click', '[data-action]', async (e, btn) => {
    btn.closest('details.menu')?.removeAttribute('open');
    const b = data.booking;
    switch (btn.dataset.action) {
      case 'pay': return apply(openBookingPayment(b, currency));
      case 'team': return apply(openTeamForm(data));
      case 'add-link': return apply(openLinkForm(b));
      case 'shot': return apply(markShootDone(b));
      case 'hold': return apply(put('/status', { status: 'on_hold' }), `${b.number} is on hold.`);
      case 'resume': return apply(put('/status', { status: b.prev_status || 'new' }), `${b.number} is back at ${BOOKING_STATUSES[b.prev_status || 'new']}.`);
      // Back from cancelled, the team counts again, so a clash with another shoot asks first.
      case 'restore': return apply(saveWithConflicts((allow) => put('/status', { status: b.prev_status || 'new', allow_conflicts: allow })),
        `${b.number} restored.`);
      case 'cancel': return cancelBooking();
      case 'delete':
        try {
          if (await deleteBookingFlow(b, currency)) navigate('/bookings', { replace: true });
        } catch (err) {
          toastError(err);
        }
        return undefined;
      default: return undefined;
    }
  });

  on(el, 'click', '[data-status]', (e, btn) => {
    const b = data.booking;
    if (btn.dataset.status === b.status) return;
    btn.closest('.stages').classList.add('is-busy');
    apply(saveWithConflicts((allow) => put('/status', { status: btn.dataset.status, allow_conflicts: allow })),
      `${b.number} → ${BOOKING_STATUSES[btn.dataset.status]}`);
  });
  on(el, 'change', '[data-checklist]', (e, box) => apply(put('/checklist', { key: box.dataset.checklist, done: box.checked })));
  on(el, 'change', '[data-task]', (e, box) => apply(put('/tasks', { key: box.dataset.task, done: box.checked })));
  onDateCommit(el, '[data-deadlines-form] input', (input) => {
    apply(put('/deadlines', { deadlines: formData(input.form) }), 'Deadlines saved.');
  });
  on(el, 'submit', '[data-delivery-form]', async (e, form) => {
    e.preventDefault();
    const d = formData(form);
    const delivery = {
      photos: d.photos, video: d.video, album: d.album, reels: d.reels, date: d.delivery_date, method: d.delivery_method,
      drive: d.delivery_drive, dropbox: d.delivery_dropbox, other: d.delivery_other, storage: d.delivery_storage, notes: d.delivery_notes,
    };
    await busy(e.submitter, async () => {
      try {
        data = await put('/delivery', { delivery });
        render();
        toast('Delivery saved.');
      } catch (err) {
        showFormError(form, err);
      }
    });
  });
  on(el, 'submit', '[data-notes-form]', async (e, form) => {
    e.preventDefault();
    await busy(e.submitter, async () => {
      try {
        data = await put('/notes', formData(form));
        render();
        toast('Notes saved.');
      } catch (err) {
        showFormError(form, err);
      }
    });
  });
  on(el, 'click', '[data-remove-link]', async (e, btn) => {
    const id = btn.closest('[data-link]').dataset.link;
    const link = data.booking.links.find((l) => l.id === id);
    if (!(await confirmDialog({ title: 'Remove this link?', message: link.label || LINK_TYPES[link.type], confirmText: 'Remove', danger: true }))) return;
    apply(bookingApi(`/bookings/${data.booking.id}/links/${id}`, { method: 'DELETE' }), 'Link removed.');
  });
  on(el, 'click', '[data-delete-payment]', async (e, btn) => {
    const p = data.payments.find((x) => String(x.id) === btn.dataset.deletePayment);
    const ok = await confirmDialog({
      title: 'Delete this payment?', message: `${money(p.amount)} on ${formatDate(p.paid_on)}. It also leaves the day book.`, confirmText: 'Delete', danger: true,
    });
    if (!ok) return;
    apply(bookingApi(`/bookings/${data.booking.id}/payments/${p.id}`, { method: 'DELETE' }), 'Payment deleted.');
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
