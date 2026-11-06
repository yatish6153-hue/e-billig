// Paying the balance by UPI: a upi:// link that opens Google Pay, PhonePe, Paytm, BHIM or any UPI app
// with the amount filled in, and the same link as a QR code to scan from another phone.
import qrcode from 'qrcode-generator';

/** The UPI payment for a bill's balance, or null when nothing is due or the business has no UPI ID. */
export function upiPayment(business, bill) {
  const balance = bill.status === 'finalized' ? bill.total - bill.amount_paid : 0;
  if (!business.upi_id || balance <= 0 || bill.currency !== 'INR') return null;
  const params = [
    `pa=${business.upi_id}`, // UPI IDs are only letters, digits, . - _ and @
    `pn=${encodeURIComponent(business.name)}`,
    `am=${(balance / 100).toFixed(2)}`,
    'cu=INR',
    `tn=${encodeURIComponent(`Bill ${bill.invoice_no}`)}`,
  ];
  return { amount: balance, link: `upi://pay?${params.join('&')}` };
}

/** QR modules for the text: size x size, dark(row, col). */
export function qrMatrix(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return { size: qr.getModuleCount(), dark: (r, c) => qr.isDark(r, c) };
}

/** The QR code as SVG, with the four-module white border scanners need. */
export function qrSvg(text, label) {
  const { size, dark } = qrMatrix(text);
  const n = size + 8;
  let d = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) if (dark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="${label}">`
    + `<rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
