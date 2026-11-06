// fetch wrapper: JSON in/out, CSRF header, consistent errors.

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || (status === 0 ? 'Network error — check your connection and try again.' : 'Something went wrong. Please try again.'));
    this.status = status;
    this.code = body?.error?.code;
    this.field = body?.error?.field;
    this.details = body?.error?.details;
  }
}

let unauthorizedHandler = null;
export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
}

export function buildQuery(params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, v);
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export async function api(path, { method = 'GET', body, query } = {}) {
  const headers = { 'X-Requested-With': 'fetch', Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`/api${path}${buildQuery(query)}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, null);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (res.status === 401 && !path.startsWith('/auth/') && unauthorizedHandler) unauthorizedHandler(err);
    throw err;
  }
  return data;
}

export const get = (path, query) => api(path, { query });
export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const put = (path, body = {}) => api(path, { method: 'PUT', body });
export const del = (path) => api(path, { method: 'DELETE' });
