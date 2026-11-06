// Bookings & Shoots: photo and video bookings (weddings, birthdays, corporate events…) from the first call to the
// final delivery. Shared by the server (checks, summaries, reminders) and the browser (the booking pages), so both
// read a booking the same way.
import { addDays } from './format.js';

/** The workflow, in order. A booking can also be put on hold or cancelled from any step. */
export const BOOKING_FLOW = [
  { key: 'new', label: 'New booking', short: 'New' },
  { key: 'confirmed', label: 'Confirmed', short: 'Confirmed' },
  { key: 'scheduled', label: 'Shoot scheduled', short: 'Scheduled' },
  { key: 'shot', label: 'Shoot completed', short: 'Shoot done' },
  { key: 'editing', label: 'Editing', short: 'Editing' },
  { key: 'review', label: 'Client review', short: 'Review' },
  { key: 'ready', label: 'Ready for delivery', short: 'Ready' },
  { key: 'delivered', label: 'Delivered', short: 'Delivered' },
  { key: 'closed', label: 'Closed', short: 'Closed' },
];
export const FLOW_KEYS = BOOKING_FLOW.map((s) => s.key);
export const BOOKING_STATUSES = {
  ...Object.fromEntries(BOOKING_FLOW.map((s) => [s.key, s.label])),
  on_hold: 'On hold',
  cancelled: 'Cancelled',
};
/** Where a booking is in the workflow; on hold and cancelled keep the step they left (prev_status). */
export const flowStep = (b) => FLOW_KEYS.indexOf(b.status === 'on_hold' || b.status === 'cancelled' ? b.prev_status || 'new' : b.status);
/** Has the shoot happened? Bookings on hold or cancelled are left out of the work lists. */
export const shootDone = (b) => FLOW_KEYS.indexOf(b.status) >= FLOW_KEYS.indexOf('shot');
const isParked = (b) => b.status === 'on_hold' || b.status === 'cancelled';

export const EVENT_TYPES = ['Wedding', 'Pre-wedding', 'Engagement', 'Birthday', 'Anniversary', 'Corporate event', 'Product shoot', 'Other'];

// The services on a booking are bill lines: { name, qty, rate, amount, product_id? }, rate and amount in paise.
// The studio's own services (Inventory → services) are offered first, with their prices; these fill in the rest.
export const SERVICE_PRESETS = [
  'Traditional photography', 'Candid photography', 'Videography', 'Cinematic video', 'Drone', 'Pre-wedding shoot',
  'Album', 'Reels / short videos', 'Live streaming', 'Photo editing', 'Video editing',
];
// Bookings saved before services had prices (migration v11) listed them by key.
const OLD_SERVICE_NAMES = {
  photography: 'Photography', videography: 'Videography', cinematic: 'Cinematic video', drone: 'Drone',
  traditional_photo: 'Traditional photography', traditional_video: 'Traditional videography', candid: 'Candid photography',
  pre_wedding: 'Pre-wedding shoot', album: 'Album', reels: 'Reels / short videos', live: 'Live streaming', other: 'Other',
};
export const lineAmount = (qty, rate) => Math.round((Number(qty) || 0) * (Number(rate) || 0));

/**
 * A booking's services as bill lines. Older bookings listed services without prices and kept one package amount;
 * whatever the lines don't cover of the total becomes a line of its own, so the total always adds up.
 */
export function servicesOf(b) {
  const lines = (Array.isArray(b.services) ? b.services : []).filter(Boolean).map((s) => (s.rate !== undefined ? s : {
    name: (s.key === 'other' && s.name) || OLD_SERVICE_NAMES[s.key] || s.name || 'Service', qty: Number(s.qty) || 1, rate: 0, amount: 0,
  }));
  const gap = (Number(b.total) || 0) + (Number(b.discount) || 0) - lines.reduce((a, s) => a + (Number(s.amount) || 0), 0);
  if (gap > 0) lines.push({ name: b.package_name || 'Package', qty: 1, rate: gap, amount: gap });
  return lines;
}

/** Subtotal of the lines, less the discount. */
export function bookingTotals(services, discount = 0) {
  const subtotal = services.reduce((a, s) => a + (s.amount ?? lineAmount(s.qty, s.rate)), 0);
  return { subtotal, discount, total: Math.max(0, subtotal - discount) };
}

/** Which post-production a service needs, read from its name: "Candid photography" → photo, "Drone" → video. */
export function serviceSections(name) {
  const n = String(name || '').toLowerCase();
  const out = [];
  if (/photo|candid|portrait|still|shoot/.test(n)) out.push('photo');
  if (/video|cinema|film|drone|reel|teaser|highlight|stream/.test(n)) out.push('video');
  if (/album/.test(n)) out.push('album');
  return out;
}

export const TEAM_ROLES = ['Photographer', 'Videographer', 'Cinematographer', 'Drone operator', 'Assistant', 'Editor'];

export const CHECKLIST = [
  { key: 'team', label: 'Team assigned' },
  { key: 'equipment', label: 'Equipment prepared' },
  { key: 'client', label: 'Client confirmation done' },
  { key: 'venue', label: 'Venue confirmed' },
  { key: 'shoot', label: 'Shoot completed' },
  { key: 'backup', label: 'Data backup completed' },
  { key: 'raw', label: 'Raw files received' },
  { key: 'editor', label: 'Editor assigned' },
];

// After the shoot: the steps for each kind of work. A step's key is "section.step", e.g. "photo.edited".
export const POST_PRODUCTION = [
  {
    key: 'photo', label: 'Photography', steps: [
      ['backup', 'Photos backed up'], ['selection', 'Selection done'], ['editing', 'Editing started'],
      ['edited', 'Editing completed'], ['client_selection', 'Client selection'], ['final', 'Final photos ready'],
    ],
  },
  {
    key: 'video', label: 'Video', steps: [
      ['backup', 'Footage backed up'], ['editor', 'Editor assigned'], ['rough_cut', 'Rough cut'], ['review', 'Client review'],
      ['revisions', 'Revisions'], ['final', 'Final video'], ['delivered', 'Delivered'],
    ],
  },
  {
    key: 'album', label: 'Album', steps: [
      ['selection', 'Album selection'], ['design', 'Album design'], ['approval', 'Client approval'], ['printing', 'Printing'], ['delivered', 'Delivered'],
    ],
  },
];
export const TASK_KEYS = POST_PRODUCTION.flatMap((s) => s.steps.map(([k]) => `${s.key}.${k}`));
export function taskLabel(key) {
  const [section, step] = String(key).split('.');
  const s = POST_PRODUCTION.find((x) => x.key === section);
  const st = s?.steps.find(([k]) => k === step);
  return s && st ? `${s.label}: ${st[1]}` : key;
}

/** The post-production sections the booked services need. When no service names one (or none is added), all of them. */
export function sectionsFor(services) {
  const wanted = new Set((services || []).flatMap((s) => serviceSections(s.name)));
  if (!wanted.size) return POST_PRODUCTION.map((s) => s.key);
  return POST_PRODUCTION.map((s) => s.key).filter((k) => wanted.has(k));
}

export const DELIVERABLES = [
  { key: 'photos', label: 'Photos delivered', section: 'photo' },
  { key: 'video', label: 'Video delivered', section: 'video' },
  { key: 'album', label: 'Album delivered', section: 'album' },
  { key: 'reels', label: 'Reels delivered' },
];
export function deliverablesFor(services) {
  const sections = sectionsFor(services);
  const reels = (services || []).some((s) => /reel/i.test(s.name || ''));
  return DELIVERABLES.filter((d) => (d.section ? sections.includes(d.section) : reels));
}
export const DELIVERY_METHODS = ['Google Drive', 'Dropbox', 'WeTransfer', 'Pen drive', 'Hard drive', 'In person', 'Courier', 'Other'];

export const DEADLINES = [
  { key: 'photo_edit', label: 'Photo editing' },
  { key: 'video_cut', label: 'Video first cut' },
  { key: 'client_review', label: 'Client review' },
  { key: 'final_delivery', label: 'Final delivery' },
  { key: 'album_delivery', label: 'Album delivery' },
];

export const LINK_TYPES = {
  drive: 'Google Drive',
  dropbox: 'Dropbox',
  wetransfer: 'WeTransfer',
  gallery: 'Client gallery',
  raw: 'Raw footage folder',
  edited: 'Edited photos folder',
  final: 'Final delivery folder',
  other: 'Other link',
};

export const BOOKING_PAY_METHODS = { cash: 'Cash', upi: 'UPI', bank: 'Bank transfer', card: 'Card', other: 'Other' };
export const BOOKING_PAYMENT_LABELS = { unpaid: 'Not paid', partial: 'Partially paid', paid: 'Paid' };
export function bookingPaymentStatus(total, paid) {
  if (total > 0 && paid >= total) return 'paid';
  return paid > 0 ? 'partial' : 'unpaid';
}

export const bookingNumber = (n) => `BK-${String(n).padStart(4, '0')}`;

/** "Wedding – Rahul & Priya" */
export const eventTitle = (b) => [b.event_type || 'Event', b.event_name || b.client_name].filter(Boolean).join(' – ');

/** "17:30" -> "5:30 pm" */
export function formatTime(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'pm' : 'am'}`;
}
/** "4:00 pm – 11:30 pm" for a date of the booking ({ start, end }). */
export function timeRange(d) {
  if (!d?.start) return '';
  return d.end ? `${formatTime(d.start)} – ${formatTime(d.end)}` : formatTime(d.start);
}

/**
 * The dates of a booking in order, each with its own times and venue: [{ date, start, end, venue }].
 * Bookings saved before that (migration v11) had one date, a number of days, and one time and venue for all.
 */
export function scheduleOf(b) {
  const list = Array.isArray(b.schedule) ? b.schedule.filter((d) => d && d.date) : [];
  if (list.length) return [...list].sort((x, y) => `${x.date}${x.start || ''}`.localeCompare(`${y.date}${y.start || ''}`));
  if (!b.event_date) return [];
  return Array.from({ length: Math.max(1, Number(b.days) || 1) }, (_, i) => ({
    date: addDays(b.event_date, i), start: b.start_time || '', end: b.end_time || '', venue: b.venue || '',
  }));
}
/** The last date of the event. */
export function endDate(b) {
  const days = scheduleOf(b);
  return days.length ? days[days.length - 1].date : b.event_date;
}
/** The first date on or after `today` (the last date once they've all gone by). */
export function nextDay(b, today) {
  const days = scheduleOf(b);
  return days.find((d) => d.date >= today) || days[days.length - 1];
}
export const daysOn = (b, date) => scheduleOf(b).filter((d) => d.date === date);

/** The time one date holds the team, as sortable "YYYY-MM-DDTHH:MM" strings. No times = the whole day. */
export function dayWindow(d) {
  // A shoot that ends after midnight (20:00 – 02:00) finishes the next day.
  const overnight = d.start && d.end && d.end <= d.start;
  return { start: `${d.date}T${d.start || '00:00'}`, end: `${overnight ? addDays(d.date, 1) : d.date}T${d.end || '23:59'}` };
}
/** The first date of booking `b` that overlaps any date of booking `a`, or null. */
export function clashDay(a, b) {
  const mine = scheduleOf(a).map(dayWindow);
  return scheduleOf(b).find((d) => {
    const y = dayWindow(d);
    return mine.some((x) => x.start < y.end && y.start < x.end);
  }) || null;
}
export const windowsOverlap = (a, b) => !!clashDay(a, b);

/** Whole days from `from` to `to` (both YYYY-MM-DD): 1 for tomorrow, -3 for three days ago. */
export function daysBetween(from, to) {
  const d = (s) => {
    const [y, m, day] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((d(to) - d(from)) / 86400_000);
}
/** Monday of the week that holds `day`. */
export function weekStart(day) {
  const [y, m, d] = day.split('-').map(Number);
  return addDays(day, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7));
}

export const SHOOT_STATES = { upcoming: 'Upcoming', today: 'Today', past: 'Date passed', done: 'Completed', on_hold: 'On hold', cancelled: 'Cancelled' };
export function shootState(b, today) {
  if (b.status === 'cancelled') return 'cancelled';
  if (b.status === 'on_hold') return 'on_hold';
  if (shootDone(b)) return 'done';
  if (daysOn(b, today).length) return 'today';
  // Between two dates of the event there's more to come.
  return endDate(b) < today ? 'past' : 'upcoming';
}

export const DELIVERY_STATES = {
  not_started: 'Not started', in_progress: 'Post-production', partial: 'Partly delivered', ready: 'Ready', delivered: 'Delivered', none: '—',
};
export function deliveryState(b) {
  if (b.status === 'cancelled') return 'none';
  if (b.status === 'delivered' || b.status === 'closed') return 'delivered';
  if (b.status === 'ready') return 'ready';
  if (deliverablesFor(b.services).some((d) => b.delivery?.[d.key])) return 'partial';
  return flowStep(b) >= FLOW_KEYS.indexOf('shot') ? 'in_progress' : 'not_started';
}

// The calendar marks each booking as one of these.
export const CALENDAR_TONES = { confirmed: 'Confirmed', upcoming: 'Upcoming', completed: 'Completed', cancelled: 'Cancelled' };
export function calendarTone(b) {
  if (b.status === 'cancelled') return 'cancelled';
  if (shootDone(b)) return 'completed';
  if (b.status === 'confirmed' || b.status === 'scheduled') return 'confirmed';
  return 'upcoming'; // a new booking (or one on hold) still to be confirmed
}

/** Booking → Shoot → Backup → Editing → Review → Delivery, each done or not, and the step it's on now. */
export const PROGRESS = ['Booking', 'Shoot', 'Backup', 'Editing', 'Review', 'Delivery'];
export function progressSteps(b) {
  const at = flowStep(b);
  const step = (key) => at >= FLOW_KEYS.indexOf(key);
  const backedUp = !!(b.checklist?.backup || b.tasks?.['photo.backup'] || b.tasks?.['video.backup']);
  const done = [step('confirmed'), step('shot'), backedUp || step('review'), step('review'), step('ready'), step('delivered')];
  const current = done.indexOf(false);
  return PROGRESS.map((label, i) => ({ label, done: done[i], current: i === current }));
}

/** Is the work behind a deadline finished? */
function deadlineDone(key, b) {
  const t = b.tasks || {};
  const d = b.delivery || {};
  const step = (k) => flowStep(b) >= FLOW_KEYS.indexOf(k);
  switch (key) {
    case 'photo_edit': return !!(t['photo.edited'] || t['photo.final'] || d.photos) || step('review');
    case 'video_cut': return !!(t['video.rough_cut'] || t['video.review'] || t['video.final'] || d.video) || step('review');
    case 'client_review': return step('ready');
    case 'album_delivery': return !!(t['album.delivered'] || d.album) || step('delivered');
    default: return step('delivered');
  }
}

/** Every deadline with a date: done, overdue (days late), soon (within 3 days) or later. Cancelled bookings have none. */
export function deadlineStates(b, today) {
  if (b.status === 'cancelled') return [];
  return DEADLINES.filter((d) => b.deadlines?.[d.key]).map((d) => {
    const date = b.deadlines[d.key];
    const days = daysBetween(today, date);
    const done = deadlineDone(d.key, b);
    return { key: d.key, label: d.label, date, days, state: done ? 'done' : days < 0 ? 'overdue' : days <= 3 ? 'soon' : 'later' };
  });
}

// Quick filters on the Bookings page. On hold and cancelled bookings only show under Payment pending (if money is due).
export const QUICK_FILTERS = [
  ['today', 'Today'], ['week', 'This week'], ['upcoming', 'Upcoming'], ['shot', 'Shoot completed'],
  ['editing', 'Editing pending'], ['payment', 'Payment pending'], ['delivery', 'Delivery pending'], ['completed', 'Completed projects'],
];
export function matchesQuick(b, quick, today) {
  // Money is owed once a booking is confirmed (or an advance came in); an enquiry isn't owed yet.
  if (quick === 'payment') return b.status !== 'cancelled' && b.total - b.amount_paid > 0 && (b.status !== 'new' || b.amount_paid > 0);
  if (isParked(b)) return false;
  switch (quick) {
    case 'today': return daysOn(b, today).length > 0;
    case 'week': {
      const from = weekStart(today);
      const to = addDays(from, 6);
      return scheduleOf(b).some((d) => d.date >= from && d.date <= to);
    }
    case 'upcoming': return !shootDone(b) && endDate(b) >= today;
    case 'shot': return shootDone(b);
    case 'editing': return b.status === 'shot' || b.status === 'editing';
    case 'delivery': return ['shot', 'editing', 'review', 'ready'].includes(b.status);
    case 'completed': return b.status === 'delivered' || b.status === 'closed';
    default: return true;
  }
}

/**
 * What needs attention: tomorrow's shoots, shoot dates gone by, deadlines overdue or close, client reviews waiting
 * and money due after the shoot. Most urgent first.
 */
export function bookingReminders(bookings, today) {
  const out = [];
  const tomorrow = addDays(today, 1);
  for (const b of bookings) {
    if (b.status === 'cancelled') continue;
    const ref = { booking: b };
    if (b.status !== 'on_hold') {
      const [day] = daysOn(b, tomorrow);
      if (!shootDone(b) && day) out.push({ ...ref, type: 'tomorrow', rank: 1, date: tomorrow, day });
      if (shootState(b, today) === 'past') out.push({ ...ref, type: 'past', rank: 2, date: endDate(b) });
      for (const d of deadlineStates(b, today)) {
        if (d.state === 'overdue') out.push({ ...ref, type: 'overdue', rank: 0, date: d.date, days: d.days, label: d.label });
        else if (d.state === 'soon') {
          const editing = d.key === 'photo_edit' || d.key === 'video_cut';
          out.push({ ...ref, type: editing ? 'editing_due' : 'delivery_due', rank: 3, date: d.date, days: d.days, label: d.label });
        }
      }
      if (b.status === 'review') out.push({ ...ref, type: 'review', rank: 4, date: b.event_date });
    }
    const due = b.total - b.amount_paid;
    if (due > 0 && (shootDone(b) || endDate(b) < today)) out.push({ ...ref, type: 'payment', rank: 5, date: b.event_date, amount: due });
  }
  return out.sort((a, b) => a.rank - b.rank || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
