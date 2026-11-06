// The day book. Every evening: add sales made without a bill, money that came in, and where you paid.
// Bills count on their own, so the day's closing (sales, money in, money out, net cash) fills itself in.
// Money received for a bill is recorded on that bill, so its balance goes down.
// Beside it, a month calendar marks the dates with shoots booked; tap a date to open it and see its shoots.
import { api } from '../lib/api.js';
import { html, setHtml, on, formData } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast, toastError, confirmDialog, openModal, busy, demoBadge, loading, clearErrors, showFieldError, showFormError } from '../lib/ui.js';
import { methodButtons } from '../components/payment-form.js';
import { moneyInput } from '../components/product-form.js';
import {
  DAY_ENTRY_KINDS, EXPENSE_CATEGORIES, PAYMENT_METHODS, formatDate, formatMoney, isoDate, addDays, toMinor, fromMinor,
} from '/shared/format.js';
import { BOOKING_PAY_METHODS, timeRange, eventTitle } from '/shared/bookings.js';
import { bookingApi, statusBadge } from '../components/booking-ui.js';
import { miniCalendar, monthRange, addMonths, shootsByDate, moneyByDate, calendarLegend } from '../components/mini-calendar.js';

const WEEK = 7;

const KINDS = {
  sale: {
    add: 'Add sale', details: 'What was sold', placeholder: 'e.g. Passport photos, prints, a frame',
    hint: 'A sale without a bill. It counts in the day’s sales and money received.',
  },
  received: {
    add: 'Add money received', details: 'Received from / for', placeholder: 'e.g. Advance from Meena for the wedding shoot',
    hint: 'Money that came in. If it’s for a bill, choose the bill and its balance goes down. Booking payments go on the booking.',
  },
  expense: {
    add: 'Add expense', details: 'Paid to / for', placeholder: 'e.g. Lab prints, shop rent, Ramesh (salary)',
    hint: 'Where you paid money.',
  },
};

function kindTabs(kind) {
  return html`<div class="segmented kind-tabs" role="tablist" aria-label="What to add">${Object.entries(DAY_ENTRY_KINDS).map(([k, label]) => html`
    <button type="button" role="tab" data-kind="${k}" class="${k === kind ? 'active' : ''}" aria-selected="${k === kind}">${label}</button>`)}</div>`;
}

/** The fields for any entry. Fields marked data-only show for that kind alone; "For bill" only on the add form. */
function entryFields(x, currency, unpaid = null) {
  const k = KINDS[x.kind];
  return html`
    <input type="hidden" name="kind" value="${x.kind}">
    ${unpaid ? html`<div class="field ef-bill" data-only="received"><label>For bill</label>
      <select class="input" name="bill_id"><option value="">Not for a bill</option>${unpaid.map((b) => html`
        <option value="${b.id}">${b.invoice_no} · ${b.customer_name || 'Walk-in customer'} · ${formatMoney(b.balance, b.currency)} due</option>`)}</select></div>` : ''}
    <div class="field ef-details"><label data-details-label>${k.details}</label>
      <input class="input" name="details" maxlength="120" value="${x.details}" placeholder="${k.placeholder}"></div>
    <div class="field ef-amount"><label>Amount <span class="req">*</span></label>${moneyInput('amount', x.amount, currency, 'required')}</div>
    <div class="field ef-cat" data-only="expense"><label>Type</label>
      <select class="input" name="category">${EXPENSE_CATEGORIES.map((c) => html`<option ${c === x.category ? 'selected' : ''}>${c}</option>`)}</select></div>
    <div class="field ef-method"><span class="label">Cash or online</span>${methodButtons(x.method)}<input type="hidden" name="method" value="${x.method}"></div>`;
}

/** Show the fields for the chosen kind (and for a bill payment, which needs no details). */
function applyKind(form, kind) {
  const k = KINDS[kind];
  form.elements.namedItem('kind').value = kind;
  form.querySelectorAll('[data-only]').forEach((x) => { x.hidden = x.dataset.only !== kind; });
  form.querySelector('[data-details-label]').textContent = k.details;
  form.elements.namedItem('details').placeholder = k.placeholder;
  const forBill = kind === 'received' && !!form.elements.namedItem('bill_id')?.value;
  form.querySelector('.ef-details').hidden = forBill;
  const add = form.querySelector('[data-add-label]');
  if (add) add.textContent = forBill ? 'Record payment' : k.add;
}

/** Kind tabs and Cash / Online buttons inside a form. */
function bindEntryForm(form, onKind) {
  form.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-kind]');
    if (tab) {
      form.querySelectorAll('[data-kind]').forEach((x) => {
        x.classList.toggle('active', x === tab);
        x.setAttribute('aria-selected', String(x === tab));
      });
      applyKind(form, tab.dataset.kind);
      onKind?.(tab.dataset.kind);
    }
    const m = e.target.closest('[data-method]');
    if (m) {
      // form.method is the form's own HTTP method property, so look the input up by name.
      form.elements.namedItem('method').value = m.dataset.method;
      form.querySelectorAll('[data-method]').forEach((x) => x.classList.toggle('active', x === m));
    }
  });
}

function readForm(form) {
  clearErrors(form);
  const d = formData(form);
  const amount = toMinor(d.amount);
  if (Number.isNaN(amount) || amount <= 0) {
    showFieldError(form, 'amount', 'Enter the amount.');
    return null;
  }
  return { ...d, amount };
}

export default async function dayBook(el, { app, query }) {
  app.setTitle('Day book');
  const money = (v) => app.money(v);
  const currency = app.business.currency;
  const today = isoDate();
  let day = /^\d{4}-\d{2}-\d{2}$/.test(String(query.date || '')) && query.date <= today ? query.date : today;
  let kind = DAY_ENTRY_KINDS[query.add] ? query.add : 'sale';
  let list = null;
  let week = [];
  let unpaid = [];
  let loadSeq = 0;
  // The calendar: the month shown, the date picked (any date; past ones also open in the day book), its shoots.
  let calMonth = day.slice(0, 7);
  let calDay = day;
  let shoots = new Map();
  let dayMoney = new Map();
  let calSeq = 0;
  const dayName = (d) => (d === today ? 'today' : formatDate(d));
  const onDay = (d) => (d === today ? 'today' : `on ${formatDate(d)}`);

  try {
    unpaid = (await api('/bills', { query: { payment: 'due', limit: 100 } })).bills;
  } catch {
    // Without the list, money received is simply not linked to a bill.
  }

  setHtml(el, html`
    <div class="page-header">
      <div><h1>Day book</h1><div class="subtitle">Every evening: add sales without a bill, money that came in, and where you paid. Bills and booking payments are counted on their own.</div></div>
    </div>
    <div class="day-nav">
      <button type="button" class="btn btn-icon" data-step="-1" aria-label="Previous day" title="Previous day">${icon('arrowLeft')}</button>
      <input class="input date-input" type="date" data-day value="${day}" max="${today}" aria-label="Day">
      <button type="button" class="btn btn-icon" data-step="1" aria-label="Next day" title="Next day">${icon('arrowRight')}</button>
      <button type="button" class="btn btn-sm" data-today>Today</button>
    </div>
    <div class="db-layout">
    <section class="card closing" data-closing>${loading()}</section>
    <aside class="card db-cal" data-cal aria-label="Calendar">${loading()}</aside>
    <section class="card db-add">
      <div class="card-header"><h2 data-add-title>Add for today</h2></div>
      <form class="card-body entry-form" data-add novalidate>
        ${kindTabs(kind)}
        <p class="muted small kind-hint" data-kind-hint>${KINDS[kind].hint}</p>
        <div class="entry-fields">
          ${entryFields({ kind, details: '', amount: '', category: 'Other', method: 'cash' }, currency, unpaid)}
          <button type="submit" class="btn btn-primary ef-add">${icon('plus')}<span data-add-label>${KINDS[kind].add}</span></button>
        </div>
      </form>
    </section>
    <section class="card db-list">
      <div class="card-header"><h2 data-list-title>Today</h2><span class="hint" data-list-total></span></div>
      <div data-list></div>
    </section>
    <section class="card db-week">
      <div class="card-header"><h2>Last 7 days</h2><span class="hint">Tap a day to open it</span></div>
      <div data-week></div>
    </section>
    </div>`);
  const calBox = el.querySelector('[data-cal]');

  const addForm = el.querySelector('[data-add]');
  bindEntryForm(addForm, (k) => {
    kind = k;
    el.querySelector('[data-kind-hint]').textContent = KINDS[k].hint;
    addForm.elements.namedItem('details').focus();
  });
  applyKind(addForm, kind);

  function renderBillOptions() {
    const select = addForm.elements.namedItem('bill_id');
    setHtml(select, html`<option value="">Not for a bill</option>${unpaid.map((b) => html`
      <option value="${b.id}">${b.invoice_no} · ${b.customer_name || 'Walk-in customer'} · ${formatMoney(b.balance, b.currency)} due</option>`)}`);
  }
  addForm.elements.namedItem('bill_id').addEventListener('change', (e) => {
    const bill = unpaid.find((b) => String(b.id) === e.target.value);
    const amount = addForm.elements.namedItem('amount');
    if (bill && !amount.value.trim()) amount.value = fromMinor(bill.balance);
    applyKind(addForm, kind);
  });

  async function load() {
    const seq = ++loadSeq;
    el.querySelectorAll('[data-closing], [data-list], [data-week]').forEach((x) => { x.style.opacity = '0.6'; });
    try {
      const [res, days] = await Promise.all([
        api('/day-book', { query: { from: day, to: day } }),
        api('/day-book/days', { query: { from: addDays(day, -(WEEK - 1)), to: day } }),
      ]);
      if (seq !== loadSeq) return;
      list = res;
      week = days.days;
      history.replaceState(null, '', day === today ? '/day-book' : `/day-book?date=${day}`);
      render();
    } catch (err) {
      toastError(err);
    } finally {
      if (seq === loadSeq) el.querySelectorAll('[data-closing], [data-list], [data-week]').forEach((x) => { x.style.opacity = ''; });
    }
  }

  function render() {
    el.querySelector('[data-day]').value = day;
    el.querySelector('[data-step="1"]').disabled = day >= today;
    el.querySelector('[data-today]').hidden = day === today;
    el.querySelector('[data-add-title]').textContent = `Add for ${dayName(day)}`;
    el.querySelector('[data-list-title]').textContent = day === today ? 'Today' : formatDate(day);
    renderClosing();
    renderList();
    renderWeek();
    // The calendar follows the day that's open (and is re-read, so new entries show).
    calDay = day;
    calMonth = day.slice(0, 7);
    renderCalendar();
    loadCalendar();
  }

  /** The shoots booked and the day book days in the month shown (and the date picked, if that's another month). */
  async function loadCalendar() {
    const seq = ++calSeq;
    const range = monthRange(calMonth);
    const from = calDay < range.from ? calDay : range.from;
    const to = calDay > range.to ? calDay : range.to;
    try {
      const [res, book] = await Promise.all([
        bookingApi('/bookings', { query: { from, to, limit: 1000 } }),
        api('/day-book/days', { query: { from, to } }),
      ]);
      if (seq !== calSeq) return;
      shoots = shootsByDate(res.bookings);
      dayMoney = moneyByDate(book.days);
      renderCalendar();
    } catch (err) {
      if (seq === calSeq) toastError(err);
    }
  }

  function renderCalendar() {
    const list = shoots.get(calDay) || [];
    setHtml(calBox, html`
      <div class="card-header"><h2 class="bk-h-icon">${icon('calendar')}Calendar</h2><span class="hint">Shoots and day book days</span></div>
      <div class="card-body db-cal-body">${miniCalendar({ month: calMonth, selected: calDay, today, shoots, money: dayMoney })}${calendarLegend()}</div>
      <div class="mc-list">
        <div class="mc-list-head"><span class="label">${list.length ? `Shoots ${onDay(calDay)}` : `No shoots booked ${onDay(calDay)}`}</span>
          <a class="inline-link small mc-new" href="/bookings/new?date=${calDay}">${icon('plus', 'sm')}New booking</a></div>
        ${list.map(({ b, day: d }) => html`<a class="mc-shoot" href="/bookings/${b.id}">
          <span class="mc-time">${timeRange(d) || 'All day'}</span>
          <span class="mc-main"><b>${b.client_name}</b><span class="muted small">${[eventTitle(b), d.venue].filter(Boolean).join(' · ')}</span></span>
          ${statusBadge(b.status)}</a>`)}
      </div>`);
  }

  /** The chosen day: sales, money received, money spent and the cash left from the day. */
  function renderClosing() {
    const d = week[0];
    const received = d.received_cash + d.received_online;
    const spent = d.spent_cash + d.spent_online;
    const net = d.received_cash - d.spent_cash;
    const billsText = `${d.bills} bill${d.bills === 1 ? '' : 's'}`;
    setHtml(el.querySelector('[data-closing]'), html`
      <div class="card-header"><h2>Closing · ${day === today ? 'Today' : formatDate(day)}</h2>
        ${day === today ? html`<span class="hint">${formatDate(day)}</span>` : ''}</div>
      <div class="closing-grid">
        <div class="cl"><div class="cl-label">Sales</div><div class="cl-value">${money(d.sales)}</div>
          <div class="cl-sub">${d.sales_added ? `${billsText} + ${money(d.sales_added)} without a bill` : billsText}</div></div>
        <div class="cl"><div class="cl-label">Money received</div><div class="cl-value text-good">${money(received)}</div>
          <div class="cl-sub">Cash ${money(d.received_cash)} · Online ${money(d.received_online)}</div></div>
        <div class="cl"><div class="cl-label">Expenses</div><div class="cl-value text-bad">${money(spent)}</div>
          <div class="cl-sub">Cash ${money(d.spent_cash)} · Online ${money(d.spent_online)}</div></div>
        <div class="cl cl-net"><div class="cl-label">Net cash</div><div class="cl-value ${net < 0 ? 'text-bad' : ''}">${money(net)}</div>
          <div class="cl-sub">Cash in ${money(d.received_cash)} − cash out ${money(d.spent_cash)}</div></div>
      </div>`);
  }

  /** Everything for the day: what you added (can be changed) and payments on bills and bookings (change those there). */
  function renderList() {
    const { entries, payments } = list;
    const bookingPayments = list.booking_payments || [];
    const moneyIn = entries.reduce((a, x) => a + (x.kind === 'expense' ? 0 : x.amount), 0)
      + [...payments, ...bookingPayments].reduce((a, p) => a + p.amount, 0);
    const moneyOut = entries.reduce((a, x) => a + (x.kind === 'expense' ? x.amount : 0), 0);
    const any = entries.length || payments.length || bookingPayments.length;
    el.querySelector('[data-list-total]').textContent = any ? `In ${money(moneyIn)} · Out ${money(moneyOut)}` : '';
    if (!any) {
      setHtml(el.querySelector('[data-list]'), html`<p class="muted entry-empty">Nothing for ${dayName(day)} yet.</p>`);
      return;
    }
    setHtml(el.querySelector('[data-list]'), html`<div class="entry-list">
      ${entries.map((x) => html`
        <div class="entry-row" data-id="${x.id}">
          <div class="entry-main">
            <div class="entry-title"><span class="kind-tag kind-${x.kind}">${DAY_ENTRY_KINDS[x.kind]}</span>
              <span>${x.details || (x.kind === 'expense' ? x.category : DAY_ENTRY_KINDS[x.kind])}</span>${demoBadge(x.is_demo)}</div>
            <div class="entry-sub">${x.kind === 'expense' && x.details ? html`<span>${x.category}</span>` : ''}<span>${PAYMENT_METHODS[x.method] || x.method}</span></div>
          </div>
          <div class="entry-amount ${x.kind === 'expense' ? 'out' : 'in'}">${x.kind === 'expense' ? '−' : '+'}${money(x.amount)}</div>
          <div class="entry-actions">
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-edit title="Edit" aria-label="Edit entry">${icon('edit', 'sm')}</button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-delete title="Delete" aria-label="Delete entry">${icon('trash', 'sm')}</button>
          </div>
        </div>`)}
      ${payments.map((p) => html`
        <div class="entry-row">
          <div class="entry-main">
            <div class="entry-title"><span class="kind-tag kind-bill">Bill</span>
              <span><a href="/bills/${p.bill_id}">${p.invoice_no}</a> · ${p.customer_name || 'Walk-in customer'}</span>${demoBadge(p.is_demo)}</div>
            <div class="entry-sub"><span>${PAYMENT_METHODS[p.method] || p.method}</span>${p.reference ? html`<span>${p.reference}</span>` : ''}</div>
          </div>
          <div class="entry-amount in">+${money(p.amount)}</div>
          <div class="entry-actions"><a class="btn btn-ghost btn-icon btn-sm" href="/bills/${p.bill_id}" title="Open the bill" aria-label="Open bill ${p.invoice_no}">${icon('arrowRight', 'sm')}</a></div>
        </div>`)}
      ${bookingPayments.map((p) => html`
        <div class="entry-row">
          <div class="entry-main">
            <div class="entry-title"><span class="kind-tag kind-booking">Booking</span>
              <span><a href="/bookings/${p.booking_id}">${p.number}</a> · ${p.client_name}${p.event_type ? ` · ${p.event_type}` : ''}</span>${demoBadge(p.is_demo)}</div>
            <div class="entry-sub"><span>${BOOKING_PAY_METHODS[p.method] || p.method}</span>${p.note ? html`<span>${p.note}</span>` : ''}</div>
          </div>
          <div class="entry-amount in">+${money(p.amount)}</div>
          <div class="entry-actions"><a class="btn btn-ghost btn-icon btn-sm" href="/bookings/${p.booking_id}" title="Open the booking" aria-label="Open booking ${p.number}">${icon('arrowRight', 'sm')}</a></div>
        </div>`)}
      <div class="entry-total"><span>${day === today ? 'Today' : formatDate(day)}</span>
        <span><span class="text-good">In ${money(moneyIn)}</span> · <span class="text-bad">Out ${money(moneyOut)}</span></span></div>
    </div>`);
  }

  function renderWeek() {
    const total = (key) => week.reduce((a, d) => a + d[key], 0);
    const cells = (d) => {
      const net = d.received_cash - d.spent_cash;
      return html`
        <td class="r" data-label="Sales">${money(d.sales)}</td>
        <td class="r" data-label="Received">${money(d.received_cash + d.received_online)}</td>
        <td class="r" data-label="Expenses">${money(d.spent_cash + d.spent_online)}</td>
        <td class="r ${net < 0 ? 'text-bad' : ''}" data-label="Net cash">${money(net)}</td>`;
    };
    const sums = {
      sales: total('sales'), received_cash: total('received_cash'), received_online: total('received_online'),
      spent_cash: total('spent_cash'), spent_online: total('spent_online'),
    };
    setHtml(el.querySelector('[data-week]'), html`<div class="table-wrap"><table class="table stack-mobile week-table">
      <thead><tr><th>Day</th><th class="r">Sales</th><th class="r">Received</th><th class="r">Expenses</th><th class="r">Net cash</th></tr></thead>
      <tbody>${week.map((d) => html`
        <tr class="clickable ${d.date === day ? 'is-selected' : ''}" data-date="${d.date}">
          <td class="td-main"><span class="cell-main">${d.date === today ? 'Today' : formatDate(d.date)}</span></td>${cells(d)}</tr>`)}</tbody>
      <tfoot><tr><td class="td-main">7 days</td>${cells(sums)}</tr></tfoot>
    </table></div>`);
  }

  function setDay(d) {
    day = d && d <= today ? d : today;
    load();
  }

  // A past date (or today) opens in the day book; a later one just shows its shoots.
  on(el, 'click', '[data-mc-day]', (e, b) => {
    const d = b.dataset.mcDay;
    if (d <= today) return setDay(d);
    calDay = d;
    if (d.slice(0, 7) !== calMonth) {
      calMonth = d.slice(0, 7);
      return loadCalendar();
    }
    return renderCalendar();
  });
  on(el, 'click', '[data-mc-step]', (e, b) => {
    calMonth = addMonths(calMonth, Number(b.dataset.mcStep));
    loadCalendar();
  });
  on(el, 'click', '[data-step]', (e, b) => setDay(addDays(day, Number(b.dataset.step))));
  on(el, 'click', '[data-today]', () => setDay(today));
  on(el, 'click', '[data-date]', (e, tr) => setDay(tr.dataset.date));
  el.querySelector('[data-day]').addEventListener('change', (e) => setDay(e.target.value));

  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = readForm(addForm);
    if (!d) return;
    await busy(e.submitter, async () => {
      try {
        const bill = d.kind === 'received' && unpaid.find((b) => String(b.id) === d.bill_id);
        if (bill) {
          await api(`/bills/${bill.id}/payments`, { method: 'POST', body: { amount: d.amount, method: d.method, paid_on: day } });
          toast(`${money(d.amount)} received for ${bill.invoice_no}.`);
          unpaid = (await api('/bills', { query: { payment: 'due', limit: 100 } })).bills;
          renderBillOptions();
        } else {
          await api('/day-book', {
            method: 'POST',
            body: { entry_date: day, kind: d.kind, details: d.details, category: d.category, amount: d.amount, method: d.method },
          });
          toast(`${DAY_ENTRY_KINDS[d.kind]} added: ${money(d.amount)}${d.details ? ` · ${d.details}` : ''}`);
        }
        addForm.elements.namedItem('details').value = '';
        addForm.elements.namedItem('amount').value = '';
        addForm.elements.namedItem('bill_id').value = '';
        applyKind(addForm, kind);
        addForm.elements.namedItem('details').focus();
        await load();
      } catch (err) {
        showFormError(addForm, err);
      }
    });
  });

  const entryFor = (b) => list.entries.find((x) => String(x.id) === b.closest('[data-id]').dataset.id);

  on(el, 'click', '[data-edit]', (e, b) => {
    const x = entryFor(b);
    const modal = openModal({
      title: 'Edit entry',
      form: true,
      body: html`${kindTabs(x.kind)}
        <div class="form-grid entry-form" style="margin-top:14px">
          <div class="field span-all"><label>Date</label><input class="input" type="date" name="entry_date" value="${x.entry_date}" max="${today}" required></div>
          ${entryFields({ ...x, category: x.category || 'Other', amount: fromMinor(x.amount) }, currency)}</div>`,
      footer: html`<button type="button" class="btn" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>`,
      onSubmit: async (form, m, submitter) => {
        const d = readForm(form);
        if (!d) return;
        await busy(submitter, async () => {
          try {
            await api(`/day-book/${x.id}`, { method: 'PUT', body: d });
            m.close();
            toast('Entry saved.');
            await load();
          } catch (err) {
            showFormError(form, err);
          }
        });
      },
    });
    bindEntryForm(modal.form);
    applyKind(modal.form, x.kind);
  });

  on(el, 'click', '[data-delete]', async (e, b) => {
    const x = entryFor(b);
    const ok = await confirmDialog({
      title: 'Delete this entry?',
      message: [DAY_ENTRY_KINDS[x.kind], x.details || x.category, money(x.amount)].filter(Boolean).join(' · '),
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/day-book/${x.id}`, { method: 'DELETE' });
      toast('Entry deleted.');
      await load();
    } catch (err) {
      toastError(err);
    }
  });

  await load();
  if (query.add) addForm.elements.namedItem('details').focus();
}
