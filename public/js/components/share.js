// Invoice sharing: secure link, clipboard, WhatsApp.
import { api } from '../lib/api.js';
import { copyText, toast } from '../lib/ui.js';
import { formatMoney, formatDate, whatsappNumber } from '/shared/format.js';
import { stageInfo } from '/shared/tracking.js';

export async function ensureShareUrl(bill) {
  if (bill.share_url) return bill.share_url;
  const res = await api(`/bills/${bill.id}/share`, { method: 'POST', body: {} });
  bill.share_url = res.share_url;
  return res.share_url;
}

/** The balance customers can pay online (by UPI, from the bill link): 0 when nothing is due or there's no UPI ID. */
export function payableBalance(business, bill) {
  const balance = bill.status === 'finalized' ? bill.total - bill.amount_paid : 0;
  return business.upi_id && bill.currency === 'INR' && balance > 0 ? balance : 0;
}

export function shareMessage(business, bill, url) {
  const balance = bill.status === 'finalized' ? bill.total - bill.amount_paid : 0;
  const lines = [
    `Hello${bill.customer_name ? ` ${bill.customer_name}` : ''},`,
    '',
    `Here is your bill ${bill.invoice_no} from ${business.name} dated ${formatDate(bill.bill_date)}.`,
    `Total: ${formatMoney(bill.total, bill.currency)}`,
  ];
  if (bill.status === 'finalized') {
    if (bill.amount_paid > 0) lines.push(`Advance: ${formatMoney(bill.amount_paid, bill.currency)}`);
    lines.push(balance > 0 ? `Balance: ${formatMoney(balance, bill.currency)}` : 'Fully paid — thank you!');
  }
  lines.push('', `View or download: ${url}`);
  if (payableBalance(business, bill)) lines.push(`Pay the balance of ${formatMoney(balance, bill.currency)} by UPI: ${url}/pay`);
  return lines.join('\n');
}

/** Work-status update for a tracked job, with the link where the customer can follow it. */
export function statusMessage(business, bill, url) {
  const stage = stageInfo(bill.work_stage);
  const balance = bill.status === 'finalized' ? bill.total - bill.amount_paid : 0;
  const lines = [
    `Hello${bill.customer_name ? ` ${bill.customer_name}` : ''},`,
    '',
    `Update on your order ${bill.invoice_no} from ${business.name}:`,
    `Status: ${stage ? stage.label : 'In progress'} — ${stage ? stage.customer : ''}`.trim(),
  ];
  if (bill.work_stage === 'final' && balance > 0) lines.push(`Balance to pay: ${formatMoney(balance, bill.currency)}`);
  lines.push('', `Track your order: ${url}`);
  if (bill.work_stage === 'final' && payableBalance(business, bill)) lines.push(`Pay the balance by UPI: ${url}/pay`);
  return lines.join('\n');
}

/**
 * Opens WhatsApp with a prefilled message. The window is opened synchronously
 * (before any await) so pop-up blockers allow it, then pointed at WhatsApp.
 * Demo customers are never auto-targeted — their numbers are samples.
 */
export async function shareOnWhatsApp(business, bill, { customerIsDemo = false, message = shareMessage } = {}) {
  const win = window.open('', '_blank');
  try {
    const url = await ensureShareUrl(bill);
    const phone = customerIsDemo ? '' : whatsappNumber(bill.customer_phone, bill.currency);
    const text = encodeURIComponent(message(business, bill, url));
    const target = `https://wa.me/${phone}?text=${text}`;
    if (win) {
      win.opener = null;
      win.location.href = target;
    } else {
      window.location.href = target;
    }
    return url;
  } catch (err) {
    win?.close();
    throw err;
  }
}

export async function copyShareLink(bill, { pay = false } = {}) {
  const url = await ensureShareUrl(bill);
  const link = pay ? `${url}/pay` : url;
  const ok = await copyText(link);
  if (ok) toast(pay ? 'Payment link copied to clipboard.' : 'Invoice link copied to clipboard.');
  else toast(`Copy this link: ${link}`, 'info', { timeout: 12000 });
  return url;
}

export function isLocalUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local') || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host);
  } catch {
    return false;
  }
}
