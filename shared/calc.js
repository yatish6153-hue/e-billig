// Bill calculations shared by the bill editor (live totals) and the server
// (source of truth). All money values are integers in minor units.

/**
 * Compute one line.
 * Exclusive pricing: price is before tax; tax is added on top.
 * Inclusive pricing: price already contains tax; the taxable value is backed out,
 * so the line total always equals qty x price less discount.
 */
export function computeLine(item, pricesIncludeTax = false) {
  const qty = Number(item.quantity) || 0;
  const price = Math.round(Number(item.unit_price) || 0);
  const discountPct = Math.min(100, Math.max(0, Number(item.discount_pct) || 0));
  const rate = Math.max(0, Number(item.tax_rate) || 0);

  if (pricesIncludeTax) {
    const inclusive = Math.round(qty * price);
    const net = inclusive - Math.round((inclusive * discountPct) / 100);
    const taxable = Math.round(net / (1 + rate / 100));
    const gross = Math.round(inclusive / (1 + rate / 100));
    return { gross, discount: gross - taxable, taxable, tax: net - taxable, total: net };
  }

  const gross = Math.round(qty * price);
  const discount = Math.round((gross * discountPct) / 100);
  const taxable = gross - discount;
  const tax = Math.round((taxable * rate) / 100);
  return { gross, discount, taxable, tax, total: taxable + tax };
}

/**
 * Compute a whole bill. discountPct takes a percentage off what the lines come to (bills without tax);
 * it is included in discount_total and reported on its own as bill_discount.
 * @returns {{lines, subtotal, discount_total, bill_discount, taxable_total, tax_total, round_off, total}}
 */
export function computeBill(items, { pricesIncludeTax = false, roundOff = false, discountPct = 0 } = {}) {
  const lines = items.map((item) => computeLine(item, pricesIncludeTax));
  const sum = (key) => lines.reduce((acc, line) => acc + line[key], 0);
  const subtotal = sum('gross');
  const pct = Math.min(100, Math.max(0, Number(discountPct) || 0));
  const billDiscount = Math.round((sum('taxable') * pct) / 100);
  const taxableTotal = sum('taxable') - billDiscount;
  const taxTotal = sum('tax');
  const raw = taxableTotal + taxTotal;
  const total = roundOff ? Math.round(raw / 100) * 100 : raw;
  return {
    lines,
    subtotal,
    discount_total: sum('discount') + billDiscount,
    bill_discount: billDiscount,
    taxable_total: taxableTotal,
    tax_total: taxTotal,
    round_off: total - raw,
    total,
  };
}

/** Group tax by rate: [{rate, taxable, tax}] for rates that produced tax. */
export function taxBreakdown(items) {
  const byRate = new Map();
  for (const item of items) {
    const rate = Number(item.tax_rate) || 0;
    if (rate <= 0) continue;
    const entry = byRate.get(rate) || { rate, taxable: 0, tax: 0 };
    entry.taxable += Number(item.taxable) || 0;
    entry.tax += Number(item.tax) || 0;
    byRate.set(rate, entry);
  }
  return [...byRate.values()].sort((a, b) => a.rate - b.rate);
}

/** Split a tax amount into two equal halves (e.g. CGST + SGST). */
export function splitTax(tax) {
  const first = Math.floor(tax / 2);
  return [first, tax - first];
}

export function paymentStatus(total, paid) {
  if (paid >= total) return 'paid';
  if (paid > 0) return 'partial';
  return 'unpaid';
}
