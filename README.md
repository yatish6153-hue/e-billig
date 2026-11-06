# eBilling — billing & inventory for small businesses

A responsive web app for **Devesh Digital Studio** (and any small business) to manage products and services, create simple bills (no GST), track jobs and payments, share bills customers can pay by UPI, and run photo and video bookings from the booking to the final delivery.

- **Stack:** Node.js 22.13+ (built-in SQLite via `node:sqlite`), Express 5, pdfkit, plain ES-module frontend. No build step and no native modules.
- **Data:** one SQLite file (`data/ebilling.db` by default). Every row belongs to a business, and every query is scoped to the signed-in user's business.

## Run it

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000. On first start the app creates a **demo login** with sample studio data (products, services, customers and bills, all marked **Demo**):

| Email | Password |
|---|---|
| `demo@example.com` | `demo1234` |

Or click **Create account** to register your own business. Tick "Add sample products & customers" if you want practice data; it can be removed later in **Settings → Demo data**.

Run the tests (API + calculation tests on an in-memory database):

```bash
npm test
```

## Features

**Dashboard: one simple home screen, set up your way.**
- Widgets, each in the colour of its part of the app:
  - quick actions;
  - **Today** (the day book closing: sales, money received, expenses, net cash);
  - a small **calendar**;
  - today's and upcoming **shoots**;
  - the **sales summary** (today, 7 days, month, year or all time);
  - **jobs at work** (Tracking);
  - **booking reminders**;
  - **recent bills**;
  - **low stock**;
  - the demo data notice.
- **Customize** (top right) turns the dashboard itself into an editor:
  - **drag a box** to put it anywhere (with a mouse from anywhere on the box; on a phone by its ⠿ handle);
  - **drag its corner** to make it wider, narrower, taller or shorter, or pick a size from its ⋯ menu (Auto, ¼, ⅓, ½, ⅔, ¾ or Full width; Fit, Shorter or Taller). A box without a set width fills what its row leaves empty; a box with a set height scrolls inside;
  - hide a box with its eye button and bring it back with **Add a box**;
  - pick up to 6 quick actions (New bill, New booking, Day book, Tracking, Add product, Add customer) and the numbers in the sales summary (total sales, paid bills, unpaid bills, due on bookings, inventory value) from those boxes' ⋯ menus.
  
  **Save** keeps it for your login, **Cancel** drops the changes, and **Back to default** resets it. Sizes apply on a computer screen; on a tablet boxes are half or full width, and on a phone one under another, in your order.
- The calendar marks only the dates with a **shoot booked, in violet** (the green day book marks are on the Day book page's calendar). Tap a date to see its shoots and the day book's money in and out, open that day, or start a new booking.
- Each part of the app has its own colour, in the menu too: Bills blue, Tracking orange, Bookings & Shoots violet, Day book green, Inventory grey.

**Inventory.**
- Products (stock-tracked goods) and **services** (shoots, editing, design: billable, never touch stock).
- Fields: name, SKU, barcode, category, unit, purchase price, selling price, quantity, low-stock level.
- Stock in, stock out (with a reason) and physical count, each recorded in a full movement history.
- Archive items you no longer sell, and export the inventory to CSV.

**Billing — kept simple.**
- Type the **customer name** and **WhatsApp number** right on the bill. A new name is saved as a customer automatically. Typing a saved number fills in the name, and shows any balance they still owe.
- Add items by search, barcode scan, or **Custom item** (type a description and price).
- **No GST.** Bills have no tax lines at all. Bills made before GST was removed keep the amounts they were created with.
- **Discount %** for the whole bill, in the bill summary. The bill shows it as "Discount (10%)".
- **Advance received** (Cash or Online, with an optional UPI/card/bank reference) is entered on the same screen, and the **Balance** updates as you type. One **Create bill** button finishes it.
- **Drafts never change stock.** Creating the bill assigns the next number and deducts stock **exactly once**: a status-guarded update plus a unique database index make a double click or retry harmless.
- **Insufficient stock** is caught when you create the bill. You see what's short and must confirm explicitly to go below zero.
- Receive the balance later (Cash or Online), from the bill or by tapping **Due ₹…** on the job in Tracking. Bills move from unpaid to partially paid to paid, and overpayment is blocked.
- **Customer paid a little less?** Enter what they paid and tick **let the rest go**: the difference shows on the bill as "Discount at payment" and the bill becomes Paid. Leave it unticked to keep the rest due.
- **Cancelling** a bill restores exactly the stock its sale removed. Duplicate a bill to re-issue it.

**Work tracking — one row per job.**
- Each job has six stage buttons: **Received · Design · Review · Print · Frame · Final**. Tap the stage the job has reached. Earlier stages show ✓, and a job at Final turns green and shows **Done**. Tapping an earlier stage moves it back. "Track this job" is ticked by default when you create a bill (the job starts at Received), or you can track any bill later.
- **Photo received:** on the bill, choose how the customer's photo came in: **WhatsApp**, **Photo to photo**, **In studio** or **Other**. It shows on the job in Tracking and on the bill page, where it can be changed later.
- **The customer's photo**, so you never forget which photo a job is for: add it on the new bill, on the bill page, or by tapping the photo square on the job in Tracking. On a phone, **Take photo** opens the camera and **Gallery** picks saved ones; on a computer, choose a file, or **paste** a copied photo (Ctrl+V, e.g. from WhatsApp Web) or drop it in. Up to 20 photos a job. Each one is made smaller before it's sent, so it's quick even on mobile data. The first photo shows on the job's row; tap it to see them all large, add more, open one full size or remove one. Photos are only for your logins: the customer's bill link never shows them.
- The **Tracking** page lists the **newest jobs first** and opens on **All**, so finished jobs stay on the list. Each row shows the customer's photo, the **bill number**, customer, bill date, WhatsApp number and **what was ordered** (each item and its quantity). Three tabs above the list, with counts: **All**, **In progress** (not final yet) and **Final**.
- **Filters:** date (today, yesterday, last 7 days, this month, last month or a chosen date), mobile number (with or without +91), name and bill number ("21", "0021" or "INV-0021"). The tab counts follow the filters.
- **Send status** (share icon) opens a prefilled update ("Your design is ready for review…") with the bill link. The customer's link shows the job's progress at the top.
- Each bill keeps a dated history of its stages. The dashboard shows how many jobs are at each stage.

**Team login — Tracking for your team, to look at only.**
- In **Settings → Team login**, add a login (a name, an email and a password) for your team. The email doesn't need to be a real inbox: it's what they type to sign in, on the same sign-in page.
- Signed in, the team sees only **Tracking**: search by bill number, name, mobile number or date, with the same All / In progress / Final tabs. Each job shows:
  - the **bill number** and the **customer's name**;
  - the **last 4 digits** of the mobile;
  - the **photos** (tap to see them large);
  - **what was ordered**;
  - the **stage**;
  - the **amount due**, or Paid.
- They see no prices, totals or payments, no other part of the app, and they can't change anything: no stage buttons, no payments, no photos added or removed.
- **Change password** signs the team out until they use the new one, and **Remove** ends that login straight away.

**Bookings & Shoots: weddings, pre-weddings, birthdays, corporate events and other programs.**
- **Overview** at the top: Total bookings, Upcoming shoots, Shoots completed, Editing pending, Ready for delivery, Delivered and Payment pending (with the amount due); quick filters (Today, This week, Upcoming, Shoot completed, Editing pending, Payment pending, Delivery pending, Completed projects); **today's** and **upcoming shoots** with client, event, date, time, venue and team; and **reminders**: tomorrow's shoots, shoot dates gone by, deadlines overdue or close, client reviews waiting and money due after the shoot.
- **+ New booking**:
  - **Client:** name, WhatsApp number, alternative contact and address.
  - **Event:** type (or your own), name and notes, with **as many dates as it needs** (**+ Add date**). Each date has its own start time, end time and **venue**, so a haldi at home and a wedding at a hotel two days later are one booking.
  - **Services & prices**, like a bill: each service with its quantity and price, then the subtotal, a discount and the total. Your services from Inventory come up with their price as you type, and a new service can be saved there in one tap.
  - **Package & payment:** the package name and the **advance**. The remaining amount and payment status work themselves out.
  - **Team.**

  A new client is saved as a customer, and **Duplicate** starts a copy of a booking.
- **Status**: New booking → Confirmed → Shoot scheduled → Shoot completed → Editing → Client review → Ready for delivery → Delivered → Closed, plus On hold and Cancelled (both remember where the booking was). Tap a status button, as in Tracking. Some moves happen by themselves: marking the shoot complete ticks the checklist; the first post-production step moves it to Editing; delivering everything booked makes it Delivered; delivered and paid in full closes it.
- **Team**: keep your photographers, videographers, editors and assistants under **Team**, and put them on each booking with a role. If someone is already on another shoot at an overlapping time (on any of its dates), you see who, when and where before saving, and can save anyway.
- **List** with booking ID, event date, client, event and venue, package and total, team, balance due, shoot and delivery status, and actions (view, edit, duplicate, mark shoot complete, add payment, add a Drive link, delete). Search by client name, phone, booking ID, event or venue; filter by date, event type, booking status, payment, delivery and team member.
- **Calendar**: month, week or day, marked Confirmed, Upcoming (still to confirm), Completed or Cancelled. Each date of a booking shows on its own day with its time and venue. Tap a booking to open it.
- **The booking page** shows progress (Booking → Shoot → Backup → Editing → Review → Delivery), the status buttons, the event's dates with their times and venues, the client (call, WhatsApp, address), the **bill & payment** (each service with its price, discount, total, received and remaining), a **shoot checklist**, **post-production** steps for photos, video and album (only those the services need), **deadlines** (photo editing, video first cut, client review, final delivery, album delivery) marked overdue in red, **delivery** (what was delivered, when, how, links, pen drive), **files & links** (Google Drive, Dropbox, WeTransfer, client gallery…), internal notes and an **activity history** written as you go.
- **Payments**: each with date, amount, method (Cash, UPI, Bank transfer, Card, Other) and note, never more than the balance. They count as money received in the **Day book** closing (cash as cash, the rest as online) and in **Reports**.

**Day book: daily sales, money received and expenses.**
- Every evening, open **Day book** (in the menu, or on the dashboard) and add what the bills don't cover:
  - **Sale**: a sale without a bill (passport photos, prints, counter sales), with Cash or Online.
  - **Money received**: money that came in. If it's for a bill, choose the bill: it's recorded as a payment on that bill and its balance goes down.
  - **Expense**: where you paid money, with a type (lab & printing, frames, rent, salary, tea…).
- The **closing** for the day adds it all up with your bills and bookings: sales (bills plus sales without a bill), money received (cash and online, booking payments included), expenses (cash and online) and **net cash** (cash in − cash out).
- The day's list shows everything you added (edit or delete any time) and the payments received on bills and bookings.
- Move between days with ‹ › or the date. **Last 7 days** shows sales, received, expenses and net cash for each day; tap a day to open it.
- A **calendar** beside it marks the dates with shoots booked (violet) and the days with money in or out (green). Tap a date to open that day; for any date it lists the shoots with their time and venue, with **New booking** to book that date.
- The dashboard and reports include sales without a bill. **Reports → Export CSV → Day book** downloads every entry for your accountant.

**Studio bill design.**
- Dark header band with your logo, name and **tagline**, faint lens rings in your colour behind the bill number, plus an accent bar in your colour.
- Items, then **Total**, **Advance**, and a highlighted **Balance**, with a rubber-stamp mark: **PAID** or **BALANCE DUE**.
- A camera and "Thank you for choosing …", then a film-strip footer that carries your **phone, email and website** (each in its own frame, with an icon) and your **address**. On the customer's link and in the PDF they are links: tap to call, email or open the website. They come from **Settings → Business details** (Phone, Email, Website, Address); anything left empty is left out. A PDF that runs to more pages shows the strip on every page.
- In **Settings → Bill design**, change the tagline, choose a colour (studio orange by default) and pick a dark or light header, with a live preview. The same design is used on screen, in PDFs and on the customer's link.

**Download & share.**
- An A4 bill (PDF or print) in the studio design.
- Buttons for Download PDF, Print, Copy link and WhatsApp. WhatsApp opens a prefilled message (total, advance, balance and the bill link) addressed to the customer's WhatsApp number.
- Share links use 192-bit random tokens, show only that one bill, are marked `noindex`, and can be **revoked or regenerated** at any time.

**Customers pay the balance by UPI.**
- Add your **UPI ID** in Settings → Bills & payments. Every bill you share on WhatsApp then carries a **Pay the balance by UPI** link (`…/pay`), and the customer's bill page shows **Pay now by UPI** at the top.
- The payment page has a **Pay ₹…** button that opens Google Pay, PhonePe, Paytm or any UPI app with the amount and bill number filled in, plus a QR code to scan from another phone. The PDF bill gets the same QR ("Scan to pay").
- The money goes straight to your UPI ID. The app isn't told about it, so when it arrives, record it with **Receive balance** (Online). The page asks the customer to send the payment screenshot on WhatsApp.
- **Copy payment link** (in the bill's ⋯ menu) gives you the link to send another way.

**Customers.** Name, WhatsApp number, email and billing address. Each customer shows bill history, total billed, paid and **balance**.

**Reports & settings.**
- Date-filtered sales reports: net sales (bills plus sales without a bill), money received (bills, bookings and the day book), outstanding, expenses (and sales less expenses), best sellers (by revenue or quantity), Cash/Online split and low stock.
- CSV exports: bill-wise sales, product-wise sales, payments (bills and bookings), the day book and inventory.
- Settings cover business details (name, phone, email, website, address) and logo, currency (INR by default), bill number prefix and next number, UPI ID, round-off, payment details and terms.

## Going live (e.g. billing.deveshstudio.com)

Run behind HTTPS (nginx, Caddy, or a platform like Render or Railway) and set:

| Variable | Example | Why |
|---|---|---|
| `NODE_ENV` | `production` | Turns the shared demo login **off** (it's on by default only for local use) |
| `PUBLIC_URL` | `https://billing.deveshstudio.com` | Base for invoice links sent on WhatsApp. Without it, local links like `http://localhost:3000/...` won't open for customers |
| `TRUST_PROXY` | `true` | Behind a reverse proxy, so secure cookies and links are detected correctly |
| `COOKIE_SECURE` | `true` | Session cookie is only sent over HTTPS |
| `PORT` | `3000` | Port to listen on (a host may set it for you) |
| `DB_PATH` | `/var/lib/ebilling/ebilling.db` or `~/ebilling-data/ebilling.db` | Where the SQLite file lives (back this up). `~/` means the home folder |
| `DEMO_ACCOUNT` | `false` / `true` | Force the demo login off or on |
| `ALLOW_SIGNUP` | `false` | Closes **Create account** to strangers. The first account on an empty database can still be made |

With the demo login off, `demo@example.com` no longer opens with the public password `demo1234`. If you used that login for real bills, change its password in **Settings → Account** before you upload the database.

**Moving your bills online:** `npm run export-db` writes `data/ebilling-upload.db`, a single-file copy of the database, safe to make while the app runs. It warns you if the demo password is still set. Upload that file as the live database.

**Backups:** copy the database file while the app is stopped, or use `sqlite3 ebilling.db ".backup backup.db"` (or `npm run export-db`) while it runs. Job photos and the logo are kept in the same file, so one backup has everything.

### Hostinger (Business or Cloud plan)

1. **Websites → Add website → Node.js Web App**, on the subdomain `billing.deveshstudio.com`. It has to be its own website, not a folder of the main site.
2. Upload a zip of this project without `node_modules`, `data`, `.git` and `test`. Hostinger runs `npm install` itself. Choose Node.js **24.x** (22.x also works), and set the entry file to `server/index.js`.
3. Set the environment variables above. Use `DB_PATH=~/domains/billing.deveshstudio.com/ebilling-data/ebilling.db`. Every deploy replaces the app folder, so the database must sit outside it.
4. Hostinger's documentation doesn't say whether that folder survives redeploys, so after the first redeploy check that your bills are still there. Keep regular backups too: download `ebilling.db` together with any `-wal` and `-shm` files beside it.

### Before real billing

1. Sign in to your own account, not the shared demo.
2. In **Settings**, upload your logo and set your UPI ID, bank details and terms. A ready-to-use version of the Devesh Studio logo (from deveshstudio.com, placed on a dark tile so its light lettering shows on white invoices) is at `server/assets/devesh-studio-logo.png`. The demo business uses it automatically.
3. Remove demo data (Settings → Demo data). If no real invoices exist yet, numbering restarts at `INV-0001`.

Demo prices are illustrative; set your own in Inventory.

## Security notes

- Passwords are hashed with scrypt. Sessions are random tokens stored hashed, in HttpOnly SameSite cookies, and expire after 30 days. Repeated failed sign-ins are rate-limited.
- A team login is limited on the server, not only on screen: every part of the API except its own view of the jobs answers it with "not allowed", and that view never includes prices, payments or the full mobile number.
- Every state-changing API call requires an `X-Requested-With` header (CSRF protection). A strict Content-Security-Policy is applied: no inline scripts, no framing.
- All HTML output is escaped. CSV exports neutralise spreadsheet formulas. Logos must be real PNG or JPEG images of 1 MB or less.

## Project layout

```
server/            Express app, routes, services (billing, inventory, PDF), schema, demo seed
shared/            Code used by both server and browser: bill maths, money formatting, invoice HTML
public/            Single-page app: index.html, css/, js/ (views, components, lib)
test/              node:test API and calculation tests
```
