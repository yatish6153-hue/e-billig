import { api } from '../lib/api.js';
import { html, setHtml, on, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { pager, loading } from '../lib/ui.js';
import { movementRows, MOVEMENT_LABELS } from './product-detail.js';

export default async function stock(el, { app, query }) {
  app.setTitle('Stock movements');
  const state = { q: '', type: query.type || '', from: '', to: '', offset: 0 };
  const LIMIT = 50;

  setHtml(el, html`
    <a class="back-link" href="/products">${icon('arrowLeft', 'sm')}Inventory</a>
    <div class="page-header">
      <div><h1>Stock movements</h1><div class="subtitle">A complete history of every change to your stock.</div></div>
    </div>
    <div class="toolbar">
      <div class="input-group grow">${icon('search')}<input class="input" type="search" data-search placeholder="Search product or SKU"></div>
      <select class="input" data-type style="width:auto" aria-label="Movement type">
        <option value="">All types</option>
        ${Object.entries(MOVEMENT_LABELS).map(([k, label]) => html`<option value="${k}" ${k === state.type ? 'selected' : ''}>${label}</option>`)}
      </select>
      <input class="input date-input" type="date" data-from aria-label="From date">
      <span class="muted">to</span>
      <input class="input date-input" type="date" data-to aria-label="To date">
    </div>
    <div data-results>${loading()}</div>`);
  const results = el.querySelector('[data-results]');

  let seq = 0;
  async function load() {
    const mySeq = ++seq;
    results.style.opacity = '0.6';
    try {
      const data = await api('/stock/movements', { query: { q: state.q, type: state.type, from: state.from, to: state.to, limit: LIMIT, offset: state.offset } });
      if (mySeq !== seq) return;
      setHtml(results, data.movements.length ? html`<div class="card">
        <div class="table-wrap"><table class="table stack-mobile">
          <thead><tr><th>When</th><th>Product</th><th>Type</th><th class="r">Change</th><th class="r">Balance</th><th>Details</th></tr></thead>
          <tbody>${movementRows(data.movements, { showProduct: true })}</tbody>
        </table></div>${pager(data.total, data.limit, data.offset)}</div>`
        : html`<div class="card"><div class="empty">${icon('arrows')}<h3>No stock movements found</h3><p>Try changing the filters.</p></div></div>`);
    } finally {
      results.style.opacity = '';
    }
  }

  const search = debounce(() => {
    state.offset = 0;
    load();
  }, 250);
  el.querySelector('[data-search]').addEventListener('input', (e) => {
    state.q = e.target.value.trim();
    search();
  });
  for (const [sel, key] of [['[data-type]', 'type'], ['[data-from]', 'from'], ['[data-to]', 'to']]) {
    el.querySelector(sel).addEventListener('change', (e) => {
      state[key] = e.target.value;
      state.offset = 0;
      load();
    });
  }
  on(el, 'click', '[data-page]', (e, b) => {
    state.offset = Number(b.dataset.page);
    load();
  });

  await load();
  return () => search.cancel();
}
