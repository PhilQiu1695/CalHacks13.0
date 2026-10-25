// Strict YouTube video URL parsing. Mirrors backend/slant_ext/ytid.py (shared cases: tests/fixtures/ytid_cases.json).
// https only; exact hostnames; 11-character IDs. watch / shorts / live on youtube.com, www, m; youtu.be short links.
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const SHORTLINK_HOSTS = new Set(['youtu.be']);

export function parseYouTube(url) {
  if (typeof url !== 'string' || !url || url.length > 2048) return null;
  let u;
  try { u = new URL(url.trim()); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const segs = u.pathname.split('/').filter(Boolean);
  let vid = null, kind = null;
  if (SHORTLINK_HOSTS.has(host)) {
    if (segs.length === 1) { vid = segs[0]; kind = 'shortlink'; }
  } else if (WATCH_HOSTS.has(host)) {
    if (segs.length === 1 && segs[0] === 'watch') {
      const v = u.searchParams.get('v');
      if (v !== null) { vid = v; kind = 'watch'; }
    } else if (segs.length === 2 && (segs[0] === 'shorts' || segs[0] === 'live')) {
      vid = segs[1]; kind = segs[0];
    }
  }
  if (!vid || !ID_RE.test(vid)) return null;
  const isShort = kind === 'shorts';
  return { videoId: vid, kind, isShort, canonicalUrl: (isShort ? 'https://www.youtube.com/shorts/' : 'https://www.youtube.com/watch?v=') + vid };
}

export function watchAt(videoId, seconds) {
  return 'https://www.youtube.com/watch?v=' + videoId + '&t=' + Math.max(0, Math.floor(Number(seconds) || 0)) + 's';
}
