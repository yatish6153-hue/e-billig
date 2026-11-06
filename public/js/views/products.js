import { api, buildQuery } from '../lib/api.js';
import { html, setHtml, on, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { stockBadge, demoBadge, pager, qtyUnit, loading } from '../lib/ui.js';
import { navigate } from '../lib/router.js';
import { openProductForm } from '../components/product-form.js';
import { openStockForm } from '../components/stock-form.js';

const STATUSES = [
  ['active', 'All products'],
  ['low', 'Low stock'],
  ['out', 'Out of stock'],
  ['archived', 'Archived'],
];

export default async function products(el, { app, query }) {
  app.setTitle('Inventory');
  const state = {
    q: query.q || '', status: query.status || 'active', category: query.category || '', kind: query.kind || '',
    sort: query.sort || 'name', offset: Number(query.offset) || 0,
  };
  const LIMIT = 50;
  let lastData = null;

  setHtml(el, html`
    <div class="page-header">
      <div><h1>Inventory</h1><div class="subtitle">Products, services, prices and stock levels.</div></div>
      <div class="page-actions">
        <a class="btn" href="/stock">${icon('arrows')}Stock movements</a>
        <a class="btn" href="/api/reports/export?type=inventory" download>${icon('download')}Export CSV</a>
        <button type="button" class="btn btn-primary" data-action="add">${icon('plus')}Add item</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="segmented">${STATUSES.map(([k, label]) => html`<button type="button" data-status="${k}" class="${k === state.status ? 'active' : ''}">${label}</button>`)}</div>
    </div>
    <div class="toolbar">
      <div class="input-group grow">${icon('search')}<input class="input" type="search" data-search placeholder="Search name, SKU, barcode or category" value="${state.q}"></div>
      <select class="input" data-kind style="width:auto" aria-label="Type">
        <option value="">Products &amp; services</option><option value="goods">Products only</option><option value="service">Services only</option>
      </select>
      <select class="input" data-category style="width:auto;min-width:160px" aria-label="Category"><option value="">All categories</option></select>
      <select class="input" data-sort style="width:auto" aria-label="Sort">
        <option value="name">Sort: Name</option><option value="stock">Sort: Lowest stock</option>
        <option value="value">Sort: Stock value</option><option value="recent">Sort: Recently updated</option>
      </select>
    </div>
    <div data-results>${loading()}</div>`);
  el.querySelector('[data-sort]').value = state.sort;
  el.querySelector('[data-kind]').value = state.kind;
  const results = el.querySelector('[data-results]');

  api('/products/categories').then(({ categories }) => {
    const select = el.querySelector('[data-category]');
    if (!select) return;
    setHtml(select, html`<option value="">All categories</option>${categories.map((c) => html`<option value="${c}">${c}</option>`)}`);
    select.value = state.category;
  }).catch(() => {});

  let seq = 0;
  async function load() {
    const mySeq = ++seq;
    results.style.opacity = '0.6';
    try {
      const data = await api('/products', {
        query: { q: state.q, status: state.status, category: state.category, kind: state.kind, sort: state.sort, limit: LIMIT, offset: state.offset },
      });
      if (mySeq !== seq) return;
      lastData = data;
      render(data);
      history.replaceState(null, '', `/products${buildQuery({
        q: state.q, status: state.status === 'active' ? '' : state.status, category: state.category, kind: state.kind,
        sort: state.sort === 'name' ? '' : state.sort, offset: state.offset || '',
      })}`);
    } finally {
      results.style.opacity = '';
    }
  }

  function render(data) {
    const money = (v) => app.money(v);
    if (!data.products.length) {
      const filtered = state.q || state.category || state.status !== 'active';
      setHtml(results, html`<div class="card"><div class="empty">${icon('package')}
        <h3>${filtered ? 'Nothing matches' : 'No products or services yet'}</h3>
        <p>${filtered ? 'Try a different search or filter.' : 'Add your first product or service to start billing and tracking stock.'}</p>
        ${filtered ? '' : html`<button type="button" class="btn btn-primary" data-action="add">${icon('plus')}Add item</button>`}</div></div>`);
      return;
    }
    setHtml(results, html`
      <div class="card">
        <div class="table-wrap"><table class="table stack-mobile">
          <thead><tr><th>Product</th><th>Category</th><th class="r">Purchase</th><th class="r">Selling</th><th class="r">Stock</th><th class="r">Value</th><th></th></tr></thead>
          <tbody>${data.products.map((p) => html`
            <tr class="clickable" data-href="/products/${p.id}">
              <td class="td-main"><span class="cell-main">${p.name}</span> ${demoBadge(p.is_demo)}
                <div class="cell-sub">${[p.sku, p.barcode].filter(Boolean).join(' · ') || 'No SKU'}</div></td>
              <td data-label="Category">${p.category || html`<span class="muted">—</span>`}</td>
              <td data-label="Purchase" class="r">${p.is_service && !p.purchase_price ? html`<span class="muted">—</span>` : money(p.purchase_price)}</td>
              <td data-label="Selling" class="r strong">${money(p.selling_price)}</td>
              <td data-label="Stock" class="r">${p.is_service
                ? html`<div class="muted small">per ${p.unit}</div><div>${stockBadge(p)}</div>`
                : html`<div class="strong ${p.quantity <= 0 ? 'text-bad' : p.is_low ? 'text-warn' : ''}">${qtyUnit(p.quantity, p.unit)}</div><div>${stockBadge(p)}</div>`}</td>
              <td data-label="Value" class="r">${p.is_service ? html`<span class="muted">—</span>` : money(p.stock_value)}</td>
              <td class="r td-hide-mobile">${p.is_service || p.archived ? '' : html`<button type="button" class="btn btn-sm" data-adjust="${p.id}">${icon('arrows')}Stock</button>`}</td>
            </tr>`)}</tbody>
        </table></div>
        ${pager(data.total, data.limit, data.offset)}
      </div>`);
  }

  on(el, 'click', '[data-status]', (e, b) => {
    state.status = b.dataset.status;
    state.offset = 0;
    el.querySelectorAll('[data-status]').forEach((x) => x.classList.toggle('active', x === b));
    load();
  });
  const search = debounce(() => {
    state.offset = 0;
    load();
  }, 250);
  el.querySelector('[data-search]').addEventListener('input', (e) => {
    state.q = e.target.value.trim();
    search();
  });
  el.querySelector('[data-category]').addEventListener('change', (e) => {
    state.category = e.target.value;
    state.offset = 0;
    load();
  });
  el.querySelector('[data-kind]').addEventListener('change', (e) => {
    state.kind = e.target.value;
    state.offset = 0;
    load();
  });
  el.querySelector('[data-sort]').addEventListener('change', (e) => {
    state.sort = e.target.value;
    state.offset = 0;
    load();
  });
  on(el, 'click', '[data-page]', (e, b) => {
    state.offset = Number(b.dataset.page);
    load();
  });
  on(el, 'click', '[data-action=add]', async () => {
    const p = await openProductForm(app, { kind: state.kind === 'service' ? 'service' : 'goods' });
    if (p) navigate(`/products/${p.id}`);
  });
  on(el, 'click', '[data-adjust]', async (e, b) => {
    e.stopPropagation();
    const product = lastData.products.find((p) => String(p.id) === b.dataset.adjust);
    const updated = await openStockForm(app, product);
    if (updated) load();
  });
  on(el, 'click', 'tr[data-href]', (e, tr) => {
    if (e.target.closest('button, a')) return;
    navigate(tr.dataset.href);
  });

  await load();
  return () => search.cancel();
}
