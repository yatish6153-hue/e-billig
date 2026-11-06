// New or edit booking: the client, the event's dates (each with its own times and venue), the services with a price
// each (a bill: subtotal, discount, total), the advance, and the team.
// /bookings/new?from=ID starts a copy of a booking; /bookings/new?date=YYYY-MM-DD starts on that day.
import { api } from '../lib/api.js';
import { html, setHtml, on, debounce, formData } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast, toastError, busy, showFormError, clearErrors, showFieldError, demoBadge } from '../lib/ui.js';
import { navigate, setLeaveGuard, clearLeaveGuard } from '../lib/router.js';
import { moneyInput } from '../components/product-form.js';
import { formatMoney, formatQty, toMinor, fromMinor, isoDate, addDays } from '/shared/format.js';
import {
  EVENT_TYPES, SERVICE_PRESETS, FLOW_KEYS, BOOKING_STATUSES, BOOKING_PAYMENT_LABELS, bookingPaymentStatus, lineAmount, scheduleOf,
} from '/shared/bookings.js';
import { bookingApi, teamEditor, saveWithConflicts, payMethodButtons, bindPayMethods } from '../components/booking-ui.js';

const blank = (date) => ({
  client_name: '', client_whatsapp: '', client_alt: '', client_address: '', event_type: '', event_name: '', event_notes: '',
  schedule: [{ date: date || isoDate(), start: '', end: '', venue: '' }], services: [], discount: 0, package_name: '',
  total: 0, amount_paid: 0, team: [],
});
const qtyOf = (s) => {
  const n = Number(String(s).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : NaN;
};

export default async function bookingEditor(el, { app, params, query }) {
  const currency = app.business.currency;
  const money = (v) => formatMoney(v, currency);
  const editing = !!params.id;
  let source = null;
  let b;
  if (editing) {
    b = (await bookingApi(`/bookings/${params.id}`)).booking;
  } else if (query.from) {
    source = (await bookingApi(`/bookings/${query.from}`)).booking;
    b = { ...source, amount_paid: 0 };
  } else {
    b = blank(/^\d{4}-\d{2}-\d{2}$/.test(String(query.date || '')) ? query.date : '');
  }
  const [{ members }, { products }] = await Promise.all([
    api('/team'),
    api('/products', { query: { kind: 'service', limit: 200 } }),
  ]);
  // The studio's own services (Inventory → services), offered with their prices.
  const catalog = products.filter((p) => p.kind === 'service' && !p.archived);
  const findService = (name) => catalog.find((p) => p.name.trim().toLowerCase() === String(name).trim().toLowerCase());

  const title = editing ? `Edit ${b.number}` : 'New booking';
  app.setTitle(title);
  const preset = EVENT_TYPES.includes(b.event_type) ? b.event_type : b.event_type ? 'Other' : '';
  const days = scheduleOf(b).map((d) => ({ date: d.date, start: d.start || '', end: d.end || '', venue: d.venue || '' }));
  if (!days.length) days.push({ date: isoDate(), start: '', end: '', venue: '' });
  const lines = (b.services || []).map((s) => ({ name: s.name, qty: s.qty, rate: s.rate, product_id: s.product_id || null }));
  // Left while loading: the page on screen now is another view's, so this one does nothing.
  if (!el.isConnected) return undefined;
  let dirty = false;
  const touch = () => {
    dirty = true;
  };
  const guard = (opts) => !dirty || (!opts?.silent && window.confirm('You have unsaved changes on this booking. Leave without saving?'));
  setLeaveGuard(guard);

  const back = editing ? `/bookings/${b.id}` : '/bookings';
  setHtml(el, html`
    <a class="back-link" href="${back}">${icon('arrowLeft', 'sm')}${editing ? b.number : 'Bookings & Shoots'}</a>
    <div class="page-header">
      <div><div class="row" style="gap:10px"><h1>${title}</h1>${editing ? demoBadge(b.is_demo) : ''}</div>
        <div class="subtitle">${source ? `A copy of ${source.number}: change the dates and anything else, then save.` : editing ? b.client_name : 'Client, event dates, services and team.'}</div></div>
    </div>
    <form class="bk-form" novalidate>
      <div class="stack">
        <section class="card"><div class="card-header"><h2>Client details</h2><span class="hint" data-customer-hint></span></div>
          <div class="card-body form-grid">
            <div class="field span-all"><label for="client_name">Client name <span class="req">*</span></label>
              <input class="input" id="client_name" name="client_name" value="${b.client_name}" maxlength="120" required autofocus></div>
            <div class="field"><label for="client_whatsapp">WhatsApp number</label>
              <input class="input" id="client_whatsapp" type="tel" name="client_whatsapp" value="${b.client_whatsapp}" maxlength="20" inputmode="tel"></div>
            <div class="field"><label for="client_alt">Alternative contact</label>
              <input class="input" id="client_alt" name="client_alt" value="${b.client_alt}" maxlength="120" placeholder="e.g. Brother – 98290 12345"></div>
            <div class="field span-all"><label for="client_address">Full location / address</label>
              <textarea class="input" id="client_address" name="client_address" maxlength="500" rows="2">${b.client_address || ''}</textarea></div>
          </div></section>

        <section class="card"><div class="card-header"><h2>Event details</h2></div>
          <div class="card-body">
            <div class="form-grid">
              <div class="field"><label for="event_type_pick">Event type</label>
                <select class="input" id="event_type_pick" data-type-pick><option value="">Choose…</option>${EVENT_TYPES.map((t) => html`
                  <option ${t === preset ? 'selected' : ''}>${t}</option>`)}</select></div>
              <div class="field" data-custom-type ${preset === 'Other' ? '' : 'hidden'}><label for="event_type_custom">Type of event</label>
                <input class="input" id="event_type_custom" data-type-custom value="${preset === 'Other' && b.event_type !== 'Other' ? b.event_type : ''}"
                  maxlength="40" placeholder="e.g. Mundan, Baby shower, Concert"></div>
              <div class="field span-all"><label for="event_name">Event name</label>
                <input class="input" id="event_name" name="event_name" value="${b.event_name}" maxlength="120" placeholder="e.g. Rahul & Priya"></div>
            </div>
            <div class="bk-days-head"><span class="label">Event dates</span><span class="field-hint">Each date has its own time and venue.</span></div>
            <div data-days></div>
            <button type="button" class="btn btn-sm" data-add-day>${icon('plus', 'sm')}Add date</button>
            <div class="field" style="margin-top:14px"><label for="event_notes">Notes</label>
              <textarea class="input" id="event_notes" name="event_notes" maxlength="2000" rows="3" placeholder="Rituals to cover, family contacts, special requests…">${b.event_notes}</textarea></div>
          </div></section>

        <section class="card"><div class="card-header"><h2>Services &amp; prices</h2><span class="hint">Each service with its own price, like a bill</span></div>
          <div class="card-body">
            <div class="bk-lines-box" data-lines></div>
            <div class="row bk-lines-actions">
              <button type="button" class="btn btn-sm" data-add-line>${icon('plus', 'sm')}Add service</button>
              <span class="field-hint">Your services from Inventory come up with their price. Type any other service and save it for next time.</span>
            </div>
            <div class="totals bk-bill">
              <div class="t-row"><span>Subtotal</span><span data-subtotal></span></div>
              <div class="t-row bk-disc"><label for="discount">Discount</label>${moneyInput('discount', b.discount ? fromMinor(b.discount) : '', currency, 'id="discount" placeholder="0"')}</div>
              <div class="t-row t-total"><span>Total</span><span data-total></span></div>
            </div>
          </div></section>
      </div>

      <div class="stack bk-form-side">
        <section class="card"><div class="card-header"><h2>Package &amp; payment</h2></div>
          <div class="card-body form-grid">
            <div class="field span-all"><label for="package_name">Package name</label>
              <input class="input" id="package_name" name="package_name" value="${b.package_name}" maxlength="120" placeholder="e.g. Gold wedding package"></div>
            <div class="span-all bk-remaining"><span>Total (from services)</span><strong data-side-total></strong></div>
            ${editing ? html`<div class="span-all bk-paystatus"><span>Received so far</span><span class="strong">${money(b.amount_paid)}</span></div>` : html`
              <div class="field span-all"><label for="advance_amount">Advance received</label>${moneyInput('advance_amount', '', currency, 'id="advance_amount"')}</div>
              <div class="field span-all" data-advance-more hidden>
                <span class="label">Paid by</span>${payMethodButtons('cash')}<input type="hidden" name="advance_method" value="cash">
                <div class="form-grid" style="margin-top:10px">
                  <div class="field"><label for="advance_date">Date</label><input class="input" id="advance_date" type="date" name="advance_date" value="${isoDate()}"></div>
                  <div class="field"><label for="advance_note">Note</label><input class="input" id="advance_note" name="advance_note" maxlength="120" placeholder="Optional"></div>
                </div></div>`}
            <div class="span-all bk-paystatus"><span>Remaining amount</span><strong data-remaining></strong></div>
            <div class="span-all bk-paystatus"><span>Payment status</span><span data-pay-status></span></div>
            ${editing ? html`<p class="field-hint span-all" style="margin:0">Add payments on the booking page.</p>` : ''}
          </div></section>

        <section class="card"><div class="card-header"><h2>Team</h2><span class="hint">Who is on this shoot</span></div>
          <div class="card-body" data-team></div></section>

        ${editing ? '' : html`<section class="card"><div class="card-body">
          <div class="field"><label for="status">Status</label>
            <select class="input" id="status" name="status">${FLOW_KEYS.map((k) => html`<option value="${k}" ${k === 'new' ? 'selected' : ''}>${BOOKING_STATUSES[k]}</option>`)}</select>
            <span class="field-hint">New booking until the client confirms.</span></div></div></section>`}

        <div class="bk-form-actions">
          <a class="btn" href="${back}">Cancel</a>
          <button type="submit" class="btn btn-primary">${icon('check')}${editing ? 'Save changes' : 'Save booking'}</button>
        </div>
      </div>
    </form>`);

  const form = el.querySelector('form');
  const field = (name) => form.elements.namedItem(name);
  const daysBox = el.querySelector('[data-days]');
  const linesBox = el.querySelector('[data-lines]');
  const team = teamEditor(el.querySelector('[data-team]'), { members, team: b.team, onChange: touch });

  // ---- Dates -----------------------------------------------------------------------
  function renderDays() {
    setHtml(daysBox, html`${days.map((d, i) => html`
      <div class="bk-day-row" data-day="${i}">
        <div class="bk-day-top"><span class="bk-dr-no">${days.length > 1 ? `Date ${i + 1}` : 'Date'}</span>
          ${days.length > 1 ? html`<button type="button" class="btn btn-ghost btn-icon btn-sm" data-remove-day title="Remove this date" aria-label="Remove date ${i + 1}">${icon('x', 'sm')}</button>` : ''}</div>
        <div class="bk-day-fields">
          <div class="field bd-date"><label for="sd${i}">Event date <span class="req">*</span></label>
            <input class="input" type="date" id="sd${i}" name="schedule.${i}.date" data-k="date" value="${d.date}" required></div>
          <div class="field bd-time"><label for="ss${i}">Start time</label><input class="input" type="time" id="ss${i}" name="schedule.${i}.start" data-k="start" value="${d.start}"></div>
          <div class="field bd-time"><label for="se${i}">End time</label><input class="input" type="time" id="se${i}" name="schedule.${i}.end" data-k="end" value="${d.end}"></div>
          <div class="field bd-venue"><label for="sv${i}">Venue</label>
            <input class="input" id="sv${i}" name="schedule.${i}.venue" data-k="venue" value="${d.venue}" maxlength="120" placeholder="e.g. Hotel Clarks Amer"></div>
        </div>
      </div>`)}`);
  }
  daysBox.addEventListener('input', (e) => {
    const row = e.target.closest('[data-day]');
    if (!row || !e.target.dataset.k) return;
    days[Number(row.dataset.day)][e.target.dataset.k] = e.target.value;
  });
  on(el, 'click', '[data-add-day]', () => {
    const last = days[days.length - 1];
    days.push({ date: last?.date ? addDays(last.date, 1) : isoDate(), start: '', end: '', venue: '' });
    renderDays();
    touch();
    daysBox.querySelector('.bk-day-row:last-child [data-k=start]')?.focus();
  });
  on(el, 'click', '[data-remove-day]', (e, btn) => {
    days.splice(Number(btn.closest('[data-day]').dataset.day), 1);
    renderDays();
    touch();
  });

  // ---- Services --------------------------------------------------------------------
  // A priced service that isn't in Inventory yet can be saved there, to come up with its price next time.
  const canSave = (l) => !!l.name.trim() && l.rate > 0 && !findService(l.name);

  function serviceOptions() {
    const own = catalog.map((p) => html`<option value="${p.name}">${money(p.selling_price)}${p.unit ? ` / ${p.unit}` : ''}</option>`);
    const more = SERVICE_PRESETS.filter((n) => !findService(n)).map((n) => html`<option value="${n}"></option>`);
    return html`${own}${more}`;
  }

  function renderLines() {
    setHtml(linesBox, html`
      ${lines.length ? html`<div class="bk-lines">
        <div class="bk-line bk-line-head" aria-hidden="true"><span>Service</span><span>Qty</span><span>Price</span><span class="r">Amount</span><span></span></div>
        ${lines.map((l, i) => html`
        <div class="bk-line" data-line="${i}">
          <div class="bl-name"><input class="input" name="services.${i}.name" data-k="name" value="${l.name}" list="bk-service-list" maxlength="120"
              placeholder="Service, e.g. Candid photography" aria-label="Service">
            <button type="button" class="inline-link small bl-save" data-save-service ${canSave(l) ? '' : 'hidden'}>${icon('plus', 'sm')}Save to my services</button></div>
          <div class="bl-qty"><span class="bl-label">Qty</span><input class="input" name="services.${i}.qty" data-k="qty"
            value="${typeof l.qty === 'number' ? formatQty(l.qty) : l.qty}" inputmode="decimal" aria-label="Quantity"></div>
          <div class="bl-rate"><span class="bl-label">Price</span>${moneyInput(`services.${i}.rate`, l.rate ? fromMinor(l.rate) : '', currency, 'data-k="rate" aria-label="Price" placeholder="0"')}</div>
          <div class="bl-amt" data-amt>${money(lineAmount(qtyOf(l.qty) || 0, l.rate))}</div>
          <button type="button" class="btn btn-ghost btn-icon btn-sm bl-rm" data-remove-line title="Remove" aria-label="Remove service">${icon('x', 'sm')}</button>
        </div>`)}</div>` : html`<p class="muted small bk-lines-empty">No services yet. Add each service with its price.</p>`}
      <datalist id="bk-service-list">${serviceOptions()}</datalist>`);
  }

  function refreshMoney() {
    const subtotal = lines.reduce((a, l) => a + lineAmount(qtyOf(l.qty) || 0, l.rate), 0);
    const disc = toMinor(field('discount').value || '0');
    const total = Math.max(0, subtotal - (Number.isNaN(disc) ? 0 : disc));
    el.querySelector('[data-subtotal]').textContent = money(subtotal);
    el.querySelector('[data-total]').textContent = money(total);
    el.querySelector('[data-side-total]').textContent = money(total);
    const advance = editing ? 0 : toMinor(field('advance_amount').value || '0');
    const paid = b.amount_paid + (Number.isNaN(advance) ? 0 : advance);
    el.querySelector('[data-remaining]').textContent = money(Math.max(0, total - paid));
    const status = bookingPaymentStatus(total, paid);
    setHtml(el.querySelector('[data-pay-status]'), html`<span class="badge badge-${status}">${BOOKING_PAYMENT_LABELS[status]}</span>`);
    if (!editing) el.querySelector('[data-advance-more]').hidden = !(advance > 0);
  }

  linesBox.addEventListener('input', (e) => {
    const row = e.target.closest('[data-line]');
    const k = e.target.dataset.k;
    if (!row || !k) return;
    const l = lines[Number(row.dataset.line)];
    if (k === 'name') {
      l.name = e.target.value;
      const match = findService(l.name);
      l.product_id = match ? match.id : null;
      // Picking one of your services fills in its price, unless you've typed a price yourself.
      const rate = row.querySelector('[data-k=rate]');
      if (match && (!rate.value.trim() || l.autoRate)) {
        rate.value = fromMinor(match.selling_price);
        l.rate = match.selling_price;
        l.autoRate = true;
      }
    } else if (k === 'qty') {
      l.qty = e.target.value;
    } else {
      const r = toMinor(e.target.value || '0');
      l.rate = Number.isNaN(r) ? 0 : r;
      l.autoRate = false;
    }
    row.querySelector('[data-amt]').textContent = money(lineAmount(qtyOf(l.qty) || 0, l.rate));
    row.querySelector('[data-save-service]').hidden = !canSave(l);
    refreshMoney();
  });
  on(el, 'click', '[data-add-line]', () => {
    lines.push({ name: '', qty: 1, rate: 0, product_id: null });
    renderLines();
    refreshMoney();
    touch();
    linesBox.querySelector('.bk-line:last-child [data-k=name]')?.focus();
  });
  on(el, 'click', '[data-remove-line]', (e, btn) => {
    lines.splice(Number(btn.closest('[data-line]').dataset.line), 1);
    renderLines();
    refreshMoney();
    touch();
  });
  on(el, 'click', '[data-save-service]', async (e, btn) => {
    const l = lines[Number(btn.closest('[data-line]').dataset.line)];
    await busy(btn, async () => {
      try {
        const { product } = await api('/products', {
          method: 'POST', body: { kind: 'service', name: l.name.trim(), selling_price: l.rate || 0, unit: 'job' },
        });
        catalog.push(product);
        l.product_id = product.id;
        toast(`${product.name} saved to your services (Inventory), at ${money(product.selling_price)}.`);
      } catch (err) {
        toastError(err);
      }
    });
    renderLines();
  });

  // ---- The rest of the form ---------------------------------------------------------
  renderDays();
  renderLines();
  refreshMoney();
  if (!editing) bindPayMethods(form.querySelector('[data-advance-more]'), field('advance_method'));

  form.addEventListener('input', (e) => {
    touch();
    if (e.target.name === 'discount' || e.target.name === 'advance_amount') refreshMoney();
  });
  form.addEventListener('change', touch);
  el.querySelector('[data-type-pick]').addEventListener('change', (e) => {
    const other = e.target.value === 'Other';
    el.querySelector('[data-custom-type]').hidden = !other;
    if (other) el.querySelector('[data-type-custom]').focus();
  });

  // A saved customer's number fills in their name and address on a new booking.
  const hint = el.querySelector('[data-customer-hint]');
  const lookup = debounce(async (digits) => {
    try {
      const { customers } = await api('/customers', { query: { q: digits, limit: 5 } });
      const match = customers.find((c) => c.phone.replace(/\D/g, '').slice(-10) === digits.slice(-10));
      if (!match) return;
      hint.textContent = `Saved customer: ${match.name}`;
      if (!field('client_name').value.trim()) field('client_name').value = match.name;
      if (!field('client_address').value.trim() && match.address) field('client_address').value = match.address;
    } catch {
      // The lookup is only a help.
    }
  }, 300);
  field('client_whatsapp').addEventListener('input', (e) => {
    const digits = e.target.value.replace(/\D/g, '');
    hint.textContent = '';
    if (digits.length >= 10 && !editing) lookup(digits);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const d = formData(form);
    if (!d.client_name.trim()) return showFieldError(form, 'client_name', 'Enter the client’s name.');
    for (const [i, day] of days.entries()) {
      if (!day.date) return showFieldError(form, `schedule.${i}.date`, 'Choose the date.');
    }
    const services = [];
    for (const [i, l] of lines.entries()) {
      if (!l.name.trim()) {
        if (!l.rate) continue; // an empty line is simply left out
        return showFieldError(form, `services.${i}.name`, 'Name this service, or remove the line.');
      }
      const qty = qtyOf(l.qty);
      if (Number.isNaN(qty) || qty <= 0) return showFieldError(form, `services.${i}.qty`, 'Enter how many, like 1 or 2.');
      const rateText = form.elements.namedItem(`services.${i}.rate`).value;
      if (rateText.trim() && Number.isNaN(toMinor(rateText))) return showFieldError(form, `services.${i}.rate`, 'Enter the price, like 15000.');
      services.push({ name: l.name.trim(), qty, rate: l.rate || 0, product_id: l.product_id || undefined });
    }
    const subtotal = services.reduce((a, s) => a + lineAmount(s.qty, s.rate), 0);
    const discount = d.discount.trim() ? toMinor(d.discount) : 0;
    if (Number.isNaN(discount)) return showFieldError(form, 'discount', 'Enter the discount, like 5000.');
    if (discount > subtotal) return showFieldError(form, 'discount', `The discount can't be more than the services add up to (${money(subtotal)}).`);
    const pick = el.querySelector('[data-type-pick]').value;
    const custom = el.querySelector('[data-type-custom]').value.trim();
    const body = {
      client_name: d.client_name, client_whatsapp: d.client_whatsapp, client_alt: d.client_alt, client_address: d.client_address,
      event_type: pick === 'Other' ? custom || 'Other' : pick, event_name: d.event_name, event_notes: d.event_notes,
      schedule: days.map((x) => ({ date: x.date, start: x.start, end: x.end, venue: x.venue })),
      services, discount, package_name: d.package_name, team: team.get(),
    };
    if (!editing) {
      const advance = d.advance_amount.trim() ? toMinor(d.advance_amount) : 0;
      if (Number.isNaN(advance)) return showFieldError(form, 'advance_amount', 'Enter the advance, like 10000.');
      if (advance > subtotal - discount) return showFieldError(form, 'advance_amount', `The advance can't be more than the total (${money(subtotal - discount)}).`);
      body.status = d.status;
      body.advance = advance ? { amount: advance, method: d.advance_method, paid_on: d.advance_date, note: d.advance_note } : null;
    }
    await busy(e.submitter, async () => {
      try {
        const res = await saveWithConflicts((allow) => bookingApi(editing ? `/bookings/${b.id}` : '/bookings', {
          method: editing ? 'PUT' : 'POST', body: { ...body, allow_conflicts: allow },
        }));
        if (!res) return;
        dirty = false;
        clearLeaveGuard(guard);
        toast(editing ? 'Booking saved.' : `${res.booking.number} booked for ${res.booking.client_name}.`);
        navigate(`/bookings/${res.booking.id}`);
      } catch (err) {
        showFormError(form, err);
      }
    });
    return undefined;
  });

  return () => {
    lookup.cancel();
    clearLeaveGuard(guard);
  };
}
