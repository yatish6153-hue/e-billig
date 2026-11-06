// Demo data. Every demo row is flagged is_demo = 1 so the UI can badge it and
// Settings can remove it in one click.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, run, tx, nowIso } from './db.js';
import { hashPassword } from './auth.js';
import { applyStockChange } from './services/inventory.js';
import { saveDraft, finalizeBill, addPayment, cancelBill } from './services/billing.js';
import { setStage } from './services/tracking.js';
import {
  createMember, createBooking, setStatus, setChecklist, setTask, setDeadlines, setDelivery, setNotes, addLink, addBookingPayment,
} from './services/bookings.js';
import { STAGE_KEYS } from '../shared/tracking.js';
import { FLOW_KEYS } from '../shared/bookings.js';
import { isoDate, addDays } from '../shared/format.js';

export const DEMO_ACCOUNT = { email: 'demo@example.com', password: 'demo1234' };

// Devesh Studio's logo (from deveshstudio.com), placed on a dark tile so its light lettering reads on white invoices.
const DEMO_LOGO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'devesh-studio-logo.png');

/** On by default for local use; off in production unless DEMO_ACCOUNT=true. */
export function demoAccountEnabled() {
  if (process.env.DEMO_ACCOUNT) return process.env.DEMO_ACCOUNT === 'true';
  return process.env.NODE_ENV !== 'production';
}

// Sample catalog for a photography & design studio: stocked goods plus services (no stock).
// kind, name, sku, barcode, category, hsn/sac, unit, purchase, selling (paise), tax %, opening qty, low-stock level
const PRODUCTS = [
  ['goods', 'Photo Frame 8x10 (Wooden)', 'DEMO-FRM-810', '8900000000011', 'Frames', '4414', 'pcs', 18000, 35000, 18, 25, 5],
  ['goods', 'Photo Frame 12x18 (Premium)', 'DEMO-FRM-1218', '8900000000028', 'Frames', '4414', 'pcs', 40000, 75000, 18, 6, 5],
  ['goods', 'Wedding Album 12x36 (40 pages)', 'DEMO-ALB-1236', '8900000000035', 'Albums', '4820', 'pcs', 250000, 450000, 18, 6, 3],
  ['goods', 'Mini Album 6x8 (20 pages)', 'DEMO-ALB-68', '8900000000042', 'Albums', '4820', 'pcs', 60000, 120000, 18, 10, 3],
  ['goods', 'Photo Print 4x6 (Glossy)', 'DEMO-PRT-46', '8900000000059', 'Prints', '4911', 'pcs', 500, 1500, 18, 500, 100],
  ['goods', 'Photo Print 8x12 (Matte)', 'DEMO-PRT-812', '8900000000066', 'Prints', '4911', 'pcs', 2000, 6000, 18, 120, 30],
  ['goods', 'Canvas Print 16x20', 'DEMO-CNV-1620', '8900000000073', 'Prints', '4911', 'pcs', 80000, 160000, 18, 3, 2],
  ['goods', 'Pen Drive 32 GB', 'DEMO-USB-32', '8900000000080', 'Accessories', '8523', 'pcs', 30000, 55000, 18, 10, 5],
  ['goods', 'Memory Card 64 GB', 'DEMO-SD-64', '8900000000097', 'Accessories', '8523', 'pcs', 55000, 90000, 18, 1, 3],
  ['goods', 'Photo Mug (Custom Print)', 'DEMO-MUG', '8900000000103', 'Gifts', '6912', 'pcs', 9000, 30000, 18, 10, 5],
  ['service', 'Wedding Photography (Full Day)', 'DEMO-SVC-WED', '', 'Photography', '998383', 'day', 0, 4000000, 18, 0, 0],
  ['service', 'Candid Photography (Full Day)', 'DEMO-SVC-CAN', '', 'Photography', '998383', 'day', 0, 2500000, 18, 0, 0],
  ['service', 'Pre-Wedding Shoot', 'DEMO-SVC-PRE', '', 'Photography', '998383', 'shoot', 0, 3000000, 18, 0, 0],
  ['service', 'Fashion Shoot (Half Day)', 'DEMO-SVC-FSN', '', 'Photography', '998382', 'shoot', 0, 1800000, 18, 0, 0],
  ['service', 'Event Coverage (4 hours)', 'DEMO-SVC-EVT', '', 'Photography', '998383', 'event', 0, 1200000, 18, 0, 0],
  ['service', 'Passport Size Photos (8 pcs)', 'DEMO-SVC-PSP', '', 'Photography', '998381', 'set', 0, 15000, 18, 0, 0],
  ['service', 'Product Photography', 'DEMO-SVC-PRD', '', 'Photography', '998382', 'product', 0, 50000, 18, 0, 0],
  ['service', 'Video Editing', 'DEMO-SVC-EDIT', '', 'Video & Animation', '', 'hr', 0, 120000, 18, 0, 0],
  ['service', 'Logo Animation', 'DEMO-SVC-LOGO', '', 'Video & Animation', '', 'job', 0, 800000, 18, 0, 0],
  ['service', 'Commercial Ad Video (30 sec)', 'DEMO-SVC-AD', '', 'Video & Animation', '', 'job', 0, 4500000, 18, 0, 0],
  ['service', 'Social Media Post Design', 'DEMO-SVC-POST', '', 'Design & Marketing', '', 'post', 0, 50000, 18, 0, 0],
  ['service', 'Social Media Marketing (Monthly)', 'DEMO-SVC-SMM', '', 'Design & Marketing', '', 'month', 0, 1500000, 18, 0, 0],
];

// name, phone, email, address, gstin — sample people and firms (placeholder numbers, example.com emails)
const CUSTOMERS = [
  ['Ananya Sharma', '+91 90000 00001', 'ananya.sharma@example.com', '45 Malviya Nagar\nJaipur, Rajasthan 302017', ''],
  ['Rohit & Priya Verma', '+91 90000 00002', 'rohit.verma@example.com', '12 Vaishali Nagar\nJaipur, Rajasthan 302021', ''],
  ['Pink City Boutique', '+91 90000 00003', 'orders@pinkcityboutique.example.com', 'Shop 21, MI Road\nJaipur, Rajasthan 302001', '08AAKFP1234L1Z2'],
  ['Shekhawati Handicrafts', '+91 90000 00004', 'hello@shekhawati.example.com', 'Plot 7, Sitapura Industrial Area\nJaipur, Rajasthan 302022', '08ABCFS5678D1Z9'],
  ['Kavita Meena', '+91 90000 00005', 'kavita.meena@example.com', 'Paota\nJaipur, Rajasthan 303106', ''],
  ['Arjun Saini', '+91 90000 00006', '', 'Sanganer\nJaipur, Rajasthan 302029', ''],
];

/** Demo products (with opening stock) and customers. Returns the inserted ids. */
export function seedDemoCatalog(businessId, userId, { openingAt = null } = {}) {
  return tx(() => {
    const products = PRODUCTS.map(([kind, name, sku, barcode, category, hsn, unit, purchase, selling, tax, qty, low]) => {
      const r = run(
        `INSERT INTO products (business_id, kind, name, sku, barcode, category, hsn, unit, purchase_price, selling_price,
           tax_rate, low_stock_threshold, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        businessId, kind, name, sku, barcode, category, hsn, unit, purchase, selling, tax, low,
      );
      const id = Number(r.lastInsertRowid);
      if (qty > 0) {
        applyStockChange(businessId, id, qty, 'opening', { userId, note: 'Opening stock (demo)', unitCost: purchase, at: openingAt });
      }
      return id;
    });
    const customers = CUSTOMERS.map(([name, phone, email, address, gstin]) => Number(run(
      'INSERT INTO customers (business_id, name, phone, email, address, gstin, is_demo) VALUES (?, ?, ?, ?, ?, ?, 1)',
      businessId, name, phone, email, address, gstin,
    ).lastInsertRowid));
    return { products, customers };
  });
}

// daysAgo, customer index (or null = walk-in), [[product index, qty, discount %]], outcome, payment method,
// payment reference, how the photo came in ('' = not set), work stage reached (null = quick sale, not tracked).
// outcome: paid | partial (50% advance) | unpaid | cancelled | draft; method: cash | online (reference says how)
const BILLS = [
  [27, 0, [[10, 2], [11, 1], [2, 2], [7, 1]], 'partial', 'online', 'Bank transfer', 'studio', 'review'],
  [24, 2, [[13, 1], [20, 20, 10]], 'paid', 'online', 'UPI', 'whatsapp', 'final'],
  [21, null, [[15, 2], [0, 1]], 'paid', 'cash', '', '', null],
  [18, 1, [[12, 1], [6, 1]], 'partial', 'online', 'UPI', 'photo', 'frame'],
  [15, 3, [[16, 25], [20, 10]], 'unpaid', null, '', 'studio', 'design'],
  [12, 4, [[14, 1], [3, 1]], 'paid', 'online', 'UPI', 'whatsapp', 'print'],
  [10, 2, [[18, 1], [19, 1]], 'unpaid', null, '', 'other', 'review'],
  [8, null, [[4, 24], [1, 1]], 'paid', 'cash', '', '', null],
  [6, 5, [[8, 1], [15, 1]], 'paid', 'online', 'UPI', '', null],
  [5, 0, [[17, 6], [9, 4]], 'partial', 'cash', '', 'whatsapp', 'received'],
  [3, null, [[5, 6], [0, 2]], 'paid', 'cash', '', '', null],
  [2, 4, [[3, 1]], 'cancelled', 'online', 'UPI', '', null],
  [1, 1, [[9, 2], [4, 10]], 'paid', 'online', 'Card', 'photo', 'print'],
  [0, null, [[15, 1]], 'paid', 'cash', '', '', null],
  [0, 3, [[21, 1], [20, 12]], 'draft', null, '', 'whatsapp', null],
];

function seedDemoBills(businessId, userId, catalog) {
  const today = isoDate();
  for (const [daysAgo, cust, lines, outcome, method, reference, photoSource, stage] of BILLS) {
    const billDate = addDays(today, -daysAgo);
    const at = new Date(`${billDate}T10:30:00`).toISOString();
    const items = lines.map(([pi, qty, disc = 0]) => {
      const p = get('SELECT * FROM products WHERE id = ?', catalog.products[pi]);
      return { product_id: p.id, quantity: qty, unit_price: p.selling_price, discount_pct: disc, tax_rate: p.tax_rate };
    });
    const id = saveDraft(businessId, userId, null, {
      customer_id: cust === null ? null : catalog.customers[cust],
      bill_date: billDate,
      photo_source: photoSource,
      items,
    }, { isDemo: true, at });
    if (outcome === 'draft') continue;
    finalizeBill(businessId, userId, id, { allowInsufficient: true, at });
    const { total } = get('SELECT total FROM bills WHERE id = ?', id);
    if (outcome === 'paid' || outcome === 'cancelled') {
      addPayment(businessId, userId, id, { amount: total, method, reference, paid_on: billDate }, { at });
    } else if (outcome === 'partial') {
      addPayment(businessId, userId, id, { amount: Math.round(total / 200) * 100, method, reference, paid_on: billDate }, { at });
    }
    if (outcome === 'cancelled') cancelBill(businessId, userId, id, { reason: 'Customer returned the items (demo).' });
    if (stage) {
      // Walk the job through each stage up to where it is now, a couple of days apart.
      for (let i = 0; i <= STAGE_KEYS.indexOf(stage); i++) {
        const day = addDays(billDate, i * 2);
        const when = Math.min(Date.parse(`${day > today ? today : day}T11:${String(i * 10).padStart(2, '0')}:00`), Date.now());
        setStage(businessId, userId, id, STAGE_KEYS[i], { at: new Date(when).toISOString() });
      }
    }
  }
}

// The day book: daysAgo, kind (sale without a bill / money received / expense), expense type, details, amount (₹), method
const DAY_ENTRIES = [
  [6, 'expense', 'Rent', 'Shop rent (November)', 8000, 'online'],
  [5, 'expense', 'Lab & printing', 'Color lab: 4x6 prints', 1450, 'online'],
  [5, 'sale', '', 'Passport photos and prints (counter)', 650, 'cash'],
  [4, 'expense', 'Frames & material', 'Frame wholesaler, Johari Bazar', 2600, 'cash'],
  [3, 'received', '', 'Advance for a birthday shoot (no bill yet)', 3000, 'online'],
  [3, 'expense', 'Travel & fuel', 'Petrol for the wedding shoot', 600, 'cash'],
  [2, 'sale', '', 'Photo prints and lamination (counter)', 420, 'cash'],
  [2, 'expense', 'Food & tea', 'Tea and snacks', 180, 'cash'],
  [1, 'expense', 'Salary', 'Assistant (advance)', 3000, 'cash'],
  [1, 'expense', 'Phone & internet', 'Broadband bill', 799, 'online'],
  [0, 'sale', '', 'Passport photos (counter)', 300, 'cash'],
  [0, 'expense', 'Food & tea', 'Tea', 60, 'cash'],
];

function seedDemoDayBook(businessId, userId) {
  const today = isoDate();
  for (const [daysAgo, kind, category, details, rupees, method] of DAY_ENTRIES) {
    run(
      `INSERT INTO day_entries (business_id, entry_date, kind, category, details, amount, method, is_demo, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      businessId, addDays(today, -daysAgo), kind, category, details, rupees * 100, method, userId,
    );
  }
}

// The studio's team for the sample bookings: name, usual role, phone (placeholder numbers).
const TEAM = [
  ['Ravi Sharma', 'Photographer', '+91 90000 10001'],
  ['Sunil Kumar', 'Videographer', '+91 90000 10002'],
  ['Karan Singh', 'Cinematographer', '+91 90000 10003'],
  ['Aman Joshi', 'Drone operator', '+91 90000 10004'],
  ['Neha Gupta', 'Editor', '+91 90000 10005'],
  ['Deepak Saini', 'Assistant', '+91 90000 10006'],
];

// Sample bookings around today. Days are counted from today (-10 = ten days ago); amounts are in rupees.
// dates = [day, start, end, venue], one per date of the event; services = [name, qty, price each] (names that match
// a demo catalog service are linked to it); customer = index into CUSTOMERS; team = [TEAM index, role on this shoot];
// pay = [day, amount, method, note], the first one being the advance. Each booking is walked through every status up
// to `status` on the way.
const BOOKINGS = [
  {
    dates: [[-11, '10:00', '13:00', 'Verma House, Vaishali Nagar'], [-10, '16:00', '23:30', 'Hotel Clarks Amer']],
    customer: 1, client: 'Rohit & Priya Verma', phone: '+91 90000 00002', address: '12 Vaishali Nagar, Jaipur',
    type: 'Wedding', name: 'Rohit & Priya', package: 'Gold wedding package', status: 'editing',
    services: [['Wedding Photography (Full Day)', 2, 40000], ['Candid Photography (Full Day)', 1, 25000], ['Cinematic video', 1, 45000],
      ['Drone', 1, 10000], ['Album (40 pages)', 1, 20000], ['Reels / short videos', 3, 2000]],
    discount: 6000,
    pay: [[-40, 50000, 'bank', 'Advance'], [-10, 50000, 'cash', 'On the wedding day']],
    team: [[0], [2], [1], [3], [4]],
    before: ['equipment', 'client', 'venue'], after: ['backup', 'raw'],
    tasks: ['photo.backup', 'photo.selection', 'photo.editing', 'video.backup', 'video.editor'],
    deadlines: { photo_edit: 2, video_cut: -3, final_delivery: 15, album_delivery: 30 },
    links: [['raw', 'Raw footage – haldi and wedding', 'https://drive.google.com/drive/folders/demo-raw-footage']],
    notes: 'The bride’s family wants candid shots of the haldi too. Album: 40 pages, matte finish.',
  },
  {
    dates: [[1, '06:30', '11:00', 'Jal Mahal'], [2, '16:00', '19:00', 'Nahargarh Fort']],
    customer: 0, client: 'Ananya Sharma', phone: '+91 90000 00001', address: '45 Malviya Nagar, Jaipur',
    type: 'Pre-wedding', name: 'Ananya & Karan', package: 'Pre-wedding cinematic', status: 'scheduled',
    services: [['Pre-Wedding Shoot', 1, 30000], ['Cinematic video', 1, 12000], ['Drone', 1, 5000]], discount: 2000,
    pay: [[-15, 20000, 'upi', 'Advance']], team: [[0], [2], [3]], before: ['client', 'venue'],
    deadlines: { final_delivery: 21 }, notes: 'Two outfit changes. Sunrise at Jal Mahal, sunset at the fort.',
  },
  {
    dates: [[0, '18:00', '22:00', 'Shree Ram Banquet, Paota']],
    customer: 4, client: 'Kavita Meena', phone: '+91 90000 00005', address: 'Paota, Jaipur',
    type: 'Birthday', name: 'Aarav’s 1st birthday', package: 'Birthday – photo + video', status: 'scheduled',
    services: [['Photography', 1, 8000], ['Videography', 1, 10000]],
    pay: [[-7, 5000, 'cash', 'Advance']], team: [[5, 'Photographer'], [1]], before: ['client', 'equipment'],
  },
  {
    dates: [[6, '10:00', '14:00', 'Pink City Boutique, MI Road']],
    customer: 2, client: 'Pink City Boutique', phone: '+91 90000 00003', address: 'Shop 21, MI Road, Jaipur',
    type: 'Corporate event', name: 'Festive collection launch', package: 'Event photos + 4 reels', status: 'confirmed',
    services: [['Event Coverage (4 hours)', 1, 12000], ['Reels / short videos', 4, 3250]],
    pay: [[-3, 10000, 'bank', 'Advance']], team: [[0], [4]], before: ['client'],
  },
  {
    dates: [[20, '17:00', '22:00', 'Raj Vilas Garden, Sanganer']],
    customer: 5, client: 'Arjun Saini', phone: '+91 90000 00006', address: 'Sanganer, Jaipur',
    type: 'Engagement', name: 'Arjun & Kritika', package: 'Engagement premium', status: 'new',
    services: [['Candid photography', 2, 15000], ['Videography', 1, 20000], ['Cinematic video', 1, 15000]],
    created: -2, notes: 'Asked for a quote with drone too. Call back on Saturday.',
  },
  {
    dates: [[-6, '11:00', '17:00', 'Devesh Studio, Paota']],
    customer: 3, client: 'Shekhawati Handicrafts', phone: '+91 90000 00004', address: 'Plot 7, Sitapura Industrial Area, Jaipur',
    type: 'Product shoot', name: 'Festive catalogue', package: 'Catalogue – 60 products', status: 'review',
    services: [['Product Photography', 60, 250]],
    pay: [[-9, 7500, 'upi', 'Advance']], team: [[0], [4]], before: ['equipment', 'client', 'venue'], after: ['backup', 'raw'],
    tasks: ['photo.backup', 'photo.selection', 'photo.editing', 'photo.edited'], deadlines: { client_review: 1, final_delivery: 4 },
    links: [['edited', 'Edited photos for approval', 'https://drive.google.com/drive/folders/demo-catalogue-edits']],
  },
  {
    dates: [[-18, '19:00', '23:00', 'Hotel Mansingh']],
    client: 'Sharma family', phone: '+91 90000 00007', address: 'C-Scheme, Jaipur',
    type: 'Anniversary', name: '25th anniversary', package: 'Anniversary + album', status: 'ready', reviewAt: -6, readyAt: -3,
    services: [['Photography', 1, 12000], ['Album (20 pages)', 1, 10000]],
    pay: [[-25, 10000, 'cash', 'Advance'], [-18, 6000, 'upi', '']], team: [[5, 'Photographer'], [4]],
    before: ['equipment', 'client', 'venue'], after: ['backup', 'raw'],
    tasks: ['photo.backup', 'photo.selection', 'photo.editing', 'photo.edited', 'photo.client_selection', 'photo.final',
      'album.selection', 'album.design', 'album.approval', 'album.printing'],
    deadlines: { album_delivery: 2 },
    delivery: { day: -3, photos: true, method: 'Google Drive', drive: 'https://drive.google.com/drive/folders/demo-anniversary' },
  },
  {
    dates: [[-46, '11:00', '14:00', 'Meena House, Paota'], [-45, '15:00', '23:00', 'Shri Ram Garden, Paota']],
    client: 'Meena family', phone: '+91 90000 00008', address: 'Paota, Jaipur',
    type: 'Wedding', name: 'Rahul & Pooja', package: 'Silver wedding package', status: 'closed', reviewAt: -22, readyAt: -16,
    services: [['Traditional photography', 2, 20000], ['Videography', 1, 35000], ['Album (40 pages)', 1, 20000]],
    pay: [[-60, 30000, 'cash', 'Advance'], [-45, 40000, 'bank', 'After the wedding'], [-12, 25000, 'upi', 'Balance']],
    team: [[0], [1], [4]], before: ['equipment', 'client', 'venue'], after: ['backup', 'raw'],
    tasks: ['photo.backup', 'photo.selection', 'photo.editing', 'photo.edited', 'photo.client_selection', 'photo.final',
      'video.backup', 'video.editor', 'video.rough_cut', 'video.review', 'video.revisions', 'video.final', 'video.delivered',
      'album.selection', 'album.design', 'album.approval', 'album.printing', 'album.delivered'],
    delivery: {
      day: -14, photos: true, video: true, album: true, method: 'Pen drive', storage: '64 GB pen drive with photos and film',
      drive: 'https://drive.google.com/drive/folders/demo-final-delivery',
    },
    links: [['final', 'Final photos and film', 'https://drive.google.com/drive/folders/demo-final-delivery']],
  },
  {
    dates: [[12, '16:00', '20:00', 'Fun City Banquet, Vaishali Nagar']],
    client: 'Gupta family', phone: '+91 90000 00009', address: 'Vaishali Nagar, Jaipur',
    type: 'Birthday', name: 'Myra’s 5th birthday', package: 'Birthday photos', status: 'cancelled', created: -5,
    services: [['Photography', 1, 12000]], team: [[5, 'Photographer']], reason: 'The family postponed the party',
  },
  {
    dates: [[28, '10:00', '16:00', 'Shekhawati Handicrafts, Sitapura'], [29, '10:00', '13:00', 'Shekhawati Handicrafts, Sitapura']],
    customer: 3, client: 'Shekhawati Handicrafts', phone: '+91 90000 00004', address: 'Plot 7, Sitapura Industrial Area, Jaipur',
    type: 'Corporate event', name: 'Factory walkthrough film', package: 'Brand film', status: 'on_hold', holdFrom: 'confirmed',
    services: [['Brand film', 1, 32000], ['Drone', 1, 8000]],
    pay: [[-4, 10000, 'bank', 'Advance']], team: [[1], [3]], notes: 'On hold until the client confirms the factory visit date.',
  },
];

function seedDemoBookings(businessId, userId, catalog) {
  const today = isoDate();
  // A moment on a day counted from today, never later than now.
  const at = (day, time = '11:00') => new Date(Math.min(Date.parse(`${addDays(today, day)}T${time}:00`), Date.now())).toISOString();
  const team = TEAM.map(([name, role, phone]) => createMember(businessId, { name, role, phone }, { isDemo: true }).id);
  const catalogService = new Map(PRODUCTS.map(([kind, name], i) => [name, kind === 'service' ? catalog.products[i] : undefined]));
  for (const s of BOOKINGS) {
    const pay = s.pay || [];
    const created = pay[0]?.[0] ?? s.created ?? -1;
    const first = s.dates[0][0];
    const [last, , lastEnd] = s.dates[s.dates.length - 1];
    const after = last + 1; // the day after the event
    const advance = pay[0];
    const id = createBooking(businessId, userId, {
      client_name: s.client, client_whatsapp: s.phone, client_address: s.address, event_type: s.type, event_name: s.name,
      schedule: s.dates.map(([day, start, end, venue]) => ({ date: addDays(today, day), start, end, venue })),
      services: s.services.map(([name, qty, rupees]) => ({ name, qty, rate: rupees * 100, product_id: catalogService.get(name) })),
      discount: (s.discount || 0) * 100, package_name: s.package,
      team: (s.team || []).map(([i, role]) => ({ member_id: team[i], role: role || TEAM[i][1] })),
      advance: advance ? { amount: advance[1] * 100, method: advance[2], paid_on: addDays(today, advance[0]), note: advance[3] } : null,
      allow_conflicts: true,
    }, { isDemo: true, customerId: s.customer === undefined ? null : catalog.customers[s.customer], at: at(created, '10:15') });

    const target = s.status === 'on_hold' ? s.holdFrom : s.status === 'cancelled' ? 'confirmed' : s.status;
    const reached = (key) => FLOW_KEYS.indexOf(target) >= FLOW_KEYS.indexOf(key);
    const move = (status, day, time) => setStatus(businessId, userId, id, { status }, { at: at(day, time) });
    const tick = (key, day) => setChecklist(businessId, userId, id, { key, done: true }, { at: at(day, '12:00') });
    if (reached('confirmed')) move('confirmed', created, '10:30');
    for (const key of s.before || []) tick(key, Math.max(created, Math.min(first - 1, 0)));
    if (reached('scheduled')) move('scheduled', Math.max(created, Math.min(first - 3, 0)), '18:00');
    if (reached('shot')) {
      move('shot', last, lastEnd);
      for (const key of s.after || []) tick(key, after);
    }
    // Payments before the delivery, the post-production steps, then delivery and the payments after it.
    const deliveredOn = s.delivery?.day ?? Infinity;
    const payments = (list) => list.forEach(([day, rupees, method, note]) => addBookingPayment(businessId, userId, id,
      { amount: rupees * 100, method, note, paid_on: addDays(today, day) }, { at: at(day, '17:00') }));
    payments(pay.slice(1).filter(([day]) => day < deliveredOn));
    (s.tasks || []).forEach((key, i) => setTask(businessId, userId, id, { key, done: true }, { at: at(Math.min(after + i, -1), '15:00') }));
    if (reached('review')) move('review', s.reviewAt ?? -1, '16:00');
    if (reached('ready')) move('ready', s.readyAt ?? -1, '16:30');
    if (s.delivery) {
      const { day, ...delivery } = s.delivery;
      setDelivery(businessId, userId, id, { delivery: { ...delivery, date: addDays(today, day) } }, { at: at(day, '17:30') });
    }
    payments(pay.slice(1).filter(([day]) => day >= deliveredOn));
    if (s.deadlines) {
      const deadlines = Object.fromEntries(Object.entries(s.deadlines).map(([key, day]) => [key, addDays(today, day)]));
      setDeadlines(businessId, userId, id, { deadlines }, { at: at(Math.max(created, Math.min(after, 0)), '19:00') });
    }
    const linkDay = s.delivery?.day ?? Math.min(after, 0);
    for (const [type, label, url] of s.links || []) addLink(businessId, userId, id, { type, label, url }, { at: at(linkDay, '20:00') });
    if (s.notes) setNotes(businessId, id, { internal_notes: s.notes });
    if (s.status === 'on_hold') move('on_hold', -1, '12:30');
    if (s.status === 'cancelled') setStatus(businessId, userId, id, { status: 'cancelled', reason: s.reason }, { at: at(-1, '13:00') });
  }
}

/** Create the shared demo login with a fully populated business, if it doesn't exist yet. */
export async function ensureDemoAccount() {
  if (!demoAccountEnabled()) return;
  if (get('SELECT 1 FROM users WHERE email = ?', DEMO_ACCOUNT.email)) return;
  const hash = await hashPassword(DEMO_ACCOUNT.password);
  tx(() => {
    const biz = run(
      `INSERT INTO businesses (tagline, name, address, phone, email, website, gstin, payment_details, invoice_terms)
       VALUES ('A Complete Design Solution', ?, ?, ?, ?, ?, ?, ?, ?)`,
      'Devesh Digital Studio (Demo)',
      'Devesh Studio, B L Jangid Market\nPaota, Jaipur, Rajasthan 303106',
      '+91 97990 16153',
      'devesh.paota@gmail.com',
      'www.deveshstudio.com',
      '',
      '',
      '50% advance confirms the booking; the balance is due on delivery.\nEdited photos are delivered within 15 days of the event.',
    );
    const businessId = Number(biz.lastInsertRowid);
    if (fs.existsSync(DEMO_LOGO)) {
      run('UPDATE businesses SET logo_mime = ?, logo_data = ?, logo_updated_at = ? WHERE id = ?',
        'image/png', fs.readFileSync(DEMO_LOGO), nowIso(), businessId);
    }
    const user = run('INSERT INTO users (business_id, name, email, password_hash) VALUES (?, ?, ?, ?)',
      businessId, 'Owner', DEMO_ACCOUNT.email, hash);
    const userId = Number(user.lastInsertRowid);
    const openingAt = new Date(`${addDays(isoDate(), -40)}T09:00:00`).toISOString();
    const catalog = seedDemoCatalog(businessId, userId, { openingAt });
    seedDemoBills(businessId, userId, catalog);
    seedDemoDayBook(businessId, userId);
    seedDemoBookings(businessId, userId, catalog);
  });
}

/** Delete every demo row for a business. Real data is untouched. */
export function removeDemoData(businessId) {
  return tx(() => {
    const bills = run('DELETE FROM bills WHERE business_id = ? AND is_demo = 1', businessId).changes;
    // Demo bookings take their payments, team and history with them.
    const bookings = run('DELETE FROM bookings WHERE business_id = ? AND is_demo = 1', businessId).changes;
    // Sample team members the owner has put on their own bookings stay on them, as part of their own team.
    run(`UPDATE team_members SET is_demo = 0 WHERE business_id = ? AND is_demo = 1 AND id IN (
           SELECT t.member_id FROM booking_team t JOIN bookings k ON k.id = t.booking_id WHERE k.business_id = ?)`,
    businessId, businessId);
    const team = run('DELETE FROM team_members WHERE business_id = ? AND is_demo = 1', businessId).changes;
    const products = run('DELETE FROM products WHERE business_id = ? AND is_demo = 1', businessId).changes;
    const customers = run('DELETE FROM customers WHERE business_id = ? AND is_demo = 1', businessId).changes;
    const entries = run('DELETE FROM day_entries WHERE business_id = ? AND is_demo = 1', businessId).changes;
    // If no real invoices (or bookings) exist yet, start numbering from 1 again.
    const { n } = get('SELECT COUNT(*) AS n FROM bills WHERE business_id = ? AND invoice_no IS NOT NULL', businessId);
    if (n === 0) run('UPDATE businesses SET next_invoice_no = 1 WHERE id = ?', businessId);
    if (!get('SELECT 1 FROM bookings WHERE business_id = ?', businessId)) run('UPDATE businesses SET next_booking_no = 1 WHERE id = ?', businessId);
    return { bills, products, customers, entries, bookings, team };
  });
}
