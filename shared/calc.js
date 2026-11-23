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
 * The price (minor units) that makes a line without tax come to `total` after its discount,
 * for typing a line's total instead of its price. Of the nearby prices it picks one whose line
 * total matches exactly (nearest when none does). Null when no price can: no quantity, a 100%
 * discount, or a total that isn't a whole amount of 0 or more.
 */
export function priceForTotal(total, quantity, discountPct = 0) {
  const qty = Number(quantity) || 0;
  const pct = Math.min(100, Math.max(0, Number(discountPct) || 0));
  const keep = 1 - pct / 100;
  if (!(qty > 0) || keep <= 0 || !Number.isInteger(total) || total < 0) return null;
  const guess = Math.round(total / (qty * keep));
  let best = guess;
  let bestDiff = Infinity;
  for (const step of [0, -1, 1, -2, 2, -3, 3]) {
    const price = guess + step;
    if (price < 0) continue;
    const diff = Math.abs(computeLine({ quantity: qty, unit_price: price, discount_pct: pct }).total - total);
    if (diff < bestDiff) {
      best = price;
      bestDiff = diff;
    }
  }
  return best;
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
