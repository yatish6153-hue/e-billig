import { api } from '../lib/api.js';
import { html, setHtml, on } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast, toastError, confirmDialog, statusBadge, demoBadge } from '../lib/ui.js';
import { navigate } from '../lib/router.js';
import { openCustomerForm } from '../components/customer-form.js';
import { formatDate } from '/shared/format.js';

export default async function customerDetail(el, { app, params }) {
  let data = await api(`/customers/${params.id}`);

  function render() {
    const { customer: c, stats, bills } = data;
    const money = (v) => app.money(v);
    app.setTitle(c.name);
    const finalized = bills.filter((b) => b.status !== 'draft');
    const drafts = bills.filter((b) => b.status === 'draft');
    setHtml(el, html`
      <a class="back-link" href="/customers">${icon('arrowLeft', 'sm')}Customers</a>
      <div class="page-header">
        <div><div class="row" style="gap:10px"><h1>${c.name}</h1>${demoBadge(c.is_demo)}</div>
          <div class="subtitle">${[c.phone, c.email].filter(Boolean).join(' · ') || 'No contact details'}</div></div>
        <div class="page-actions">
          <a class="btn btn-primary" href="/bills/new?customer_id=${c.id}">${icon('filePlus')}New bill</a>
          <button type="button" class="btn" data-action="edit">${icon('edit')}Edit</button>
          <button type="button" class="btn btn-danger" data-action="delete">${icon('trash')}Delete</button>
        </div>
      </div>
      <div class="stats-grid">
        <div class="card stat"><div class="stat-label">Balance</div>
          <div class="stat-value ${stats.outstanding > 0 ? 'text-bad' : ''}">${money(stats.outstanding)}</div>
          <div class="stat-sub">${stats.outstanding > 0 ? 'Across unpaid and partly paid bills' : 'Nothing due'}</div></div>
        <div class="card stat"><div class="stat-label">Total billed</div><div class="stat-value">${money(stats.total_billed)}</div>
          <div class="stat-sub">${stats.bills_count} invoice${stats.bills_count === 1 ? '' : 's'}</div></div>
        <div class="card stat"><div class="stat-label">Total paid</div><div class="stat-value">${money(stats.total_paid)}</div>
          <div class="stat-sub">${stats.last_bill_date ? `Last bill ${formatDate(stats.last_bill_date)}` : 'No invoices yet'}</div></div>
        <div class="card stat"><div class="stat-label">Details</div>
          <div class="small" style="margin-top:4px;white-space:pre-line">${c.address || 'No address saved'}</div>
</div>
      </div>
      <section class="card">
        <div class="card-header"><h2>Invoice history</h2>${drafts.length ? html`<span class="hint">${drafts.length} draft${drafts.length === 1 ? '' : 's'} not counted</span>` : ''}</div>
        ${bills.length ? html`<div class="table-wrap"><table class="table stack-mobile">
          <thead><tr><th>Invoice</th><th>Date</th><th>Status</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Balance</th></tr></thead>
          <tbody>${[...finalized, ...drafts].map((b) => html`
            <tr class="clickable" data-href="/bills/${b.id}">
              <td class="td-main"><span class="cell-main">${b.invoice_no || `Draft #${b.id}`}</span> ${demoBadge(b.is_demo)}</td>
              <td data-label="Date">${formatDate(b.bill_date)}</td>
              <td data-label="Status">${statusBadge(b)}</td>
              <td data-label="Total" class="r">${money(b.total)}</td>
              <td data-label="Paid" class="r">${b.status === 'draft' ? '—' : money(b.amount_paid)}</td>
              <td data-label="Balance" class="r strong ${b.balance > 0 ? 'text-bad' : 'muted'}">${b.status === 'finalized' ? money(b.balance) : '—'}</td>
            </tr>`)}</tbody>
        </table></div>`
        : html`<div class="empty">${icon('bill')}<h3>No invoices yet</h3><p>Bills for ${c.name} will appear here.</p>
            <a class="btn btn-primary" href="/bills/new?customer_id=${c.id}">${icon('plus')}Create bill</a></div>`}
      </section>`);
  }

  on(el, 'click', '[data-action=edit]', async () => {
    const updated = await openCustomerForm({ customer: data.customer });
    if (updated) {
      data = await api(`/customers/${params.id}`);
      render();
    }
  });
  on(el, 'click', '[data-action=delete]', async () => {
    const c = data.customer;
    if (data.bills.length) {
      toast(`${c.name} has ${data.bills.length} bill${data.bills.length === 1 ? '' : 's'}, so they can't be deleted — their invoice history must be kept.`, 'info');
      return;
    }
    const ok = await confirmDialog({
      title: `Delete ${c.name}?`, message: 'This removes the customer permanently.', confirmText: 'Delete customer', danger: true,
    });
    if (!ok) return;
    try {
      await api(`/customers/${c.id}`, { method: 'DELETE' });
      toast(`${c.name} deleted.`);
      navigate('/customers');
    } catch (err) {
      toastError(err);
    }
  });
  on(el, 'click', 'tr[data-href]', (e, tr) => navigate(tr.dataset.href));

  render();
}
