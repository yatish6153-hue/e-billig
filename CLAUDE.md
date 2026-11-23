# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

eBilling: billing, job tracking and a day book for Devesh Digital Studio (a photo and design studio in Jaipur), usable by any small business. Node.js + Express 5 + SQLite through the built-in `node:sqlite`, with a plain ES-module single-page app. There is no build step, bundler or native module. The owner writes in Hinglish; keep UI copy short, plain English.

## Commands

- `npm install`: dependencies (express, pdfkit, qrcode-generator, @fontsource-variable/inter, @fontsource-variable/bricolage-grotesque).
- `npm start`: serves http://localhost:3000 from `server/index.js`, using `data/ebilling.db`.
- `npm run dev`: the same with `node --watch`. Without it, restart the server after server changes; `public/` and `shared/` changes only need a browser reload.
- `npm test`: runs `node --test test/*.test.js`. On Node 24, `node --test test/` does not work; pass the glob.
- One test: `node --test --test-name-pattern="day book" test/api.test.js`.

Requires Node ≥ 22.13. Environment: `PORT`, `DB_PATH` (default `data/ebilling.db`), `PUBLIC_URL` (base of share links sent on WhatsApp), `TRUST_PROXY`, `COOKIE_SECURE`, `NODE_ENV=production` (turns the demo login off), `DEMO_ACCOUNT=true|false`, `SMTP_*` / `MAIL_FROM` (the account backups are emailed from), `TZ`. Any of these can go in a git-ignored `.env` file (`server/env.js` loads it; `.env.example` lists them). When enabled, a shared demo login from `server/seed.js` is created on first start.

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

**Team logins (v15).** `users.role` is `owner` or `team`. A team login is for the studio's team: it looks at the jobs, and the one thing it can change is adding the customer's photo to a job.
- `ownerOnly` (`server/auth.js`) guards every API router but `/api/auth` and `/api/view`, so a team login gets 403 everywhere else. Mount a new router with `requireAuth, ownerOnly` unless the team must see it.
- `/api/view` (`server/routes/view.js`) is all the team reaches. It lists the jobs from `findJobs` (`server/routes/tracking.js`, the same search as Tracking) with only these fields:
  - the bill number and the customer's name;
  - the mobile's last 4 digits;
  - the photos, through `/api/view/jobs/:id/photos/…`, and only for tracked jobs;
  - the items (name and quantity);
  - the stage and the amount due.

  `POST /api/view/jobs/:id/photos` lets the team add a photo to a job on its list (`addPhoto`, the same checks and limit as the owner's; `bill_photos.user_id` is the team login) and answers with the job's photos on the team's links. There is no way for the team to remove one.

  Never add prices, totals, payments or the full number there. Its phone search (`findJobs(…, { team: true })`) matches only the last 4 digits, or a whole number exactly, so trying digits one by one can't uncover a number.
- `/auth/me` gives a team login only the business's name, logo (`/api/view/logo`) and currency.
- The owner adds, re-passwords and removes team logins in Settings (`/api/settings/team-logins`). A new password or removal deletes that login's sessions. A team login can't change its own password, email or preferences. The owner changes their own login email in Settings → Account (`POST /api/auth/email` with the current password); it isn't the business's email on bills. If no login has the demo email any more (the owner renamed it), the next start creates a new demo business for it (`ensureDemoAccount`).
- In the browser, `app.isTeam` gives a shell with only Tracking and Sign out, and every other path goes to `/tracking`, which loads `views/team-jobs.js` (no stage buttons or payments; the photo dialog `openPhotos({ addPath, canRemove: false })` adds through `/api/view` and has no Remove).

**Bills** (`server/services/billing.js`):
- `saveDraft` validates input (`validateBillInput`) and resolves or creates the customer from the typed name and WhatsApp number. It stores lines and totals from `shared/calc.js#computeBill`, the same function the editor uses for live totals.
- Drafts never touch stock. `finalizeBill` assigns the next invoice number, can record an advance, and deducts stock exactly once. The guard is a status-checked `UPDATE … WHERE status = 'draft' AND stock_applied = 0` plus a unique index on sale movements. `cancelBill` restores the stock its sale removed. Services (`products.kind = 'service'`) never touch stock.
- `deleteBill` (`DELETE /api/bills/:id`, the bill page's "Delete bill") removes a bill of any status: a finalized bill's stock goes back first (`putStockBack`, as for cancelling), and its items, payments, photos and stages cascade, so its money leaves the day book and reports. Its stock movements stay with `bill_id` set to null, and its invoice number is never reused.
- No GST: `validateBillInput` forces every tax rate to 0 and `with_gst = 0`. The GST paths in `calc.js`, `invoice-html.js` and `pdf.js` remain so bills created before GST was removed still render. Keep them.
- New bills take one discount % for the whole bill (`bills.discount_pct`, `computeBill({ discountPct })`). Each line also has its own `discount_pct`: the editor shows every line as Qty · Price · Discount · Total, and a new line starts at 30% (`ITEM_DISCOUNT` in `bill-editor.js`). Typing the line's total works the price out backwards (`shared/calc.js#priceForTotal`); the price is what's saved.
- `payment_status` (unpaid / partial / paid) follows `amount_paid`, and a payment larger than the balance is rejected.
- `addPayment` with `settle: true` lets the rest of the balance go: it adds it to `settle_discount` and `discount_total` and lowers `total`, so the bill is paid and sales count only what was charged. `invoiceTotals` shows it as "Discount at payment". With `settle`, the amount may be 0.

**Rendering a bill.** `shared/invoice-html.js#renderInvoiceHtml` serves both the in-app bill view and the customer's page. `server/services/pdf.js` draws the same design with pdfkit and the bundled Inter fonts in `server/fonts/` (needed for ₹). Totals rows come from `invoiceTotals`, which the HTML, the PDF and the editor all use, so change totals there. Colour and header style come from business settings (`bill_color`, `bill_header`). The business's phone, email, website (v16 `businesses.website`, stored without `https://`) and address are in the footer's film strip, not at the top, from `billContacts` (tel:, mailto: and https:// links; the address on one line); the top-right block now only holds a GST bill's GSTIN. Its icons are SVG path data in `BILL_ICONS`, drawn as `<path>`s in the HTML and with `doc.path()` in the PDF, which repeats the strip on every page (`reelLayout` sizes it, and `bottom()` leaves room for it).

The look follows the studio's website (deveshstudio.com), always in the business's colour: a warm-black band (`#0d0a08`) with a glow from the top right, labels as "● LABEL", the customer inside viewfinder corners, items numbered 01, 02 … (`frameNo`), and the PDF's amounts in tabular figures (`TNUM`: Inter's kerning otherwise hides the decimal point in amounts like 7.14). When a change touches one of HTML or PDF, make it in the other too.

**Review card.** v19 `businesses.review_url` (Settings → Bills & payments → Google review link; `reviewUrl()` in `server/routes/settings.js` adds `https://` and refuses anything but a plain web address). Every bill but a cancelled one ends with a "Review us on Google." card (`reviewLink` / `reviewCopy`; another site's link says "Leave us a review"): gold stars and a "Write a review" pill button that opens the link (full width on a phone; in the PDF the whole card is the link). No QR code: the owner shares bills on WhatsApp, so customers tap. The button's words are near-black or white, whichever reads better on the business colour (`onAccent`, `--on-accent`). The demo business is seeded with the studio's link.

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

Expense types (v17, `businesses.expense_types`, a JSON list; empty means `EXPENSE_CATEGORIES`) are the owner's own: `serializeBusiness` returns them as `business.expense_types`, and `PUT /api/settings/expense-types` `{ types, renames: [{ from, to }] }` saves the list and renames the type on saved expenses (in two steps, so swaps work). The day book's Type field has "Edit types". A removed type stays on its old expenses.

The page shows a Day, a Week (Monday to Sunday) or a Month (`?view=week|month&date=`): a week or month has its closing summed from `/api/day-book/days`, a day-by-day table and the expenses by type, and no add form.

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
- Booking payments (`cash`, `upi`, `bank`, `card`, `other`; the buttons offer only `BOOKING_PAY_CHOICES`, Cash / UPI / Other, and the others stay for older payments) are money received, not sales: the day book closing counts cash as cash and the rest as online, and reports and the payments CSV include them.
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

**Sign-in page** (`views/auth.js`, the "Auth" block in `app.css`). It follows the studio website and the bills: on warm black (`#0d0a08`) with an ember glow and lens rings, the logo for dark backgrounds (`public/brand/devesh-studio-logo-dark.png`, the logo with its tile made transparent), a "● eBilling" label, a headline in Bricolage Grotesque inside viewfinder corners ending in an orange full stop, and numbered points; the form on warm white with an orange pill button (`#ff7a1a`, text `#1a0900`). Bricolage is self-hosted like Inter: `@fontsource-variable/bricolage-grotesque`, served at `/vendor/bricolage` (`server/app.js`) and linked in `index.html`. Everything is scoped to `.auth`, so the app keeps its blue; at 860px and narrower the dark side is a short band above the form. While it shows it sets `<meta name="theme-color">` to the warm black, and its cleanup puts the app colour back.

**Client** (`public/js`):
- `main.js` registers routes (`route('/path', () => import('./views/x.js'))`) and the nav.
- Each view exports `default async function (el, { app, params, query })`, renders into `el`, and may return a cleanup function.
- `lib/dom.js` has `html`, a tagged template that escapes every interpolation (use `raw()` only for trusted markup), plus `setHtml`, delegated `on` and `debounce`.
  - Use `onDateCommit` instead of `change` when a date input's change saves or redraws: Chromium fires `change` for each typed part of a date.
- A view that sets a leave guard clears it in its cleanup with `clearLeaveGuard(guard)` (`lib/router.js`). A view that awaits before drawing returns at once if `!el.isConnected` (it was left while loading), so it can't touch the next view's guard.
- `lib/ui.js` has toasts, `openModal`, `confirmDialog`, `busy` and form-error helpers.
- `isPhone()` (`lib/dom.js`) tells a phone or tablet from a computer. Phones get "Take photo" (the camera) beside "Gallery". WhatsApp links go through `whatsappLink` / `shareOnWhatsApp` (`components/share.js`): `https://wa.me/…` on a phone, `whatsapp://send?…` on a computer so the WhatsApp desktop app opens instead of a browser tab, with a toast offering WhatsApp Web if the app doesn't open. The customer's public pages keep wa.me. `whatsappButton` / `onWhatsAppButton` / `openWhatsAppChat` (same file) give the Customers list and a customer's page a button that opens a chat with the number, nothing typed; a demo customer's button only says its number is a sample.
- The product form shows the name, stock, selling price and category; purchase price, unit, low-stock alert, SKU and barcode are under "More options".
- Settings → Categories & types edits the product categories and the expense types with `components/name-list.js#openNameListEditor` (the day book's "Edit types" uses it too). Product categories (v18, `businesses.product_categories`, a JSON list) come from `services/business.js#productCategories`: the owner's list in their order, then any other category an item uses, matched without regard to case, with item counts; `/api/products/categories` returns them. `PUT /api/settings/product-categories` `{ categories, renames }` renames the category on its items and takes a category left off the list off its items.
- Layouts adapt with container queries (`container: …` in `public/css/app.css`) as well as media queries.
- `public/css/invoice.css` styles the bill and the public pages.

**Exports** (`GET /api/reports/export?type=`). bills, items, payments, daybook and inventory are CSV (`v.toCsv`: a UTF-8 BOM, and text starting with = + - @ gets a leading `'`, which Excel shows). `customers` is a real Excel file from `server/services/xlsx.js` (no dependency: deflated zip of inline-string sheet XML, a bold frozen header, money cells as numbers with 2 decimals), so numbers like +91 98290 12345 show as typed; pass `columns` in the export to make another type an .xlsx. Its totals reuse the Customers page's `AGGREGATES` (`routes/customers.js`).

**Email backups** (`server/services/backup-email.js`, `server/services/mail.js`; v20 `businesses.backup_email`, `backup_daily`, `backup_emailed_at`, `backup_email_error`; `GET/PUT /api/backup/email`, `POST /api/backup/email/send`).
- `mail.js` sends with nodemailer through the SMTP account in `.env` (`SMTP_HOST`, `SMTP_PORT` (465), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`; see `.env.example`). `server/env.js`, imported first by `index.js`, loads `.env` (values already in the environment win). `mailError` turns nodemailer errors into plain words; tests swap the transport with `setMailTransport`.
- `emailBackup` gzips `createBackup`'s file and attaches it (up to `MAX_ATTACHMENT_BYTES`, else the email says to download it), then records the time or the error. `startBackupEmails` (index.js only, never in tests) checks every 15 minutes; `backupEmailDue` is once a day from `SEND_HOUR` (21, the server's clock, `TZ`), with the first one and a missed day sent at once, retrying an hour after a failure. "Send backup now" allows one a minute.
- `stageBackup` takes a gzipped upload too (the emailed file), unpacking it with the same 1 GB limit. A restore keeps the business's `backup_*` columns as they are.

**Backup & restore** (`server/services/backup.js`, routes `server/routes/backup.js` at `/api/backup`, owner only; Settings → Backup & restore).
- A backup is an SQLite file made with the app's own schema (`migrate(conn)` in `db.js`), holding the business's row and every row of `BACKUP_TABLES`, plus an `ebilling_backup` key/value table (app, format, created_at, business_name). No `users` or `sessions`. A new table with business data must go in `BACKUP_TABLES` (parents first; `via` for a table without `business_id`); a test fails until it's listed there or in `NOT_IN_BACKUP`.
- Restoring is two steps: `POST /api/backup/check` takes the raw file (`application/octet-stream`, streamed to a temp file, 1 GB at most), checks it and returns a token and what it holds; `POST /api/backup/restore { upload }` replaces everything in one transaction. One upload waits per business, for 30 minutes.
- The file comes from outside: it must be SQLite with the `ebilling_backup` table, no views or triggers, and pass `quick_check`; an older schema is migrated in the temp copy, a newer one refused. Backup files are opened with `enableForeignKeyConstraints: false` (node:sqlite turns them on by default), as they hold no logins.
- The restore deletes the business's rows (children first), then copies the backup's in (parents first). A row keeps its id unless another row has it now (ids of deleted rows are reused), else gets a new one; foreign keys are remapped from `PRAGMA foreign_key_list`, `business_id` becomes the signed-in business, a link to a login that isn't this business's is cleared, and a missing required parent makes it "damaged". Bookings' `services[].product_id` is remapped too. On the way in, links and pictures are checked as when typed: the settings checks in `services/business.js`, `webLink` for booking links, `imageType` for photos and the logo; a share token another bill has is cleared. `next_invoice_no` / `next_booking_no` never go down.

**Demo data.** `server/seed.js` creates the demo business (catalog, bills, tracked jobs, day book, a team and ten bookings at every step), with every row flagged `is_demo` and removable from Settings. It only runs when the demo login is first created, so an existing demo business never gets new sample rows. A new table holding business data needs its demo rows deleted in `removeDemoData` and counted in `server/routes/auth.js#mePayload`. Sample team members the owner has put on their own bookings are kept (made real) rather than deleted, as deleting would take them off those bookings.

## Tests

`test/api.test.js` starts the real app on an in-memory database (`openDb(':memory:')`, random port) and drives it over HTTP. Its `client()` keeps the session cookie and sends the CSRF header, and most tests create a fresh business with `newBusiness()`. `test/shared.test.js` covers the shared modules. Test dates use `today` (the UTC date), and the demo-account assertions depend on the data in `server/seed.js`.
