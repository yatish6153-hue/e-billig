import { api } from '../lib/api.js';
import { html, setHtml, on } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast, toastError, confirmDialog, stockBadge, demoBadge, qtyUnit, pager } from '../lib/ui.js';
import { openProductForm } from '../components/product-form.js';
import { openStockForm } from '../components/stock-form.js';
import { formatDateTime, formatQty } from '/shared/format.js';

export const MOVEMENT_LABELS = {
  opening: 'Opening stock',
  purchase: 'Stock added',
  adjustment: 'Adjustment',
  sale: 'Sale',
  sale_cancel: 'Sale cancelled',
};

export function movementRows(movements, { showProduct = false } = {}) {
  return movements.map((m) => html`
    <tr>
      <td data-label="When" class="nowrap">${formatDateTime(m.created_at)}</td>
      ${showProduct ? html`<td class="td-main"><a href="/products/${m.product_id}" class="cell-main">${m.product_name}</a></td>` : ''}
      <td data-label="Type"><span class="badge badge-plain ${m.quantity < 0 ? 'badge-draft' : 'badge-ok'}">${MOVEMENT_LABELS[m.type] || m.type}</span></td>
      <td data-label="Change" class="r strong ${m.quantity < 0 ? 'text-bad' : 'text-good'}">${m.quantity > 0 ? '+' : ''}${formatQty(m.quantity)} ${m.unit || ''}</td>
      <td data-label="Balance" class="r">${formatQty(m.balance_after)}</td>
      <td data-label="Details">${m.bill_id && m.invoice_no ? html`<a href="/bills/${m.bill_id}">${m.invoice_no}</a>` : ''}
        ${m.note && !(m.bill_id && m.invoice_no) ? m.note : ''}${m.user_name ? html`<div class="cell-sub">by ${m.user_name}</div>` : ''}</td>
    </tr>`);
}

export default async function productDetail(el, { app, params }) {
  let product;
  let sales;
  let offset = 0;
  const LIMIT = 20;

  async function loadProduct() {
    ({ product, sales } = await api(`/products/${params.id}`));
  }

  async function renderMovements() {
    const box = el.querySelector('[data-movements]');
    const data = await api('/stock/movements', { query: { product_id: product.id, limit: LIMIT, offset } });
    setHtml(box, data.movements.length ? html`
      <div class="table-wrap"><table class="table stack-mobile">
        <thead><tr><th>When</th><th>Type</th><th class="r">Change</th><th class="r">Balance</th><th>Details</th></tr></thead>
        <tbody>${movementRows(data.movements.map((m) => ({ ...m, unit: product.unit })))}</tbody>
      </table></div>${pager(data.total, data.limit, data.offset)}`
      : html`<div class="empty">${icon('arrows')}<p>No stock movements yet.</p></div>`);
  }

  function render() {
    const money = (v) => app.money(v);
    const p = product;
    app.setTitle(p.name);
    const margin = p.selling_price - p.purchase_price;
    setHtml(el, html`
      <a class="back-link" href="/products">${icon('arrowLeft', 'sm')}Inventory</a>
      <div class="page-header">
        <div><div class="row" style="gap:10px"><h1>${p.name}</h1>${stockBadge(p)}${demoBadge(p.is_demo)}</div>
          <div class="subtitle">${[p.category, p.sku && `SKU ${p.sku}`, p.barcode && `Barcode ${p.barcode}`].filter(Boolean).join(' · ') || 'No category'}</div></div>
        <div class="page-actions">
          ${p.is_service ? '' : html`<button type="button" class="btn btn-primary" data-action="stock">${icon('arrows')}Adjust stock</button>`}
          <button type="button" class="btn" data-action="edit">${icon('edit')}Edit</button>
          <button type="button" class="btn" data-action="archive">${icon('archive')}${p.archived ? 'Restore' : 'Archive'}</button>
        </div>
      </div>
      ${p.archived ? html`<div class="alert alert-info" style="margin-bottom:16px">${icon('info')}<div>This item is archived — it's hidden from billing search. Restore it to sell it again.</div></div>` : ''}
      ${p.is_service ? renderService(p, money) : renderGoods(p, money, margin)}`);
    if (!p.is_service) renderMovements().catch(toastError);
  }

  function renderService(p, money) {
    return html`
      <div class="stats-grid">
        <div class="card stat"><div class="stat-label">Price</div><div class="stat-value">${money(p.selling_price)}</div>
          <div class="stat-sub">per ${p.unit}</div></div>
        <div class="card stat"><div class="stat-label">Billed</div><div class="stat-value">${qtyUnit(sales.qty, p.unit)}</div>
          <div class="stat-sub">in ${sales.bills} bill${sales.bills === 1 ? '' : 's'}</div></div>
        <div class="card stat"><div class="stat-label">Revenue</div><div class="stat-value">${money(sales.revenue)}</div>
          <div class="stat-sub">From finalized bills</div></div>
        <div class="card stat"><div class="stat-label">Stock</div><div class="stat-value">—</div>
          <div class="stat-sub">Services don't use stock</div></div>
      </div>`;
  }

  function renderGoods(p, money, margin) {
    return html`
      <div class="stats-grid">
        <div class="card stat"><div class="stat-label">In stock</div>
          <div class="stat-value ${p.quantity <= 0 ? 'text-bad' : p.is_low ? 'text-warn' : ''}">${qtyUnit(p.quantity, p.unit)}</div>
          <div class="stat-sub">Alert at ${qtyUnit(p.low_stock_threshold, p.unit)}</div></div>
        <div class="card stat"><div class="stat-label">Selling price</div><div class="stat-value">${money(p.selling_price)}</div>
          <div class="stat-sub">per ${p.unit}</div></div>
        <div class="card stat"><div class="stat-label">Purchase price</div><div class="stat-value">${money(p.purchase_price)}</div>
          <div class="stat-sub ${margin < 0 ? 'text-bad' : ''}">${p.purchase_price > 0 ? `Margin ${money(margin)} per ${p.unit}` : 'Cost not set'}</div></div>
        <div class="card stat"><div class="stat-label">Stock value</div><div class="stat-value">${money(p.stock_value)}</div>
          <div class="stat-sub">Sold ${qtyUnit(sales.qty, p.unit)} in ${sales.bills} bill${sales.bills === 1 ? '' : 's'}</div></div>
      </div>
      <section class="card">
        <div class="card-header"><h2>Stock movement history</h2><span class="hint">Every addition, adjustment, sale and cancellation</span></div>
        <div data-movements><div class="loading"><span class="spinner"></span></div></div>
      </section>`;
  }

  on(el, 'click', '[data-action]', async (e, b) => {
    const action = b.dataset.action;
    if (action === 'edit') {
      const updated = await openProductForm(app, { product });
      if (updated) {
        await loadProduct();
        render();
      }
    } else if (action === 'stock') {
      const updated = await openStockForm(app, product);
      if (updated) {
        await loadProduct();
        offset = 0;
        render();
      }
    } else if (action === 'archive') {
      const archiving = !product.archived;
      if (archiving) {
        const ok = await confirmDialog({
          title: `Archive ${product.name}?`,
          message: 'Archived products are hidden from billing and lists but keep their history. You can restore them any time.',
          confirmText: 'Archive',
        });
        if (!ok) return;
      }
      try {
        ({ product } = await api(`/products/${product.id}/archive`, { method: 'POST', body: { archived: archiving } }));
        render();
        toast(archiving ? 'Product archived.' : 'Product restored.');
      } catch (err) {
        toastError(err);
      }
    }
  });
  on(el, 'click', '[data-page]', (e, b) => {
    offset = Number(b.dataset.page);
    renderMovements().catch(toastError);
  });

  await loadProduct();
  render();
}
