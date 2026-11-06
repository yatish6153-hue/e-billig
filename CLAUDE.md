# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

eBilling: billing, job tracking and a day book for Devesh Digital Studio (a photo and design studio in Jaipur), usable by any small business. Node.js + Express 5 + SQLite through the built-in `node:sqlite`, with a plain ES-module single-page app. There is no build step, bundler or native module. The owner writes in Hinglish; keep UI copy short, plain English.

## Commands

- `npm install`: dependencies (express, pdfkit, qrcode-generator, @fontsource-variable/inter).
- `npm start`: serves http://localhost:3000 from `server/index.js`, using `data/ebilling.db`.
- `npm run dev`: the same with `node --watch`. Without it, restart the server after server changes; `public/` and `shared/` changes only need a browser reload.
- `npm test`: runs `node --test test/*.test.js`. On Node 24, `node --test test/` does not work; pass the glob.
- One test: `node --test --test-name-pattern="day book" test/api.test.js`.

Requires Node ≥ 22.13. Environment:
- `PORT`: a number, or a socket path from the host.
- `DB_PATH`: default `data/ebilling.db`; a leading `~/` is the home folder.
- `PUBLIC_URL`: base of the share links sent on WhatsApp.
- `TRUST_PROXY` and `COOKIE_SECURE`.
- `NODE_ENV=production`: turns the demo login off.
- `DEMO_ACCOUNT=true|false`. When enabled, a shared demo login from `server/seed.js` is created on first start.
- `ALLOW_SIGNUP=false`: closes registration once any user exists (`signupAllowed()` in `server/routes/auth.js`; `/auth/config` reports it to the login page).

While the demo login is off, `/auth/login` refuses `DEMO_ACCOUNT` with its public password (403 `DEMO_PASSWORD`): the owner's real bills live in the demo business, so the live server must never open with `demo1234`. `npm run export-db` (`tools/export-db.js`) writes a single-file `VACUUM INTO` copy for uploading. It warns while that password is still set.

Live target: a Hostinger Node.js Web App on `billing.deveshstudio.com`. Every deploy replaces the app folder there, so `DB_PATH` points outside it (`~/domains/billing.deveshstudio.com/ebilling-data/ebilling.db`).

## The local database is real business data

`data/ebilling.db` (git-ignored) holds the owner's real bills, customers and payments. The owner also works inside the demo-flagged business, so never reset, reseed or "clean up" it. Before a schema change, stop the server and copy `data/ebilling.db*` somewhere safe. To try anything that writes data, run a throwaway copy, e.g. `PORT=3100 DB_PATH=<scratch>/verify.db node server/index.js`, opened at `127.0.0.1:3100` so its login cookie doesn't replace the one for `localhost:3000`.

## Architecture

**Three code areas.** `server/` holds the Express app, routes and services; `public/` holds the SPA (`index.html`, `css/`, `js/`). `shared/` is plain ES modules imported by the server through relative paths and served to the browser at `/shared/…`, so they must not import npm packages, Node built-ins or browser-only paths. `shared/` holds:
- bill maths (`calc.js`);
- money and date formatting plus constants (`format.js`);
- the bill renderer (`invoice-html.js`);
- work stages (`tracking.js`).

**Money is integer minor units (paise) everywhere.** The browser converts typed amounts with `toMinor` / `fromMinor` before sending, and server validators (`v.money` in `server/util.js`) reject non-integers. Quantities are rounded to 3 decimals.

**Database.** `server/db.js` wraps `DatabaseSync` with `get`, `all`, `run` and a nestable `tx()`, and holds `MIGRATIONS`, applied in order by `PRAGMA user_version`. Migrations are append-only SQL: add a new entry and never edit an old one, because the real database has already run it.

**Multi-tenant.** Every row belongs to a business, and every query filters by `business_id = req.businessId` (set by `requireAuth`). Single rows are looked up `WHERE id = ? AND business_id = ?`; see the `owned…()` helpers in the routes. Tests assert that another business can't see or change anything.

**Request pipeline** (`server/app.js`), in order:
1. Security headers with a strict CSP (`script-src 'self'`: no inline scripts or `on…` attributes).
2. JSON body parsing.
3. `csrfGuard`: every state-changing `/api` call (anything but GET, HEAD or OPTIONS) must send `X-Requested-With: fetch`, which `public/js/lib/api.js` always does.
4. Auth routes, then `requireAuth` on each API router.
5. The public share pages under `/i`, then static files.
6. An SPA fallback that serves `index.html` for any other GET.

To report errors, throw the helpers from `util.js`: `badRequest(message, field)`, `notFound`, `conflict(message, { code })`. The `field` lets the client show the message next to the right input.

**Team logins (v15).** `users.role` is `owner` or `team`. A team login is for the studio's team and is view only.
- `ownerOnly` (`server/auth.js`) guards every API router but `/api/auth` and `/api/view`, so a team login gets 403 everywhere else. Mount a new router with `requireAuth, ownerOnly` unless the team must see it.
- `/api/view` (`server/routes/view.js`) is all the team reaches. It lists the jobs from `findJobs` (`server/routes/tracking.js`, the same search as Tracking) with only these fields:
  - the bill number and the customer's name;
  - the mobile's last 4 digits;
  - the photos, through `/api/view/jobs/:id/photos/…`, and only for tracked jobs;
  - the items (name and quantity);
  - the stage and the amount due.

  Never add prices, totals, payments or the full number there. Its phone search (`findJobs(…, { team: true })`) matches only the last 4 digits, or a whole number exactly, so trying digits one by one can't uncover a number.
- `/auth/me` gives a team login only the business's name, logo (`/api/view/logo`) and currency.
- The owner adds, re-passwords and removes team logins in Settings (`/api/settings/team-logins`). A new password or removal deletes that login's sessions. A team login can't change its own password or preferences.
- In the browser, `app.isTeam` gives a shell with only Tracking and Sign out, and every other path goes to `/tracking`, which loads `views/team-jobs.js` (no stage buttons, payments or photo changes).

**Bills** (`server/services/billing.js`):
- `saveDraft` validates input (`validateBillInput`) and resolves or creates the customer from the typed name and WhatsApp number. It stores lines and totals from `shared/calc.js#computeBill`, the same function the editor uses for live totals.
- Drafts never touch stock. `finalizeBill` assigns the next invoice number, can record an advance, and deducts stock exactly once. The guard is a status-checked `UPDATE … WHERE status = 'draft' AND stock_applied = 0` plus a unique index on sale movements. `cancelBill` restores the stock its sale removed. Services (`products.kind = 'service'`) never touch stock.
- No GST: `validateBillInput` forces every tax rate to 0 and `with_gst = 0`. The GST paths in `calc.js`, `invoice-html.js` and `pdf.js` remain so bills created before GST was removed still render. Keep them.
- New bills take one discount % for the whole bill (`bills.discount_pct`, `computeBill({ discountPct })`). Per-line `discount_pct` still exists for older bills, and the editor only shows that column when a line uses it.
- `payment_status` (unpaid / partial / paid) follows `amount_paid`, and a payment larger than the balance is rejected.
- `addPayment` with `settle: true` lets the rest of the balance go: it adds it to `settle_discount` and `discount_total` and lowers `total`, so the bill is paid and sales count only what was charged. `invoiceTotals` shows it as "Discount at payment". With `settle`, the amount may be 0.

**Rendering a bill.** `shared/invoice-html.js#renderInvoiceHtml` serves both the in-app bill view and the customer's page. `server/services/pdf.js` draws the same design with pdfkit and the bundled Inter fonts in `server/fonts/` (needed for ₹). Totals rows come from `invoiceTotals`, which the HTML, the PDF and the editor all use, so change totals there. Colour and header style come from business settings (`bill_color`, `bill_header`). The business's phone, email, website (v16 `businesses.website`, stored without `https://`) and address are in the footer's film strip, not at the top, from `billContacts` (tel:, mailto: and https:// links; the address on one line); the top-right block now only holds a GST bill's GSTIN. Its icons are SVG path data in `BILL_ICONS`, drawn as `<path>`s in the HTML and with `doc.path()` in the PDF, which repeats the strip on every page (`reelLayout` sizes it, and `bottom()` leaves room for it).

**Customer links** (`server/routes/public.js`, no login): `/i/:token` (bill), `/i/:token/pay` (UPI payment page), `/i/:token/pdf` and `/i/:token/logo`. A token is random, revocable (`share_token` on the bill) and exposes only its own bill. `server/services/upi.js` builds the `upi://pay` link for the balance and its QR code (`qrcode-generator`). It returns null unless all of these hold:
- the bill is finalized and has a balance;
- the currency is INR;
- the business has a `upi_id`.

The money goes straight to that UPI ID, so never set a placeholder `upi_id` on a real business.

**Work tracking.** `bills.work_stage` runs `received → design → review → print → frame → final` (null means not tracked), with history in `bill_stages` (`server/services/tracking.js#setStage`). A job starts at `STAGE_KEYS[0]`. Stage definitions, the chain shown to customers, and `PHOTO_SOURCES` (how the customer's photo came in, stored in `bills.photo_source` and changeable after creation via `PUT /api/bills/:id/photo-source`) live in `shared/tracking.js`. The app's tap-a-stage buttons are `public/js/components/stages.js`.

**Job photos** (v14, table `bill_photos`; `server/services/photos.js`, browser side `public/js/components/job-photos.js`): the customer's photo on a job, so it's clear later which one the job is for.
- The browser makes each photo smaller (a JPEG up to 1600 px and a 360 px copy for lists) and sends both as data URLs, as JSON, to `POST /api/bills/:id/photos`. Both must fit in the 2 MB JSON limit. Any bill but a cancelled one takes photos, drafts too, up to 20 each.
- The server checks the bytes are JPEG, PNG or WebP (whatever the upload claims) and keeps them as BLOBs. `GET /api/bills/:id/photos/:photoId` (and `/thumb`) serves them only to the business's own logins, never on the customer's link. The browser caches each one by its id, so ids are `AUTOINCREMENT` and never reused.
- `/api/tracking` jobs and the bill detail include `photos`. The bill form keeps new photos until the bill is saved, then sends them.
- A bill's photos are deleted with it (`ON DELETE CASCADE`), so removing demo bills needs nothing extra. `/api/tracking` lists jobs newest bill first, filtered by date, phone, name or bill number and by `stage` (`all`, `open` = not final yet, or a stage key; the page's tabs are All / In progress / Final), with per-stage counts that follow the filters. Allowed stages are a CHECK on `work_stage`; SQLite can't alter a CHECK, so migration v9 shows how to change it (move the column aside, drop, re-add, copy back).

**Day book** (`server/routes/daybook.js`, table `day_entries`). An entry is one of:
- `kind = 'sale'`: a sale without a bill;
- `'received'`: other money received;
- `'expense'`: an expense, with a category.

The page also has a month calendar (`public/js/components/mini-calendar.js`, also on the dashboard) that marks the dates of bookings in violet (not cancelled, from `/api/bookings?from=&to=`) and days with money in or out in green (from `/api/day-book/days`; the dashboard leaves the green marks out and shows shoots only); a past date opens in the day book, a later one only lists its shoots. `/api/day-book/days` builds each day's closing from bills, bill payments, booking payments and these entries. Money received for a bill is recorded as a bill payment (`POST /api/bills/:id/payments`), never as an entry, so it isn't counted twice. The dashboard and reports add `kind = 'sale'` entries to sales.

**Bookings & Shoots** (photo / video bookings; `server/services/bookings.js`, `server/routes/bookings.js`, rules and labels in `shared/bookings.js`; views `bookings.js` for overview / list / calendar, `booking-editor.js` and `booking-view.js`; shared UI in `public/js/components/booking-ui.js`).
- Tables (v11): `bookings`, `team_members`, `booking_team`, `booking_payments`, `booking_activity`. `businesses.next_booking_no` numbers them `BK-0001`. Small per-booking records (`schedule`, `services`, `checklist`, `tasks`, `deadlines`, `delivery`, `links`) are JSON text columns, read through `parse()`.
- Dates (v12): `schedule` is `[{ date, start, end, venue }]`, one entry per date, each with its own times and venue; the first date is also copied into `event_date` / `start_time` / `end_time` / `venue`, and `days` is the number of dates. Use `scheduleOf`, `endDate`, `daysOn` and `dayWindow`, not those columns. The old form sent `event_date` + `days` + one time and venue, which `readSchedule` still accepts as consecutive dates.
- Services (v12) are bill lines `{ name, qty, rate, amount, product_id? }`; `total` = their sum less `discount` (`bookingTotals`), never typed in. `product_id` links one of the studio's services (Inventory, `kind = 'service'`), which the form offers with its price. Post-production sections and deliverables are read from the services' names (`serviceSections`).
- Bookings saved under v11 still read: `scheduleOf` builds their dates from `event_date` / `days`, and `servicesOf` turns the old `{ key, qty }` services into ₹0 lines plus a line for the old total, so the total and balance are unchanged. The client's address is `client_address`; the form no longer has phone, email or a Maps link, and an update that leaves out phone or email keeps what was saved.
- Status runs `BOOKING_FLOW` (`new` → … → `closed`); `on_hold` and `cancelled` keep the step they left in `prev_status`. Automatic moves: `shot` ticks the checklist; the first post-production step at `shot` moves it to `editing`; every deliverable delivered moves it to `delivered`; delivered and paid in full closes it, and money due again re-opens it.
- `settleStatus` applies those last two rules after every change that can affect them, including creating a booking and setting its status. Closing a booking with money due is refused (field `status`).
- Bringing a cancelled booking back checks its team for clashes like a new booking (409 `TEAM_CONFLICT` unless `allow_conflicts`).
- Lists, summary counts, quick filters and reminders are worked out in memory from all of a business's bookings with the shared helpers (`shootState`, `deliveryState`, `deadlineStates`, `matchesQuick`, `bookingReminders`). They depend on the viewer's date, which `bookingApi` sends as `?today=`.
- Team clashes: `teamConflicts` compares every date's `dayWindow` (no times = the whole day) and reports the other booking's clashing date, time and venue. Saving a booking or its team is refused with 409 `TEAM_CONFLICT` (the clashes in `details`) unless `allow_conflicts` is set; the browser's `saveWithConflicts` asks, then retries. Cancelled bookings hold no one.
- Every change writes a line to `booking_activity`. A new client is saved as a customer through `billing.js#resolveCustomer` (demo bookings link demo customers instead).
- Booking payments (`cash`, `upi`, `bank`, `card`, `other`) are money received, not sales: the day book closing counts cash as cash and the rest as online, and reports and the payments CSV include them.
- Removing a team member who has worked on bookings only hides them (`active = 0`), so those bookings keep the name.

**Dashboard** (`public/js/views/dashboard.js`, definitions in `shared/dashboard.js`). It is made of widgets (boxes, `DASHBOARD_WIDGETS`), quick actions (`QUICK_ACTIONS`) and summary numbers (`SUMMARY_STATS`).
- Customize turns the page into an editor: drag a box to move it, drag its corner or use its ⋯ menu to size it, hide boxes and add them back. Pointer events handle the dragging; a mouse can grab anywhere on a box, a finger only its handle, so the page still scrolls.
- What a box has inside can't be clicked while customizing. Each box is a CSS container, so what's inside fits any width.
- Customize saves the owner's choice per login: `PUT /api/auth/preferences` into `users.preferences` (v13), returned in `/auth/me` as `user.preferences.dashboard`. `dashboardPrefs()` makes any saved value whole: every widget once, only known keys, and sizes cleaned. A new widget appears for everyone at the end, shown unless it's in `HIDDEN_AT_FIRST`.
- Sizes are per widget:
  - `w` is the columns of 12 (3 to 12, or null);
  - `h` is the height in px (120 to 1600 in steps of 20, or null).
- `layoutSpans` turns them into columns, row by row:
  - computer (the grid ≥ 900 px wide): set widths kept, and a box without one (half, or full for `wide` ones) grows to fill its row;
  - tablet (≥ 560 px): half or full, the last box of a row filling it;
  - phone: one per row.
  
  Heights only apply on a computer.
- The page fetches only what the visible widgets need.

**Colours by part of the app.** Tokens `--c-bills`, `--c-book`, `--c-daybook`, `--c-track`, `--c-stock`, `--c-cust` and `--c-report` in `app.css`. An `area-…` class sets `--area` / `--area-bg`, which the menu, dashboard widgets and quick actions use. Bookings are violet and the day book green everywhere, including the calendar marks.

**Client** (`public/js`):
- `main.js` registers routes (`route('/path', () => import('./views/x.js'))`) and the nav.
- Each view exports `default async function (el, { app, params, query })`, renders into `el`, and may return a cleanup function.
- `lib/dom.js` has `html`, a tagged template that escapes every interpolation (use `raw()` only for trusted markup), plus `setHtml`, delegated `on` and `debounce`.
  - Use `onDateCommit` instead of `change` when a date input's change saves or redraws: Chromium fires `change` for each typed part of a date.
- A view that sets a leave guard clears it in its cleanup with `clearLeaveGuard(guard)` (`lib/router.js`). A view that awaits before drawing returns at once if `!el.isConnected` (it was left while loading), so it can't touch the next view's guard.
- `lib/ui.js` has toasts, `openModal`, `confirmDialog`, `busy` and form-error helpers.
- Layouts adapt with container queries (`container: …` in `public/css/app.css`) as well as media queries.
- `public/css/invoice.css` styles the bill and the public pages.

**Demo data.** `server/seed.js` creates the demo business (catalog, bills, tracked jobs, day book, a team and ten bookings at every step), with every row flagged `is_demo` and removable from Settings. It only runs when the demo login is first created, so an existing demo business never gets new sample rows. A new table holding business data needs its demo rows deleted in `removeDemoData` and counted in `server/routes/auth.js#mePayload`. Sample team members the owner has put on their own bookings are kept (made real) rather than deleted, as deleting would take them off those bookings.

## Tests

`test/api.test.js` starts the real app on an in-memory database (`openDb(':memory:')`, random port) and drives it over HTTP. Its `client()` keeps the session cookie and sends the CSRF header, and most tests create a fresh business with `newBusiness()`. `test/shared.test.js` covers the shared modules. Test dates use `today` (the UTC date), and the demo-account assertions depend on the data in `server/seed.js`.
