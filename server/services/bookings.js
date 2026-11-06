// Bookings & Shoots: a booking moves New booking → … → Closed (or goes on hold / is cancelled), with the team on
// the shoot, payments, a shoot checklist, post-production steps, deadlines, delivery, links and an activity log.
// Lists are filtered in memory: a studio has hundreds of bookings, and most filters depend on dates and progress.
import crypto from 'node:crypto';
import { get, all, run, tx, nowIso } from '../db.js';
import * as v from '../util.js';
import { formatMoney, formatDate, isoDate, addDays } from '../../shared/format.js';
import {
  BOOKING_STATUSES, FLOW_KEYS, CHECKLIST, TASK_KEYS, DEADLINES, LINK_TYPES, BOOKING_PAY_METHODS, QUICK_FILTERS,
  bookingNumber, bookingPaymentStatus, shootState, shootDone, deliveryState, calendarTone, deadlineStates, clashDay,
  endDate, deliverablesFor, taskLabel, matchesQuick, bookingReminders, eventTitle, timeRange, scheduleOf, servicesOf,
  bookingTotals, lineAmount, daysOn,
} from '../../shared/bookings.js';
import { getBusiness } from './business.js';
import { resolveCustomer } from './billing.js';

const JSON_FIELDS = ['schedule', 'services', 'checklist', 'tasks', 'deadlines', 'delivery', 'links'];
const LIST_FIELDS = new Set(['schedule', 'services', 'links']);
const parked = (status) => status === 'on_hold' || status === 'cancelled';
const step = (status) => FLOW_KEYS.indexOf(status);
const dayOf = (at) => isoDate(at ? new Date(at) : new Date());

function parse(row) {
  const b = { ...row, is_demo: !!row.is_demo };
  for (const k of JSON_FIELDS) {
    let value = null;
    try {
      value = JSON.parse(row[k] || 'null');
    } catch {
      // A damaged field reads as empty rather than breaking the page.
    }
    const list = LIST_FIELDS.has(k);
    b[k] = (list ? Array.isArray(value) : value && typeof value === 'object' && !Array.isArray(value)) ? value : list ? [] : {};
  }
  // Bookings from before dates and prices (v11) read as dates and bill lines too.
  b.schedule = scheduleOf(b);
  b.services = servicesOf(b);
  return b;
}

function teamOf(ids) {
  const map = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return map;
  for (const t of all(
    `SELECT bt.booking_id, bt.member_id, bt.role, m.name, m.phone FROM booking_team bt JOIN team_members m ON m.id = bt.member_id
      WHERE bt.booking_id IN (SELECT value FROM json_each(?)) ORDER BY bt.id`,
    JSON.stringify(ids),
  )) map.get(t.booking_id)?.push({ member_id: t.member_id, name: t.name, role: t.role, phone: t.phone });
  return map;
}

export function serializeBooking(b, team, today) {
  const deadlines = deadlineStates(b, today);
  return {
    ...b,
    team,
    number: bookingNumber(b.booking_no),
    end_date: endDate(b),
    subtotal: b.total + b.discount,
    balance: b.status === 'cancelled' ? 0 : Math.max(0, b.total - b.amount_paid),
    shoot_state: shootState(b, today),
    delivery_state: deliveryState(b),
    tone: calendarTone(b),
    deadline_states: deadlines,
    overdue: deadlines.filter((d) => d.state === 'overdue').length,
  };
}

function loadAll(businessId, today) {
  const rows = all('SELECT * FROM bookings WHERE business_id = ?', businessId).map(parse);
  const team = teamOf(rows.map((r) => r.id));
  return rows.map((b) => serializeBooking(b, team.get(b.id), today));
}

function owned(businessId, id) {
  const row = get('SELECT * FROM bookings WHERE id = ? AND business_id = ?', v.id(id, 'Booking'), businessId);
  if (!row) throw v.notFound('Booking');
  return parse(row);
}

function log(businessId, bookingId, userId, text, at = null) {
  run('INSERT INTO booking_activity (business_id, booking_id, text, user_id, created_at) VALUES (?, ?, ?, ?, ?)',
    businessId, bookingId, text, userId, at || nowIso());
}

function saveJson(id, field, value, at = null) {
  run(`UPDATE bookings SET ${field} = ?, updated_at = ? WHERE id = ?`, JSON.stringify(value), at || nowIso(), id);
}

function moneyOf(businessId) {
  const { currency } = getBusiness(businessId);
  return (minor) => formatMoney(minor, currency);
}

// ---- Input -------------------------------------------------------------------
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function time(value, field, label) {
  const s = v.text(value, field, label, { max: 5 });
  if (s && !TIME_RE.test(s)) throw v.badRequest(`${label} must be a time like 10:30.`, field);
  return s;
}

/** A web link. "drive.google.com/…" gets https:// in front; anything other than http(s) is refused. */
export function webLink(value, field, label) {
  let s = v.text(value, field, label, { max: 600 });
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  if (!/^https?:\/\/[^\s/?#.]+(\.[^\s/?#.]+)+([/?#]\S*)?$/i.test(s)) {
    throw v.badRequest(`${label} must be a web link, like https://drive.google.com/…`, field);
  }
  return s;
}

/** The services booked, as bill lines with a price each. product_id links one of the studio's own services. */
function readServices(businessId, list) {
  if (list === undefined || list === null || list === '') return [];
  if (!Array.isArray(list)) throw v.badRequest('The services are not valid.', 'services');
  if (list.length > 60) throw v.badRequest('A booking can have up to 60 services.', 'services');
  return list.map((s, i) => {
    const f = (k) => `services.${i}.${k}`;
    const name = v.text(s?.name, f('name'), `Service ${i + 1}`, { max: 120, required: true });
    const qty = v.number(s?.qty, f('qty'), `Quantity for ${name}`, { min: 0.01, max: 100000, decimals: 2, required: false, fallback: 1 });
    const rate = v.money(s?.rate, f('rate'), `Price for ${name}`, { required: false });
    const line = { name, qty, rate, amount: lineAmount(qty, rate) };
    const productId = Number(s?.product_id);
    if (Number.isInteger(productId) && productId > 0
      && get("SELECT 1 FROM products WHERE id = ? AND business_id = ? AND kind = 'service'", productId, businessId)) line.product_id = productId;
    return line;
  });
}

/**
 * The event's dates, each with its own times and venue. A caller may instead send one event_date with a number of
 * days, times and a venue (how bookings were made before dates could differ): those become consecutive dates.
 */
function readSchedule(body) {
  let list = body.schedule;
  if (!Array.isArray(list)) {
    if (!body.event_date) throw v.badRequest('Add the event date.', 'event_date');
    const first = v.date(body.event_date, 'event_date', 'Event date');
    const days = v.integer(body.days, 'days', 'Number of days', { min: 1, max: 30, required: false, fallback: 1 });
    list = Array.from({ length: days }, (_, i) => ({ date: addDays(first, i), start: body.start_time, end: body.end_time, venue: body.venue }));
  }
  if (!list.length) throw v.badRequest('Add the event date.', 'schedule.0.date');
  if (list.length > 30) throw v.badRequest('A booking can have up to 30 dates.', 'schedule');
  return list.map((d, i) => {
    const f = (k) => `schedule.${i}.${k}`;
    const n = list.length > 1 ? ` (date ${i + 1})` : '';
    return {
      date: v.date(d?.date, f('date'), `Event date${n}`),
      start: time(d?.start, f('start'), `Start time${n}`),
      end: time(d?.end, f('end'), `End time${n}`),
      venue: v.text(d?.venue, f('venue'), `Venue${n}`, { max: 120 }),
    };
  }).sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`));
}

/** The people on a booking, one role each. Only this business's team members can be chosen. */
function readTeam(businessId, list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw v.badRequest('The team is not valid.', 'team');
  const out = [];
  for (const t of list.slice(0, 40)) {
    const memberId = Number(t?.member_id);
    const m = Number.isInteger(memberId) && memberId > 0
      ? get('SELECT id, name, role FROM team_members WHERE id = ? AND business_id = ?', memberId, businessId)
      : null;
    if (!m) throw v.badRequest('Choose each team member from the list.', 'team');
    if (out.some((x) => x.member_id === m.id)) continue;
    out.push({ member_id: m.id, name: m.name, role: v.text(t.role, 'team', 'Role', { max: 40 }) || m.role });
  }
  return out;
}

/**
 * Client, event dates, services and team. The total is the services' sum less the discount. The first date's day,
 * times and venue are also kept in event_date / start_time / end_time / venue (for sorting and older readers).
 * Phone and email aren't on the form any more: left out, a booking keeps what it had.
 */
function readBooking(businessId, body) {
  const schedule = readSchedule(body);
  const services = readServices(businessId, body.services);
  const { subtotal } = bookingTotals(services);
  const discount = v.money(body.discount, 'discount', 'Discount', { required: false });
  if (discount > subtotal) throw v.badRequest("The discount can't be more than the services add up to.", 'discount');
  const [first] = schedule;
  return {
    client_name: v.text(body.client_name, 'client_name', 'Client name', { max: 120, required: true }),
    client_whatsapp: v.phone(body.client_whatsapp, 'client_whatsapp', 'WhatsApp number'),
    client_phone: body.client_phone === undefined ? undefined : v.phone(body.client_phone, 'client_phone', 'Phone number'),
    client_email: body.client_email === undefined ? undefined : v.email(body.client_email, 'client_email'),
    client_alt: v.text(body.client_alt, 'client_alt', 'Alternative contact', { max: 120 }),
    client_address: v.text(body.client_address, 'client_address', 'Address', { max: 500, multiline: true }),
    event_type: v.text(body.event_type, 'event_type', 'Event type', { max: 40 }),
    event_name: v.text(body.event_name, 'event_name', 'Event name', { max: 120 }),
    event_notes: v.text(body.event_notes, 'event_notes', 'Notes', { max: 2000, multiline: true }),
    schedule,
    event_date: first.date,
    start_time: first.start,
    end_time: first.end,
    venue: first.venue,
    days: schedule.length,
    services,
    discount,
    total: subtotal - discount,
    package_name: v.text(body.package_name, 'package_name', 'Package name', { max: 120 }),
    team: readTeam(businessId, body.team),
  };
}

function readPayment(body, prefix = '') {
  const f = (k) => (prefix ? `${prefix}_${k}` : k);
  return {
    amount: v.money(body.amount, f('amount'), prefix ? 'Advance received' : 'Amount', { min: 1 }),
    method: v.oneOf(body.method || 'cash', Object.keys(BOOKING_PAY_METHODS), f('method'), 'Payment method'),
    paid_on: v.date(body.paid_on || isoDate(), f('date'), 'Date'),
    note: v.text(body.note, f('note'), 'Note', { max: 120 }),
  };
}

// ---- Team clashes ------------------------------------------------------------
/** Other bookings (not cancelled) where someone on `team` is already working at an overlapping time. */
export function teamConflicts(businessId, booking, team, excludeId = 0) {
  if (!team.length) return [];
  const rows = all(
    `SELECT b.id, b.booking_no, b.client_name, b.event_type, b.event_name, b.event_date, b.days, b.start_time, b.end_time,
            b.venue, b.schedule, bt.member_id, m.name AS member_name
       FROM booking_team bt JOIN bookings b ON b.id = bt.booking_id JOIN team_members m ON m.id = bt.member_id
      WHERE b.business_id = ? AND b.status <> 'cancelled' AND b.id <> ? AND bt.member_id IN (SELECT value FROM json_each(?))
      ORDER BY b.event_date, b.start_time`,
    businessId, excludeId || 0, JSON.stringify(team.map((t) => t.member_id)),
  );
  return rows.flatMap((row) => {
    const o = parse(row);
    const day = clashDay(booking, o);
    return day ? [{
      member_id: o.member_id,
      member_name: o.member_name,
      booking_id: o.id,
      number: bookingNumber(o.booking_no),
      title: eventTitle(o),
      // The other booking's date that clashes.
      event_date: day.date,
      end_date: day.date,
      time: timeRange(day),
      venue: day.venue,
    }] : [];
  });
}

function conflictError(conflicts) {
  const c = conflicts[0];
  const first = `${c.member_name} is already on ${c.number} (${c.title}) on ${formatDate(c.event_date)}${c.time ? `, ${c.time}` : ''}${c.venue ? ` at ${c.venue}` : ''}.`;
  const more = conflicts.length > 1 ? ` ${conflicts.length - 1} more clash${conflicts.length > 2 ? 'es' : ''} too.` : '';
  return v.conflict(first + more, { code: 'TEAM_CONFLICT', details: conflicts });
}

const teamText = (team) => team.map((t) => (t.role ? `${t.name} (${t.role})` : t.name)).join(', ');

function writeTeam(businessId, userId, b, team, at) {
  const before = teamOf([b.id]).get(b.id);
  run('DELETE FROM booking_team WHERE booking_id = ?', b.id);
  for (const t of team) run('INSERT INTO booking_team (booking_id, member_id, role) VALUES (?, ?, ?)', b.id, t.member_id, t.role);
  const added = team.filter((t) => !before.some((x) => x.member_id === t.member_id && x.role === t.role));
  const removed = before.filter((x) => !team.some((t) => t.member_id === x.member_id));
  if (added.length) log(businessId, b.id, userId, `Assigned: ${teamText(added)}`, at);
  if (removed.length) log(businessId, b.id, userId, `Removed from the team: ${removed.map((x) => x.name).join(', ')}`, at);
  // Assigning people ticks "Team assigned" (and "Editor assigned" once someone is the editor).
  const checklist = { ...b.checklist };
  if (team.length && !checklist.team) checklist.team = dayOf(at);
  if (team.some((t) => /editor/i.test(t.role)) && !checklist.editor) checklist.editor = dayOf(at);
  if (JSON.stringify(checklist) !== JSON.stringify(b.checklist)) saveJson(b.id, 'checklist', checklist, at);
}

// ---- Payments ----------------------------------------------------------------
function refreshPayments(bookingId) {
  const { paid } = get('SELECT COALESCE(SUM(amount), 0) AS paid FROM booking_payments WHERE booking_id = ?', bookingId);
  const { total } = get('SELECT total FROM bookings WHERE id = ?', bookingId);
  run('UPDATE bookings SET amount_paid = ?, payment_status = ? WHERE id = ?', paid, bookingPaymentStatus(total, paid), bookingId);
}

function insertPayment(businessId, userId, bookingId, p, at) {
  run(
    `INSERT INTO booking_payments (business_id, booking_id, amount, method, note, paid_on, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    businessId, bookingId, p.amount, p.method, p.note, p.paid_on, userId, at || nowIso(),
  );
}

/** Delivered and paid in full closes the project; money due again on a closed project re-opens it. */
function settleStatus(businessId, userId, bookingId, at) {
  const r = get('SELECT status, total, amount_paid FROM bookings WHERE id = ?', bookingId);
  if (r.status === 'delivered' && r.total > 0 && r.amount_paid >= r.total) {
    run("UPDATE bookings SET status = 'closed' WHERE id = ?", bookingId);
    log(businessId, bookingId, userId, 'Project closed · delivered and paid', at);
  } else if (r.status === 'closed' && r.amount_paid < r.total) {
    run("UPDATE bookings SET status = 'delivered' WHERE id = ?", bookingId);
    log(businessId, bookingId, userId, 'Re-opened · payment due', at);
  }
}

// ---- Create & change -----------------------------------------------------------
/**
 * New booking. The client is saved as a customer (like a bill's). An advance becomes the first payment.
 * A team clash is refused with code TEAM_CONFLICT unless allow_conflicts is set.
 */
export function createBooking(businessId, userId, body, { isDemo = false, customerId = null, at = null } = {}) {
  const input = readBooking(businessId, body);
  const status = body.status ? v.oneOf(body.status, FLOW_KEYS, 'status', 'Status') : 'new';
  const a = body.advance;
  const advance = a && ![undefined, null, '', 0, '0'].includes(a.amount) ? readPayment(a, 'advance') : null;
  if (advance && advance.amount > input.total) throw v.badRequest("The advance can't be more than the total.", 'advance_amount');
  if (status === 'closed' && (advance?.amount || 0) < input.total) {
    throw v.badRequest('A booking is closed once it is paid in full. Choose another status, or enter the full amount as the advance.', 'status');
  }
  const money = moneyOf(businessId);
  return tx(() => {
    const conflicts = teamConflicts(businessId, input, input.team);
    if (conflicts.length && !v.bool(body.allow_conflicts)) throw conflictError(conflicts);
    const customer = isDemo
      ? customerId
      : resolveCustomer(businessId, { id: null, name: input.client_name, phone: input.client_whatsapp || input.client_phone || '' })?.id ?? null;
    const { next } = get('SELECT next_booking_no AS next FROM businesses WHERE id = ?', businessId);
    const { top } = get('SELECT COALESCE(MAX(booking_no), 0) AS top FROM bookings WHERE business_id = ?', businessId);
    const no = Math.max(next, top + 1);
    run('UPDATE businesses SET next_booking_no = ? WHERE id = ?', no + 1, businessId);
    const when = at || nowIso();
    const r = run(
      `INSERT INTO bookings (business_id, booking_no, status, customer_id, client_name, client_phone, client_whatsapp, client_email,
         client_alt, client_address, event_type, event_name, event_date, start_time, end_time, days, venue, schedule, event_notes,
         services, discount, package_name, total, checklist, is_demo, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      businessId, no, status, customer, input.client_name, input.client_phone ?? '', input.client_whatsapp, input.client_email ?? '',
      input.client_alt, input.client_address, input.event_type, input.event_name, input.event_date, input.start_time, input.end_time,
      input.days, input.venue, JSON.stringify(input.schedule), input.event_notes, JSON.stringify(input.services), input.discount,
      input.package_name, input.total, JSON.stringify(step(status) >= step('shot') ? { shoot: dayOf(at) } : {}), isDemo ? 1 : 0,
      userId, when, when,
    );
    const id = Number(r.lastInsertRowid);
    log(businessId, id, userId, `Booking created · ${BOOKING_STATUSES[status]}`, when);
    writeTeam(businessId, userId, owned(businessId, id), input.team, when);
    if (advance) {
      insertPayment(businessId, userId, id, advance, when);
      log(businessId, id, userId, `${money(advance.amount)} advance received · ${BOOKING_PAY_METHODS[advance.method]}`, when);
    }
    refreshPayments(id);
    settleStatus(businessId, userId, id, when);
    return id;
  });
}

/** Change the client, event, services, package and team. Status, payments and progress have their own calls. */
export function updateBooking(businessId, userId, id, body) {
  const b = owned(businessId, id);
  const input = readBooking(businessId, body);
  const money = moneyOf(businessId);
  if (input.total < b.amount_paid) {
    throw v.badRequest(`The total can't be less than what's been received (${money(b.amount_paid)}).`, 'services');
  }
  input.client_phone ??= b.client_phone;
  input.client_email ??= b.client_email;
  tx(() => {
    const conflicts = b.status === 'cancelled' ? [] : teamConflicts(businessId, input, input.team, b.id);
    if (conflicts.length && !v.bool(body.allow_conflicts)) throw conflictError(conflicts);
    // The same client (name unchanged) keeps their saved customer, whose number follows a correction. A new name is a
    // different client, as on a bill.
    const sameClient = b.customer_id && input.client_name.toLowerCase() === b.client_name.toLowerCase()
      && get('SELECT 1 FROM customers WHERE id = ? AND business_id = ?', b.customer_id, businessId);
    const customer = b.is_demo
      ? b.customer_id
      : resolveCustomer(businessId, {
        id: sameClient ? b.customer_id : null, name: input.client_name, phone: input.client_whatsapp || input.client_phone || '',
      })?.id ?? null;
    run(
      `UPDATE bookings SET customer_id = ?, client_name = ?, client_phone = ?, client_whatsapp = ?, client_email = ?, client_alt = ?,
         client_address = ?, event_type = ?, event_name = ?, event_date = ?, start_time = ?, end_time = ?, days = ?, venue = ?,
         schedule = ?, event_notes = ?, services = ?, discount = ?, package_name = ?, total = ?, updated_at = ? WHERE id = ?`,
      customer, input.client_name, input.client_phone, input.client_whatsapp, input.client_email, input.client_alt,
      input.client_address, input.event_type, input.event_name, input.event_date, input.start_time, input.end_time, input.days,
      input.venue, JSON.stringify(input.schedule), input.event_notes, JSON.stringify(input.services), input.discount,
      input.package_name, input.total, nowIso(), b.id,
    );
    const moved = JSON.stringify(input.schedule) !== JSON.stringify(b.schedule);
    const changed = Object.keys(input).some((k) => k !== 'team' && JSON.stringify(input[k]) !== JSON.stringify(b[k]));
    if (changed) log(businessId, b.id, userId, 'Booking details updated', null);
    if (moved) {
      const dates = input.schedule.map((d) => [formatDate(d.date), timeRange(d)].filter(Boolean).join(' '));
      log(businessId, b.id, userId, `Dates: ${dates.join(' · ')}`, null);
    }
    if (input.total !== b.total) log(businessId, b.id, userId, `Total changed to ${money(input.total)}`, null);
    writeTeam(businessId, userId, b, input.team, null);
    refreshPayments(b.id);
    settleStatus(businessId, userId, b.id, null);
  });
}

/** Just the team (from the booking page). */
export function setTeam(businessId, userId, id, body) {
  const b = owned(businessId, id);
  const team = readTeam(businessId, body.team);
  tx(() => {
    const conflicts = b.status === 'cancelled' ? [] : teamConflicts(businessId, b, team, b.id);
    if (conflicts.length && !v.bool(body.allow_conflicts)) throw conflictError(conflicts);
    writeTeam(businessId, userId, b, team, null);
    run('UPDATE bookings SET updated_at = ? WHERE id = ?', nowIso(), b.id);
  });
}

const STATUS_NOTES = {
  new: 'Back to New booking',
  confirmed: 'Booking confirmed',
  scheduled: 'Shoot scheduled',
  shot: 'Shoot completed',
  editing: 'Editing started',
  review: 'Sent for client review',
  ready: 'Ready for delivery',
  delivered: 'Delivered',
  closed: 'Project closed',
};

/** Move to any status. On hold / cancelled remember the step they left, so the booking can carry on from there. */
export function setStatus(businessId, userId, id, body, { at = null } = {}) {
  const b = owned(businessId, id);
  const status = v.oneOf(body.status, Object.keys(BOOKING_STATUSES), 'status', 'Status');
  if (status === b.status) return;
  if (status === 'closed' && b.amount_paid < b.total) {
    throw v.badRequest(`${moneyOf(businessId)(b.total - b.amount_paid)} is still due. A booking is closed once it is paid in full.`, 'status');
  }
  // A cancelled booking held no one, so bringing it back checks its team as a new booking would.
  if (b.status === 'cancelled') {
    const conflicts = teamConflicts(businessId, b, teamOf([b.id]).get(b.id), b.id);
    if (conflicts.length && !v.bool(body.allow_conflicts)) throw conflictError(conflicts);
  }
  const reason = status === 'cancelled' ? v.text(body.reason, 'reason', 'Reason', { max: 200 }) : '';
  const prev = parked(status) ? (parked(b.status) ? b.prev_status : b.status) : null;
  let note;
  if (status === 'cancelled') note = `Booking cancelled${reason ? ` · ${reason}` : ''}`;
  else if (status === 'on_hold') note = 'Put on hold';
  else if (parked(b.status)) note = `${b.status === 'on_hold' ? 'Back from hold' : 'Booking restored'} · ${BOOKING_STATUSES[status]}`;
  else if (step(status) < step(b.status)) note = `Moved back to ${BOOKING_STATUSES[status]}`;
  else note = STATUS_NOTES[status];
  tx(() => {
    run('UPDATE bookings SET status = ?, prev_status = ?, cancel_reason = ?, updated_at = ? WHERE id = ?', status, prev, reason, at || nowIso(), b.id);
    if (status === 'shot' && !b.checklist.shoot) saveJson(b.id, 'checklist', { ...b.checklist, shoot: dayOf(at) }, at);
    log(businessId, b.id, userId, note, at);
    // Delivered and already paid in full closes, as it would on the payment.
    settleStatus(businessId, userId, b.id, at);
  });
}

export function setChecklist(businessId, userId, id, body, { at = null } = {}) {
  const b = owned(businessId, id);
  const key = v.oneOf(body.key, CHECKLIST.map((c) => c.key), 'key', 'Checklist item');
  const done = v.bool(body.done);
  if (!!b.checklist[key] === done) return;
  const checklist = { ...b.checklist };
  if (done) checklist[key] = dayOf(at);
  else delete checklist[key];
  const { label } = CHECKLIST.find((c) => c.key === key);
  tx(() => {
    saveJson(b.id, 'checklist', checklist, at);
    // Ticking "Shoot completed" on a booking that hasn't got there yet moves it to Shoot completed.
    if (key === 'shoot' && done && !parked(b.status) && step(b.status) < step('shot')) run("UPDATE bookings SET status = 'shot' WHERE id = ?", b.id);
    log(businessId, b.id, userId, done ? label : `${label}: unticked`, at);
  });
}

/** A post-production step. The first step ticked after the shoot moves the booking to Editing. */
export function setTask(businessId, userId, id, body, { at = null } = {}) {
  const b = owned(businessId, id);
  const key = v.oneOf(body.key, TASK_KEYS, 'key', 'Step');
  const done = v.bool(body.done);
  if (!!b.tasks[key] === done) return;
  const tasks = { ...b.tasks };
  if (done) tasks[key] = dayOf(at);
  else delete tasks[key];
  tx(() => {
    saveJson(b.id, 'tasks', tasks, at);
    log(businessId, b.id, userId, done ? taskLabel(key) : `${taskLabel(key)}: unticked`, at);
    if (done && b.status === 'shot') {
      run("UPDATE bookings SET status = 'editing' WHERE id = ?", b.id);
      log(businessId, b.id, userId, STATUS_NOTES.editing, at);
    }
  });
}

export function setDeadlines(businessId, userId, id, body, { at = null } = {}) {
  const b = owned(businessId, id);
  const input = body.deadlines && typeof body.deadlines === 'object' ? body.deadlines : {};
  const deadlines = {};
  for (const d of DEADLINES) {
    const date = v.date(input[d.key], `deadline_${d.key}`, `${d.label} deadline`, { required: false });
    if (date) deadlines[d.key] = date;
  }
  const changed = DEADLINES.filter((d) => (deadlines[d.key] || '') !== (b.deadlines[d.key] || ''));
  if (!changed.length) return;
  tx(() => {
    saveJson(b.id, 'deadlines', deadlines, at);
    log(businessId, b.id, userId, `Deadlines: ${changed.map((d) => (deadlines[d.key] ? `${d.label} ${formatDate(deadlines[d.key])}` : `${d.label} removed`)).join(', ')}`, at);
  });
}

/** The delivery record in a fixed shape (checked when it comes from the form, as stored otherwise). */
function readDelivery(d, check) {
  const link = (value, field, label) => (check ? webLink(value, field, label) : String(value || ''));
  const text = (value, field, label, opts) => (check ? v.text(value, field, label, opts) : String(value || ''));
  return {
    photos: v.bool(d.photos),
    video: v.bool(d.video),
    album: v.bool(d.album),
    reels: v.bool(d.reels),
    date: (check ? v.date(d.date, 'delivery_date', 'Delivery date', { required: false }) : d.date) || '',
    method: text(d.method, 'delivery_method', 'Delivery method', { max: 40 }),
    drive: link(d.drive, 'delivery_drive', 'Google Drive link'),
    dropbox: link(d.dropbox, 'delivery_dropbox', 'Dropbox link'),
    other: link(d.other, 'delivery_other', 'Other download link'),
    storage: text(d.storage, 'delivery_storage', 'Hard drive / pen drive', { max: 120 }),
    notes: text(d.notes, 'delivery_notes', 'Delivery notes', { max: 1000, multiline: true }),
  };
}

/** What was delivered, when and how. Once everything booked is delivered, the booking moves to Delivered. */
export function setDelivery(businessId, userId, id, body, { at = null } = {}) {
  const b = owned(businessId, id);
  const d = body.delivery && typeof body.delivery === 'object' ? body.delivery : {};
  const delivery = readDelivery(d, true);
  if (JSON.stringify(delivery) === JSON.stringify(readDelivery(b.delivery, false))) return;
  const items = deliverablesFor(b.services);
  const newly = items.filter((x) => delivery[x.key] && !b.delivery[x.key]);
  tx(() => {
    saveJson(b.id, 'delivery', delivery, at);
    log(businessId, b.id, userId, newly.length
      ? `${newly.map((x) => x.label).join(', ')}${delivery.method ? ` · ${delivery.method}` : ''}`
      : 'Delivery details updated', at);
    if (items.length && items.every((x) => delivery[x.key]) && step(b.status) >= step('shot') && step(b.status) < step('delivered')) {
      run("UPDATE bookings SET status = 'delivered' WHERE id = ?", b.id);
      log(businessId, b.id, userId, STATUS_NOTES.delivered, at);
      settleStatus(businessId, userId, b.id, at);
    }
  });
}

export function setNotes(businessId, id, body) {
  const b = owned(businessId, id);
  const notes = v.text(body.internal_notes, 'internal_notes', 'Internal notes', { max: 5000, multiline: true });
  run('UPDATE bookings SET internal_notes = ?, updated_at = ? WHERE id = ?', notes, nowIso(), b.id);
}

export function addLink(businessId, userId, id, body, { at = null } = {}) {
  const b = owned(businessId, id);
  const type = v.oneOf(body.type || 'other', Object.keys(LINK_TYPES), 'type', 'Link type');
  const url = webLink(body.url, 'url', 'Link');
  if (!url) throw v.badRequest('Paste the link.', 'url');
  const label = v.text(body.label, 'label', 'Name', { max: 80 });
  if (b.links.length >= 50) throw v.badRequest('A booking can keep up to 50 links.', 'url');
  const link = { id: crypto.randomBytes(6).toString('hex'), type, label, url, added_on: dayOf(at) };
  tx(() => {
    saveJson(b.id, 'links', [...b.links, link], at);
    log(businessId, b.id, userId, `Link added: ${label || LINK_TYPES[type]}`, at);
  });
}

export function removeLink(businessId, userId, id, linkId) {
  const b = owned(businessId, id);
  const link = b.links.find((l) => l.id === String(linkId));
  if (!link) throw v.notFound('Link');
  tx(() => {
    saveJson(b.id, 'links', b.links.filter((l) => l !== link));
    log(businessId, b.id, userId, `Link removed: ${link.label || LINK_TYPES[link.type]}`);
  });
}

export function addBookingPayment(businessId, userId, id, body, { at = null } = {}) {
  const b = owned(businessId, id);
  const money = moneyOf(businessId);
  if (b.status === 'cancelled') throw v.conflict('This booking is cancelled.');
  if (b.total <= 0) throw v.badRequest('Add the package amount first (Edit booking).', 'amount');
  const balance = b.total - b.amount_paid;
  if (balance <= 0) throw v.conflict('This booking is already fully paid.');
  const p = readPayment(body);
  if (p.amount > balance) throw v.badRequest(`Amount can't be more than the balance (${money(balance)}).`, 'amount');
  tx(() => {
    insertPayment(businessId, userId, b.id, p, at);
    refreshPayments(b.id);
    log(businessId, b.id, userId, `${money(p.amount)} payment received · ${BOOKING_PAY_METHODS[p.method]}${p.note ? ` · ${p.note}` : ''}`, at);
    settleStatus(businessId, userId, b.id, at);
  });
}

export function deleteBookingPayment(businessId, userId, id, paymentId) {
  const b = owned(businessId, id);
  const p = get('SELECT * FROM booking_payments WHERE id = ? AND booking_id = ?', v.id(paymentId, 'Payment'), b.id);
  if (!p) throw v.notFound('Payment');
  const money = moneyOf(businessId);
  tx(() => {
    run('DELETE FROM booking_payments WHERE id = ?', p.id);
    refreshPayments(b.id);
    log(businessId, b.id, userId, `${money(p.amount)} payment removed (${formatDate(p.paid_on)})`);
    settleStatus(businessId, userId, b.id, null);
  });
}

/** Deletes the booking with its payments, team and history. */
export function deleteBooking(businessId, id) {
  const b = owned(businessId, id);
  run('DELETE FROM bookings WHERE id = ?', b.id);
  return { number: bookingNumber(b.booking_no) };
}

// ---- Reading -------------------------------------------------------------------
export function bookingDetail(businessId, id, today) {
  const b = owned(businessId, id);
  const team = teamOf([b.id]).get(b.id);
  return {
    booking: serializeBooking(b, team, today),
    payments: all('SELECT id, amount, method, note, paid_on, created_at FROM booking_payments WHERE booking_id = ? ORDER BY paid_on DESC, id DESC', b.id),
    activity: all('SELECT id, text, created_at FROM booking_activity WHERE booking_id = ? ORDER BY created_at DESC, id DESC LIMIT 300', b.id),
    conflicts: b.status === 'cancelled' ? [] : teamConflicts(businessId, b, team, b.id),
  };
}

/** Client name, phone, booking ID ("12", "0012", "BK-0012"), event or venue. */
function matchesSearch(b, q) {
  const term = q.toLowerCase();
  const venues = b.schedule.map((d) => d.venue);
  const text = [b.client_name, b.event_type, b.event_name, ...venues, b.package_name, b.number].join(' ').toLowerCase();
  if (text.includes(term)) return true;
  const digits = q.replace(/\D/g, '');
  if (!digits) return false;
  if (/^(bk[\s-]*)?\d+$/i.test(q.trim()) && Number(digits) === b.booking_no) return true;
  return digits.length >= 3 && [b.client_phone, b.client_whatsapp, b.client_alt].some((p) => String(p).replace(/\D/g, '').includes(digits.slice(-10)));
}

/** Upcoming bookings first (soonest first), then past ones (latest first). */
function byDate(today) {
  return (a, b) => {
    const ua = a.end_date >= today;
    const ub = b.end_date >= today;
    if (ua !== ub) return ua ? -1 : 1;
    const c = `${a.event_date}${a.start_time}`.localeCompare(`${b.event_date}${b.start_time}`);
    return (ua ? c : -c) || b.id - a.id;
  };
}

/**
 * Filters: q (search), from / to (a date of the event in the range), type, status, payment (unpaid | partial | paid),
 * delivery (a delivery state), member (team member id) and quick (a quick filter).
 */
export function listBookings(businessId, query, today) {
  let list = loadAll(businessId, today);
  const eventTypes = [...new Set(list.map((b) => b.event_type).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const q = String(query.q || '').trim();
  if (q) list = list.filter((b) => matchesSearch(b, q));
  const from = v.optionalDate(query.from);
  const to = v.optionalDate(query.to);
  if (from || to) list = list.filter((b) => b.schedule.some((d) => (!from || d.date >= from) && (!to || d.date <= to)));
  const type = String(query.type || '').toLowerCase();
  if (type) list = list.filter((b) => b.event_type.toLowerCase() === type);
  if (query.status) list = list.filter((b) => b.status === query.status);
  if (query.payment) list = list.filter((b) => b.payment_status === query.payment && (query.payment === 'paid' || b.status !== 'cancelled'));
  if (query.delivery) list = list.filter((b) => b.delivery_state === query.delivery);
  const member = Number(query.member);
  if (member) list = list.filter((b) => b.team.some((t) => t.member_id === member));
  if (QUICK_FILTERS.some(([k]) => k === query.quick)) list = list.filter((b) => matchesQuick(b, query.quick, today));
  list.sort(byDate(today));
  const { limit } = v.paging(query, { defaultLimit: 200, maxLimit: 1000 });
  return { bookings: list.slice(0, limit), total: list.length, event_types: eventTypes };
}

const brief = (b) => ({
  id: b.id, number: b.number, status: b.status, client_name: b.client_name, event_type: b.event_type, event_name: b.event_name,
  event_date: b.event_date, end_date: b.end_date, balance: b.balance, is_demo: b.is_demo,
});

/**
 * The top of the Bookings page: summary counts, quick-filter counts, today's and upcoming shoots, reminders.
 * Each shoot carries `day`: the date it's listed for (today's, or the next one), with that date's times and venue.
 */
export function bookingOverview(businessId, today) {
  const list = loadAll(businessId, today);
  const count = (quick) => list.filter((b) => matchesQuick(b, quick, today)).length;
  const due = list.filter((b) => matchesQuick(b, 'payment', today));
  const byTime = (a, b) => `${a.day.date}${a.day.start}`.localeCompare(`${b.day.date}${b.day.start}`);
  const after = (b) => b.schedule.find((d) => d.date > today);
  return {
    today,
    summary: {
      total: list.filter((b) => b.status !== 'cancelled').length,
      cancelled: list.filter((b) => b.status === 'cancelled').length,
      upcoming: count('upcoming'),
      shot: count('shot'),
      editing: count('editing'),
      ready: list.filter((b) => b.status === 'ready').length,
      delivered: count('completed'),
      payment: due.length,
      due: due.reduce((a, b) => a + b.balance, 0),
    },
    quick: Object.fromEntries(QUICK_FILTERS.map(([k]) => [k, count(k)])),
    today_shoots: list.filter((b) => matchesQuick(b, 'today', today)).map((b) => ({ ...b, day: daysOn(b, today)[0] })).sort(byTime),
    upcoming_shoots: list.filter((b) => !parked(b.status) && !shootDone(b) && after(b))
      .map((b) => ({ ...b, day: after(b) })).sort(byTime).slice(0, 8),
    reminders: bookingReminders(list, today).slice(0, 40).map((r) => ({ ...r, booking: brief(r.booking) })),
  };
}

// ---- Team members ----------------------------------------------------------------
const serializeMember = (m) => ({ ...m, active: !!m.active, is_demo: !!m.is_demo });

export function listTeam(businessId) {
  return all(
    `SELECT m.*, (SELECT COUNT(*) FROM booking_team bt JOIN bookings b ON b.id = bt.booking_id
                   WHERE bt.member_id = m.id AND b.status <> 'cancelled'
                     AND (b.event_date >= ? OR EXISTS (SELECT 1 FROM json_each(b.schedule) d WHERE json_extract(d.value, '$.date') >= ?))) AS upcoming
       FROM team_members m WHERE m.business_id = ? AND m.active = 1 ORDER BY m.name COLLATE NOCASE`,
    isoDate(), isoDate(), businessId,
  ).map(serializeMember);
}

function readMember(body) {
  return {
    name: v.text(body.name, 'name', 'Name', { max: 80, required: true }),
    role: v.text(body.role, 'role', 'Role', { max: 40 }),
    phone: v.phone(body.phone, 'phone', 'Phone'),
  };
}

function ownedMember(businessId, id) {
  const m = get('SELECT * FROM team_members WHERE id = ? AND business_id = ?', v.id(id, 'Team member'), businessId);
  if (!m) throw v.notFound('Team member');
  return m;
}

export function createMember(businessId, body, { isDemo = false } = {}) {
  const m = readMember(body);
  const r = run('INSERT INTO team_members (business_id, name, role, phone, is_demo) VALUES (?, ?, ?, ?, ?)',
    businessId, m.name, m.role, m.phone, isDemo ? 1 : 0);
  return serializeMember(get('SELECT * FROM team_members WHERE id = ?', Number(r.lastInsertRowid)));
}

export function updateMember(businessId, id, body) {
  const m = ownedMember(businessId, id);
  const d = readMember(body);
  run('UPDATE team_members SET name = ?, role = ?, phone = ?, updated_at = ? WHERE id = ?', d.name, d.role, d.phone, nowIso(), m.id);
  return serializeMember(get('SELECT * FROM team_members WHERE id = ?', m.id));
}

/** Someone who has worked on bookings leaves the list but keeps their name on those bookings. */
export function removeMember(businessId, id) {
  const m = ownedMember(businessId, id);
  const { n } = get('SELECT COUNT(*) AS n FROM booking_team WHERE member_id = ?', m.id);
  if (n) run('UPDATE team_members SET active = 0, updated_at = ? WHERE id = ?', nowIso(), m.id);
  else run('DELETE FROM team_members WHERE id = ?', m.id);
  return { kept_on_bookings: n };
}
