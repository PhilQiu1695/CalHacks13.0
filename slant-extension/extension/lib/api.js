// Backend client. The connection (ingress link + this browser's key) lives in chrome.storage.local only, never sync.
export const HOST = 'https://server-prod.mana.space';
const LINK_RE = /^https:\/\/server-prod\.mana\.space\/api\/sandbox\/ingress\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/slant-ext\/?$/;

export class ApiErr extends Error {
  constructor(code, message, retryable = false, status = 0) { super(message); this.code = code; this.retryable = retryable; this.status = status; }
}

function decodeJwt(t) {
  try {
    const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(p + '='.repeat((4 - (p.length % 4)) % 4)));
  } catch (e) { return null; }
}

// Accepts a pairing link (<ingress url>#pair=XXXX-XXXX), a reconnect link (<ingress url>) or a bare code.
export function parseLink(input) {
  const s = String(input || '').trim();
  const bare = s.match(/^([0-9A-Za-z]{4})[- ]?([0-9A-Za-z]{4})$/);
  if (bare) return { code: (bare[1] + '-' + bare[2]).toUpperCase() };
  let u;
  try { u = new URL(s); } catch (e) { return { error: 'That doesn’t look like a Slant link. Copy it from the Slant for Chrome page in Mana.' }; }
  const frag = new URLSearchParams(u.hash.replace(/^#/, ''));
  const code = frag.get('pair') || u.searchParams.get('pair') || null;
  const base = (u.origin + u.pathname).replace(/\/$/, '');
  const m = base.match(LINK_RE);
  if (!m) return { error: 'Use the link from the Slant for Chrome page in Mana. It starts with https://server-prod.mana.space/api/sandbox/ingress/' };
  const claims = decodeJwt(m[1]);
  if (!claims || claims.service !== 'slant-ext') return { error: 'This link isn’t for Slant for Chrome.' };
  return { base, code, exp: claims.exp ? claims.exp * 1000 : null };
}

export async function getConn() { return (await chrome.storage.local.get('conn')).conn || null; }
export async function setConn(conn) { if (conn) await chrome.storage.local.set({ conn }); else await chrome.storage.local.remove('conn'); }
export const linkExpired = (conn) => !!(conn && conn.linkExp && Date.now() > conn.linkExp);

async function request(base, method, path, { key, body, timeoutMs = 25000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let r;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['X-Slant-Key'] = key;
    r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'omit', signal: ctl.signal });
  } catch (e) {
    throw new ApiErr('network', 'Couldn’t reach Slant. Check your internet connection, then try again.', true);
  } finally { clearTimeout(timer); }
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  if (r.ok) return data || {};
  if (data && typeof data.detail === 'string') {               // Mana ingress gateway, before reaching the backend
    if (/expired/i.test(data.detail)) throw new ApiErr('link_expired', 'This browser’s connection link expired.', false, r.status);
    if (r.status === 401 || r.status === 403) throw new ApiErr('link_invalid', 'This connection link isn’t valid any more.', false, r.status);
    throw new ApiErr('backend_down', 'Slant’s backend isn’t responding right now (' + r.status + '). Try again in a minute.', true, r.status);
  }
  if (data && data.error) {
    const c = data.error.code;
    if (r.status === 401) throw new ApiErr('unauthorized', data.error.message, false, 401);
    throw new ApiErr(c, data.error.message, r.status >= 500 || c === 'rate_limited' || c === 'busy', r.status);
  }
  if (r.status >= 500) throw new ApiErr('backend_down', 'Slant’s backend isn’t responding right now (' + r.status + '). Try again in a minute.', true, r.status);
  throw new ApiErr('http_' + r.status, 'Slant returned an unexpected error (' + r.status + ').', false, r.status);
}

async function authed(method, path, body, timeoutMs) {
  const conn = await getConn();
  if (!conn || !conn.key) throw new ApiErr('not_paired', 'Connect this browser to Slant first.');
  if (linkExpired(conn)) throw new ApiErr('link_expired', 'This browser’s connection link expired.');
  return request(conn.base, method, path, { key: conn.key, body, timeoutMs });
}

export async function pair(base, code, label) { return request(base, 'POST', '/v1/pair', { body: { code, label }, timeoutMs: 30000 }); }
export async function session(base, key) { return request(base, 'GET', '/v1/session', { key }); }
export async function submitJob(url, idempotencyKey, mode, extra) { return authed('POST', '/v1/jobs', { url, idempotencyKey, mode, ...(extra || {}) }, 30000); }
export async function getJob(id) { return authed('GET', '/v1/jobs/' + encodeURIComponent(id), null, 20000); }
