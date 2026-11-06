// A small month calendar for the Day book and the dashboard. Dates with a shoot booked (Bookings & Shoots) are
// tinted violet with a violet dot per shoot; days with money in or out in the Day book get a green dot when
// `money` is passed (the Day book does; the dashboard shows shoots only).
// Clicks come back through data-mc-day (a date) and data-mc-step (±1 month).
import { html } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { addDays, isoDate, formatDate } from '/shared/format.js';
import { weekStart } from '/shared/bookings.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The dates a month's grid shows: Monday of its first week to Sunday of its last. month = "YYYY-MM". */
export function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  return { from: weekStart(`${month}-01`), to: addDays(weekStart(isoDate(new Date(y, m, 0))), 6) };
}

export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  return isoDate(new Date(y, m - 1 + n, 1)).slice(0, 7);
}

/** Bookings by date: Map(date → [{ b, day }]) for every date of each booking (cancelled ones left out). */
export function shootsByDate(bookings) {
  const map = new Map();
  for (const b of bookings) {
    if (b.status === 'cancelled') continue;
    for (const day of b.schedule) {
      if (!map.has(day.date)) map.set(day.date, []);
      map.get(day.date).push({ b, day });
    }
  }
  for (const list of map.values()) list.sort((x, y) => (x.day.start || '').localeCompare(y.day.start || ''));
  return map;
}

/** Day book days with money in or out: Map(date → day) from /api/day-book/days. */
export function moneyByDate(days) {
  const map = new Map();
  for (const d of days) {
    const moneyIn = d.received_cash + d.received_online;
    const moneyOut = d.spent_cash + d.spent_online;
    if (d.sales || moneyIn || moneyOut) map.set(d.date, { ...d, money_in: moneyIn, money_out: moneyOut });
  }
  return map;
}

/** money: false leaves out the green Day book mark, for a calendar that shows shoots only. */
export const calendarLegend = ({ money = true } = {}) => html`<div class="mc-legend">
  <span><i class="mk-shoot"></i>Shoot booked</span>${money ? html`<span><i class="mk-day"></i>Day book (money in or out)</span>` : ''}</div>`;

export function miniCalendar({ month, selected, today, shoots, money = new Map() }) {
  const { from, to } = monthRange(month);
  const [y, m] = month.split('-').map(Number);
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return html`<div class="mc">
    <div class="mc-head">
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-mc-step="-1" aria-label="Previous month">${icon('chevronLeft')}</button>
      <span class="mc-title">${MONTHS[m - 1]} ${y}</span>
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-mc-step="1" aria-label="Next month">${icon('chevronRight')}</button>
    </div>
    <div class="mc-grid">
      ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => html`<span class="mc-wd">${w.slice(0, 2)}</span>`)}
      ${days.map((d) => {
        const list = shoots.get(d) || [];
        const day = money.get(d);
        const label = [formatDate(d), list.length ? `${list.length} shoot${list.length === 1 ? '' : 's'} booked` : '', day ? 'money in the day book' : '']
          .filter(Boolean).join(', ');
        return html`<button type="button" class="mc-day ${d.slice(0, 7) !== month ? 'is-out' : ''} ${d === today ? 'is-today' : ''}
          ${d === selected ? 'is-selected' : ''} ${list.length ? 'is-booked' : ''}" data-mc-day="${d}" aria-label="${label}" aria-pressed="${d === selected}">
          <span class="mc-no">${Number(d.slice(8))}</span>
          <span class="mc-dots">${list.slice(0, 3).map(() => html`<i class="mk-shoot"></i>`)}${list.length > 3 ? html`<b>+</b>` : ''}${day ? html`<i class="mk-day"></i>` : ''}</span>
        </button>`;
      })}
    </div>
  </div>`;
}
