// Work tracking, one row per job, newest first: the customer's photo (tap to see it or add one), bill number,
// customer, date, WhatsApp number, how the photo came in, what was ordered, and the stage buttons
// Received · Design · Review · Print · Frame · Final (tap one to move the job there).
// All (the default) keeps finished jobs on the list; filter by date, mobile number, name and bill number.
import { api, buildQuery } from '../lib/api.js';
import { html, setHtml, on, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast, toastError, openModal, demoBadge, loading } from '../lib/ui.js';
import { WORK_STAGES, STAGE_KEYS, PHOTO_SOURCES, stageLabel } from '/shared/tracking.js';
import { formatDate, formatQty, isoDate, addDays } from '/shared/format.js';
import { shareOnWhatsApp, statusMessage } from '../components/share.js';
import { stageButtons } from '../components/stages.js';
import { openPaymentForm } from '../components/payment-form.js';
import { photoThumb, openPhotos } from '../components/job-photos.js';

export const DATE_OPTIONS = [
  ['', 'All dates'],
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['7d', 'Last 7 days'],
  ['month', 'This month'],
  ['lastmonth', 'Last month'],
  ['pick', 'Choose a date…'],
];

/** Bill-date range for a date option; "pick" uses the chosen day. */
export function dateRange(option, day) {
  const today = isoDate();
  const [y, m] = today.split('-').map(Number);
  switch (option) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: addDays(today, -1), to: addDays(today, -1) };
    case '7d': return { from: addDays(today, -6), to: today };
    case 'month': return { from: `${today.slice(0, 8)}01`, to: today };
    case 'lastmonth': return { from: isoDate(new Date(y, m - 2, 1)), to: isoDate(new Date(y, m - 1, 0)) };
    case 'pick': return day ? { from: day, to: day } : {};
    default: return {};
  }
}

const SHOWN_ITEMS = 4;
const sum = (counts) => STAGE_KEYS.reduce((a, k) => a + counts[k], 0);

// Tabs above the list: every job, the ones still being worked on, and the finished ones.
const TABS = [['all', 'All'], ['open', 'In progress'], ['final', 'Final']];
const tabCount = (counts, tab) => (tab === 'all' ? sum(counts) : tab === 'final' ? counts.final : sum(counts) - counts.final);

export default async function tracking(el, { app, query }) {
  app.setTitle('Tracking');
  const money = (v) => app.money(v);
  let stage = TABS.some(([key]) => key === query.stage) ? query.stage : 'all';
  const qDate = String(query.date || '');
  let dateOption = /^\d{4}-\d{2}-\d{2}$/.test(qDate) ? 'pick' : DATE_OPTIONS.some(([k]) => k === qDate) ? qDate : '';
  let day = dateOption === 'pick' ? qDate : '';
  let phone = String(query.phone || '');
  let name = String(query.name || '');
  let billNo = String(query.bill || '');
  let data = null;
  let loadSeq = 0;
  const filtering = () => !!(dateOption || phone || name || billNo);

  setHtml(el, html`
    <div class="page-header">
      <div><h1>Tracking</h1><div class="subtitle">Tap a stage to update the job: ${WORK_STAGES.map((s) => s.label).join(' · ')}.</div></div>
      <div class="page-actions"><button type="button" class="btn" data-action="track-bill">${icon('plus')}Track a bill</button></div>
    </div>
    <div class="stage-chips" data-counts role="tablist" aria-label="Show jobs"></div>
    <div class="track-filters">
      <div class="input-group tf-date">${icon('calendar')}
        <select class="input" data-date aria-label="Date">${DATE_OPTIONS.map(([k, label]) => html`
          <option value="${k}" ${k === dateOption ? 'selected' : ''}>${label}</option>`)}</select></div>
      <input class="input tf-day" type="date" data-day value="${day}" aria-label="Bill date" ${dateOption === 'pick' ? '' : 'hidden'}>
      <div class="input-group tf-phone">${icon('phone')}
        <input class="input" type="tel" inputmode="numeric" data-phone value="${phone}" placeholder="Mobile number" aria-label="Mobile number"></div>
      <div class="input-group tf-name">${icon('user')}
        <input class="input" type="search" data-name value="${name}" placeholder="Name" aria-label="Customer name"></div>
      <div class="input-group tf-bill">${icon('bill')}
        <input class="input" type="search" inputmode="numeric" data-bill value="${billNo}" placeholder="Bill number" aria-label="Bill number"></div>
      <button type="button" class="inline-link small tf-clear" data-clear ${filtering() ? '' : 'hidden'}>${icon('x', 'sm')}Clear</button>
    </div>
    <div data-jobs>${loading()}</div>`);

  const jobsEl = el.querySelector('[data-jobs]');
  const dayInput = el.querySelector('[data-day]');

  async function load() {
    const seq = ++loadSeq;
    jobsEl.style.opacity = '0.6';
    try {
      const res = await api('/tracking', { query: { stage, ...dateRange(dateOption, day), phone, name, bill: billNo } });
      if (seq !== loadSeq) return;
      data = res;
      history.replaceState(null, '', `/tracking${buildQuery({
        stage: stage === 'all' ? '' : stage, date: dateOption === 'pick' ? day : dateOption, phone, name, bill: billNo,
      })}`);
      renderCounts();
      renderJobs();
    } finally {
      if (seq === loadSeq) jobsEl.style.opacity = '';
    }
  }

  function renderCounts() {
    setHtml(el.querySelector('[data-counts]'), html`${TABS.map(([key, label]) => html`
      <button type="button" role="tab" class="stage-chip ${stage === key ? 'active' : ''}" data-filter="${key}" aria-selected="${stage === key}">
        ${label}<b>${tabCount(data.counts, key)}</b></button>`)}`);
  }

  /** What was ordered: the first few items, then "+2 more" (opens the bill). */
  function itemsLine(j) {
    if (!j.items.length) return '';
    const shown = j.items.slice(0, SHOWN_ITEMS);
    const more = j.items.length - shown.length;
    return html`<div class="tr-items">${shown.map((it) => html`
      <span class="tr-item" title="${it.name}">${it.name}${it.quantity !== 1 ? html` <b>×${formatQty(it.quantity)}</b>` : ''}</span>`)}
      ${more > 0 ? html`<a class="tr-item tr-more" href="/bills/${j.id}">+${more} more</a>` : ''}</div>`;
  }

  function row(j) {
    return html`
      <div class="track-row ${j.balance > 0 ? 'has-due' : ''}" data-id="${j.id}">
        <div class="tr-photo">${photoThumb(j.photos)}</div>
        <div class="tr-main">
          <div class="tr-top"><a class="tr-no" href="/bills/${j.id}">${j.invoice_no}</a>
            <span class="tr-name">${j.customer_name || 'Walk-in customer'}</span></div>
          <div class="tr-sub"><span class="tr-date">${formatDate(j.bill_date)}</span>
            ${j.customer_phone ? html`<span class="tr-phone">${j.customer_phone}</span>` : ''}
            ${j.photo_source ? html`<span class="tr-src" title="Photo received">${icon('camera', 'sm')}${PHOTO_SOURCES[j.photo_source]}</span>` : ''}${demoBadge(j.is_demo)}</div>
          ${itemsLine(j)}
        </div>
        <div class="tr-stages">${stageButtons(j.work_stage)}</div>
        <div class="tr-pay">${j.balance > 0 ? html`<button type="button" class="btn btn-sm btn-pay" data-pay
          title="Tap to record the money received">${icon('wallet', 'sm')}Due ${money(j.balance)}</button>` : ''}</div>
        <div class="tr-actions">
          ${j.work_stage === 'final' ? html`<span class="tr-done">${icon('check', 'sm')}Done</span>` : ''}
          <button type="button" class="btn btn-ghost btn-icon btn-sm tr-wa" data-wa title="Send status on WhatsApp" aria-label="Send status on WhatsApp">${icon('share', 'sm')}</button>
        </div>
      </div>`;
  }

  function renderJobs() {
    const total = sum(data.counts);
    if (!data.jobs.length) {
      const [title, hint] = total
        ? [stage === 'final' ? 'No finished jobs yet' : 'Every job is final', 'Try another tab.']
        : filtering()
          ? ['No jobs match these filters', 'Try another date, mobile number, name or bill number.']
          : ['No jobs tracked yet', 'Bills made with "Track this job" ticked show up here.'];
      setHtml(jobsEl, html`<div class="card"><div class="empty">${icon('kanban')}<h3>${title}</h3><p>${hint}</p>
        ${!total && filtering() ? html`<button type="button" class="btn" data-clear>Clear filters</button>` : ''}</div></div>`);
      return;
    }
    const expected = tabCount(data.counts, stage);
    setHtml(jobsEl, html`<div class="card track-list">${data.jobs.map(row)}</div>
      ${data.jobs.length < expected ? html`<p class="muted small track-more">Showing the first ${data.jobs.length} of ${expected} jobs. Choose a date to see the rest.</p>` : ''}`);
  }

  async function moveTo(job, to) {
    try {
      await api(`/bills/${job.id}/stage`, { method: 'PUT', body: { stage: to } });
      toast(`${job.invoice_no} → ${stageLabel(to)}${to === 'final' ? ' · Done' : ''}`);
      await load();
    } catch (err) {
      toastError(err);
      renderJobs();
    }
  }

  const jobFor = (target) => data.jobs.find((j) => String(j.id) === target.closest('[data-id]')?.dataset.id);
  const showClear = () => {
    el.querySelector('.tf-clear').hidden = !filtering();
  };

  on(el, 'click', '[data-filter]', (e, b) => {
    stage = b.dataset.filter;
    load();
  });
  on(el, 'click', '[data-set-stage]', (e, b) => {
    const job = jobFor(b);
    if (!job || b.dataset.setStage === job.work_stage) return;
    b.closest('.stages').classList.add('is-busy');
    moveTo(job, b.dataset.setStage);
  });
  on(el, 'click', '[data-pay]', async (e, b) => {
    const job = jobFor(b);
    if (!job) return;
    if (await openPaymentForm(job)) await load();
  });
  on(el, 'click', '[data-photos]', (e, b) => {
    const job = jobFor(b);
    if (!job) return;
    openPhotos({
      bill: job,
      photos: job.photos,
      onChange: (photos) => {
        job.photos = photos;
        const cell = el.querySelector(`.track-row[data-id="${job.id}"] .tr-photo`);
        if (cell) setHtml(cell, photoThumb(photos));
      },
    });
  });
  on(el, 'click', '[data-wa]', async (e, b) => {
    const job = jobFor(b);
    if (!job) return;
    try {
      await shareOnWhatsApp(app.business, job, { customerIsDemo: job.is_demo, message: statusMessage });
      if (job.is_demo) toast('Demo customer numbers are samples, so choose who to send it to in WhatsApp.', 'info');
    } catch (err) {
      toastError(err);
    }
  });

  el.querySelector('[data-date]').addEventListener('change', (e) => {
    dateOption = e.target.value;
    dayInput.hidden = dateOption !== 'pick';
    if (dateOption === 'pick') {
      day = day || isoDate();
      dayInput.value = day;
      try {
        dayInput.showPicker();
      } catch {
        dayInput.focus();
      }
    }
    showClear();
    load();
  });
  dayInput.addEventListener('change', () => {
    day = dayInput.value;
    load();
  });
  const search = debounce(() => load(), 250);
  el.querySelector('[data-phone]').addEventListener('input', (e) => {
    phone = e.target.value.replace(/\D/g, '');
    showClear();
    search();
  });
  el.querySelector('[data-name]').addEventListener('input', (e) => {
    name = e.target.value.trim();
    showClear();
    search();
  });
  el.querySelector('[data-bill]').addEventListener('input', (e) => {
    billNo = e.target.value.trim();
    showClear();
    search();
  });
  on(el, 'click', '[data-clear]', () => {
    dateOption = '';
    day = '';
    phone = '';
    name = '';
    billNo = '';
    el.querySelector('[data-date]').value = '';
    dayInput.value = '';
    dayInput.hidden = true;
    el.querySelector('[data-phone]').value = '';
    el.querySelector('[data-name]').value = '';
    el.querySelector('[data-bill]').value = '';
    showClear();
    search.cancel();
    load();
  });
  on(el, 'click', '[data-action=track-bill]', () => openTrackBill());

  /** Pick a created bill that isn't tracked yet and start it at the first stage. */
  function openTrackBill() {
    const modal = openModal({
      title: 'Track a bill',
      body: html`<p class="muted small">Choose a bill to start at <strong>${stageLabel(STAGE_KEYS[0])}</strong>.</p>
        <div class="input-group" style="margin-bottom:10px">${icon('search')}<input class="input" data-bill-search placeholder="Bill number, name or WhatsApp number" autofocus></div>
        <div data-bill-results>${loading()}</div>`,
    });
    const box = modal.el.querySelector('[data-bill-results]');
    let results = [];
    const find = debounce(async (term) => {
      try {
        const res = await api('/bills', { query: { untracked: 1, q: term, limit: 8 } });
        results = res.bills;
        setHtml(box, results.length ? html`<div class="list">${results.map((b) => html`
          <button type="button" class="list-item pick-bill" data-pick="${b.id}">
            <div class="li-main"><div class="li-title">${b.invoice_no} · ${b.customer_name || 'Walk-in customer'}</div>
              <div class="li-sub">${formatDate(b.bill_date)}${b.customer_phone ? ` · ${b.customer_phone}` : ''}</div></div>
            <span class="strong">${money(b.total)}</span>
          </button>`)}</div>`
          : html`<p class="muted" style="margin:8px 0">No untracked bills found.</p>`);
      } catch (err) {
        toastError(err);
      }
    }, 200);
    modal.el.querySelector('[data-bill-search]').addEventListener('input', (e) => find(e.target.value.trim()));
    modal.el.addEventListener('click', async (e) => {
      const pick = e.target.closest('[data-pick]');
      if (!pick) return;
      const bill = results.find((b) => String(b.id) === pick.dataset.pick);
      try {
        await api(`/bills/${bill.id}/stage`, { method: 'PUT', body: { stage: STAGE_KEYS[0] } });
        modal.close();
        toast(`${bill.invoice_no} → ${stageLabel(STAGE_KEYS[0])}`);
        stage = 'all';
        await load();
      } catch (err) {
        toastError(err);
      }
    });
    find('');
  }

  await load();
  return () => search.cancel();
}
