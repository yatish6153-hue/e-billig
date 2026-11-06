/** Base URL used in share links. PUBLIC_URL wins so links work behind proxies/tunnels. */
export function publicBaseUrl(req) {
  const configured = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

export function shareUrl(req, token) {
  return `${publicBaseUrl(req)}/i/${token}`;
}
