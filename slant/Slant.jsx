
const MODEL = 'gpt-6-astra';
const GEM_MODEL = 'gemini-3.8-flash';
const SERIF = "Georgia, 'Times New Roman', serif";
const MAX_CHARS = 360000;
const DIMS = [
  { key: 'one_sided', name: 'One-sidedness', hint: 'Leaves out or strawmans other perspectives' },
  { key: 'loaded_language', name: 'Loaded language', hint: 'Charged, pejorative or flattering wording' },
  { key: 'sensationalism', name: 'Sensationalism', hint: 'Exaggeration, alarm, outrage framing' },
  { key: 'unsupported_claims', name: 'Unsupported claims', hint: 'Assertions made without evidence or sourcing' },
  { key: 'ad_hominem', name: 'Personal attacks', hint: 'Targets people rather than their arguments' },
];
const SRC_LABEL = { captions: 'Creator captions', 'auto-captions': 'YouTube auto-captions', 'ai-transcription': 'AI transcription (no captions)' };
// Political lean uses the AllSides Media Bias Meter scale, −6 to +6, and its five bands
// (Left −6 to −3, Lean Left −2.99 to −1, Center −0.99 to +0.99, Lean Right +1 to +2.99, Right +3 to +6),
// applied to the score as displayed (one decimal). `units` is each band's width, for proportional layouts.
const LEAN_MAX = 6;
const LEAN_BANDS = [
  { label: 'Left', range: '−6 to −3', units: 3 },
  { label: 'Lean Left', range: '−2.9 to −1', units: 2 },
  { label: 'Center', range: '−0.9 to +0.9', units: 2 },
  { label: 'Lean Right', range: '+1 to +2.9', units: 2 },
  { label: 'Right', range: '+3 to +6', units: 3 },
];
const LEAN_COLS = LEAN_BANDS.map((b) => b.units + 'fr').join(' ');
const LEAN_TICKS = [-6, -3, -1, 0, 1, 3, 6];   // band boundaries and ends, labelled under the lean bar
const LEAN_SCALE_NOTE = 'AllSides scale, −6 to +6';
const FLAG_PARTS = [{ key: 'political', name: 'Political lean' }].concat(DIMS.map((d) => ({ key: d.key, name: d.name })), [{ key: 'other', name: 'Other' }]);
const FLAG_NOTE_MAX = 280;
// Every signed-in visitor (anonymous ones included) may write only flags/<their uid> on an analysis.
const FLAG_PERMS = { per_user_read: true, per_user_write: true };
const SLANT_EXPLAINER = 'How far the presentation departs from fair, balanced treatment, in any direction.';
const VIEW_ONLY_WHY = 'Only people with edit access can start new analyses, because each one is saved to this app and runs on the owner’s Mana credits.';
const shortH = (wide) => (wide ? 'min(46vh, 520px)' : 'min(58vh, 480px)');
const isPage = (s) => s === 'how' || s === 'feed';
const isShort = (url) => /\/shorts\//i.test(String(url || ''));
const isDenied = (e) => /permission/i.test(String((e && (e.code || e.message)) || e || ''));
function leanScore(pol) { return Math.round(clamp(pol && pol.score, -LEAN_MAX, LEAN_MAX) * 10) / 10; }
function leanBand(s) { return s <= -3 ? 0 : s <= -1 ? 1 : s < 1 ? 2 : s < 3 ? 3 : 4; }
function fmtLean(s) { return s === 0 ? '0' : (s > 0 ? '+' : '−') + Math.abs(s); }
function leanColor(band, P) { return band < 0 ? P.faint : band <= 1 ? P.left : band >= 3 ? P.right : P.ink; }

const SYSTEM = [
  'You are Slant, a careful, even-handed media-bias analyst. You read a YouTube transcript and assess how the content is slanted: the framing, selection and wording chosen by the creator, host or narrator. You judge presentation, not whether the conclusions are true, and you hold every side to the same standard.',
  '',
  'Rules:',
  '- Use only the transcript. Captions may contain transcription errors; do not penalize them.',
  '- Separate the creator\'s own voice from views they quote or report in order to rebut or explain them. Quoting a view is not endorsing it. Interviews and debates are judged on how the host frames and balances them.',
  '- Political lean uses the AllSides Media Bias Meter scale, from -6 to +6 (one decimal allowed): -6 strongly left/progressive, 0 centrist or balanced, +6 strongly right/conservative. Bands: -6 to -3 Left (strong alignment with left-wing thought or agendas), -2.99 to -1 Lean Left (moderate alignment), -0.99 to +0.99 Center (no clear or consistent tilt, or balanced), +1 to +2.99 Lean Right (moderate alignment), +3 to +6 Right (strong alignment). Reserve the far ends (beyond +/-5) for pervasive, explicit advocacy. Use the conventional US left-right axis unless the content concerns another country\'s politics; then map to that country\'s axis and name it in the label. If the video has no meaningful political or social-issue content, set applicable=false, score=0, label "Not political", confidence "high", and return no quotes.',
  '- Return all five other dimensions, scored 0-10 where 0 means absent, in this order: one_sided, loaded_language, sensationalism, unsupported_claims, ad_hominem. Calibrate: neutral explainers and straight news usually sit at 0-3; reserve 8-10 for pervasive, extreme cases.',
  '- overall (0-10) is how far the presentation as a whole departs from fair, balanced, evidence-based treatment of its subject, in any direction.',
  '- Evidence: every quote must be copied verbatim from the transcript, contiguous words exactly as written (it may start and end mid-sentence), 6 to 35 words, with seg set to the segment number where the quote begins. Never paraphrase inside a quote, and do not include the [segment timestamp] prefix. Give 2-4 quotes for political lean when applicable and 1-3 quotes for each dimension scoring 3 or more; dimensions scoring 0-2 may have none. In why, say in one sentence what the quote shows.',
  '- Explanations are 2-4 plain sentences naming the specific moves the creator makes. No boilerplate hedging.',
  '- headline is a short verdict of at most 10 words. summary is 2-3 sentences. balance lists concrete things the video does fairly (may be empty). caveats lists real limits of this assessment, such as auto-captions, a partial transcript, satire, or one segment of a longer show.',
].join('\n');

const QUOTES = { type: 'array', items: { type: 'object', additionalProperties: false, required: ['seg', 'quote', 'why'],
  properties: { seg: { type: 'integer' }, quote: { type: 'string' }, why: { type: 'string' } } } };
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['headline', 'summary', 'topic', 'contentType', 'overall', 'political', 'dimensions', 'balance', 'caveats'],
  properties: {
    headline: { type: 'string' }, summary: { type: 'string' }, topic: { type: 'string' }, contentType: { type: 'string' },
    overall: { type: 'number' },
    political: { type: 'object', additionalProperties: false, required: ['applicable', 'score', 'label', 'confidence', 'explanation', 'quotes'],
      properties: { applicable: { type: 'boolean' }, score: { type: 'number' }, label: { type: 'string' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] }, explanation: { type: 'string' }, quotes: QUOTES } },
    dimensions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'score', 'explanation', 'quotes'],
      properties: { key: { type: 'string', enum: DIMS.map((d) => d.key) }, score: { type: 'number' }, explanation: { type: 'string' }, quotes: QUOTES } } },
    balance: { type: 'array', items: { type: 'string' } },
    caveats: { type: 'array', items: { type: 'string' } },
  },
};

function parseVideoId(raw) {
  const s = (raw || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch (e) { return null; }
  const host = u.hostname.toLowerCase();
  const ok = (c) => (c && /^[A-Za-z0-9_-]{11}$/.test(c) ? c : null);
  if (host.endsWith('youtu.be')) return ok(u.pathname.split('/').filter(Boolean)[0]);
  if (host.includes('youtube')) {
    const v = ok(u.searchParams.get('v'));
    if (v) return v;
    const p = u.pathname.split('/').filter(Boolean);
    if (p.length >= 2 && ['shorts', 'embed', 'live', 'v'].includes(p[0])) return ok(p[1]);
  }
  return null;
}
function fmtT(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = String(sec % 60).padStart(2, '0');
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, Number(v) || 0));
const clean = (o) => JSON.parse(JSON.stringify(o));
const asArr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : v && typeof v === 'object' ? Object.keys(v).sort((a, b) => a - b).map((k) => v[k]) : []);
// Mana lets people other than the owner write at most 10 levels below file-system. Dimension quotes sit
// 11 deep (apps/slant/app/analyses/<id>/result/dimensions/<i>/quotes/<j>/quote), so an editor's save
// stores each dimension's quotes as a JSON string (quotesJson). unpackResult restores the usual shape
// when analyses load, so every reader sees result.dimensions[i].quotes as before.
function packResult(res) {
  const r = clean(res || {});
  asArr(r.dimensions).forEach((d) => {
    if (d && d.quotes != null) { d.quotesJson = JSON.stringify(asArr(d.quotes)); delete d.quotes; }
  });
  return r;
}
function unpackResult(res) {
  if (!res || !res.dimensions) return res;
  let changed = false;
  const dims = asArr(res.dimensions).map((d) => {
    if (!d || d.quotes != null || typeof d.quotesJson !== 'string') return d;
    changed = true;
    let q = [];
    try { q = JSON.parse(d.quotesJson); } catch (e) { q = []; }
    const out = { ...d, quotes: Array.isArray(q) ? q : [] };
    delete out.quotesJson;
    return out;
  });
  return changed ? { ...res, dimensions: dims } : res;
}
const unpackAll = (all) => {
  const out = {};
  Object.keys(all || {}).forEach((k) => { const it = all[k]; out[k] = it && it.result ? { ...it, result: unpackResult(it.result) } : it; });
  return out;
};
function norm(s) {
  return String(s || '').toLowerCase().replace(/[’‘`]/g, "'").replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}']+/gu, ' ').replace(/\s+/g, ' ').trim();
}
function buildIndex(snips) {
  let text = ''; const starts = [];
  snips.forEach((s) => { starts.push(text.length); text += norm(s.text) + ' '; });
  return { text, starts };
}
function segAt(idx, off) {
  let lo = 0, hi = idx.starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (idx.starts[mid] <= off) lo = mid; else hi = mid - 1; }
  return lo;
}
function findNear(idx, needle, seg) {
  let best = -1, bestD = Infinity, from = 0;
  for (let n = 0; n < 200; n++) {
    const k = idx.text.indexOf(needle, from);
    if (k < 0) break;
    const sg = segAt(idx, k), d = Math.abs(sg - seg);
    if (d < bestD) { bestD = d; best = sg; }
    from = k + 1;
  }
  return best;
}
function locate(idx, snips, q) {
  const seg = Math.min(Math.max(0, parseInt(q && q.seg, 10) || 0), Math.max(0, snips.length - 1));
  const n = norm(q && q.quote);
  if (!idx || !n) return { seg, status: 'missing' };
  let s = findNear(idx, n, seg);
  if (s >= 0) return { seg: s, status: 'exact' };
  const w = n.split(' ');
  if (w.length >= 4) {
    const k = Math.min(6, w.length);
    s = findNear(idx, w.slice(0, k).join(' '), seg);
    if (s >= 0) return { seg: s, status: 'partial' };
    s = findNear(idx, w.slice(-k).join(' '), seg);
    if (s >= 0) return { seg: Math.max(0, s - 1), status: 'partial' };
  }
  return { seg, status: 'missing' };
}
function biasWord(v) {
  v = Number(v) || 0;
  return v < 2.5 ? 'Minimal' : v < 4.5 ? 'Mild' : v < 6.5 ? 'Moderate' : v < 8.5 ? 'Strong' : 'Extreme';
}
function leanText(pol) {
  if (!pol || !pol.applicable) return 'Not political';
  const s = leanScore(pol);
  return LEAN_BANDS[leanBand(s)].label + ' · ' + fmtLean(s);
}

// ---- Feed history ------------------------------------------------------------------------------------------------
// Every video a person chooses to analyze (pasting a link here, or with Slant for Chrome) is kept privately at
// <owner>/file-system/slant-feeds/<uid>/videos/<videoId> with a snapshot of its scores (feedSnap), so the feed report
// survives later deletions. slant-feeds carries per_user_read/write: each person reads and writes only their own child.
// The slant-ext backend writes the same shape (backend/slant_ext/feed.py).
const FEED_KEEP = [{ days: 91, label: '3 months' }, { days: 182, label: '6 months' }, { days: 365, label: '1 year' }];
const FEED_WINDOWS = [{ days: 30, label: 'Last 30 days' }, { days: 91, label: '3 months' }, { days: 182, label: '6 months' }, { days: 365, label: '1 year' }];
const DAY_MS = 86400000;
function feedSnap(res) {
  const r = res || {}; const pol = r.political || {}; const dims = {};
  asArr(r.dimensions).forEach((d) => { if (d && d.key) dims[d.key] = Math.round(clamp(d.score, 0, 10) * 10) / 10; });
  const out = { political: !!pol.applicable, overall: Math.round(clamp(r.overall, 0, 10) * 10) / 10, dims,
    contentType: String(r.contentType || '').slice(0, 120), topic: String(r.topic || '').slice(0, 240), headline: String(r.headline || '').slice(0, 160) };
  if (pol.applicable) out.lean = leanScore(pol);
  return out;
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;

// ---- Bias bear -------------------------------------------------------------------------------------------------
// Drawing code copied verbatim from Slant for Chrome 1.3.2 (extension/content.js: compose, bearLeanLabel, bearScoreWord),
// so the feed's bear changes exactly as the extension's does: v = { L lean −6..6, S sensationalism, K loaded language,
// P personal attacks, U unsupported claims, O one-sidedness (0..10) }. Body color follows L, the eyebrows the highest of
// S, K and P, the eyes U, and the ear on the lean side grows with O. Keep it in step with the extension.
const SLANT_BEAR = (() => {
  const W = 48, H = 62, D = 4;
  const BLUE = [[58,112,246],[36,82,208]], PURP = [[183, 156, 237], [155, 123, 219]], RED = [[238,74,74],[196,44,44]];
  const mixc = (a, b, t) => 'rgb(' + [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)).join(',') + ')';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, Number(v) || 0));
  const mk = () => Array.from({ length: H }, () => new Uint8Array(W));
  const put = (m, x, y, c) => { if (x >= 0 && x < W && y >= 0 && y < H) m[y][x] = c; };
  function ell(m, cx, cy, rx, ry, c, sh) {
    for (let y = Math.floor(cy - ry) - 1; y <= Math.ceil(cy + ry) + 1; y++)
      for (let x = Math.floor(cx - rx) - 1; x <= Math.ceil(cx + rx) + 1; x++) {
        const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) put(m, x, y, (sh && dx * 0.6 + dy * 0.8 > 0.55) ? sh : c);
      }
  }
  function ln(m, x1, y1, x2, y2, r, c) {
    const n = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 4) + 1;
    for (let i = 0; i <= n; i++) { const t = i / n; ell(m, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, r, r, c); }
  }
  // v: { L: -6..6 lean, S: sensationalism, K: loaded language, P: personal attacks, U: unsupported claims, O: one-sidedness (all 0..10) }
  // opt: { sleepy: bool, oy: bob offset }
  function compose(v, opt) {
    opt = opt || {};
    const a = clamp(v.L, -6, 6) / 6, t = Math.max(v.S, v.K, v.P) / 10, r = clamp(v.U, 0, 10) / 10, o = clamp(v.O, 0, 10) / 10;
    const m = mk(), tg = a < 0 ? BLUE : RED, k = Math.abs(a);
    const PAL = ['', '#3F2670', mixc(PURP[0], tg[0], k), mixc(PURP[1], tg[1], k), '#EADCFB', '#FFFFFF',
      mixc([43, 27, 77], [154, 143, 184], Math.min(1, r * 1.2)), '#F3A9D0', '#F7EEFF'];
    const oy = opt.oy || 0, Y = (q) => q + D + oy;
    const sd = clamp(v.L / 3, -1, 1), rg = Math.max(0, sd) * o, lg = Math.max(0, -sd) * o;   // the ear on the lean side grows
    const re = 4.6 * (1 + 0.8 * rg - 0.45 * lg), le = 4.6 * (1 + 0.8 * lg - 0.45 * rg);
    const rcx = 36 + 2.5 * rg, rcy = Y(9) - 1.2 * rg, lcx = 12 - 2.5 * lg, lcy = Y(9) - 1.2 * lg;
    ell(m, lcx, lcy, le, le, 2, 3); ell(m, rcx, rcy, re, re, 2, 3);
    ell(m, lcx, lcy + 0.6, le * 0.5, le * 0.5, 4); ell(m, rcx, rcy + 0.6, re * 0.5, re * 0.5, 4);
    ell(m, 24, Y(40), 9.5, 10, 2, 3); ell(m, 24, Y(41), 5.8, 6.8, 8); put(m, 21, Y(37), 5);
    const gy = D + 54 + oy;
    ell(m, 19.5, gy + 2 - 2.6, 5.2, 3.6, 1); ell(m, 28.5, gy + 2 - 2.6, 5.2, 3.6, 1);
    ell(m, 19.5, gy - 0.6, 4.2, 2.6, 2, 3); ell(m, 28.5, gy - 0.6, 4.2, 2.6, 2, 3);
    ln(m, 15, Y(35), 13, Y(43), 3, 1); ln(m, 33, Y(35), 35, Y(43), 3, 1);
    ell(m, 13, Y(44), 3.6, 3.6, 1); ell(m, 35, Y(44), 3.6, 3.6, 1);
    ln(m, 15, Y(35), 13, Y(43), 2, 2); ln(m, 33, Y(35), 35, Y(43), 2, 2);
    ell(m, 13, Y(44), 2.6, 2.6, 2, 3); ell(m, 35, Y(44), 2.6, 2.6, 2, 3);
    ell(m, 24, Y(20), 16.5, 14, 1); ell(m, 24, Y(20), 15.5, 13, 2, 3); ell(m, 24, Y(26), 5.2, 3.4, 4);
    put(m, 23, Y(24), 1); put(m, 24, Y(24), 1); put(m, 23, Y(27), 1); put(m, 24, Y(27), 1);
    put(m, 15, Y(25), 7); put(m, 16, Y(25), 7); put(m, 32, Y(25), 7); put(m, 33, Y(25), 7);
    const dh = Math.round(t * 4), up = Math.round(t * 2), thick = t >= 0.6;
    for (let x = 16; x <= 22; x++) { const yl = Y(15) - up + Math.round(dh * (x - 16) / 6); put(m, x, yl, 1); if (thick) put(m, x, yl + 1, 1); }
    for (let x = 26; x <= 32; x++) { const yr = Y(15) - up + Math.round(dh * (32 - x) / 6); put(m, x, yr, 1); if (thick) put(m, x, yr + 1, 1); }
    const ey = Y(20.5), spread = r > 0.6 ? 1 : 0, rr = opt.sleepy ? 1 : r;
    [19, 29].forEach((ex, idx) => {
      ell(m, ex, ey, 3.2, 3.2, 5);
      const pxs = ex + (idx === 0 ? -spread : spread);
      ell(m, pxs, ey, 2, 2, 6);
      if (rr < 0.35) { put(m, Math.floor(pxs - 1), Math.floor(ey - 1), 5); put(m, Math.floor(pxs + 0.5), Math.floor(ey + 0.5), 5); }
      else if (rr < 0.7) put(m, Math.floor(pxs - 1), Math.floor(ey - 1), 5);
      if (rr > 0.35) {
        const lid = (rr - 0.35) / 0.65 * 0.55, edge = ey - 3.2 + lid * 6.4;
        for (let y = Math.floor(ey - 4); y <= Math.ceil(ey + 4); y++) for (let x = Math.floor(ex - 4); x <= Math.ceil(ex + 4); x++) {
          const dx = x + 0.5 - ex, dy = y + 0.5 - ey;
          if (dx * dx + dy * dy <= 3.2 * 3.2) { if (y + 0.5 < edge) put(m, x, y, 2); else if (y + 0.5 < edge + 1) put(m, x, y, 1); }
        }
      }
    });
    const out = mk();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (m[y][x]) out[y][x] = m[y][x];
      else if ((y > 0 && m[y - 1][x]) || (y < H - 1 && m[y + 1][x]) || (x > 0 && m[y][x - 1]) || (x < W - 1 && m[y][x + 1])) out[y][x] = 1;
    }
    return { grid: out, pal: PAL };
  }
  // Same thresholds as the app (AllSides bands on the score rounded to 0.1; Slant score words).
  function bearLeanLabel(score) {
    const s = Math.round(clamp(score, -6, 6) * 10) / 10;
    return s <= -3 ? 'Left' : s <= -1 ? 'Lean Left' : s < 1 ? 'Center' : s < 3 ? 'Lean Right' : 'Right';
  }
  function bearScoreWord(v) {
    v = Number(v) || 0;
    return v < 2.5 ? 'Minimal' : v < 4.5 ? 'Mild' : v < 6.5 ? 'Moderate' : v < 8.5 ? 'Strong' : 'Extreme';
  }
  return { W, H, compose, bearLeanLabel, bearScoreWord };
})();
const BEAR_PART = { one_sided: 'Ears', loaded_language: 'Eyebrows', sensationalism: 'Eyebrows', unsupported_claims: 'Eyes', ad_hominem: 'Eyebrows' };

function BearCanvas({ v, scale = 4, label }) {
  const ref = React.useRef(null);
  const [bob, setBob] = React.useState(0);
  React.useEffect(() => {   // the extension's idle bob: one pixel every 600 ms, off for reduced motion and hidden tabs
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const t = setInterval(() => { if (!document.hidden) setBob((b) => 1 - b); }, 600);
    return () => clearInterval(t);
  }, []);
  const sig = JSON.stringify(v) + '|' + bob;
  React.useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext('2d'); const { W, H } = SLANT_BEAR;
    const { grid, pal } = SLANT_BEAR.compose(v, { oy: bob });
    ctx.clearRect(0, 0, W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = grid[y][x]; if (c) { ctx.fillStyle = pal[c]; ctx.fillRect(x, y, 1, 1); } }
  }, [sig]);
  return <canvas ref={ref} width={48} height={62} role="img" aria-label={label}
    style={{ display: 'block', width: 48 * scale, height: 62 * scale, imageRendering: 'pixelated', filter: 'drop-shadow(0 6px 10px rgba(30,20,60,.35))' }} />;
}


async function geminiTranscript(url, vid) {
  const body = {
    contents: [{ parts: [
      { fileData: { fileUri: 'https://www.youtube.com/watch?v=' + vid } },
      { text: 'Transcribe every spoken word of this video verbatim, in its original language. Return only a JSON array of objects {"t": start time in seconds (number), "text": what was said}, one entry per sentence or short phrase, roughly every 4 to 12 seconds, in order. Do not summarize or skip.' },
    ] }],
    generationConfig: { responseMimeType: 'application/json', mediaResolution: 'MEDIA_RESOLUTION_LOW', maxOutputTokens: 65536 },
  };
  const r = await fetch(url + '/models/' + GEM_MODEL + ':generateContent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    if (r.status === 402) throw new Error('Out of Mana credits.');
    throw new Error('AI transcription failed (' + r.status + '). The video may be private or too long.');
  }
  const j = await r.json();
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  let text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let arr = [];
  try { arr = JSON.parse(text); } catch (e) {
    const cut = text.lastIndexOf('},');
    try { arr = JSON.parse(text.slice(0, cut + 1) + ']'); } catch (e2) { throw new Error('AI transcription returned unreadable output.'); }
  }
  return (Array.isArray(arr) ? arr : []).filter((x) => x && typeof x.text === 'string' && x.text.trim())
    .map((x, i, a) => ({ t: Number(x.t) || 0, d: Math.max(0, (Number(a[i + 1] && a[i + 1].t) || (Number(x.t) || 0) + 5) - (Number(x.t) || 0)), text: x.text.trim() }));
}

async function runAnalysis(url, meta, snips) {
  let tx = snips.map((s, i) => '[' + i + ' ' + fmtT(s.t) + '] ' + String(s.text).replace(/\s+/g, ' ').trim()).join('\n');
  let truncated = false;
  if (tx.length > MAX_CHARS) { tx = tx.slice(0, MAX_CHARS); truncated = true; }
  const user = 'Video title: ' + (meta.title || '(unknown)') + '\nChannel: ' + (meta.author || '(unknown)') +
    '\nTranscript source: ' + (SRC_LABEL[meta.source] || meta.source) + (truncated ? '\nNote: only the first part of the transcript fits; say so in caveats.' : '') +
    '\n\nTRANSCRIPT. Each line is [segment-number timestamp] text.\n' + tx;
  const r = await fetch(url + '/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { name: 'bias_report', strict: true, schema: SCHEMA } } }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    if (r.status === 402) throw new Error('Out of Mana credits.');
    throw new Error('Analysis failed (' + r.status + '). ' + t.slice(0, 160));
  }
  const j = await r.json();
  const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!c) throw new Error('The model returned an empty report.');
  return { result: JSON.parse(c), truncated };
}

function palette(dark) {
  return dark ? {
    ink: '#F4F4F5', soft: 'rgba(244,244,245,0.66)', faint: 'rgba(244,244,245,0.42)', line: 'rgba(255,255,255,0.11)',
    surface: 'rgba(255,255,255,0.035)', field: 'rgba(255,255,255,0.06)', accent: '#F07A5F', onAccent: '#18181B',
    left: '#7FA6E0', right: '#E58A7E', mid: 'rgba(255,255,255,0.32)', hl: 'rgba(240,122,95,0.24)', hlSoft: 'rgba(255,255,255,0.07)',
  } : {
    ink: '#18181B', soft: 'rgba(24,24,27,0.66)', faint: 'rgba(24,24,27,0.42)', line: 'rgba(24,24,27,0.10)',
    surface: 'rgba(24,24,27,0.025)', field: '#FFFFFF', accent: '#E8654A', onAccent: '#FFFFFF',
    left: '#3E6DB5', right: '#C2473B', mid: 'rgba(24,24,27,0.22)', hl: 'rgba(232,101,74,0.18)', hlSoft: 'rgba(24,24,27,0.055)',
  };
}

function Axis({ pol, P, compact }) {
  const ok = !!(pol && pol.applicable);
  const s = ok ? leanScore(pol) : 0;
  const band = ok ? leanBand(s) : -1;
  const target = ok ? ((s + LEAN_MAX) / (2 * LEAN_MAX)) * 100 : 50;
  const [pos, setPos] = React.useState(compact ? target : 50);
  React.useEffect(() => {
    if (compact) { setPos(target); return; }
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setPos(target); return; }
    const t = setTimeout(() => setPos(target), 120);
    return () => clearTimeout(t);
  }, [target, compact]);
  const h = compact ? 14 : 46;
  const track = (
    <div style={{ position: 'relative', height: h, width: '100%' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: compact ? 6 : 21, height: compact ? 2 : 4, borderRadius: 2,
        background: ok ? 'linear-gradient(90deg,' + P.left + ',' + P.mid + ' 50%,' + P.right + ')' : P.line, opacity: ok ? 0.6 : 1 }} />
      {!compact && Array.from({ length: 2 * LEAN_MAX + 1 }).map((_, i) => {
        const v = i - LEAN_MAX;
        const edge = Math.abs(v) === LEAN_MAX || Math.abs(v) === 3 || Math.abs(v) === 1;   // ends and the band boundaries at −3, −1, +1, +3
        return <div key={i} style={{ position: 'absolute', left: (i * 100 / (2 * LEAN_MAX)) + '%', top: edge ? 13 : 17, width: 1, height: edge ? 20 : 12,
          background: edge ? P.faint : P.line, transform: 'translateX(-0.5px)' }} />;
      })}
      {ok && (
        <div style={{ position: 'absolute', left: pos + '%', top: 0, height: h, transform: 'translateX(-50%)',
          transition: compact ? 'none' : 'left 1100ms cubic-bezier(.2,.8,.2,1)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ width: compact ? 8 : 12, height: compact ? 8 : 12, borderRadius: 99, background: P.ink, marginTop: compact ? 3 : 0,
            boxShadow: '0 0 0 3px ' + (compact ? 'transparent' : 'var(--slant-bg, transparent)') }} />
          {!compact && <div style={{ width: 2, flex: 1, background: P.ink }} />}
        </div>
      )}
    </div>
  );
  if (compact) return track;
  return (
    <div>
      {track}
      <div style={{ position: 'relative', height: 14, marginTop: 2, fontSize: 11, lineHeight: '14px', color: P.faint, fontVariantNumeric: 'tabular-nums' }} aria-hidden="true">
        {LEAN_TICKS.map((v) => (
          <span key={v} style={{ position: 'absolute', left: ((v + LEAN_MAX) / (2 * LEAN_MAX)) * 100 + '%',
            transform: v === -LEAN_MAX ? 'none' : v === LEAN_MAX ? 'translateX(-100%)' : 'translateX(-50%)' }}>{fmtLean(v)}</span>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: LEAN_COLS, marginTop: 4 }}>
        {LEAN_BANDS.map((b, i) => (
          <div key={b.label} style={{ textAlign: 'center', fontSize: 11, lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            color: i === band ? leanColor(i, P) : P.faint, fontWeight: i === band ? 600 : 400 }}>{b.label}</div>
        ))}
      </div>
    </div>
  );
}

function Meter({ score, P }) {
  const s = Math.round(clamp(score, 0, 10));
  return (
    <div style={{ display: 'flex', gap: 3 }} aria-label={s + ' out of 10'}>
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} style={{ width: 12, height: 6, borderRadius: 1.5, background: i < s ? P.ink : P.line, opacity: i < s ? 0.85 : 1 }} />
      ))}
    </div>
  );
}

function QuoteItem({ q, loc, snips, active, onPlay, P }) {
  const t = snips && snips[loc.seg] ? snips[loc.seg].t : null;
  return (
    <div style={{ borderLeft: '2px solid ' + (active ? P.accent : P.line), paddingLeft: 14, margin: '14px 0 0', transition: 'border-color .25s' }}>
      <div style={{ fontFamily: SERIF, fontSize: 16, lineHeight: 1.55, color: P.ink }}>“{q.quote}”</div>
      {q.why && <div style={{ fontSize: 13, lineHeight: 1.5, color: P.soft, marginTop: 4 }}>{q.why}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
        {t != null && (
          <button onClick={onPlay} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid ' + (active ? P.accent : P.line),
            color: active ? P.accent : P.soft, background: 'transparent', borderRadius: 999, padding: '2px 10px 2px 8px', fontSize: 12,
            fontVariantNumeric: 'tabular-nums', cursor: 'pointer' }}>
            <svg width="8" height="9" viewBox="0 0 8 9"><path d="M0 0l8 4.5L0 9z" fill="currentColor" /></svg>{fmtT(t)}
          </button>
        )}
        {loc.status === 'partial' && <span style={{ fontSize: 12, color: P.faint }} title="Matched loosely; the wording may differ slightly">approximate match</span>}
      </div>
    </div>
  );
}

function TranscriptPanel({ snips, paras, marked, activeSeg, onSeek, P, height }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (activeSeg == null || !ref.current) return;
    const el = ref.current.querySelector('[data-seg="' + activeSeg + '"]');
    if (el) ref.current.scrollTo({ top: Math.max(0, el.offsetTop - 64), behavior: 'smooth' });
  }, [activeSeg]);
  if (!snips) return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: P.faint, fontSize: 13 }}>Loading transcript…</div>;
  return (
    <div ref={ref} style={{ position: 'relative', height, overflowY: 'auto', paddingRight: 6, fontSize: 14, lineHeight: 1.65, color: P.soft }}>
      {paras.map((p) => (
        <div key={p.start} style={{ display: 'grid', gridTemplateColumns: '46px minmax(0,1fr)', gap: 8, marginBottom: 12 }}>
          <button onClick={() => onSeek(p.start)} style={{ textAlign: 'left', fontSize: 12, color: P.faint, background: 'none', border: 0, padding: '3px 0 0',
            cursor: 'pointer', fontVariantNumeric: 'tabular-nums', alignSelf: 'start' }}>{fmtT(snips[p.start].t)}</button>
          <div>
            {p.idx.map((i) => (
              <span key={i} data-seg={i} style={{ background: i === activeSeg ? P.hl : marked.has(i) ? P.hlSoft : 'transparent',
                color: i === activeSeg || marked.has(i) ? P.ink : undefined, borderRadius: 3, transition: 'background .3s',
                WebkitBoxDecorationBreak: 'clone', boxDecorationBreak: 'clone' }}>{snips[i].text} </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function UserDiv() {
  const { theme } = useTheme();
  const P = palette(theme === 'dark');
  const ingress = useIngressUrl('yt-bias');
  const oa = useManaRouter('openai');
  const gm = useManaRouter('gemini');
  const analysesAddr = relPathAddress('analyses');
  const base = analysesAddr ? analysesAddr.replace(/\/analyses$/, '') : null;

  const rootRef = React.useRef(null);
  const [w, setW] = React.useState(900);
  React.useEffect(() => {
    if (!rootRef.current) return;
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(rootRef.current);
    return () => ro.disconnect();
  }, []);

  const [items, setItems] = React.useState(null);
  React.useEffect(() => {
    if (!analysesAddr) { setItems({}); return; }
    const un = FS.onValue(FS.ref(FS.db, analysesAddr), (s) => setItems(unpackAll(s.val() || {})));
    return () => un();
  }, [analysesAddr]);

  // Can this viewer save analyses? The owner and editors can; people on a view-only link cannot. Deleting a key that never
  // exists answers it without changing anything, and before any credits are spent.
  const [canWrite, setCanWrite] = React.useState(null);
  const probeRef = React.useRef(null);
  React.useEffect(() => {
    if (!base) return;
    let live = true;
    const probe = FS.remove(FS.ref(FS.db, base + '/analyses/_probe_' + (userId || 'anon')), false).then(() => true, () => false);
    probe.then((v) => { if (live) setCanWrite(v); });
    probeRef.current = Promise.race([probe, new Promise((res) => setTimeout(() => res(null), 8000))]);
    return () => { live = false; };
  }, [base]);

  // ---- Feed history (private to each signed-in person) ----
  const feedAddr = userId && ownerId ? ownerId + '/file-system/slant-feeds/' + userId : null;
  const [feed, setFeed] = React.useState(null);
  const feedRef = React.useRef(null);
  React.useEffect(() => {
    if (!feedAddr) { setFeed(null); return; }
    const un = FS.onValue(FS.ref(FS.db, feedAddr), (s) => { const v = s.val() || {}; feedRef.current = v; setFeed(v); },
      () => { feedRef.current = {}; setFeed({ _error: true }); });
    return () => un();
  }, [feedAddr]);
  const keepDays = (feed && feed.settings && Number(feed.settings.keepDays)) || 365;
  // Retention: entries and reports older than the person's chosen period are removed when they open Slant.
  const prunedRef = React.useRef(false);
  React.useEffect(() => {
    if (!feed || feed._error || !feedAddr || prunedRef.current) return;
    prunedRef.current = true;
    const cut = Date.now() - keepDays * DAY_MS; const upd = {};
    Object.keys(feed.videos || {}).forEach((k) => { const e = feed.videos[k]; if (e && (e.lastAt || 0) < cut) upd['videos/' + k] = null; });
    Object.keys(feed.reports || {}).forEach((k) => { const r = feed.reports[k]; if (r && ((r.metadata && r.metadata.createdAt) || 0) < cut) upd['reports/' + k] = null; });
    if (Object.keys(upd).length) FS.update(FS.ref(FS.db, feedAddr), upd, false).catch(() => {});
  }, [feed, feedAddr, keepDays]);
  async function recordFeed(id, rec) {
    if (!feedAddr || !rec || !rec.videoId || !rec.result) return;
    try {
      let cur = feedRef.current;
      if (!cur) { const s = await FS.get(FS.ref(FS.db, feedAddr)); cur = s.val() || {}; }
      const prev = cur.videos ? cur.videos[rec.videoId] : null;
      const t = Date.now();
      const upd = { ['videos/' + rec.videoId]: clean({ videoId: rec.videoId, analysisId: id,
        url: rec.url || 'https://www.youtube.com/watch?v=' + rec.videoId, title: String(rec.title || '').slice(0, 300), author: String(rec.author || '').slice(0, 120),
        short: isShort(rec.url), firstAt: (prev && prev.firstAt) || t, lastAt: t, count: ((prev && prev.count) || 0) + 1,
        vias: { ...((prev && prev.vias) || {}), app: true }, s: feedSnap(rec.result),
        metadata: { type: 'entry', createdAt: (prev && prev.metadata && prev.metadata.createdAt) || t, updatedAt: t } }) };
      if (!cur.metadata) upd.metadata = { type: 'entry', createdAt: t, updatedAt: t };
      await FS.update(FS.ref(FS.db, feedAddr), upd, false);
    } catch (e) { console.warn('Slant feed: could not record', e); }
  }
  async function unfeed(vid) { if (feedAddr) await FS.update(FS.ref(FS.db, feedAddr), { ['videos/' + vid]: null }, false).catch(() => {}); }
  const inFeed = (vid) => !!(feed && feed.videos && feed.videos[vid]);
  const feedAll = React.useMemo(() => {
    const v = (feed && feed.videos) || {};
    const byVid = {};
    Object.keys(items || {}).forEach((k) => {
      const it = items[k];
      if (!it || !it.videoId || !it.result) return;
      const c = (it.metadata && it.metadata.createdAt) || 0;
      if (!byVid[it.videoId] || c > byVid[it.videoId].c) byVid[it.videoId] = { id: k, it, c };
    });
    return Object.keys(v).map((k) => v[k]).filter((e) => e && e.videoId && e.s).map((e) => {
      const direct = items && e.analysisId && items[e.analysisId] && items[e.analysisId].result ? { id: e.analysisId, it: items[e.analysisId] } : byVid[e.videoId];
      if (!direct) return { ...e, live: false };
      return { ...e, analysisId: direct.id, title: direct.it.title || e.title, author: direct.it.author || e.author, s: feedSnap(direct.it.result), live: true };
    }).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  }, [feed, items]);
  const [feedWin, setFeedWin] = React.useState(91);
  const [feedConfirm, setFeedConfirm] = React.useState(null);
  const [showAllFeed, setShowAllFeed] = React.useState(false);
  const [showLibrary, setShowLibrary] = React.useState(false);
  async function setKeep(days) {
    if (!feedAddr) return;
    const cut = Date.now() - days * DAY_MS; const upd = { 'settings/keepDays': days };
    Object.keys((feed && feed.videos) || {}).forEach((k) => { const e = feed.videos[k]; if (e && (e.lastAt || 0) < cut) upd['videos/' + k] = null; });
    await FS.update(FS.ref(FS.db, feedAddr), upd, false).catch(() => {});
    setFeedConfirm(null);
  }
  async function clearFeed() {
    if (!feedAddr) return;
    await FS.update(FS.ref(FS.db, feedAddr), { videos: null, reports: null }, false).catch(() => {});
    setFeedConfirm(null);
  }

  const readSel = () => new URLSearchParams(window.location.search).get('slant');
  const [sel, setSel] = React.useState(readSel);
  const pushedRef = React.useRef(false);
  React.useEffect(() => {
    const on = () => setSel(readSel());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const openItem = (id) => {
    const u = new URL(window.location.href); u.searchParams.set('slant', id);
    window.history.pushState({}, '', u.toString()); pushedRef.current = true; setSel(id);
    try { rootRef.current && rootRef.current.scrollIntoView({ block: 'start' }); } catch (e) {}
  };
  const closeItem = () => {
    if (pushedRef.current) { pushedRef.current = false; window.history.back(); return; }
    const u = new URL(window.location.href); u.searchParams.delete('slant'); u.searchParams.delete('report');
    window.history.replaceState({}, '', u.toString()); setSel(null);
  };

  const [tx, setTx] = React.useState({});
  React.useEffect(() => {
    if (!sel || isPage(sel) || tx[sel] || !base) return;
    let live = true;
    FS.get(FS.ref(FS.db, base + '/transcripts/' + sel + '/snippets')).then((s) => {
      if (live) setTx((p) => ({ ...p, [sel]: asArr(s.val()) }));
    }).catch(() => live && setTx((p) => ({ ...p, [sel]: [] })));
    return () => { live = false; };
  }, [sel, base]);

  const [input, setInput] = React.useState('');
  const [job, setJob] = React.useState(null);
  const [tick, setTick] = React.useState(0);
  const running = !!job && job.phase !== 'error' && job.phase !== 'viewonly';
  React.useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const [active, setActive] = React.useState(null);
  const [play, setPlay] = React.useState({ start: 0, nonce: 0, auto: false });
  const [confirmDel, setConfirmDel] = React.useState(null);
  const [flagOpen, setFlagOpen] = React.useState(false);
  const [flagPart, setFlagPart] = React.useState('');
  const [flagNote, setFlagNote] = React.useState('');
  const [flagMsg, setFlagMsg] = React.useState(null);
  const [showNotes, setShowNotes] = React.useState(false);
  React.useEffect(() => {
    setActive(null); setPlay({ start: 0, nonce: 0, auto: false });
    setFlagOpen(false); setFlagMsg(null); setShowNotes(false);
  }, [sel]);

  const rec = sel && !isPage(sel) && items ? items[sel] : null;
  const snips = sel && !isPage(sel) ? tx[sel] : null;
  const idx = React.useMemo(() => (snips && snips.length ? buildIndex(snips) : null), [snips]);
  const paras = React.useMemo(() => {
    if (!snips) return [];
    const out = []; let cur = null;
    snips.forEach((s, i) => {
      if (!cur || (s.t - snips[cur.start].t > 40 && /[.?!]["”']?$/.test(String(snips[i - 1].text).trim())) || s.t - snips[cur.start].t > 75) {
        cur = { start: i, idx: [] }; out.push(cur);
      }
      cur.idx.push(i);
    });
    return out;
  }, [snips]);

  const result = rec && rec.result ? rec.result : null;
  const located = React.useMemo(() => {
    const m = {}; const marked = new Set();
    if (!result || !snips || !snips.length) return { m, marked };
    const add = (key, q) => { const l = locate(idx, snips, q); m[key] = l; if (l.status !== 'missing') marked.add(l.seg); };
    asArr(result.political && result.political.quotes).forEach((q, i) => add('p' + i, q));
    asArr(result.dimensions).forEach((d) => asArr(d.quotes).forEach((q, i) => add(d.key + i, q)));
    return { m, marked };
  }, [result, snips, idx]);

  const flags = rec && rec.flags && typeof rec.flags === 'object'
    ? Object.keys(rec.flags).filter((k) => k !== 'metadata' && rec.flags[k] && rec.flags[k].part)
      .map((k) => ({ uid: k, ...rec.flags[k] })).sort((a, b) => (b.at || 0) - (a.at || 0))
    : [];
  const myFlag = userId ? flags.find((f) => f.uid === userId) : null;
  const isOwner = !!userId && userId === ownerId;

  const playerRef = React.useRef(null);
  const seekTo = (seg, key) => {
    if (!snips || !snips[seg]) return;
    setActive({ seg, key });
    setPlay((p) => ({ start: Math.floor(snips[seg].t), nonce: p.nonce + 1, auto: true }));
    if (w < 900 && playerRef.current) playerRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  async function fetchTranscript(vid) {
    let meta = {}, note = '';
    if (ingress.url) {
      try {
        const r = await fetch(ingress.url + '/transcript?url=' + encodeURIComponent(vid));
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.snippets && j.snippets.length) {
          return { snips: j.snippets, source: j.isGenerated ? 'auto-captions' : 'captions',
            meta: { title: j.title, author: j.author, language: j.language } };
        }
        meta = { title: j.title, author: j.author }; note = j.error || '';
      } catch (e) { note = 'The caption service is offline.'; }
    }
    if (!gm.url) throw new Error((note ? note + ' ' : '') + 'AI transcription is not ready yet; try again in a moment.');
    setJob((j) => ({ ...j, phase: 'transcribing', note }));
    const s = await geminiTranscript(gm.url, vid);
    if (!s.length) throw new Error('No speech was found in this video.');
    return { snips: s, source: 'ai-transcription', meta };
  }

  async function analyze(raw) {
    const vid = parseVideoId(raw);
    if (!vid) { setJob({ phase: 'error', error: 'That doesn’t look like a YouTube link.' }); return; }
    // Already analyzed: open the saved report instead of paying for a new one. Re-analyze stays on the report.
    const seen = list.find((it) => it.videoId === vid);
    if (seen) { setJob(null); setInput(''); recordFeed(seen.id, seen); openItem(seen.id); return; }
    if (!items) { setJob({ phase: 'error', error: 'Saved analyses are still loading. Try again in a moment.' }); return; }
    let writable = canWrite;
    if (writable == null && probeRef.current) writable = await probeRef.current;
    if (writable === false) { setJob({ phase: 'viewonly', vid }); return; }
    if (!oa.url) { setJob({ phase: 'error', error: oa.error ? oa.error.message : 'Still connecting. Try again in a moment.' }); return; }
    setJob({ phase: 'captions', started: Date.now(), vid });
    try {
      const got = await fetchTranscript(vid);
      const meta = { ...got.meta };
      if (!meta.title) {
        try {
          const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + vid));
          if (r.ok) { const o = await r.json(); meta.title = o.title; meta.author = o.author_name; }
        } catch (e) {}
      }
      setJob((j) => ({ ...j, phase: 'analyzing' }));
      const snipsN = got.snips.map((s) => ({ t: Number(s.t) || 0, d: Number(s.d) || 0, text: String(s.text || '') }));
      const { result: res, truncated } = await runAnalysis(oa.url, { ...meta, source: got.source }, snipsN);
      const id = 'v' + Date.now(); const t = Date.now();
      const last = snipsN[snipsN.length - 1];
      await FS.update(FS.ref(FS.db, base), {
        ['analyses/' + id]: clean({ videoId: vid, url: raw.trim(), title: meta.title || '', author: meta.author || '', language: meta.language || '',
          source: got.source, model: MODEL, segments: snipsN.length, duration: last ? last.t + last.d : 0, truncated, result: isOwner ? res : packResult(res),
          flags: { metadata: { permissions: FLAG_PERMS } },
          metadata: { type: 'entry', createdAt: t, updatedAt: t } }),
        ['transcripts/' + id]: { snippets: snipsN, metadata: { type: 'entry', createdAt: t, updatedAt: t } },
      });
      setTx((p) => ({ ...p, [id]: snipsN }));
      recordFeed(id, { videoId: vid, url: raw.trim(), title: meta.title || '', author: meta.author || '', result: res });
      setJob(null); setInput('');
      openItem(id);
    } catch (e) {
      if (isDenied(e) && writable !== true) { setCanWrite(false); setJob({ phase: 'viewonly', vid }); return; }
      if (isDenied(e)) { setJob((j) => ({ ...(j || {}), phase: 'error', error: 'Couldn’t save this analysis: ' + ((e && e.message) || String(e)) })); return; }
      setJob((j) => ({ ...(j || {}), phase: 'error', error: (e && e.message) || String(e) }));
    }
  }

  async function reanalyze(id) {
    const r0 = items && items[id]; const s = tx[id];
    if (!r0 || !s || !oa.url || canWrite === false) return;
    setJob({ phase: 'analyzing', started: Date.now(), vid: r0.videoId, reId: id });
    try {
      const { result: res, truncated } = await runAnalysis(oa.url, { title: r0.title, author: r0.author, source: r0.source }, s);
      await FS.update(FS.ref(FS.db, base + '/analyses/' + id), { result: isOwner ? clean(res) : packResult(res), truncated, model: MODEL, 'metadata/updatedAt': Date.now() });
      if (feedAddr && inFeed(r0.videoId)) FS.update(FS.ref(FS.db, feedAddr + '/videos/' + r0.videoId), { s: feedSnap(res), analysisId: id }, false).catch(() => {});
      setJob(null); setActive(null);
    } catch (e) {
      if (isDenied(e) && canWrite !== true) { setCanWrite(false); setJob(null); return; }
      setJob((j) => ({ ...(j || {}), phase: 'error', error: (e && e.message) || String(e) }));
    }
  }

  async function remove(id) {
    await FS.update(FS.ref(FS.db, base), { ['analyses/' + id]: null, ['transcripts/' + id]: null });
    setConfirmDel(null);
    if (sel === id) closeItem();
  }

  // "Disagree?" notes: one per person per analysis, stored at analyses/<id>/flags/<uid>.
  const flagRef = () => FS.ref(FS.db, base + '/analyses/' + sel + '/flags/' + userId);
  function openFlag() {
    setFlagPart(myFlag ? myFlag.part : ''); setFlagNote(myFlag ? String(myFlag.note || '') : '');
    setFlagMsg(null); setFlagOpen(true);
  }
  async function sendFlag(e) {
    e.preventDefault();
    if (!flagPart || !base || !rec) return;
    if (!userId) { setFlagMsg({ error: 'Sign in to Mana to send a note.' }); return; }
    const editing = !!myFlag;
    setFlagMsg({ saving: true });
    try {
      await FS.set(flagRef(), { part: flagPart, note: flagNote.trim().slice(0, FLAG_NOTE_MAX), at: Date.now() }, false);
      setFlagOpen(false);
      setFlagMsg({ ok: editing ? 'Your note was updated.' : 'Thanks. Your note is saved with this analysis.' });
    } catch (err) {
      setFlagMsg({ error: isDenied(err) ? 'Notes can’t be saved on this analysis.' : 'Couldn’t save your note. Try again.' });
    }
  }
  async function withdrawFlag() {
    try { await FS.remove(flagRef(), false); setFlagOpen(false); setFlagMsg({ ok: 'Your note was removed.' }); }
    catch (err) { setFlagMsg({ error: 'Couldn’t remove your note. Try again.' }); }
  }

  const list = items ? Object.keys(items).filter((k) => k !== 'metadata' && items[k] && items[k].videoId)
    .map((k) => ({ id: k, ...items[k] })).sort((a, b) => ((b.metadata && b.metadata.createdAt) || 0) - ((a.metadata && a.metadata.createdAt) || 0)) : [];
  const elapsed = job && job.started ? Math.max(0, Math.round((Date.now() - job.started) / 1000)) : 0;
  void tick;

  const label = { fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: P.faint, fontWeight: 500 };
  const pillBtn = (primary) => ({ height: 38, padding: '0 16px', borderRadius: 999, fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
    border: primary ? '1px solid ' + P.accent : '1px solid ' + P.line, background: primary ? P.accent : 'transparent', color: primary ? P.onAccent : P.ink });

  function renderInput(big) {
    return (
      <form onSubmit={(e) => { e.preventDefault(); if (!running && input.trim()) analyze(input); }}
        style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%', maxWidth: big ? 640 : 520, flexWrap: 'wrap' }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Paste a YouTube link" disabled={running}
          onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t && parseVideoId(t) && !running) { e.preventDefault(); setInput(t); analyze(t); } }}
          style={{ flex: '1 1 200px', minWidth: 0, height: big ? 46 : 38, padding: '0 18px', borderRadius: 999, border: '1px solid ' + P.line,
            background: P.field, color: P.ink, fontSize: big ? 15 : 13, outline: 'none' }} />
        <button type="submit" disabled={running || !input.trim()} style={{ ...pillBtn(true), height: big ? 46 : 38, padding: big ? '0 22px' : '0 16px',
          opacity: running || !input.trim() ? 0.5 : 1 }}>{running ? 'Working…' : canWrite === false ? 'Open' : 'Analyze'}</button>
      </form>
    );
  }

  function renderJob() {
    if (!job) return null;
    if (job.phase === 'error') {
      return (
        <div style={{ marginTop: 16, fontSize: 13, color: P.ink, display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ color: P.accent }}>Couldn’t analyze this video.</span><span style={{ color: P.soft }}>{job.error}</span>
          <button onClick={() => setJob(null)} style={{ background: 'none', border: 0, color: P.faint, fontSize: 13, cursor: 'pointer', textDecoration: 'underline' }}>Dismiss</button>
        </div>
      );
    }
    if (job.phase === 'viewonly') {
      return (
        <div style={{ marginTop: 16, fontSize: 13, lineHeight: 1.6, color: P.soft, maxWidth: 600 }}>
          <span style={{ color: P.ink, fontWeight: 500 }}>This video hasn’t been analyzed yet.</span>{' '}
          {VIEW_ONLY_WHY}{sel ? '' : ' Saved analyses are below.'}{' '}
          <button onClick={() => setJob(null)} style={{ background: 'none', border: 0, padding: 0, color: P.faint, fontSize: 13, cursor: 'pointer', textDecoration: 'underline' }}>Dismiss</button>
        </div>
      );
    }
    const steps = job.reId ? [{ k: 'analyzing', t: 'Re-reading the transcript and scoring bias' }] : [
      { k: 'captions', t: 'Fetching the transcript' },
      ...(job.phase === 'transcribing' || job.note ? [{ k: 'transcribing', t: 'No captions, so transcribing the audio' }] : []),
      { k: 'analyzing', t: 'Reading the transcript and scoring bias' },
    ];
    const at = steps.findIndex((s) => s.k === job.phase);
    return (
      <div style={{ marginTop: 18, display: 'grid', gap: 8 }}>
        {steps.map((s, i) => (
          <div key={s.k} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: i <= at ? P.ink : P.faint }}>
            <span style={{ width: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              {i < at ? <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6.5l2.5 2.5L10 3.5" stroke={P.ink} strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
                : i === at ? <span className="slant-spin" style={{ width: 11, height: 11, borderRadius: 99, border: '1.6px solid ' + P.line, borderTopColor: P.accent }} />
                : <span style={{ width: 5, height: 5, borderRadius: 99, background: P.line }} />}
            </span>
            <span>{s.t}</span>
            {i === at && <span style={{ color: P.faint, fontVariantNumeric: 'tabular-nums' }}>{elapsed}s</span>}
          </div>
        ))}
        {job.phase === 'analyzing' && <div style={{ fontSize: 12, color: P.faint, marginLeft: 24 }}>Usually 20 to 60 seconds, longer for long videos.</div>}
      </div>
    );
  }

  function leanTag(pol) {
    if (!pol || !pol.applicable) return <span style={{ color: P.faint }}>Not political</span>;
    const s = leanScore(pol); const b = leanBand(s);
    return (
      <span style={{ fontVariantNumeric: 'tabular-nums' }} title={'Political lean, ' + LEAN_SCALE_NOTE}>
        <span style={{ color: leanColor(b, P), fontWeight: 600 }}>{LEAN_BANDS[b].label}</span>
        <span style={{ color: P.soft }}>{' · ' + fmtLean(s)}</span>
      </span>
    );
  }

  function renderThumb(it, narrow) {
    const fallback = (e) => {
      const img = e.currentTarget;
      if (img.dataset.fb) return;
      img.dataset.fb = '1'; img.src = 'https://i.ytimg.com/vi/' + it.videoId + '/hqdefault.jpg';
    };
    if (isShort(it.url)) {
      // Shorts use YouTube's 9:16 thumbnail, uncropped; the landscape ones shrink the frame into the middle.
      const h = narrow ? 80 : 96;
      return (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <img src={'https://i.ytimg.com/vi/' + it.videoId + '/oardefault.jpg'} alt="" loading="lazy" decoding="async"
            onError={fallback} onLoad={(e) => { if (e.currentTarget.naturalWidth < 200) fallback(e); }}
            style={{ height: h, width: Math.round((h * 9) / 16), objectFit: 'cover', borderRadius: 8, background: P.line, display: 'block' }} />
        </div>
      );
    }
    return <img src={'https://i.ytimg.com/vi/' + it.videoId + '/mqdefault.jpg'} alt="" loading="lazy" decoding="async"
      style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', borderRadius: 8, background: P.line, display: 'block' }} />;
  }

  function renderRow(it) {
    const r = it.result || {};
    const d = it.metadata && it.metadata.createdAt ? new Date(it.metadata.createdAt) : null;
    const narrow = w < 560;
    const delBtn = { background: 'none', border: 0, cursor: 'pointer', fontSize: 12, padding: 0 };
    return (
      <div key={it.id} className="slant-row" onClick={() => openItem(it.id)} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openItem(it.id); }}
        style={{ display: 'grid', gridTemplateColumns: (narrow ? '96px' : '128px') + ' minmax(0,1fr)' + (narrow ? '' : ' 150px'), gap: narrow ? 14 : 16,
          padding: '14px 0', borderTop: '1px solid ' + P.line, cursor: 'pointer', alignItems: 'center' }}>
        {renderThumb(it, narrow)}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: SERIF, fontSize: 16, lineHeight: 1.35, color: P.ink, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{it.title || it.videoId}</div>
          <div style={{ fontSize: 12, color: P.faint, marginTop: 4 }}>{[it.author, d && d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })].filter(Boolean).join(' · ')}</div>
          {r.headline && <div style={{ fontSize: 13, color: P.soft, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.headline}</div>}
          {narrow && (
            <div style={{ fontSize: 12, color: P.faint, marginTop: 5 }}>
              {leanTag(r.political)}<span>{' · Slant ' + Math.round(clamp(r.overall, 0, 10)) + '/10'}</span>
            </div>
          )}
        </div>
        {!narrow && (
          <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
            <div style={{ width: 120 }}><Axis pol={r.political} P={P} compact /></div>
            <div style={{ fontSize: 12 }}>{leanTag(r.political)}</div>
            {canWrite === true && (confirmDel === it.id ? (
              <div style={{ display: 'flex', gap: 10 }} onClick={(e) => e.stopPropagation()}>
                <button onClick={() => remove(it.id)} style={{ ...delBtn, color: P.accent }}>Remove</button>
                <button onClick={() => setConfirmDel(null)} style={{ ...delBtn, color: P.faint }}>Keep</button>
              </div>
            ) : (
              <button className="slant-del" onClick={(e) => { e.stopPropagation(); setConfirmDel(it.id); }} style={{ ...delBtn, color: P.faint }}>Remove</button>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderHome() {
    const linkBtn = { background: 'none', border: 0, padding: 0, font: 'inherit', color: P.ink, cursor: 'pointer',
      textDecoration: 'underline', textUnderlineOffset: 3, textDecorationColor: P.mid };
    return (
      <div>
        <div style={{ padding: w < 600 ? '28px 0 8px' : '56px 0 12px' }}>
          <div style={label}>Slant</div>
          <h1 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: w < 600 ? 32 : 44, lineHeight: 1.1, letterSpacing: '-0.01em', margin: '14px 0 12px', color: P.ink }}>How slanted is this video?</h1>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: P.soft, maxWidth: 560, margin: '0 0 26px' }}>
            Paste a YouTube link. Slant reads the full transcript, scores political lean and five other signals, and shows the exact lines behind every score.{' '}
            <button onClick={() => openItem('how')} style={linkBtn}>How Slant works</button>
          </p>
          {renderInput(true)}
          {canWrite === false && !job && (
            <div style={{ marginTop: 14, fontSize: 13, lineHeight: 1.6, color: P.soft, maxWidth: 600 }}>
              <span style={{ color: P.ink, fontWeight: 500 }}>View-only link.</span>{' '}
              Open any saved analysis below, or paste the link of a video that’s already been analyzed. {VIEW_ONLY_WHY}
            </div>
          )}
          {renderJob()}
          {feedAddr && (
            <button onClick={() => openItem('feed')} className="slant-feedlink"
              style={{ marginTop: 22, display: 'inline-flex', alignItems: 'center', gap: 10, background: 'none', border: 0, padding: 0, cursor: 'pointer', color: P.ink, fontSize: 14, textAlign: 'left' }}>
              <svg width="34" height="14" viewBox="0 0 34 14" aria-hidden="true">
                <line x1="1" y1="12" x2="33" y2="12" stroke={P.line} strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="7" cy="8" r="2.4" fill={P.left} /><circle cx="12" cy="8" r="2.4" fill={P.left} /><circle cx="12" cy="3" r="2.4" fill={P.left} />
                <circle cx="17" cy="8" r="2.4" fill={P.mid} /><circle cx="25" cy="8" r="2.4" fill={P.right} />
              </svg>
              <span><span style={{ fontWeight: 500, textDecoration: 'underline', textUnderlineOffset: 3, textDecorationColor: P.mid }}>Your feed</span>
                <span style={{ color: P.soft }}>{feedAll.length ? ' · ' + feedAll.length + (feedAll.length === 1 ? ' video' : ' videos') + ': see your averages' : ' · every video you analyze, averaged on the bias bear'}</span></span>
            </button>
          )}
        </div>
        {list.length > 0 && (
          <div style={{ marginTop: 44 }}>
            <div style={{ ...label, marginBottom: 6 }}>Analyzed · {list.length}</div>
            {list.map(renderRow)}
            <div style={{ borderTop: '1px solid ' + P.line }} />
          </div>
        )}
        {items && list.length === 0 && !job && (
          <div style={{ marginTop: 40, fontSize: 13, color: P.faint }}>{canWrite === false ? 'No analyses have been saved yet.' : 'Your analyses will collect here.'}</div>
        )}
      </div>
    );
  }

  function renderPlayer(vid, short, wide) {
    const src = 'https://www.youtube-nocookie.com/embed/' + vid + '?rel=0&modestbranding=1&playsinline=1&start=' + play.start + (play.auto ? '&autoplay=1' : '');
    const box = short
      ? { width: 'min(100%, calc(' + shortH(wide) + ' * 9 / 16))', aspectRatio: '9 / 16', margin: '0 auto' }
      : { width: '100%', aspectRatio: '16/9' };
    return (
      <div ref={playerRef} style={{ ...box, borderRadius: 12, overflow: 'hidden', background: '#000' }}>
        <iframe key={vid + '-' + play.nonce} src={src} title="YouTube video" style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
      </div>
    );
  }

  function renderQuotes(arr, prefix) {
    if (!snips) return null;
    return asArr(arr).map((q, i) => {
      const key = prefix + i; const loc = located.m[key];
      if (!loc || loc.status === 'missing') return null;
      return <QuoteItem key={key} q={q} loc={loc} snips={snips} P={P} active={active && active.key === key} onPlay={() => seekTo(loc.seg, key)} />;
    });
  }

  function renderAnalysis() {
    const r = result || {};
    const pol = r.political || {};
    const polOk = !!pol.applicable;
    const s = polOk ? leanScore(pol) : 0;
    const band = polOk ? leanBand(s) : -1;
    const lc = leanColor(band, P);
    const dims = asArr(r.dimensions);
    const byKey = {}; dims.forEach((d) => { byKey[d.key] = d; });
    const ov = clamp(r.overall, 0, 10);
    const reRunning = job && job.reId === sel && job.phase !== 'error';
    const polQuotes = renderQuotes(pol.quotes, 'p');
    const hasPolQuotes = Array.isArray(polQuotes) && polQuotes.some(Boolean);
    return (
      <div style={{ minWidth: 0 }}>
        <section>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <div style={label}>Political lean <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400, color: P.faint }}>· {LEAN_SCALE_NOTE}</span></div>
            {polOk && pol.confidence && <div style={{ fontSize: 12, color: P.faint }}>{pol.confidence} confidence</div>}
          </div>
          {polOk ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: SERIF, fontSize: w < 600 ? 48 : 56, lineHeight: 1, color: P.ink, fontVariantNumeric: 'tabular-nums' }}>{fmtLean(s)}<span style={{ fontFamily: 'inherit', fontSize: 18, color: P.faint, marginLeft: 6 }} aria-label="on a scale from −6 to +6">/ ±6</span></span>
                <span title={'AllSides scale: ' + LEAN_BANDS.map((b) => b.label + ' ' + b.range).join(', ')}
                  style={{ display: 'inline-flex', alignItems: 'center', height: 30, padding: '0 14px', borderRadius: 999, border: '1px solid ' + lc + '66',
                    color: lc, fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}>{LEAN_BANDS[band].label}</span>
              </div>
              {pol.label && <div style={{ fontSize: 14, lineHeight: 1.5, color: P.soft, marginTop: 10 }}>{pol.label}</div>}
            </div>
          ) : (
            <div>
              <div style={{ fontFamily: SERIF, fontSize: 32, lineHeight: 1.1, color: P.ink, marginTop: 10 }}>Not political</div>
              <div style={{ fontSize: 14, color: P.soft, marginTop: 8 }}>No political or social-issue content detected.</div>
            </div>
          )}
          <div style={{ marginTop: 18 }}><Axis pol={pol} P={P} /></div>

          <div style={{ marginTop: 26, paddingTop: 18, borderTop: '1px solid ' + P.line }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ ...label, flex: w < 560 ? '1 1 100%' : '1 1 auto' }}>Slant score</div>
              <Meter score={ov} P={P} />
              <div style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ fontFamily: SERIF, fontSize: 24, color: P.ink }}>{Math.round(ov * 10) / 10}</span>
                <span style={{ fontSize: 14, color: P.faint }}>{' / 10 · ' + biasWord(ov)}</span>
              </div>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.5, color: P.soft, marginTop: 6 }}>{SLANT_EXPLAINER}</div>
          </div>

          <h2 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 26, lineHeight: 1.25, margin: '30px 0 10px', color: P.ink }}>{r.headline}</h2>
          <p style={{ fontSize: 15, lineHeight: 1.65, color: P.soft, margin: 0, maxWidth: 680 }}>{r.summary}</p>
          <div style={{ fontSize: 12, color: P.faint, marginTop: 12 }}>{[r.contentType, r.topic].filter(Boolean).join(' · ')}</div>
        </section>

        {polOk && (pol.explanation || hasPolQuotes) && (
          <section style={{ marginTop: 44 }}>
            <div style={label}>Why this lean</div>
            {pol.explanation && <p style={{ fontSize: 15, lineHeight: 1.65, color: P.soft, margin: '12px 0 0', maxWidth: 680 }}>{pol.explanation}</p>}
            {polQuotes}
          </section>
        )}

        <section style={{ marginTop: 48 }}>
          <div style={label}>Other signals</div>
          {DIMS.map((dm) => {
            const d = byKey[dm.key] || { score: 0, explanation: '', quotes: [] };
            return (
              <div key={dm.key} style={{ borderTop: '1px solid ' + P.line, padding: '18px 0 20px', marginTop: dm.key === 'one_sided' ? 12 : 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                    <div style={{ fontSize: 15, color: P.ink, fontWeight: 500 }}>{dm.name}</div>
                    <div style={{ fontSize: 12, color: P.faint, marginTop: 2 }}>{dm.hint}</div>
                  </div>
                  <Meter score={d.score} P={P} />
                  <div style={{ width: 34, textAlign: 'right', fontSize: 14, color: P.ink, fontVariantNumeric: 'tabular-nums' }}>{Math.round(clamp(d.score, 0, 10))}</div>
                </div>
                {d.explanation && <p style={{ fontSize: 14, lineHeight: 1.6, color: P.soft, margin: '10px 0 0', maxWidth: 680 }}>{d.explanation}</p>}
                {renderQuotes(d.quotes, dm.key)}
              </div>
            );
          })}
        </section>

        {(asArr(r.balance).length > 0 || asArr(r.caveats).length > 0) && (
          <section style={{ marginTop: 28, display: 'grid', gridTemplateColumns: w < 700 ? '1fr' : '1fr 1fr', gap: 28, borderTop: '1px solid ' + P.line, paddingTop: 22 }}>
            {asArr(r.balance).length > 0 && (
              <div>
                <div style={label}>Done fairly</div>
                <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 14, lineHeight: 1.6, color: P.soft }}>{asArr(r.balance).map((b, i) => <li key={i} style={{ marginBottom: 6 }}>{b}</li>)}</ul>
              </div>
            )}
            {asArr(r.caveats).length > 0 && (
              <div>
                <div style={label}>Caveats</div>
                <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 14, lineHeight: 1.6, color: P.soft }}>{asArr(r.caveats).map((b, i) => <li key={i} style={{ marginBottom: 6 }}>{b}</li>)}</ul>
              </div>
            )}
          </section>
        )}

        <div style={{ marginTop: 36, paddingTop: 16, borderTop: '1px solid ' + P.line, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: P.faint }}>
          <span>{[SRC_LABEL[rec.source] || rec.source, rec.segments ? rec.segments + ' lines' : '', rec.truncated ? 'transcript truncated' : ''].filter(Boolean).join(' · ')}</span>
          <button onClick={() => openItem('how')} style={{ background: 'none', border: 0, padding: 0, color: P.faint, fontSize: 12, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }}>How Slant works</button>
          <span style={{ flex: 1 }} />
          {canWrite === true && (
            <button onClick={() => reanalyze(sel)} disabled={!snips || !!running} style={{ ...pillBtn(false), height: 32, fontSize: 12, opacity: !snips || running ? 0.5 : 1 }}>{reRunning ? 'Re-analyzing…' : 'Re-analyze'}</button>
          )}
          {feedAddr && (inFeed(rec.videoId) ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: P.soft }}>
              <button onClick={() => openItem('feed')} style={{ background: 'none', border: 0, padding: 0, color: P.soft, fontSize: 12, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }}>In your feed</button>
              <button onClick={() => unfeed(rec.videoId)} style={{ background: 'none', border: 0, padding: 0, color: P.faint, fontSize: 12, cursor: 'pointer' }}>Remove</button>
            </span>
          ) : (
            <button onClick={() => recordFeed(sel, rec)} style={{ ...pillBtn(false), height: 32, fontSize: 12 }}>Add to my feed</button>
          ))}
          <a href={'https://www.youtube.com/watch?v=' + rec.videoId} target="_blank" rel="noreferrer" style={{ ...pillBtn(false), height: 32, fontSize: 12, display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>Open on YouTube</a>
        </div>
        {job && job.reId === sel && renderJob()}
        {renderFlags()}
      </div>
    );
  }

  function renderFlags() {
    const n = flags.length;
    const linkBtn = { background: 'none', border: 0, padding: 0, color: P.faint, fontSize: 12, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 };
    const chip = (on) => ({ height: 32, padding: '0 12px', borderRadius: 999, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
      border: '1px solid ' + (on ? P.ink : P.line), background: on ? P.hlSoft : 'transparent', color: on ? P.ink : P.soft });
    const partName = (k) => { const p = FLAG_PARTS.find((x) => x.key === k); return p ? p.name : 'Other'; };
    const saving = !!(flagMsg && flagMsg.saving);
    return (
      <div style={{ marginTop: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12, color: P.faint }}>
          {!flagOpen && (
            <button onClick={openFlag} style={{ ...pillBtn(false), height: 30, padding: '0 14px', fontSize: 12 }}>{myFlag ? 'Edit your note' : 'Disagree?'}</button>
          )}
          {n > 0 && <span>{n === 1 ? '1 person flagged this analysis' : n + ' people flagged this analysis'}</span>}
          {isOwner && n > 0 && <button onClick={() => setShowNotes((v) => !v)} style={linkBtn}>{showNotes ? 'Hide notes' : 'Show notes'}</button>}
          {flagMsg && flagMsg.ok && !flagOpen && <span style={{ color: P.soft }}>{flagMsg.ok}</span>}
        </div>
        {flagOpen && (
          <form onSubmit={sendFlag} style={{ marginTop: 6, maxWidth: 640 }}>
            <div style={{ fontSize: 14, color: P.ink, fontWeight: 500 }}>Which part do you disagree with?</div>
            <div role="radiogroup" aria-label="Part of the analysis" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              {FLAG_PARTS.map((p) => (
                <button type="button" key={p.key} role="radio" aria-checked={flagPart === p.key} onClick={() => setFlagPart(p.key)} style={chip(flagPart === p.key)}>{p.name}</button>
              ))}
            </div>
            <label htmlFor="slant-flag-note" style={{ display: 'block', fontSize: 13, color: P.soft, margin: '16px 0 6px' }}>
              Short note <span style={{ color: P.faint }}>(optional)</span>
            </label>
            <textarea id="slant-flag-note" value={flagNote} onChange={(e) => setFlagNote(e.target.value.slice(0, FLAG_NOTE_MAX))} rows={3} maxLength={FLAG_NOTE_MAX}
              placeholder="What doesn’t match the video?"
              style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', padding: '10px 14px', borderRadius: 12, border: '1px solid ' + P.line,
                background: P.field, color: P.ink, fontSize: 14, lineHeight: 1.5, outline: 'none', fontFamily: 'inherit' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <button type="submit" disabled={!flagPart || saving} style={{ ...pillBtn(true), height: 34, fontSize: 13, opacity: !flagPart || saving ? 0.5 : 1 }}>
                {saving ? 'Saving…' : myFlag ? 'Update' : 'Send'}
              </button>
              <button type="button" onClick={() => { setFlagOpen(false); setFlagMsg(null); }} style={{ ...pillBtn(false), height: 34, fontSize: 13 }}>Cancel</button>
              {myFlag && <button type="button" onClick={withdrawFlag} style={linkBtn}>Remove my note</button>}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: P.faint, fontVariantNumeric: 'tabular-nums' }}>{flagNote.length}/{FLAG_NOTE_MAX}</span>
            </div>
            {flagMsg && flagMsg.error && <div style={{ fontSize: 13, color: P.accent, marginTop: 10 }}>{flagMsg.error}</div>}
          </form>
        )}
        {isOwner && showNotes && n > 0 && (
          <div style={{ marginTop: 12, maxWidth: 640 }}>
            {flags.map((f) => (
              <div key={f.uid} style={{ borderTop: '1px solid ' + P.line, padding: '10px 0' }}>
                <div style={{ fontSize: 12, color: P.faint }}>{partName(f.part) + (f.at ? ' · ' + new Date(f.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '')}</div>
                {f.note && <div style={{ fontSize: 14, lineHeight: 1.5, color: P.soft, marginTop: 3 }}>{String(f.note).slice(0, FLAG_NOTE_MAX)}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderFeed() {
    const narrow = w < 600;
    const para = { fontSize: 14, lineHeight: 1.65, color: P.soft, margin: 0 };
    const sec = { marginTop: 44, paddingTop: 24, borderTop: '1px solid ' + P.line };
    const linkBtn = { background: 'none', border: 0, padding: 0, font: 'inherit', fontSize: 13, color: P.soft, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3, textDecorationColor: P.mid };
    const chip = (on) => ({ height: 32, padding: '0 14px', borderRadius: 999, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
      border: '1px solid ' + (on ? P.ink : P.line), background: on ? P.hlSoft : 'transparent', color: on ? P.ink : P.soft });
    const back = (
      <div style={{ padding: '20px 0 22px' }}>
        <button onClick={closeItem} style={{ background: 'none', border: 0, padding: 0, color: P.soft, fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M8.5 3L4.5 7l4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          All videos
        </button>
      </div>
    );
    if (!feedAddr) return <div>{back}<p style={para}>Sign in to Mana to keep a feed.</p></div>;
    if (!feed) return <div>{back}<div style={{ color: P.faint, fontSize: 13 }}>Loading your feed…</div></div>;
    if (feed._error) return <div>{back}<p style={para}>Your feed couldn’t be loaded. Try again later.</p></div>;

    const keepLabel = (FEED_KEEP.find((k) => k.days === keepDays) || FEED_KEEP[2]).label;
    const wins = FEED_WINDOWS.filter((x) => x.days <= keepDays);
    const win = wins.find((x) => x.days === feedWin) || wins[wins.length - 1];
    const cut = Date.now() - win.days * DAY_MS;
    const entries = feedAll.filter((e) => (e.lastAt || 0) >= cut);
    const openEntry = (e) => { if (e.live && e.analysisId) openItem(e.analysisId); else window.open(e.url || 'https://www.youtube.com/watch?v=' + e.videoId, '_blank', 'noopener'); };
    const library = list.filter((it) => it.result && !inFeed(it.videoId));
    const fmtDay = (ms) => new Date(ms || 0).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

    // Plain arithmetic means of the scores already saved for these videos. Nothing else is computed.
    // Lean: political videos only (others have no lean score). Slant score and signals: every video that has the score.
    const avgOf = (vals) => ({ v: vals.length ? mean(vals) : null, n: vals.length });
    const polVals = entries.filter((e) => e.s.political && typeof e.s.lean === 'number').map((e) => clamp(e.s.lean, -LEAN_MAX, LEAN_MAX));
    const avgLean = avgOf(polVals);
    const avgOverall = avgOf(entries.filter((e) => typeof e.s.overall === 'number').map((e) => clamp(e.s.overall, 0, 10)));
    const avgDim = {};
    DIMS.forEach((d) => { avgDim[d.key] = avgOf(entries.filter((e) => e.s.dims && typeof e.s.dims[d.key] === 'number').map((e) => clamp(e.s.dims[d.key], 0, 10))); });
    const political = avgLean.n > 0;
    // The extension's mapping (scoresFromResult): non-political means L = 0; missing signals count as 0.
    const bearV = { L: political ? avgLean.v : 0, S: avgDim.sensationalism.v || 0, K: avgDim.loaded_language.v || 0,
      P: avgDim.ad_hominem.v || 0, U: avgDim.unsupported_claims.v || 0, O: avgDim.one_sided.v || 0 };
    const leanR = political ? r1(avgLean.v) : 0;
    const leanLbl = political ? SLANT_BEAR.bearLeanLabel(avgLean.v) : 'Not political';
    const leanInk = political ? leanColor(leanBand(leanR), P) : P.soft;
    const bearLabel = 'Bias bear for the average of ' + entries.length + (entries.length === 1 ? ' video' : ' videos') + ': ' + leanLbl +
      (political ? ' ' + fmtLean(leanR) : '') + (avgOverall.v != null ? ', Slant ' + r1(avgOverall.v) + ' out of 10' : '');

    function leanMini(v) {
      if (v == null) return <span style={{ color: P.faint }}>Not political</span>;
      const b = leanBand(r1(v));
      return <span style={{ fontVariantNumeric: 'tabular-nums' }}><span style={{ color: leanColor(b, P), fontWeight: 600 }}>{LEAN_BANDS[b].label}</span><span style={{ color: P.soft }}>{' · ' + fmtLean(r1(v))}</span></span>;
    }
    function statRow(name, hint, value, of, part, key) {
      return (
        <div key={key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 14, alignItems: 'baseline', padding: '13px 0', borderTop: '1px solid ' + P.line }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, color: P.ink, fontWeight: 500 }}>{name}</div>
            <div style={{ fontSize: 12, color: P.faint, marginTop: 2 }}>{[hint, part ? 'Bear: ' + part : ''].filter(Boolean).join(' · ')}</div>
          </div>
          <div style={{ textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ fontSize: 15, color: P.ink }}>{value}</span>{of && <span style={{ fontSize: 12, color: P.faint }}>{of}</span>}
          </div>
        </div>
      );
    }

    return (
      <div>
        {back}
        <div style={{ maxWidth: 820 }}>
          <div style={label}>Your feed</div>
          <h1 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: narrow ? 32 : 42, lineHeight: 1.1, letterSpacing: '-0.01em', margin: '14px 0 12px', color: P.ink }}>Your averages</h1>
          <p style={{ ...para, fontSize: 15, maxWidth: 620 }}>The average of Slant’s scores for the videos in your feed, drawn on the bias bear from Slant for Chrome. Every video you analyze in Slant or with Slant for Chrome stays here for {keepLabel}, private to your Mana account.</p>
          <div role="radiogroup" aria-label="Period" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 22 }}>
            {wins.map((x) => {
              const c = feedAll.filter((e) => (e.lastAt || 0) >= Date.now() - x.days * DAY_MS).length;
              return <button key={x.days} role="radio" aria-checked={x.days === win.days} onClick={() => setFeedWin(x.days)} style={chip(x.days === win.days)}>{x.label}<span style={{ color: P.faint, marginLeft: 6, fontVariantNumeric: 'tabular-nums' }}>{c}</span></button>;
            })}
          </div>
        </div>

        <section style={{ marginTop: 36, display: 'grid', gridTemplateColumns: w < 760 ? 'minmax(0,1fr)' : 'minmax(240px,300px) minmax(0,1fr)', gap: w < 760 ? 28 : 56, alignItems: 'start' }}>
          <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <BearCanvas v={entries.length ? bearV : { L: 0, S: 0, K: 0, P: 0, U: 0, O: 0 }} scale={narrow ? 3.5 : 4} label={entries.length ? bearLabel : 'Neutral bias bear: no videos in this period'} />
            <figcaption style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, textAlign: 'center', padding: '8px 16px', borderRadius: 14, border: '1px solid ' + P.line, background: P.surface }}>
              {entries.length ? (
                <>
                  <span style={{ fontSize: 15, fontWeight: 600, color: leanInk, fontVariantNumeric: 'tabular-nums' }}>{political ? leanLbl + ' · ' + fmtLean(leanR) : leanLbl}</span>
                  {political && <span style={{ fontSize: 12.5, color: P.soft }}>{LEAN_SCALE_NOTE}</span>}
                  {avgOverall.v != null && <span style={{ fontSize: 12.5, color: P.soft, fontVariantNumeric: 'tabular-nums' }}>{'Slant ' + r1(avgOverall.v) + ' / 10 · ' + SLANT_BEAR.bearScoreWord(avgOverall.v)}</span>}
                </>
              ) : <span style={{ fontSize: 14, color: P.soft }}>No videos in this period</span>}
            </figcaption>
            <div style={{ fontSize: 12, color: P.faint }}>Average of {entries.length} {entries.length === 1 ? 'video' : 'videos'} · {win.label.toLowerCase()}</div>
          </figure>

          <div style={{ minWidth: 0 }}>
            {entries.length === 0 ? (
              <p style={{ ...para, maxWidth: 560 }}>{feedAll.length ? 'No videos in this period. Choose a longer period above.' : 'Your feed is empty. Paste a YouTube link on the home page, or add videos that are already analyzed below.'}</p>
            ) : (
              <div>
                <div style={label}>Averages</div>
                <div style={{ marginTop: 10 }}>
                  {statRow('Videos', avgLean.n + ' political · ' + (entries.length - avgLean.n) + ' not political', String(entries.length), '', '', 'n')}
                  {statRow('Political lean', political ? 'Mean of ' + avgLean.n + ' political ' + (avgLean.n === 1 ? 'video' : 'videos') + ' · ' + LEAN_SCALE_NOTE : 'No political videos in this period', political ? <span style={{ color: leanInk }}>{fmtLean(leanR) + ' · ' + LEAN_BANDS[leanBand(leanR)].label}</span> : '—', '', 'Body color', 'lean')}
                  {statRow('Slant score', 'Mean of ' + avgOverall.n + ' · ' + SLANT_EXPLAINER, avgOverall.v == null ? '—' : String(r1(avgOverall.v)), avgOverall.v == null ? '' : ' / 10', '', 'overall')}
                </div>
                <div style={{ ...label, marginTop: 28 }}>Signals</div>
                <div style={{ marginTop: 10 }}>
                  {DIMS.map((d) => statRow(d.name, 'Mean of ' + avgDim[d.key].n + ' · ' + d.hint, avgDim[d.key].v == null ? '—' : String(r1(avgDim[d.key].v)), avgDim[d.key].v == null ? '' : ' / 10', BEAR_PART[d.key], d.key))}
                  <div style={{ borderTop: '1px solid ' + P.line }} />
                </div>
                <p style={{ fontSize: 12.5, lineHeight: 1.6, color: P.faint, margin: '14px 0 0', maxWidth: 560 }}>
                  As in Slant for Chrome, the eyebrows follow the highest of the three averages marked Eyebrows, and the ear on the lean side grows with one-sidedness. Each number is a plain average of saved scores, rounded to one decimal.
                </p>
              </div>
            )}
          </div>
        </section>

        {entries.length > 0 && (
            <section style={sec}>
              <div style={label}>Videos · {entries.length}</div>
              <div style={{ marginTop: 6 }}>
                {(showAllFeed ? entries : entries.slice(0, 12)).map((e) => (
                  <div key={e.videoId} className="slant-row" style={{ display: 'grid', gridTemplateColumns: (narrow ? '' : '64px ') + 'minmax(0,1fr) auto', gap: 14, padding: '11px 0', borderTop: '1px solid ' + P.line, alignItems: 'center' }}>
                    {!narrow && <div style={{ fontSize: 12, color: P.faint, fontVariantNumeric: 'tabular-nums' }}>{fmtDay(e.lastAt)}</div>}
                    <div style={{ minWidth: 0 }}>
                      <button onClick={() => openEntry(e)} style={{ display: 'block', maxWidth: '100%', background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer', fontFamily: SERIF, fontSize: 15, lineHeight: 1.35, color: P.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title || e.videoId}</button>
                      <div style={{ fontSize: 12, color: P.faint, marginTop: 3 }}>{[e.author, narrow ? fmtDay(e.lastAt) : '', e.count > 1 ? e.count + ' times' : '', e.vias && e.vias['chrome-extension'] ? 'Chrome' : '', e.live ? '' : 'analysis removed, scores kept'].filter(Boolean).join(' · ')}</div>
                    </div>
                    <div style={{ display: 'grid', justifyItems: 'end', gap: 3, fontSize: 12 }}>
                      {leanMini(e.s.political ? e.s.lean : null)}
                      <div style={{ display: 'flex', gap: 10, color: P.faint }}>
                        <span>Slant {Math.round(e.s.overall)}/10</span>
                        <button className="slant-del" onClick={() => unfeed(e.videoId)} style={{ background: 'none', border: 0, padding: 0, color: P.faint, fontSize: 12, cursor: 'pointer' }}>Remove</button>
                      </div>
                    </div>
                  </div>
                ))}
                <div style={{ borderTop: '1px solid ' + P.line }} />
                {entries.length > 12 && <button onClick={() => setShowAllFeed(!showAllFeed)} style={{ ...linkBtn, marginTop: 10 }}>{showAllFeed ? 'Show fewer' : 'Show all ' + entries.length}</button>}
              </div>
            </section>
        )}

        {library.length > 0 && (
          <section style={sec}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ ...label, flex: 1 }}>Already analyzed in Slant · {library.length} not in your feed</div>
              <button onClick={() => setShowLibrary(!showLibrary)} style={linkBtn}>{showLibrary ? 'Hide' : 'Add videos you’ve watched'}</button>
            </div>
            {showLibrary && (
              <div style={{ marginTop: 8 }}>
                <p style={{ ...para, fontSize: 13 }}>Add the ones you actually watched, so your averages include them.</p>
                {library.map((it) => (
                  <div key={it.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto', gap: 14, padding: '10px 0', borderTop: '1px solid ' + P.line, alignItems: 'center' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: SERIF, fontSize: 15, color: P.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title || it.videoId}</div>
                      <div style={{ fontSize: 12, color: P.faint, marginTop: 2 }}>{it.author}</div>
                    </div>
                    <div style={{ fontSize: 12 }}>{leanTag(it.result.political)}</div>
                    <button onClick={() => recordFeed(it.id, it)} style={{ ...pillBtn(false), height: 30, fontSize: 12, padding: '0 12px' }}>Add</button>
                  </div>
                ))}
                <div style={{ borderTop: '1px solid ' + P.line }} />
              </div>
            )}
          </section>
        )}

        <section style={sec}>
          <div style={label}>History</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
            <span style={{ fontSize: 14, color: P.ink, marginRight: 4 }}>Keep my feed for</span>
            {FEED_KEEP.map((k) => {
              const lose = feedAll.filter((e) => (e.lastAt || 0) < Date.now() - k.days * DAY_MS).length;
              return <button key={k.days} onClick={() => (lose ? setFeedConfirm({ keep: k.days, lose, label: k.label }) : setKeep(k.days))} style={chip(k.days === keepDays)}>{k.label}</button>;
            })}
          </div>
          {feedConfirm && feedConfirm.keep && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 12, fontSize: 13, color: P.soft }}>
              <span>This removes {feedConfirm.lose} {feedConfirm.lose === 1 ? 'video' : 'videos'} older than {feedConfirm.label}.</span>
              <button onClick={() => setKeep(feedConfirm.keep)} style={{ ...pillBtn(true), height: 30, fontSize: 12 }}>Remove and keep {feedConfirm.label}</button>
              <button onClick={() => setFeedConfirm(null)} style={{ ...pillBtn(false), height: 30, fontSize: 12 }}>Cancel</button>
            </div>
          )}
          <div style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
            {feedConfirm && feedConfirm.clear ? (
              <>
                <span style={{ color: P.soft }}>Delete all {feedAll.length} videos from your feed? The analyses themselves stay in Slant.</span>
                <button onClick={clearFeed} style={{ ...pillBtn(false), height: 30, fontSize: 12, color: P.accent, borderColor: P.accent }}>Delete my feed</button>
                <button onClick={() => setFeedConfirm(null)} style={{ ...pillBtn(false), height: 30, fontSize: 12 }}>Cancel</button>
              </>
            ) : feedAll.length > 0 && <button onClick={() => setFeedConfirm({ clear: true })} style={linkBtn}>Clear my feed</button>}
          </div>
        </section>
      </div>
    );
  }


  function renderHow() {
    const narrow = w < 600;
    const h2 = { fontFamily: SERIF, fontWeight: 400, fontSize: narrow ? 22 : 24, lineHeight: 1.25, color: P.ink, margin: '0 0 12px' };
    const para = { fontSize: 15, lineHeight: 1.7, color: P.soft, margin: '0 0 14px' };
    const term = { color: P.ink, fontWeight: 600 };
    const sec = { marginTop: 36, paddingTop: 26, borderTop: '1px solid ' + P.line };
    const stackBands = w < 560;
    const limits = [
      ['Auto-captions', 'YouTube’s automatic captions mishear names and words, and videos without captions are transcribed by AI, which can slip too.'],
      ['Short videos', 'A Short or a brief clip gives little to go on, so its scores rest on a handful of lines.'],
      ['Satire', 'Comedy, irony and impressions can read as slant even when the creator is joking.'],
      ['AI raters can carry their own lean', 'The ratings come from an AI model, which can have leanings and blind spots of its own. Read a score as a sourced opinion, not a verdict.'],
      ['Transcript only', 'Visuals, music, editing and on-screen text aren’t considered.'],
    ];
    return (
      <div>
        <div style={{ padding: '20px 0 22px' }}>
          <button onClick={closeItem} style={{ background: 'none', border: 0, padding: 0, color: P.soft, fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M8.5 3L4.5 7l4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
            All videos
          </button>
        </div>
        <article style={{ maxWidth: 680 }}>
          <div style={label}>Slant</div>
          <h1 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: narrow ? 32 : 42, lineHeight: 1.1, letterSpacing: '-0.01em', margin: '14px 0 14px', color: P.ink }}>How Slant works</h1>
          <p style={{ ...para, fontSize: 17, color: P.ink }}>Slant reads a video’s transcript and rates how it presents its subject: what it includes, how it frames it, and the words it chooses.</p>

          <section style={sec}>
            <h2 style={h2}>What it measures</h2>
            <p style={para}><span style={term}>Political lean</span>, from −6 (left) to +6 (right), the scale of the AllSides Media Bias Meter, on the conventional US axis unless the video is about another country’s politics. Its label follows AllSides’ five bands:</p>
            {!stackBands && <div style={{ height: 4, borderRadius: 2, marginTop: 4, opacity: 0.6, background: 'linear-gradient(90deg,' + P.left + ',' + P.mid + ' 50%,' + P.right + ')' }} />}
            <div style={{ display: 'grid', gridTemplateColumns: stackBands ? '1fr' : LEAN_COLS, marginTop: stackBands ? 0 : 10 }}>
              {LEAN_BANDS.map((b, i) => (
                <div key={b.label} style={stackBands
                  ? { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderBottom: i < LEAN_BANDS.length - 1 ? '1px solid ' + P.line : 0 }
                  : { textAlign: 'center', padding: '2px 4px', borderLeft: i ? '1px solid ' + P.line : 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: leanColor(i, P) }}>{b.label}</div>
                  <div style={{ fontSize: 12, color: P.faint, fontVariantNumeric: 'tabular-nums', marginTop: stackBands ? 0 : 3 }}>{b.range}</div>
                </div>
              ))}
            </div>
            <p style={{ ...para, marginTop: 22 }}><span style={term}>Slant score</span>, from 0 to 10: how far the presentation departs from fair, balanced treatment, in any direction. A Center video can still score high, and a clearly partisan one can score low if it argues fairly.</p>
            <p style={para}><span style={term}>Five signals</span>, each from 0 (absent) to 10:</p>
            <div>
              {DIMS.map((d) => (
                <div key={d.key} style={{ display: 'grid', gridTemplateColumns: stackBands ? '1fr' : '180px minmax(0, 1fr)', gap: stackBands ? 2 : 16, padding: '9px 0', borderTop: '1px solid ' + P.line, fontSize: 14, lineHeight: 1.5 }}>
                  <div style={{ color: P.ink, fontWeight: 500 }}>{d.name}</div>
                  <div style={{ color: P.soft }}>{d.hint}</div>
                </div>
              ))}
            </div>
          </section>

          <section style={sec}>
            <h2 style={h2}>It rates presentation, not truth</h2>
            <p style={para}>Slant judges how a video makes its case, not whether its claims are true. It isn’t a fact-checker: an accurate video can be one-sided, and a calm, balanced one can still be wrong.</p>
          </section>

          <section style={sec}>
            <h2 style={h2}>Scores cite verified quotes</h2>
            <p style={para}>Political lean and any signal that scores 3 or more come with quotes copied word for word from the transcript, each with a timestamp you can tap to hear it in context. Slant checks every quote against the transcript before showing it: quotes it can’t find are left out, and loose matches are marked “approximate match”.</p>
          </section>

          <section style={sec}>
            <h2 style={h2}>Limits</h2>
            {limits.map(([t, d]) => <p key={t} style={para}><span style={term}>{t}.</span> {d}</p>)}
          </section>

          <p style={{ ...para, marginTop: 30, fontSize: 14 }}>Think a rating is off? Use <span style={term}>Disagree?</span> at the bottom of any analysis.</p>
        </article>
      </div>
    );
  }

  function renderDetail() {
    if (!items) return <div style={{ padding: '60px 0', color: P.faint, fontSize: 13 }}>Loading…</div>;
    if (!rec) {
      return (
        <div style={{ padding: '60px 0' }}>
          <div style={{ color: P.soft, fontSize: 14 }}>This analysis no longer exists.</div>
          <button onClick={closeItem} style={{ ...pillBtn(false), marginTop: 14 }}>All videos</button>
        </div>
      );
    }
    const wide = w >= 900;
    const short = isShort(rec.url);
    const tHeight = !wide ? 420 : short
      ? 'max(220px, calc(100vh - var(--mana-top-inset, 72px) - ' + shortH(true) + ' - 110px))'
      : 'max(260px, calc(100vh - var(--mana-top-inset, 72px) - 330px))';
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '20px 0 22px', flexWrap: 'wrap' }}>
          <button onClick={closeItem} style={{ background: 'none', border: 0, padding: 0, color: P.soft, fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M8.5 3L4.5 7l4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
            All videos
          </button>
          {wide && renderInput(false)}
        </div>
        {wide && job && !job.reId && <div style={{ marginTop: -8, marginBottom: 18 }}>{renderJob()}</div>}
        <div style={{ marginBottom: 30 }}>
          <div style={{ fontFamily: SERIF, fontSize: w < 600 ? 22 : 28, lineHeight: 1.25, color: P.ink }}>{rec.title || rec.videoId}</div>
          <div style={{ fontSize: 13, color: P.faint, marginTop: 6 }}>{[rec.author, rec.duration ? fmtT(rec.duration) : ''].filter(Boolean).join(' · ')}</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: wide ? 'minmax(0,1fr) minmax(320px,400px)' : 'minmax(0,1fr)', gap: wide ? 56 : 32 }}>
          {!wide && renderPlayer(rec.videoId, short, false)}
          {renderAnalysis()}
          <aside style={wide ? { position: 'sticky', top: 'calc(var(--mana-top-inset, 72px) + 12px)', alignSelf: 'start' } : {}}>
            {wide && renderPlayer(rec.videoId, short, true)}
            <div style={{ ...label, margin: wide ? '20px 0 10px' : '0 0 10px', display: 'flex', justifyContent: 'space-between' }}>
              <span>Transcript</span><span style={{ textTransform: 'none', letterSpacing: 0 }}>{located.marked.size ? located.marked.size + ' cited lines highlighted' : ''}</span>
            </div>
            <TranscriptPanel snips={snips} paras={paras} marked={located.marked} activeSeg={active ? active.seg : null}
              onSeek={(i) => seekTo(i, 't' + i)} P={P} height={tHeight} />
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="w-full" style={{ color: P.ink, paddingBottom: 'calc(var(--mana-bottom-inset, 80px) + 24px)' }}>
      <style>{'@keyframes slantspin{to{transform:rotate(360deg)}}.slant-spin{display:inline-block;animation:slantspin .8s linear infinite}' +
        '.slant-row .slant-del{opacity:0;transition:opacity .15s}.slant-row:hover .slant-del,.slant-row:focus-within .slant-del{opacity:1}' +
        '.slant-row:hover img{opacity:.9}@media (prefers-reduced-motion: reduce){.slant-spin{animation-duration:2.4s}}'}</style>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '0 ' + (w < 600 ? 16 : 28) + 'px' }}>
        {sel === 'how' ? renderHow() : sel === 'feed' ? renderFeed() : sel ? renderDetail() : renderHome()}
        {(ingress.error || oa.error) && !sel && canWrite !== false && (
          <div style={{ marginTop: 24, fontSize: 12, color: P.faint }}>
            {oa.error ? 'Analysis unavailable: ' + oa.error.message : 'Caption service offline; Slant will transcribe the audio instead.'}
          </div>
        )}
      </div>
    </div>
  );
}