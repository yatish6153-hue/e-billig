// The dashboard is a set of widgets (boxes) the owner can show, hide, put in order and size (Customize), plus a choice
// of quick actions and of the numbers in the sales summary. Kept per login (users.preferences.dashboard). Each widget
// and action belongs to one part of the app (area), which gives it its colour.

export const DASHBOARD_WIDGETS = [
  { key: 'demo', label: 'Demo data notice', area: 'demo', icon: 'info', wide: true },
  { key: 'actions', label: 'Quick actions', area: 'bills', icon: 'plus', wide: true },
  { key: 'today', label: 'Today’s closing (Day book)', area: 'daybook', icon: 'wallet', wide: true },
  { key: 'calendar', label: 'Calendar', area: 'bookings', icon: 'calendar' },
  { key: 'shoots', label: 'Today’s and upcoming shoots', area: 'bookings', icon: 'camera' },
  { key: 'summary', label: 'Sales summary', area: 'bills', icon: 'trending', wide: true },
  { key: 'work', label: 'Jobs at work (Tracking)', area: 'tracking', icon: 'kanban', wide: true },
  { key: 'reminders', label: 'Booking reminders', area: 'bookings', icon: 'bell' },
  { key: 'bills', label: 'Recent bills', area: 'bills', icon: 'bill' },
  { key: 'stock', label: 'Low-stock alerts', area: 'stock', icon: 'box' },
];
const HIDDEN_AT_FIRST = new Set(['reminders']);

export const QUICK_ACTIONS = [
  { key: 'bill', label: 'New bill', sub: 'Search or scan products', area: 'bills', icon: 'filePlus', href: '/bills/new' },
  { key: 'booking', label: 'New booking', sub: 'Wedding, event or shoot', area: 'bookings', icon: 'camera', href: '/bookings/new' },
  { key: 'daybook', label: 'Day book', sub: 'Sales, money in, expenses', area: 'daybook', icon: 'wallet', href: '/day-book?add=1' },
  { key: 'tracking', label: 'Tracking', sub: 'Jobs at each stage', area: 'tracking', icon: 'kanban', href: '/tracking' },
  { key: 'product', label: 'Add product', sub: 'With opening stock', area: 'stock', icon: 'package', action: 'add-product' },
  { key: 'customer', label: 'Add customer', sub: 'Name, phone, address', area: 'customers', icon: 'userPlus', action: 'add-customer' },
];
export const MAX_ACTIONS = 6;

export const SUMMARY_STATS = [
  { key: 'sales', label: 'Total sales' },
  { key: 'paid', label: 'Paid bills' },
  { key: 'unpaid', label: 'Unpaid bills' },
  { key: 'booking_due', label: 'Due on bookings' },
  { key: 'stock_value', label: 'Inventory value' },
];

const DEFAULT_ACTIONS = ['bill', 'booking', 'daybook', 'product'];
const DEFAULT_STATS = ['sales', 'paid', 'unpaid', 'stock_value'];

// Sizes. On a computer the dashboard is 12 columns wide: a box takes w of them (a quarter up to the full width) and,
// when h is set, that many pixels of height. A box without w takes half the width (wide ones the full width) and
// grows to fill what its row leaves empty; without h it is as tall as what's in it. Tablets show boxes half or full
// width and phones one per row, in the same order.
export const COLUMNS = 12;
export const MIN_WIDTH = 3;
export const HEIGHT = { min: 120, max: 1600, step: 20 };
export const WIDTHS = [[3, '¼'], [4, '⅓'], [6, '½'], [8, '⅔'], [9, '¾'], [12, 'Full']];
export const widthLabel = (w) => WIDTHS.find(([n]) => n === w)?.[1] || `${w}/12`;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const cleanWidth = (w) => (typeof w === 'number' && Number.isFinite(w) ? clamp(Math.round(w), MIN_WIDTH, COLUMNS) : null);
export const cleanHeight = (h) => (typeof h === 'number' && Number.isFinite(h)
  ? Math.round(clamp(h, HEIGHT.min, HEIGHT.max) / HEIGHT.step) * HEIGHT.step : null);

export const widgetInfo = (key) => DASHBOARD_WIDGETS.find((w) => w.key === key);

/**
 * The saved choices made whole: every widget once, in the saved order (any widget added later goes at the end), with
 * a known size or none, and only known quick actions (up to MAX_ACTIONS) and summary numbers (at least one).
 */
export function dashboardPrefs(saved) {
  const s = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const keys = DASHBOARD_WIDGETS.map((w) => w.key);
  const widgets = [];
  for (const w of Array.isArray(s.widgets) ? s.widgets : []) {
    if (w && keys.includes(w.key) && !widgets.some((x) => x.key === w.key)) {
      widgets.push({ key: w.key, show: w.show !== false, w: cleanWidth(w.w), h: cleanHeight(w.h) });
    }
  }
  for (const k of keys) if (!widgets.some((x) => x.key === k)) widgets.push({ key: k, show: !HIDDEN_AT_FIRST.has(k), w: null, h: null });
  const pick = (value, allowed, fallback, max) => {
    const list = Array.isArray(value) ? [...new Set(value.filter((k) => allowed.includes(k)))].slice(0, max) : null;
    return list && list.length ? list : [...fallback];
  };
  return {
    widgets,
    actions: pick(s.actions, QUICK_ACTIONS.map((a) => a.key), DEFAULT_ACTIONS, MAX_ACTIONS),
    stats: pick(s.stats, SUMMARY_STATS.map((x) => x.key), DEFAULT_STATS, SUMMARY_STATS.length),
  };
}

/**
 * How many of the 12 columns each box takes, in order. "wide" (a computer): the box's own width, or half (wide ones
 * full) for a box without one, which then grows to fill what its row leaves empty. "medium" (a tablet): half or full,
 * and the last box of a row fills it. "narrow" (a phone): one box per row.
 */
export function layoutSpans(boxes, mode = 'wide') {
  if (mode === 'narrow') return boxes.map(() => COLUMNS);
  const half = COLUMNS / 2;
  const spans = boxes.map((b) => {
    const w = b.w ?? (widgetInfo(b.key)?.wide ? COLUMNS : half);
    return mode === 'medium' ? (w <= half ? half : COLUMNS) : w;
  });
  const grows = boxes.map((b) => mode === 'medium' || b.w == null);
  let row = [];
  let used = 0;
  const close = () => {
    const last = row.filter((i) => grows[i]).pop();
    if (last !== undefined) spans[last] += COLUMNS - used;
    row = [];
    used = 0;
  };
  spans.forEach((span, i) => {
    if (used + span > COLUMNS) close();
    row.push(i);
    used += span;
  });
  close();
  return spans;
}
