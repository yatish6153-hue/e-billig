import { api } from '../lib/api.js';
import { html, setHtml, on, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { demoBadge, pager, loading } from '../lib/ui.js';
import { navigate } from '../lib/router.js';
import { openCustomerForm } from '../components/customer-form.js';
import { formatDate } from '/shared/format.js';

export default async function customers(el, { app, query }) {
  app.setTitle('Customers');
  const state = { q: query.q || '', filter: query.filter || '', offset: 0 };
  const LIMIT = 50;

  setHtml(el, html`
    <div class="page-header">
      <div><h1>Customers</h1><div class="subtitle">Contacts, invoice history and outstanding balances.</div></div>
      <div class="page-actions"><button type="button" class="btn btn-primary" data-action="add">${icon('userPlus')}Add customer</button></div>
    </div>
    <div class="toolbar">
      <div class="input-group grow">${icon('search')}<input class="input" type="search" data-search placeholder="Search name, WhatsApp number or email" value="${state.q}"></div>
      <div class="segmented">
        <button type="button" data-filter="" class="${state.filter ? '' : 'active'}">All</button>
        <button type="button" data-filter="outstanding" class="${state.filter === 'outstanding' ? 'active' : ''}">With balance due</button>
      </div>
    </div>
    <div data-results>${loading()}</div>`);
  const results = el.querySelector('[data-results]');

  let seq = 0;
  async function load() {
    const mySeq = ++seq;
    results.style.opacity = '0.6';
    try {
      const data = await api('/customers', {
        query: { q: state.q, filter: state.filter, sort: state.filter === 'outstanding' ? 'outstanding' : '', limit: LIMIT, offset: state.offset },
      });
      if (mySeq !== seq) return;
      render(data);
    } finally {
      results.style.opacity = '';
    }
  }

  function render(data) {
    const money = (v) => app.money(v);
    if (!data.customers.length) {
      const filtered = state.q || state.filter;
      setHtml(results, html`<div class="card"><div class="empty">${icon('users')}
        <h3>${filtered ? 'No customers match' : 'No customers yet'}</h3>
        <p>${filtered ? 'Try a different search.' : 'Save customers to bill them faster and track what they owe.'}</p>
        ${filtered ? '' : html`<button type="button" class="btn btn-primary" data-action="add">${icon('userPlus')}Add customer</button>`}</div></div>`);
      return;
    }
    setHtml(results, html`<div class="card">
      <div class="table-wrap"><table class="table stack-mobile">
        <thead><tr><th>Customer</th><th>WhatsApp</th><th class="r">Bills</th><th>Last bill</th><th class="r">Total billed</th><th class="r">Balance</th></tr></thead>
        <tbody>${data.customers.map((c) => html`
          <tr class="clickable" data-href="/customers/${c.id}">
            <td class="td-main"><span class="cell-main">${c.name}</span> ${demoBadge(c.is_demo)}${c.email ? html`<div class="cell-sub">${c.email}</div>` : ''}</td>
            <td data-label="WhatsApp">${c.phone || html`<span class="muted">—</span>`}</td>
            <td data-label="Bills" class="r">${c.bills_count}</td>
            <td data-label="Last bill">${c.last_bill_date ? formatDate(c.last_bill_date) : html`<span class="muted">—</span>`}</td>
            <td data-label="Total billed" class="r">${money(c.total_billed)}</td>
            <td data-label="Balance" class="r strong ${c.outstanding > 0 ? 'text-bad' : 'muted'}">${money(c.outstanding)}</td>
          </tr>`)}</tbody>
      </table></div>${pager(data.total, data.limit, data.offset)}</div>`);
  }

  const search = debounce(() => {
    state.offset = 0;
    load();
  }, 250);
  el.querySelector('[data-search]').addEventListener('input', (e) => {
    state.q = e.target.value.trim();
    search();
  });
  on(el, 'click', '[data-filter]', (e, b) => {
    state.filter = b.dataset.filter;
    state.offset = 0;
    el.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('active', x === b));
    load();
  });
  on(el, 'click', '[data-page]', (e, b) => {
    state.offset = Number(b.dataset.page);
    load();
  });
  on(el, 'click', '[data-action=add]', async () => {
    const c = await openCustomerForm();
    if (c) navigate(`/customers/${c.id}`);
  });
  on(el, 'click', 'tr[data-href]', (e, tr) => navigate(tr.dataset.href));

  await load();
  return () => search.cancel();
}
