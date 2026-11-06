// Pieces the Bookings & Shoots pages share: status badges, who is on a shoot, the status buttons, the payment and
// link dialogs, the team list, and the warning when someone on the team is already booked at that time.
import { api } from '../lib/api.js';
import { html, setHtml, formData } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openModal, confirmDialog, toast, toastError, busy, showFormError, clearErrors, showFieldError, demoBadge, loading } from '../lib/ui.js';
import { moneyInput } from './product-form.js';
import { formatDate, formatMoney, toMinor, fromMinor, isoDate } from '/shared/format.js';
import {
  BOOKING_FLOW, BOOKING_STATUSES, SHOOT_STATES, DELIVERY_STATES, BOOKING_PAYMENT_LABELS, BOOKING_PAY_METHODS, TEAM_ROLES, LINK_TYPES,
  progressSteps, flowStep, timeRange, eventTitle, scheduleOf,
} from '/shared/bookings.js';

/** Booking calls carry the viewer's date, so "today" and "tomorrow" follow their calendar. */
export const bookingApi = (path, { query, ...rest } = {}) => api(path, { ...rest, query: { ...query, today: isoDate() } });

export const statusBadge = (status) => html`<span class="badge bk-st bk-st-${status}">${BOOKING_STATUSES[status] || status}</span>`;
export const shootBadge = (state) => html`<span class="badge bk-sh bk-sh-${state}">${SHOOT_STATES[state] || state}</span>`;
export const deliveryBadge = (state) => (state === 'none'
  ? html`<span class="muted">—</span>`
  : html`<span class="badge bk-dl bk-dl-${state}">${DELIVERY_STATES[state] || state}</span>`);
export const paymentBadge = (b) => html`<span class="badge badge-${b.payment_status}">${BOOKING_PAYMENT_LABELS[b.payment_status]}</span>`;

/** "04 Nov 2026 · 6:00 pm – 10:00 pm", or "11 Nov 2026 – 12 Nov 2026 · 2 dates" */
export function whenText(b) {
  const days = scheduleOf(b);
  if (days.length <= 1) return [formatDate(b.event_date), timeRange(days[0])].filter(Boolean).join(' · ');
  return `${formatDate(days[0].date)} – ${formatDate(days[days.length - 1].date)} · ${days.length} dates`;
}

/** "12 Nov 2026 · 4:00 pm – 11:30 pm · Hotel Clarks Amer" for one date of a booking. */
export const dayText = (d) => [formatDate(d.date), timeRange(d), d.venue].filter(Boolean).join(' · ');

export function teamLine(team, { empty = 'No team yet' } = {}) {
  if (!team?.length) return html`<span class="muted">${empty}</span>`;
  return html`<span class="bk-team">${team.map((t) => html`<span class="bk-person">${t.name}${t.role ? html`<span class="muted"> · ${t.role}</span>` : ''}</span>`)}</span>`;
}

/** Booking → Shoot → Backup → Editing → Review → Delivery, read from where the booking is. */
export function progressBar(b) {
  return html`<ol class="bk-progress" aria-label="Progress">${progressSteps(b).map((s) => html`
    <li class="${s.done ? 'is-done' : ''} ${s.current ? 'is-current' : ''}"><span class="bk-dot">${s.done ? icon('check', 'sm') : ''}</span><span>${s.label}</span></li>`)}</ol>`;
}

/** The status buttons, New → Closed: tap one to move the booking there (like the stage buttons in Tracking). */
export function statusChain(b) {
  const parked = b.status === 'on_hold' || b.status === 'cancelled';
  const at = flowStep(b);
  return html`<div class="stages bk-chain ${b.status === 'closed' ? 'is-complete' : ''} ${parked ? 'is-parked' : ''}" role="group" aria-label="Booking status">
    ${BOOKING_FLOW.map((s, i) => html`<button type="button" class="st ${i < at || (parked && i === at) ? 'st-done' : ''} ${!parked && i === at ? 'st-current' : ''}"
      data-status="${s.key}" title="${s.label}">${i < at ? icon('check', 'sm') : ''}${s.short}</button>`)}</div>`;
}

const dueIn = (days) => (days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`);
const daysLate = (days) => `${-days} day${days === -1 ? '' : 's'} overdue`;

/** One reminder from the overview: what needs doing, for which booking, and when. */
export function reminderItem(r, money) {
  const b = r.booking;
  const v = {
    overdue: ['bad', 'alert', r.label, `Due ${formatDate(r.date)} · ${daysLate(r.days ?? 0)}`],
    editing_due: ['warn', 'clock', `${r.label} deadline`, `Due ${dueIn(r.days)} · ${formatDate(r.date)}`],
    delivery_due: ['warn', 'clock', `${r.label} deadline`, `Due ${dueIn(r.days)} · ${formatDate(r.date)}`],
    tomorrow: ['info', 'camera', 'Shoot tomorrow', [timeRange(r.day), r.day?.venue].filter(Boolean).join(' · ')],
    past: ['warn', 'camera', 'Shoot date has passed', 'Mark the shoot complete, or change the date'],
    review: ['info', 'eye', 'Client review pending', 'Waiting for the client’s feedback'],
    payment: ['warn', 'wallet', 'Payment pending', `${money(r.amount)} due`],
  }[r.type];
  if (!v) return '';
  const [tone, ic, what, when] = v;
  return html`<a class="bk-rem bk-rem-${tone}" href="/bookings/${b.id}">
    <span class="bk-rem-icon">${icon(ic, 'sm')}</span>
    <span class="bk-rem-body"><span class="bk-rem-title">${eventTitle(b)}</span>
      <span class="bk-rem-what">${what}</span><span class="bk-rem-when">${[b.number, when].filter(Boolean).join(' · ')}</span></span></a>`;
}

// ---- Team clashes ----------------------------------------------------------------
/**
 * Run save(allowConflicts). If someone on the team is already booked at that time, show who and where, and save
 * again only if the owner says so. Resolves with save's result, or null when they go back.
 */
export async function saveWithConflicts(save) {
  try {
    return await save(false);
  } catch (err) {
    if (err.code !== 'TEAM_CONFLICT' || !Array.isArray(err.details)) throw err;
    const ok = await confirmDialog({
      title: 'Team already booked',
      body: html`<p>Someone on this team is booked on another shoot at the same time:</p>
        <ul class="bk-clashes">${err.details.map((c) => html`<li><strong>${c.member_name}</strong> · ${c.number} ${c.title}
          <div class="muted small">${[formatDate(c.event_date), c.time, c.venue].filter(Boolean).join(' · ')}</div></li>`)}</ul>
        <p class="muted small">Change the team or the time, or save anyway if they can do both.</p>`,
      confirmText: 'Save anyway',
      cancelText: 'Go back',
    });
    return ok ? save(true) : null;
  }
}

export function clashNote(conflicts) {
  if (!conflicts?.length) return '';
  return html`<div class="alert alert-warn bk-clash">${icon('alert')}<div class="alert-body"><strong>Team clash.</strong>
    ${conflicts.map((c) => html`<div>${c.member_name} is also on <a href="/bookings/${c.booking_id}">${c.number}</a> (${c.title}),
      ${[formatDate(c.event_date), c.time, c.venue].filter(Boolean).join(', ')}.</div>`)}</div></div>`;
}

// ---- Team ----------------------------------------------------------------------------
const roleOptions = (id) => html`<datalist id="${id}">${TEAM_ROLES.map((r) => html`<option value="${r}"></option>`)}</datalist>`;

/** Add or edit someone on the team. Resolves with the saved person, or null. */
export function openMemberForm(member = null) {
  return new Promise((resolve) => {
    let saved = null;
    openModal({
      title: member ? `Edit ${member.name}` : 'Add team member',
      size: 'sm',
      form: true,
      body: html`<div class="form-grid">
        <div class="field span-all"><label>Name <span class="req">*</span></label>
          <input class="input" name="name" value="${member?.name || ''}" maxlength="80" required autofocus></div>
        <div class="field"><label>Usual role</label>
          <input class="input" name="role" list="bk-member-roles" value="${member?.role || ''}" maxlength="40" placeholder="Photographer">${roleOptions('bk-member-roles')}</div>
        <div class="field"><label>Phone</label><input class="input" type="tel" name="phone" value="${member?.phone || ''}" maxlength="20"></div>
      </div>`,
      footer: html`<button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">${member ? 'Save' : 'Add to team'}</button>`,
      onClose: () => resolve(saved),
      onSubmit: async (form, m, submitter) => {
        await busy(submitter, async () => {
          try {
            const res = await api(member ? `/team/${member.id}` : '/team', { method: member ? 'PUT' : 'POST', body: formData(form) });
            saved = res.member;
            toast(member ? `${saved.name} saved.` : `${saved.name} added to the team.`);
            m.close();
          } catch (err) {
            showFormError(form, err);
          }
        });
      },
    });
  });
}

/** The studio's team list: add, edit, remove. Resolves true if anything changed. */
export function openTeamManager() {
  return new Promise((resolve) => {
    let changed = false;
    let members = [];
    const modal = openModal({
      title: 'Team',
      body: html`<p class="muted small" style="margin-top:0">The people you put on shoots. Choose them on each booking.</p>
        <div data-members>${loading()}</div>`,
      footer: html`<button type="button" class="btn" data-close>Done</button>
        <button type="button" class="btn btn-primary" data-add-member>${icon('userPlus')}Add person</button>`,
      onClose: () => resolve(changed),
    });
    const box = modal.el.querySelector('[data-members]');
    async function load() {
      members = (await api('/team')).members;
      setHtml(box, members.length
        ? html`<div class="list bk-members">${members.map((m) => html`
          <div class="list-item" data-member-id="${m.id}">
            <div class="li-main"><div class="li-title">${m.name} ${demoBadge(m.is_demo)}</div>
              <div class="li-sub">${[m.role, m.phone, m.upcoming ? `${m.upcoming} upcoming shoot${m.upcoming === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || 'No role yet'}</div></div>
            <div class="entry-actions">
              <button type="button" class="btn btn-ghost btn-icon btn-sm" data-edit-member title="Edit" aria-label="Edit ${m.name}">${icon('edit', 'sm')}</button>
              <button type="button" class="btn btn-ghost btn-icon btn-sm" data-remove-member title="Remove" aria-label="Remove ${m.name}">${icon('trash', 'sm')}</button>
            </div>
          </div>`)}</div>`
        : html`<div class="empty">${icon('users')}<h3>No team yet</h3><p>Add the photographers, videographers and editors you work with.</p></div>`);
    }
    modal.el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-add-member]')) {
        if (await openMemberForm()) {
          changed = true;
          await load();
        }
        return;
      }
      const row = e.target.closest('[data-member-id]');
      const m = row && members.find((x) => String(x.id) === row.dataset.memberId);
      if (!m) return;
      if (e.target.closest('[data-edit-member]') && await openMemberForm(m)) {
        changed = true;
        await load();
      }
      if (e.target.closest('[data-remove-member]')) {
        const ok = await confirmDialog({
          title: `Remove ${m.name}?`, message: 'They leave the team list. Bookings they worked on keep their name.', confirmText: 'Remove', danger: true,
        });
        if (!ok) return;
        try {
          await api(`/team/${m.id}`, { method: 'DELETE' });
          changed = true;
          toast(`${m.name} removed from the team.`);
          await load();
        } catch (err) {
          toastError(err);
        }
      }
    });
    load().catch(toastError);
  });
}

/**
 * The "person · role" rows for a booking's team, inside `container`. members = the studio's team.
 * Returns { get } giving [{ member_id, role }] for the people chosen.
 */
export function teamEditor(container, { members, team = [], onChange }) {
  const list = [...members];
  // People already on this booking stay on the list even if they've since left the team.
  for (const t of team) if (!list.some((m) => m.id === t.member_id)) list.push({ id: t.member_id, name: t.name, role: t.role });
  const rows = team.map((t) => ({ member_id: t.member_id, role: t.role || '' }));
  const changed = () => onChange?.();

  function render() {
    setHtml(container, html`
      ${rows.length ? html`<div class="bk-team-rows">${rows.map((r, i) => html`
        <div class="bk-team-row" data-row="${i}">
          <select class="input" data-member aria-label="Team member">
            <option value="">Choose a person…</option>
            ${list.map((m) => html`<option value="${m.id}" ${m.id === r.member_id ? 'selected' : ''}>${m.name}</option>`)}
            <option value="new">+ Add a new person…</option>
          </select>
          <input class="input" data-role list="bk-team-roles" value="${r.role}" placeholder="Role" aria-label="Role" maxlength="40">
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-remove-row title="Remove" aria-label="Remove from the team">${icon('x', 'sm')}</button>
        </div>`)}</div>` : html`<p class="muted small bk-team-empty">No one on this shoot yet.</p>`}
      ${roleOptions('bk-team-roles')}
      <button type="button" class="btn btn-sm" data-add-row>${icon('userPlus', 'sm')}Add team member</button>`);
  }

  container.addEventListener('change', async (e) => {
    const select = e.target.closest('[data-member]');
    if (!select) return;
    const i = Number(select.closest('[data-row]').dataset.row);
    let m = list.find((x) => String(x.id) === select.value);
    if (select.value === 'new') {
      m = await openMemberForm();
      // Closing the form without adding anyone leaves the row with the person it had.
      if (!m) {
        render();
        return;
      }
      list.push(m);
    }
    const before = list.find((x) => x.id === rows[i].member_id);
    // The role follows the person unless it was typed in by hand.
    if (m && (!rows[i].role || rows[i].role === before?.role)) rows[i].role = m.role || '';
    rows[i].member_id = m ? m.id : null;
    render();
    changed();
  });
  container.addEventListener('input', (e) => {
    const input = e.target.closest('[data-role]');
    if (!input) return;
    rows[Number(input.closest('[data-row]').dataset.row)].role = input.value;
    changed();
  });
  container.addEventListener('click', (e) => {
    if (e.target.closest('[data-add-row]')) {
      rows.push({ member_id: null, role: '' });
      render();
      container.querySelector('.bk-team-row:last-child [data-member]')?.focus();
      changed();
    }
    const rm = e.target.closest('[data-remove-row]');
    if (rm) {
      rows.splice(Number(rm.closest('[data-row]').dataset.row), 1);
      render();
      changed();
    }
  });
  render();
  return { get: () => rows.filter((r) => r.member_id).map((r) => ({ member_id: r.member_id, role: r.role.trim() })) };
}

/** Change who is on a booking's shoot (from the booking page). Resolves with the booking's page data, or null. */
export async function openTeamForm(detail) {
  const { booking: b } = detail;
  const { members } = await api('/team');
  return new Promise((resolve) => {
    let result = null;
    let editor;
    const modal = openModal({
      title: `Team — ${b.number}`,
      form: true,
      body: html`<p class="muted small" style="margin-top:0">${eventTitle(b)} · ${whenText(b)}</p><div data-team-editor></div>`,
      footer: html`<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary">Save team</button>`,
      onClose: () => resolve(result),
      onSubmit: async (form, m, submitter) => {
        await busy(submitter, async () => {
          try {
            const team = editor.get();
            const res = await saveWithConflicts((allow) => bookingApi(`/bookings/${b.id}/team`, { method: 'PUT', body: { team, allow_conflicts: allow } }));
            if (!res) return;
            result = res;
            toast('Team saved.');
            m.close();
          } catch (err) {
            toastError(err);
          }
        });
      },
    });
    editor = teamEditor(modal.el.querySelector('[data-team-editor]'), { members, team: b.team });
  });
}

// ---- Payments & links ------------------------------------------------------------------
export function payMethodButtons(selected) {
  return html`<div class="method-options bk-methods" role="radiogroup" aria-label="Payment method">${Object.entries(BOOKING_PAY_METHODS).map(([value, label]) =>
    html`<button type="button" class="pay-option ${value === selected ? 'active' : ''}" data-pay-method="${value}">${label}</button>`)}</div>`;
}

/** Make the method buttons in `root` set the hidden input `input`. */
export function bindPayMethods(root, input) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pay-method]');
    if (!b) return;
    input.value = b.dataset.payMethod;
    root.querySelectorAll('[data-pay-method]').forEach((x) => x.classList.toggle('active', x === b));
  });
}

/** Record money received for a booking. Resolves with the booking's page data, or null. */
export function openBookingPayment(b, currency) {
  const money = (v) => formatMoney(v, currency);
  const balance = b.total - b.amount_paid;
  return new Promise((resolve) => {
    let result = null;
    const modal = openModal({
      title: `Add payment — ${b.number}`,
      form: true,
      body: html`
        <div class="big-total"><div class="bt-label">Balance</div><div class="bt-value">${money(balance)}</div>
          <div class="muted small">Package ${money(b.total)} · received ${money(b.amount_paid)}</div></div>
        <div class="form-grid">
          <div class="field"><label>Amount received <span class="req">*</span></label>${moneyInput('amount', fromMinor(balance), currency, 'required autofocus')}</div>
          <div class="field"><label>Date</label><input class="input" type="date" name="paid_on" value="${isoDate()}" required></div>
          <div class="field span-all"><span class="label">Paid by</span>${payMethodButtons('cash')}<input type="hidden" name="method" value="cash"></div>
          <div class="field span-all"><label>Note <span class="muted">(optional)</span></label>
            <input class="input" name="note" maxlength="120" placeholder="e.g. Second instalment, UPI ref 4521"></div>
        </div>`,
      footer: html`<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary">Save payment</button>`,
      onClose: () => resolve(result),
      onSubmit: async (form, m, submitter) => {
        clearErrors(form);
        const d = formData(form);
        const amount = toMinor(d.amount);
        if (Number.isNaN(amount) || amount <= 0) return showFieldError(form, 'amount', 'Enter the amount received.');
        if (amount > balance) return showFieldError(form, 'amount', `Amount can't be more than the balance (${money(balance)}).`);
        await busy(submitter, async () => {
          try {
            result = await bookingApi(`/bookings/${b.id}/payments`, { method: 'POST', body: { ...d, amount } });
            toast(`Payment of ${money(amount)} saved.`);
            m.close();
          } catch (err) {
            showFormError(form, err);
          }
        });
        return undefined;
      },
    });
    bindPayMethods(modal.form, modal.form.elements.namedItem('method'));
  });
}

/** Save a link (Google Drive, Dropbox, client gallery…) on a booking. Resolves with the booking's page data, or null. */
export function openLinkForm(b, { type = 'drive' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    openModal({
      title: `Add a link — ${b.number}`,
      form: true,
      body: html`<p class="muted small" style="margin-top:0">Keep big files on Google Drive, Dropbox or WeTransfer and save the link here.</p>
        <div class="form-grid">
          <div class="field"><label>What it is</label><select class="input" name="type">${Object.entries(LINK_TYPES).map(([k, label]) => html`
            <option value="${k}" ${k === type ? 'selected' : ''}>${label}</option>`)}</select></div>
          <div class="field"><label>Name <span class="muted">(optional)</span></label><input class="input" name="label" maxlength="80" placeholder="e.g. Haldi and mehendi"></div>
          <div class="field span-all"><label>Link <span class="req">*</span></label>
            <input class="input" type="url" name="url" maxlength="600" placeholder="https://drive.google.com/…" required autofocus></div>
        </div>`,
      footer: html`<button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary">Save link</button>`,
      onClose: () => resolve(result),
      onSubmit: async (form, m, submitter) => {
        clearErrors(form);
        const d = formData(form);
        if (!d.url.trim()) return showFieldError(form, 'url', 'Paste the link.');
        await busy(submitter, async () => {
          try {
            result = await bookingApi(`/bookings/${b.id}/links`, { method: 'POST', body: d });
            toast('Link saved.');
            m.close();
          } catch (err) {
            showFormError(form, err);
          }
        });
        return undefined;
      },
    });
  });
}

/** Mark the shoot complete: the booking moves to Shoot completed and post-production can start. */
export async function markShootDone(b) {
  const res = await bookingApi(`/bookings/${b.id}/status`, { method: 'PUT', body: { status: 'shot' } });
  toast(`${b.number}: shoot completed. Post-production can start.`);
  return res;
}

/** Delete a booking after saying what goes with it. Resolves true when deleted. */
export async function deleteBookingFlow(b, currency) {
  const ok = await confirmDialog({
    title: `Delete ${b.number}?`,
    message: `${eventTitle(b)} for ${b.client_name} will be deleted with its history${b.amount_paid ? `, and the ${formatMoney(b.amount_paid, currency)} received will leave the day book` : ''}. This can't be undone.`,
    confirmText: 'Delete booking',
    danger: true,
  });
  if (!ok) return false;
  await bookingApi(`/bookings/${b.id}`, { method: 'DELETE' });
  toast(`${b.number} deleted.`);
  return true;
}
