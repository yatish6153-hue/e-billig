// History-API router with an optional "unsaved changes" guard.
const routes = [];
let handler = null;
let leaveGuard = null;
let currentUrl = location.pathname + location.search;

export function route(pattern, load) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  })}/?$`);
  routes.push({ re, keys, load, pattern });
}

/** fn() returns true when it is OK to leave the current view. */
export function setLeaveGuard(fn) {
  leaveGuard = fn;
}

/** Take fn off as the guard if it still is one, so a view that has been left can't remove the next view's guard. */
export function clearLeaveGuard(fn) {
  if (leaveGuard === fn) leaveGuard = null;
}

function canLeave() {
  if (!leaveGuard) return true;
  if (leaveGuard()) {
    leaveGuard = null;
    return true;
  }
  return false;
}

export function navigate(to, { replace = false, force = false } = {}) {
  if (!force && !canLeave()) return false;
  leaveGuard = null;
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  dispatch();
  return true;
}

export function reload() {
  dispatch();
}

function match(pathname) {
  for (const r of routes) {
    const m = r.re.exec(pathname);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { route: r, params };
    }
  }
  return null;
}

function dispatch() {
  currentUrl = location.pathname + location.search;
  const query = Object.fromEntries(new URLSearchParams(location.search));
  handler(match(location.pathname), query, location.pathname);
}

export function startRouter(onRoute) {
  handler = onRoute;
  window.addEventListener('popstate', () => {
    if (!canLeave()) {
      history.pushState(null, '', currentUrl);
      return;
    }
    dispatch();
  });
  window.addEventListener('beforeunload', (e) => {
    if (leaveGuard && !leaveGuard({ silent: true })) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download') || a.dataset.external !== undefined) return;
    const href = a.getAttribute('href');
    if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/api/') || href.startsWith('/i/')) return;
    e.preventDefault();
    if (href === location.pathname + location.search) return;
    navigate(href);
  });
  dispatch();
}
