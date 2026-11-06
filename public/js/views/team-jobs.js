// Tracking for a team login (Settings → Team login): find a job by bill number, name or mobile number and see where
// it is. Each row shows the customer's photo, the bill number and name, the last 4 digits of the mobile, what was
// ordered, the stage and what is still due. To look at only: no prices, totals or payments, and nothing to change.
import { api, buildQuery } from '../lib/api.js';
import { html, setHtml, on, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { loading, demoBadge } from '../lib/ui.js';
import { STAGE_KEYS, PHOTO_SOURCES } from '/shared/tracking.js';
import { formatDate, formatQty, isoDate } from '/shared/format.js';
import { stageButtons } from '../components/stages.js';
import { photoThumb, openPhotos } from '../components/job-photos.js';
import { DATE_OPTIONS, dateRange } from './tracking.js';

const TABS = [['all', 'All'], ['open', 'In progress'], ['final', 'Final']];
const sum = (counts) => STAGE_KEYS.reduce((a, k) => a + counts[k], 0);
const tabCount = (counts, tab) => (tab === 'all' ? sum(counts) : tab === 'final' ? counts.final : sum(counts) - counts.final);

export default async function teamJobs(el, { app, query }) {
  app.setTitle('Tracking');
  let stage = TABS.some(([key]) => key === query.stage) ? query.stage : 'all';
  let dateOption = '';
  let day = '';
  let phone = '';
  let name = '';
  let billNo = '';
  let data = null;
  let loadSeq = 0;
  const filtering = () => !!(dateOption || phone || name || billNo);

  setHtml(el, html`
    <div class="page-header">
      <div><h1>Tracking</h1><div class="subtitle">Find a job by bill number, name or mobile number. To look at only.</div></div>
    </div>
    <div class="stage-chips" data-counts role="tablist" aria-label="Show jobs"></div>
    <div class="track-filters">
      <div class="input-group tf-bill">${icon('bill')}
        <input class="input" type="search" inputmode="numeric" data-bill placeholder="Bill number" aria-label="Bill number"></div>
      <div class="input-group tf-name">${icon('user')}
        <input class="input" type="search" data-name placeholder="Name" aria-label="Customer name"></div>
      <div class="input-group tf-phone">${icon('phone')}
        <input class="input" type="tel" inputmode="numeric" data-phone placeholder="Mobile number" aria-label="Mobile number"></div>
      <div class="input-group tf-date">${icon('calendar')}
        <select class="input" data-date aria-label="Date">${DATE_OPTIONS.map(([k, label]) => html`<option value="${k}">${label}</option>`)}</select></div>
      <input class="input tf-day" type="date" data-day aria-label="Bill date" hidden>
      <button type="button" class="inline-link small tf-clear" data-clear hidden>${icon('x', 'sm')}Clear</button>
    </div>
    <div data-jobs>${loading()}</div>`);

  const jobsEl = el.querySelector('[data-jobs]');
  const dayInput = el.querySelector('[data-day]');

  async function load() {
    const seq = ++loadSeq;
    jobsEl.style.opacity = '0.6';
    try {
      const res = await api('/view/jobs', { query: { stage, ...dateRange(dateOption, day), phone, name, bill: billNo } });
      if (seq !== loadSeq) return;
      data = res;
      history.replaceState(null, '', `/tracking${buildQuery({ stage: stage === 'all' ? '' : stage })}`);
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

  function row(j) {
    return html`
      <div class="track-row team-row" data-id="${j.id}">
        <div class="tr-photo">${photoThumb(j.photos, { readOnly: true })}</div>
        <div class="tr-main">
          <div class="tr-top"><span class="tr-no">${j.invoice_no}</span>
            <span class="tr-name">${j.customer_name || 'Walk-in customer'}</span></div>
          <div class="tr-sub"><span class="tr-date">${formatDate(j.bill_date)}</span>
            ${j.phone_last4 ? html`<span class="tr-phone" title="Last 4 digits of the mobile number">•••• ${j.phone_last4}</span>` : ''}
            ${j.photo_source ? html`<span class="tr-src" title="Photo received">${icon('camera', 'sm')}${PHOTO_SOURCES[j.photo_source]}</span>` : ''}${demoBadge(j.is_demo)}</div>
          ${j.items.length ? html`<div class="tr-items">${j.items.map((it) => html`
            <span class="tr-item" title="${it.name}">${it.name}${it.quantity !== 1 ? html` <b>×${formatQty(it.quantity)}</b>` : ''}</span>`)}</div>` : ''}
        </div>
        <div class="tr-stages">${stageButtons(j.work_stage, { readOnly: true })}</div>
        <div class="tr-pay">${j.due > 0 ? html`<span class="due-tag">${icon('wallet', 'sm')}Due ${app.money(j.due)}</span>`
          : html`<span class="paid-tag">${icon('checkCircle', 'sm')}Paid</span>`}</div>
        <div class="tr-actions">${j.work_stage === 'final' ? html`<span class="tr-done">${icon('check', 'sm')}Done</span>` : ''}</div>
      </div>`;
  }

  function renderJobs() {
    const total = sum(data.counts);
    if (!data.jobs.length) {
      const [title, hint] = total
        ? [stage === 'final' ? 'No finished jobs yet' : 'Every job is final', 'Try another tab.']
        : filtering()
          ? ['No jobs match', 'Try another bill number, name, mobile number or date.']
          : ['No jobs yet', 'Jobs show up here once a bill is being tracked.'];
      setHtml(jobsEl, html`<div class="card"><div class="empty">${icon('kanban')}<h3>${title}</h3><p>${hint}</p></div></div>`);
      return;
    }
    const expected = tabCount(data.counts, stage);
    setHtml(jobsEl, html`<div class="card track-list">${data.jobs.map(row)}</div>
      ${data.jobs.length < expected ? html`<p class="muted small track-more">Showing the first ${data.jobs.length} of ${expected} jobs. Choose a date to see the rest.</p>` : ''}`);
  }

  const showClear = () => {
    el.querySelector('[data-clear]').hidden = !filtering();
  };
  on(el, 'click', '[data-filter]', (e, b) => {
    stage = b.dataset.filter;
    load();
  });
  on(el, 'click', '[data-photos]', (e, b) => {
    const job = data.jobs.find((j) => String(j.id) === b.closest('[data-id]')?.dataset.id);
    if (job) openPhotos({ bill: job, photos: job.photos, readOnly: true });
  });

  const search = debounce(() => load(), 250);
  const field = (selector, set) => el.querySelector(selector).addEventListener('input', (e) => {
    set(e.target.value);
    showClear();
    search();
  });
  field('[data-bill]', (value) => {
    billNo = value.trim();
  });
  field('[data-name]', (value) => {
    name = value.trim();
  });
  field('[data-phone]', (value) => {
    phone = value.replace(/\D/g, '');
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
  on(el, 'click', '[data-clear]', () => {
    dateOption = '';
    day = '';
    phone = '';
    name = '';
    billNo = '';
    el.querySelectorAll('.track-filters input').forEach((i) => {
      i.value = '';
    });
    el.querySelector('[data-date]').value = '';
    dayInput.hidden = true;
    showClear();
    search.cancel();
    load();
  });

  await load();
  return () => search.cancel();
}
