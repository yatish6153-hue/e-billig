// App bootstrap: session check, shell (sidebar / mobile nav), routing.
import { route, startRouter, navigate, reload } from './lib/router.js';
import { api, onUnauthorized } from './lib/api.js';
import { html, setHtml } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { toast, toastError, loading, errorBlock } from './lib/ui.js';
import { formatMoney } from '/shared/format.js';

const root = document.getElementById('app');

const app = {
  me: null,
  get business() {
    return this.me.business;
  },
  /** A team login (Settings → Team login) sees only Tracking, to look at. */
  get isTeam() {
    return this.me?.user.role === 'team';
  },
  get home() {
    return this.isTeam ? '/tracking' : '/dashboard';
  },
  money(minor) {
    return formatMoney(minor, this.me.business.currency);
  },
  setMe(me) {
    this.me = me;
    if (me) renderChrome();
  },
  async refreshMe() {
    this.setMe(await api('/auth/me'));
  },
  setTitle(title) {
    const biz = this.me?.business?.name;
    document.title = [title, biz || 'eBilling'].filter(Boolean).join(' · ');
  },
};

route('/dashboard', () => import('./views/dashboard.js'));
route('/bills', () => import('./views/bills.js'));
route('/bills/new', () => import('./views/bill-editor.js'));
route('/bills/:id/edit', () => import('./views/bill-editor.js'));
route('/bills/:id', () => import('./views/bill-view.js'));
route('/tracking', () => import(app.isTeam ? './views/team-jobs.js' : './views/tracking.js'));
route('/bookings', () => import('./views/bookings.js'));
route('/bookings/new', () => import('./views/booking-editor.js'));
route('/bookings/:id/edit', () => import('./views/booking-editor.js'));
route('/bookings/:id', () => import('./views/booking-view.js'));
route('/day-book', () => import('./views/daybook.js'));
route('/expenses', () => import('./views/daybook.js'));
route('/products', () => import('./views/products.js'));
route('/products/:id', () => import('./views/product-detail.js'));
route('/stock', () => import('./views/stock.js'));
route('/customers', () => import('./views/customers.js'));
route('/customers/:id', () => import('./views/customer-detail.js'));
route('/reports', () => import('./views/reports.js'));
route('/settings', () => import('./views/settings.js'));

// key, link, label, icon, and the part of the app it is (its colour).
const NAV = [
  ['dashboard', '/dashboard', 'Dashboard', 'dashboard', 'dashboard'],
  ['bills', '/bills', 'Bills', 'bill', 'bills'],
  ['tracking', '/tracking', 'Tracking', 'kanban', 'tracking'],
  ['bookings', '/bookings', 'Bookings & Shoots', 'camera', 'bookings'],
  ['daybook', '/day-book', 'Day book', 'wallet', 'daybook'],
  ['products', '/products', 'Inventory', 'package', 'stock'],
  ['customers', '/customers', 'Customers', 'users', 'customers'],
  ['reports', '/reports', 'Reports', 'chart', 'reports'],
  ['settings', '/settings', 'Settings', 'settings', 'settings'],
];

function navKey(pathname) {
  if (pathname.startsWith('/bills/new')) return 'new';
  if (pathname.startsWith('/bills')) return 'bills';
  if (pathname.startsWith('/tracking')) return 'tracking';
  if (pathname.startsWith('/bookings')) return 'bookings';
  if (pathname.startsWith('/day-book') || pathname.startsWith('/expenses')) return 'daybook';
  if (pathname.startsWith('/products') || pathname.startsWith('/stock')) return 'products';
  if (pathname.startsWith('/customers')) return 'customers';
  if (pathname.startsWith('/reports')) return 'reports';
  if (pathname.startsWith('/settings')) return 'settings';
  return 'dashboard';
}

let shellReady = false;

function ensureShell() {
  if (shellReady) return;
  const team = app.isTeam;
  setHtml(root, html`
    <div class="shell ${team ? 'is-team' : ''}">
      <aside class="sidebar" aria-label="Main navigation">
        <div class="brand">
          <div class="brand-mark" data-brand-mark></div>
          <div style="min-width:0"><div class="brand-name" data-brand-name></div>
            <div class="brand-sub">${team ? 'Team view' : html`Billing &amp; inventory`}</div></div>
        </div>
        ${team ? '' : html`<a class="btn btn-primary btn-new" href="/bills/new">${icon('plus')}New bill</a>`}
        <nav class="nav">
          ${NAV.filter(([key]) => !team || key === 'tracking').map(([key, href, label, ic, area]) => html`<a href="${href}" data-nav="${key}" class="area-${area}">${icon(ic)}${label}</a>`)}
        </nav>
        <div class="sidebar-foot">
          <div class="user-name" data-user-name></div>
          <div class="user-email" data-user-email></div>
          <button type="button" class="btn btn-sm" data-logout>${icon('logout')}Sign out</button>
        </div>
      </aside>
      <div class="sidebar-backdrop" data-close-nav></div>
      <div class="main-col">
        <header class="topbar">
          <button type="button" class="btn btn-ghost btn-icon" data-open-nav aria-label="Open menu">${icon('menu')}</button>
          <div class="tb-title" data-brand-name></div>
          ${team ? html`<button type="button" class="btn btn-ghost btn-sm" data-logout>${icon('logout')}Sign out</button>` : html`
          <a class="btn btn-ghost btn-icon" href="/customers" aria-label="Customers" title="Customers">${icon('users')}</a>
          <a class="btn btn-ghost btn-icon" href="/settings" aria-label="Settings" title="Settings">${icon('settings')}</a>`}
        </header>
        <main id="view" class="view"></main>
      </div>
      ${team ? '' : html`<nav class="bottom-nav" aria-label="Quick navigation">
        <a href="/dashboard" data-nav="dashboard" class="area-dashboard">${icon('dashboard')}Home</a>
        <a href="/bills" data-nav="bills" class="area-bills">${icon('bill')}Bills</a>
        <a href="/bills/new" data-nav="new" class="bn-new"><span class="bn-plus">${icon('plus')}</span>New bill</a>
        <a href="/tracking" data-nav="tracking" class="area-tracking">${icon('kanban')}Tracking</a>
        <a href="/products" data-nav="products" class="area-stock">${icon('package')}Inventory</a>
      </nav>`}
    </div>`);
  shellReady = true;
  const shell = root.querySelector('.shell');
  root.querySelector('[data-open-nav]').addEventListener('click', () => shell.classList.add('nav-open'));
  root.querySelector('[data-close-nav]').addEventListener('click', () => shell.classList.remove('nav-open'));
  root.querySelector('.sidebar').addEventListener('click', (e) => {
    if (e.target.closest('a')) shell.classList.remove('nav-open');
  });
  root.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', logout));
  renderChrome();
}

function renderChrome() {
  if (!shellReady || !app.me) return;
  const { business, user } = app.me;
  root.querySelectorAll('[data-brand-name]').forEach((el) => {
    el.textContent = business.name;
  });
  const mark = root.querySelector('[data-brand-mark]');
  mark.classList.toggle('has-logo', !!business.logo_url);
  if (business.logo_url) setHtml(mark, html`<img src="${business.logo_url}" alt="">`);
  else mark.textContent = business.name.trim().charAt(0).toUpperCase() || 'B';
  root.querySelector('[data-user-name]').textContent = user.name;
  root.querySelector('[data-user-email]').textContent = user.email;
}

async function logout() {
  try {
    await api('/auth/logout', { method: 'POST', body: {} });
  } catch {
    // Signing out locally is still correct even if the request failed.
  }
  app.me = null;
  shellReady = false;
  navigate('/login', { force: true });
  toast('You have been signed out.', 'info');
}

function onAuthed(me, next) {
  app.me = me;
  shellReady = false;
  navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : app.home, { replace: true, force: true });
}

onUnauthorized(() => {
  if (!app.me) return;
  app.me = null;
  shellReady = false;
  toast('Your session has ended. Please sign in again.', 'info');
  navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true, force: true });
});

let token = 0;
let cleanup = null;

async function handleRoute(match, query, pathname) {
  const myToken = ++token;
  if (typeof cleanup === 'function') {
    try {
      cleanup();
    } catch (err) {
      console.error(err);
    }
  }
  cleanup = null;

  if (!app.me) {
    if (pathname !== '/login' && pathname !== '/register') {
      const next = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + location.search)}`;
      navigate(`/login${next}`, { replace: true, force: true });
      return;
    }
    shellReady = false;
    const mod = await import('./views/auth.js');
    if (myToken !== token) return;
    cleanup = await mod.default(root, { mode: pathname === '/register' ? 'register' : 'login', query, onAuthed });
    return;
  }

  if (pathname === '/' || pathname === '/login' || pathname === '/register' || (app.isTeam && pathname !== '/tracking')) {
    navigate(app.home, { replace: true, force: true });
    return;
  }

  ensureShell();
  const key = navKey(pathname);
  root.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
  root.querySelector('.shell')?.classList.remove('nav-open');

  const container = document.createElement('div');
  root.querySelector('#view').replaceChildren(container);
  window.scrollTo(0, 0);

  if (!match) {
    app.setTitle('Not found');
    setHtml(container, html`<div class="card"><div class="empty">${icon('info')}<h3>Page not found</h3>
      <p>The page you're looking for doesn't exist.</p><a class="btn" href="${app.home}">Go to dashboard</a></div></div>`);
    return;
  }

  setHtml(container, loading());
  try {
    const mod = await match.route.load();
    if (myToken !== token) return;
    const result = await mod.default(container, { params: match.params, query, app });
    if (myToken !== token) {
      if (typeof result === 'function') result();
      return;
    }
    cleanup = result;
  } catch (err) {
    if (myToken !== token || err.status === 401) return;
    console.error(err);
    setHtml(container, errorBlock(err));
    container.querySelector('[data-action=reload]')?.addEventListener('click', () => reload());
  }
}

async function boot() {
  try {
    app.me = await api('/auth/me');
  } catch (err) {
    if (err.status !== 401) {
      setHtml(root, html`<div class="view"><div class="card"><div class="empty">${icon('alert')}<h3>Can't reach the server</h3>
        <p>${err.message}</p><button class="btn">Retry</button></div></div></div>`);
      root.querySelector('button').addEventListener('click', () => location.reload());
      return;
    }
    app.me = null;
  }
  startRouter(handleRoute);
}

window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.status === 401) return;
  if (e.reason?.message) toastError(e.reason);
});

boot();
