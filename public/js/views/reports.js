import { api, buildQuery } from '../lib/api.js';
import { html, setHtml, on } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { qtyUnit, stockBadge, demoBadge, toast } from '../lib/ui.js';
import { navigate } from '../lib/router.js';
import { columnChart, compactMoney } from '../components/chart.js';
import { isoDate, addDays, formatDate, PAYMENT_METHODS, currencyInfo } from '/shared/format.js';

const PRESETS = [
  ['today', 'Today'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['month', 'This month'],
  ['lastmonth', 'Last month'],
  ['year', 'This year'],
  ['custom', 'Custom'],
];

function presetRange(key) {
  const today = isoDate();
  const [y, m] = today.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  switch (key) {
    case 'today': return { from: today, to: today };
    case '7d': return { from: addDays(today, -6), to: today };
    case '30d': return { from: addDays(today, -29), to: today };
    case 'lastmonth': {
      const first = new Date(y, m - 2, 1);
      const last = new Date(y, m - 1, 0);
      return { from: isoDate(first), to: isoDate(last) };
    }
    case 'year': return { from: `${y}-01-01`, to: today };
    default: return { from: `${y}-${pad(m)}-01`, to: today };
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default async function reports(el, { app, query }) {
  app.setTitle('Reports');
  let preset = query.from || query.to ? 'custom' : 'month';
  let range = preset === 'custom' ? { from: query.from || '', to: query.to || isoDate() } : presetRange(preset);
  let sortBy = 'total';
  let report = null;
  let chart = null;

  setHtml(el, html`
    <div class="page-header">
      <div><h1>Reports</h1><div class="subtitle">Sales, payments, expenses and stock — for any period.</div></div>
      <div class="page-actions">
        <details class="menu">
          <summary class="btn">${icon('download')}Export CSV ${icon('chevronDown', 'sm')}</summary>
          <div class="menu-items">
            <a data-export="bills" href="#">${icon('file')}Sales (bill-wise)</a>
            <a data-export="items" href="#">${icon('package')}Sales (product-wise)</a>
            <a data-export="payments" href="#">${icon('wallet')}Payments received</a>
            <a data-export="daybook" href="#">${icon('rupee')}Day book (sales, money in, expenses)</a>
            <a data-export="inventory" href="#">${icon('box')}Current inventory</a>
          </div>
        </details>
      </div>
    </div>
    <div class="toolbar">
      <div class="segmented">${PRESETS.map(([k, label]) => html`<button type="button" data-preset="${k}" class="${k === preset ? 'active' : ''}">${label}</button>`)}</div>
    </div>
    <div class="toolbar">
      <label class="muted small" for="r-from">From</label>
      <input class="input date-input" type="date" id="r-from" data-from value="${range.from}">
      <label class="muted small" for="r-to">To</label>
      <input class="input date-input" type="date" id="r-to" data-to value="${range.to}">
    </div>
    <div data-report></div>`);

  const box = el.querySelector('[data-report]');

  async function load() {
    box.style.opacity = '0.6';
    try {
      report = await api('/reports/sales', { query: range });
      history.replaceState(null, '', `/reports${preset === 'custom' ? buildQuery(range) : ''}`);
      render();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      box.style.opacity = '';
    }
  }

  function render() {
    const r = report;
    const s = r.summary;
    const money = (v) => app.money(v);
    const sym = currencyInfo(app.business.currency).symbol;
    chart?.destroy();
    const products = [...r.top_products].sort((a, b) => (sortBy === 'quantity' ? b.quantity - a.quantity : b.total - a.total)).slice(0, 10);
    const maxTop = Math.max(1, ...products.map((p) => (sortBy === 'quantity' ? p.quantity : p.total)));
    const methodsTotal = r.payment_methods.reduce((a, m) => a + m.amount, 0) || 1;
    const periodText = `${formatDate(r.period.from) || 'the beginning'} – ${formatDate(r.period.to) || 'today'}`;

    setHtml(box, html`
      <div class="stats-grid">
        <div class="card stat"><div class="stat-label"><span class="stat-icon">${icon('trending')}</span>Net sales</div>
          <div class="stat-value">${money(s.sales + s.sales_added)}</div>
          <div class="stat-sub">${s.bills} bill${s.bills === 1 ? '' : 's'}${s.sales_added ? ` + ${money(s.sales_added)} without a bill` : ` · avg ${money(s.average)}`}</div></div>
        <div class="card stat"><div class="stat-label"><span class="stat-icon">${icon('wallet')}</span>Money received</div>
          <div class="stat-value">${money(s.collected + s.received_added + (s.received_bookings || 0))}</div>
          <div class="stat-sub">${s.received_added || s.received_bookings
            ? [`Bills ${money(s.collected)}`, s.received_bookings ? `bookings ${money(s.received_bookings)}` : '', s.received_added ? `day book ${money(s.received_added)}` : '']
              .filter(Boolean).join(' · ')
            : 'Recorded in this period'}</div></div>
        <div class="card stat"><div class="stat-label"><span class="stat-icon">${icon('clock')}</span>Outstanding</div>
          <div class="stat-value ${s.outstanding > 0 ? 'text-bad' : ''}">${money(s.outstanding)}</div><div class="stat-sub">Still due on these bills</div></div>
        <a class="card stat" href="/day-book"><div class="stat-label"><span class="stat-icon">${icon('rupee')}</span>Expenses</div>
          <div class="stat-value">${money(s.expenses)}</div><div class="stat-sub">Sales less expenses ${money(s.sales + s.sales_added - s.expenses)}</div></a>
      </div>

      <div class="split-wide" style="margin-bottom:16px">
        <section class="card">
          <div class="card-header"><h2>Sales by ${r.trend_bucket === 'day' ? 'day' : 'month'}</h2>
            <button type="button" class="btn btn-ghost btn-sm" data-action="toggle-chart" aria-pressed="false">${icon('table')}Table</button></div>
          <div class="card-body">${r.trend.some((t) => t.total > 0) ? html`<div data-chart></div>` : html`<div class="empty">${icon('barChart')}<p>No finalized sales in ${periodText}.</p></div>`}</div>
        </section>
        <section class="card">
          <div class="card-header"><h2>Summary</h2><span class="hint">${periodText}</span></div>
          <div class="card-body"><dl class="kv">
            <dt>Gross amount</dt><dd>${money(s.subtotal)}</dd>
            <dt>Discounts</dt><dd>${s.discount ? `-${money(s.discount)}` : money(0)}</dd>
            <dt>Billed sales</dt><dd>${money(s.sales)}</dd>
            <dt>Sales without a bill</dt><dd>${money(s.sales_added)}</dd>
            <dt class="strong">Net sales</dt><dd class="total">${money(s.sales + s.sales_added)}</dd>
            <dt>Expenses</dt><dd>${s.expenses ? `-${money(s.expenses)}` : money(0)}</dd>
            <dt class="strong">Sales less expenses</dt><dd class="total">${money(s.sales + s.sales_added - s.expenses)}</dd>
          </dl>
          ${r.cancelled.count ? html`<p class="muted small" style="margin:12px 0 0">${r.cancelled.count} cancelled bill${r.cancelled.count === 1 ? '' : 's'} (${money(r.cancelled.total)}) excluded.</p>` : ''}
          </div>
        </section>
      </div>

      <div class="split-wide" style="margin-bottom:16px">
        <section class="card">
          <div class="card-header"><h2>Best-selling products</h2>
            <div class="segmented"><button type="button" data-sort="total" class="${sortBy === 'total' ? 'active' : ''}">By revenue</button>
              <button type="button" data-sort="quantity" class="${sortBy === 'quantity' ? 'active' : ''}">By quantity</button></div></div>
          ${products.length ? html`<div class="table-wrap"><table class="table stack-mobile">
            <thead><tr><th>Product</th><th class="r">Qty sold</th><th class="r">Bills</th><th class="r">Revenue</th><th class="td-hide-mobile" style="width:22%"><span class="sr-only">Share</span></th></tr></thead>
            <tbody>${products.map((p, i) => html`<tr>
              <td class="td-main"><span class="muted">${i + 1}.</span> ${p.product_id ? html`<a class="cell-main" href="/products/${p.product_id}">${p.name}</a>` : html`<span class="cell-main">${p.name}</span> <span class="muted small">(custom)</span>`}</td>
              <td data-label="Qty sold" class="r">${qtyUnit(p.quantity, p.unit)}</td>
              <td data-label="Bills" class="r">${p.bills}</td>
              <td data-label="Revenue" class="r strong">${money(p.total)}</td>
              <td class="td-hide-mobile"><div class="meter" aria-hidden="true"><span style="width:${Math.max(2, Math.round(((sortBy === 'quantity' ? p.quantity : p.total) / maxTop) * 100))}%"></span></div></td>
            </tr>`)}</tbody></table></div>`
          : html`<div class="empty">${icon('package')}<p>No products sold in this period.</p></div>`}
        </section>
        <section class="card">
          <div class="card-header"><h2>Payment methods</h2></div>
          ${r.payment_methods.length ? html`<div class="card-body stack" style="gap:12px">
            ${r.payment_methods.map((m) => html`<div>
              <div class="row" style="justify-content:space-between"><span class="strong">${PAYMENT_METHODS[m.method] || m.method}</span>
                <span class="num">${money(m.amount)} <span class="muted small">· ${m.count}</span></span></div>
              <div class="meter" style="margin-top:6px" aria-hidden="true"><span style="width:${Math.max(2, Math.round((m.amount / methodsTotal) * 100))}%"></span></div>
            </div>`)}</div>`
          : html`<div class="empty">${icon('wallet')}<p>No payments recorded in this period.</p></div>`}
        </section>
      </div>

      <section class="card">
        <div class="card-header"><h2>Low-stock items</h2>
          <span class="hint">${r.low_stock.count} product${r.low_stock.count === 1 ? '' : 's'} at or below alert level</span></div>
        ${r.low_stock.items.length ? html`<div class="table-wrap"><table class="table stack-mobile">
          <thead><tr><th>Product</th><th>Category</th><th class="r">In stock</th><th class="r">Alert level</th><th>Status</th></tr></thead>
          <tbody>${r.low_stock.items.map((p) => html`<tr class="clickable" data-href="/products/${p.id}">
            <td class="td-main"><a class="cell-main" href="/products/${p.id}">${p.name}</a> ${demoBadge(p.is_demo)}</td>
            <td data-label="Category">${p.category || '—'}</td>
            <td data-label="In stock" class="r strong ${p.quantity <= 0 ? 'text-bad' : 'text-warn'}">${qtyUnit(p.quantity, p.unit)}</td>
            <td data-label="Alert level" class="r">${qtyUnit(p.low_stock_threshold, p.unit)}</td>
            <td data-label="Status">${stockBadge(p)}</td></tr>`)}</tbody></table></div>`
        : html`<div class="empty">${icon('checkCircle')}<p>All products are above their alert levels.</p></div>`}
      </section>`);

    const chartHost = box.querySelector('[data-chart]');
    if (chartHost) {
      const points = r.trend.map((t) => {
        if (r.trend_bucket === 'day') {
          return { label: formatDate(t.period).slice(0, 6), title: `${formatDate(t.period)} · ${t.count} bill${t.count === 1 ? '' : 's'}`, value: t.total };
        }
        const [yy, mm] = t.period.split('-');
        return { label: `${MONTHS[Number(mm) - 1]} ${yy.slice(2)}`, title: `${MONTHS[Number(mm) - 1]} ${yy} · ${t.count} bill${t.count === 1 ? '' : 's'}`, value: t.total };
      });
      chart = columnChart(chartHost, points, {
        formatValue: (v) => app.money(v),
        formatTick: (v) => compactMoney(v, app.business.currency, sym),
        ariaLabel: `Sales by ${r.trend_bucket}`,
        height: 240,
      });
    }
  }

  on(el, 'click', '[data-preset]', (e, b) => {
    preset = b.dataset.preset;
    el.querySelectorAll('[data-preset]').forEach((x) => x.classList.toggle('active', x === b));
    if (preset === 'custom') {
      el.querySelector('[data-from]').focus();
      return;
    }
    range = presetRange(preset);
    el.querySelector('[data-from]').value = range.from;
    el.querySelector('[data-to]').value = range.to;
    load();
  });
  for (const key of ['from', 'to']) {
    el.querySelector(`[data-${key}]`).addEventListener('change', (e) => {
      range = { ...range, [key]: e.target.value };
      if (range.from && range.to && range.from > range.to) {
        toast('The start date must be on or before the end date.', 'error');
        return;
      }
      preset = 'custom';
      el.querySelectorAll('[data-preset]').forEach((x) => x.classList.toggle('active', x.dataset.preset === 'custom'));
      load();
    });
  }
  on(el, 'click', '[data-sort]', (e, b) => {
    sortBy = b.dataset.sort;
    render();
  });
  on(el, 'click', '[data-action=toggle-chart]', (e, b) => {
    const pressed = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(pressed));
    setHtml(b, html`${icon(pressed ? 'barChart' : 'table')}${pressed ? 'Chart' : 'Table'}`);
    chart?.setTableView(pressed);
  });
  on(el, 'click', '[data-export]', (e, a) => {
    e.preventDefault();
    a.closest('details')?.removeAttribute('open');
    const type = a.dataset.export;
    const link = document.createElement('a');
    link.href = `/api/reports/export${buildQuery({ type, ...(type === 'inventory' ? {} : range) })}`;
    link.download = '';
    document.body.append(link);
    link.click();
    link.remove();
    toast('Export started — check your downloads.', 'info');
  });
  on(el, 'click', 'tr[data-href]', (e, tr) => {
    if (!e.target.closest('a')) navigate(tr.dataset.href);
  });
  const closeMenus = (e) => {
    el.querySelectorAll('details.menu[open]').forEach((d) => {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  };
  document.addEventListener('click', closeMenus);

  await load();
  return () => {
    chart?.destroy();
    document.removeEventListener('click', closeMenus);
  };
}
