
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
  '- Political lean uses the AllSides Media Bias Meter scale, from -6 to +6 (one decimal allowed): -6 strongly left/progressive, 0 centrist or balanced, +6 strongly right/conservative. Bands: -6 to -3 Left (strong alignment with left-wing thought or agendas), -2.99 to -1 Lean Left (moderate alignment), -0.99 to +0.99 Center (no clear or consistent tilt, or balanced), +1 to +2.99 Lean Right (moderate alignment), +3 to +6 Right (strong alignment). Reserve the far ends (beyond +/-5) for pervasive, explicit advocacy. Use the conventional US left-right axis unless the content concerns another country\'s politics; then map to that country\'s axis and name it in the label. If the video has no meaningful political or social-issue content, set applicable=false, score=0, label "Not political", and return no quotes.',
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
    political: { type: 'object', additionalProperties: false, required: ['applicable', 'score', 'label', 'explanation', 'quotes'],
      properties: { applicable: { type: 'boolean' }, score: { type: 'number' }, label: { type: 'string' },
        explanation: { type: 'string' }, quotes: QUOTES } },
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


// geminiTranscript and runAnalysis are no longer called by the page; they remain the source the backend's prompt and
// request format are extracted from (slant-extension/spec/extract_spec.js). New analyses run on the slant-ext backend.
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
    card: 'rgba(255,255,255,0.045)', cardLine: 'rgba(255,255,255,0.12)', text: 'rgba(244,244,245,0.86)', cite: 'rgba(250,204,21,0.20)', citeOn: 'rgba(250,204,21,0.42)',
    meter: '#E07A55', meterOff: 'rgba(255,255,255,0.12)', barMid: '#A07BE0', leftBg: 'rgba(127,166,224,0.16)', rightBg: 'rgba(229,138,126,0.16)', open: 'rgba(255,255,255,0.03)',
  } : {
    ink: '#18181B', soft: 'rgba(24,24,27,0.66)', faint: 'rgba(24,24,27,0.42)', line: 'rgba(24,24,27,0.10)',
    surface: 'rgba(24,24,27,0.025)', field: '#FFFFFF', accent: '#E8654A', onAccent: '#FFFFFF',
    left: '#3E6DB5', right: '#C2473B', mid: 'rgba(24,24,27,0.22)', hl: 'rgba(232,101,74,0.18)', hlSoft: 'rgba(24,24,27,0.055)',
    card: '#FFFFFF', cardLine: '#E4E4E7', text: '#27272A', cite: '#FDF1B8', citeOn: '#F9D86B',
    meter: '#B5492A', meterOff: '#E4E4E7', barMid: '#8B3FD9', leftBg: '#E3ECFD', rightBg: '#FBE4E1', open: '#FAFAFA',
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
    <div style={{ background: P.open, border: '1px solid ' + (active ? P.accent : P.cardLine), borderRadius: 14, padding: '16px 18px', marginTop: 12, transition: 'border-color .25s' }}>
      <div style={{ fontSize: 18, lineHeight: 1.55, color: P.ink }}>“{q.quote}”</div>
      {q.why && <div style={{ fontSize: 16, lineHeight: 1.55, color: P.soft, marginTop: 8 }}>{q.why}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
        {t != null && (
          <button onClick={onPlay} style={{ minHeight: 44, padding: '0 18px', borderRadius: 999, border: '1.5px solid ' + (active ? P.accent : P.ink),
            background: 'transparent', color: active ? P.accent : P.ink, fontSize: 16, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 8,
            cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}>
            <svg width="12" height="13" viewBox="0 0 8 9" aria-hidden="true"><path d="M0 0l8 4.5L0 9z" fill="currentColor" /></svg>Play at {fmtT(t)}
          </button>
        )}
        {loc.status === 'partial' && <span style={{ fontSize: 15, color: P.faint }} title="Matched loosely; the wording may differ slightly">Wording may differ slightly</span>}
      </div>
    </div>
  );
}

function TranscriptPanel({ snips, paras, marked, activeSeg, onSeek, P, height }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (activeSeg == null || !ref.current) return;
    const el = ref.current.querySelector('[data-seg="' + activeSeg + '"]');
    if (el) ref.current.scrollTo({ top: Math.max(0, el.offsetTop - 80), behavior: 'smooth' });
  }, [activeSeg]);
  if (!snips) return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: P.faint, fontSize: 17 }}>Loading transcript…</div>;
  return (
    <div ref={ref} style={{ position: 'relative', height, overflowY: 'auto', padding: '14px 20px 18px', fontSize: 17, lineHeight: 1.7, color: P.soft }}>
      {paras.map((p) => (
        <div key={p.start} style={{ display: 'grid', gridTemplateColumns: '58px minmax(0,1fr)', gap: 10, marginBottom: 14 }}>
          <button onClick={() => onSeek(p.start)} title="Play from here" style={{ textAlign: 'left', fontSize: 16, fontWeight: 600, color: P.left, background: 'none', border: 0, padding: '3px 0 0',
            cursor: 'pointer', fontVariantNumeric: 'tabular-nums', alignSelf: 'start', textDecoration: 'underline', textUnderlineOffset: 3 }}>{fmtT(snips[p.start].t)}</button>
          <div>
            {p.idx.map((i) => (
              <span key={i} data-seg={i} style={{ background: i === activeSeg ? P.citeOn : marked.has(i) ? P.cite : 'transparent',
                color: i === activeSeg || marked.has(i) ? P.ink : undefined, borderRadius: 4, transition: 'background .3s',
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
  // New analyses run on Slant's backend (sandbox service slant-ext), the same pipeline as Slant for Chrome. The page holds
  // no AI access: the backend checks the signed-in person is the owner or an Editor before spending credits.
  const svc = useIngressUrl('slant-ext');
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
  // Feed drag preview (Jaeyeon Lee, approved from preview 2026-10-25): dragging the lean bar or a signal bar shows its
  // effect on the bear live; releasing restores the saved averages. Component state only, never written to Firebase.
  const [peek, setPeek] = React.useState(null);   // { key: 'lean' | DIMS key, v: number } while dragging
  const endPeek = React.useCallback(() => setPeek(null), []);
  const peeking = !!peek;
  React.useEffect(() => {
    if (!peeking) return undefined;
    const evs = ['pointerup', 'pointercancel', 'mouseup', 'touchend', 'touchcancel', 'blur'];
    evs.forEach((t) => window.addEventListener(t, endPeek));
    return () => evs.forEach((t) => window.removeEventListener(t, endPeek));
  }, [peeking, endPeek]);
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
  const [leanQOpen, setLeanQOpen] = React.useState(false);
  const [openDim, setOpenDim] = React.useState(null);
  React.useEffect(() => {
    setLeanQOpen(false); setOpenDim(null);
    setActive(null); setPlay({ start: 0, nonce: 0, auto: false });
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

  const isOwner = !!userId && userId === ownerId;

  const playerRef = React.useRef(null);
  const seekTo = (seg, key) => {
    if (!snips || !snips[seg]) return;
    setActive({ seg, key });
    setPlay((p) => ({ start: Math.floor(snips[seg].t), nonce: p.nonce + 1, auto: true }));
    if (w < 760 && playerRef.current) playerRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  async function callSvc(method, path, body) {
    const user = FS.auth.currentUser;
    if (!svc.url || !user) throw new Error(svc.error ? 'Analysis unavailable: ' + svc.error.message : 'Still connecting. Try again in a moment.');
    const tok = await user.getIdToken();
    const r = await fetch(svc.url + path, { method, body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: 'Bearer ' + tok, 'X-Slant-Id-Token': tok, 'Content-Type': 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((j.error && j.error.message) || ('Request failed (' + r.status + ')')); e.status = r.status; e.code = j.error && j.error.code; throw e; }
    return j;
  }
  const PHASE_OF = { queued: 'captions', checking: 'captions', captions: 'captions', transcribing: 'transcribing', analyzing: 'analyzing', saving: 'analyzing' };
  // Start a backend job and follow it until it finishes; returns the saved analysis id.
  async function runJob(body, onStage) {
    const idem = 'web-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    let j = (await callSvc('POST', '/v1/me/analyze', { ...body, idempotencyKey: idem })).job;
    const t0 = Date.now(); let misses = 0;
    while (j.state !== 'done' && j.state !== 'failed') {
      onStage(j.stage);
      if (Date.now() - t0 > 15 * 60000) throw new Error('This analysis is taking unusually long. Check back in a few minutes; it will appear here when it’s saved.');
      await new Promise((res) => setTimeout(res, 1500));
      try { j = (await callSvc('GET', '/v1/me/jobs/' + j.id)).job; misses = 0; }
      catch (e) { if ((e.status && e.status < 500 && e.status !== 429) || ++misses > 8) throw e; }
    }
    if (j.state === 'failed') throw new Error((j.error && j.error.message) || 'The analysis failed. Nothing was saved.');
    return j.result && j.result.recordId;
  }
  const isViewOnlyErr = (e) => e && (e.code === 'view_only' || e.code === 'sign_in_required' || e.status === 403);

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
    setJob({ phase: 'captions', started: Date.now(), vid });
    try {
      const rid = await runJob({ url: raw.trim(), mode: 'auto' }, (st) => setJob((j) => (j && j.vid === vid && !j.reId
        ? { ...j, phase: PHASE_OF[st] || j.phase, note: st === 'transcribing' ? 'no captions' : j.note } : j)));
      setJob(null); setInput('');
      if (rid) openItem(rid);   // the backend saved it and added it to your feed
    } catch (e) {
      if (isViewOnlyErr(e)) { setCanWrite(false); setJob({ phase: 'viewonly', vid }); return; }
      setJob((j) => ({ ...(j || {}), phase: 'error', error: (e && e.message) || String(e) }));
    }
  }

  async function reanalyze(id) {
    const r0 = items && items[id];
    if (!r0 || canWrite === false) return;
    setJob({ phase: 'analyzing', started: Date.now(), vid: r0.videoId, reId: id });
    try {
      await runJob({ url: r0.url || 'https://www.youtube.com/watch?v=' + r0.videoId, mode: 'fresh', recordId: id }, () => {});
      setJob(null); setActive(null);
    } catch (e) {
      if (isViewOnlyErr(e)) { setCanWrite(false); setJob(null); return; }
      setJob((j) => ({ ...(j || {}), phase: 'error', error: (e && e.message) || String(e) }));
    }
  }

  async function remove(id) {
    await FS.update(FS.ref(FS.db, base), { ['analyses/' + id]: null, ['transcripts/' + id]: null });
    setConfirmDel(null);
    if (sel === id) closeItem();
  }

  const list = items ? Object.keys(items).filter((k) => k !== 'metadata' && items[k] && items[k].videoId)
    .map((k) => ({ id: k, ...items[k] })).sort((a, b) => ((b.metadata && b.metadata.createdAt) || 0) - ((a.metadata && a.metadata.createdAt) || 0)) : [];
  const elapsed = job && job.started ? Math.max(0, Math.round((Date.now() - job.started) / 1000)) : 0;
  void tick;

  const label = { fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: P.faint, fontWeight: 500 };
  const pillBtn = (primary) => ({ height: 38, padding: '0 16px', borderRadius: 999, fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
    border: primary ? '1px solid ' + P.accent : '1px solid ' + P.line, background: primary ? P.accent : 'transparent', color: primary ? P.onAccent : P.ink });

  // Visitors (no edit access) never see the list of all analyses or the search bar; they get their own feed instead.
  const visitor = canWrite === false;
  function feedButton() {
    return (
      <button onClick={() => openItem('feed')} style={{ display: 'inline-flex', alignItems: 'center', gap: 10, height: 46, padding: '0 20px', borderRadius: 999,
        border: '1px solid ' + P.ink, background: 'transparent', color: P.ink, fontSize: 16, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
        <svg width="34" height="14" viewBox="0 0 34 14" aria-hidden="true">
          <line x1="1" y1="12" x2="33" y2="12" stroke={P.line} strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="7" cy="8" r="2.4" fill={P.left} /><circle cx="12" cy="8" r="2.4" fill={P.left} /><circle cx="12" cy="3" r="2.4" fill={P.left} />
          <circle cx="17" cy="8" r="2.4" fill={P.mid} /><circle cx="25" cy="8" r="2.4" fill={P.right} />
        </svg>
        Your feed<span aria-hidden="true">→</span>
      </button>
    );
  }

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
          {narrow && (
            <div style={{ fontSize: 12, color: P.faint, marginTop: 5 }}>
              {leanTag(r.political)}
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
      <div ref={playerRef} style={{ ...box, borderRadius: wide ? 0 : 12, overflow: 'hidden', background: '#000' }}>
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
    const pillBg = band < 0 ? P.hlSoft : band <= 1 ? P.leftBg : band >= 3 ? P.rightBg : P.hlSoft;
    const pos = ((s + LEAN_MAX) / (2 * LEAN_MAX)) * 100;
    const dims = asArr(r.dimensions);
    const byKey = {}; dims.forEach((d) => { byKey[d.key] = d; });
    const sigs = DIMS.map((dm) => ({ ...dm, d: byKey[dm.key] || { score: 0, explanation: '', quotes: [] } }))
      .sort((x, y) => (Number(y.d.score) || 0) - (Number(x.d.score) || 0));
    const reRunning = job && job.reId === sel && job.phase !== 'error';
    const polQuotes = renderQuotes(pol.quotes, 'p');
    const nPolQuotes = Array.isArray(polQuotes) ? polQuotes.filter(Boolean).length : 0;
    const narrowCard = w < 520;
    const pad = narrowCard ? '18px 18px' : '22px 24px';
    const card = { background: P.card, border: '1px solid ' + P.cardLine, borderRadius: 18, overflow: 'hidden' };
    const big = { fontSize: 15, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: P.soft };
    const sub = { fontSize: 16, color: P.faint, marginTop: 4, lineHeight: 1.45 };
    const chev = (open) => (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" style={{ flex: 'none', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>
        <path d="M6 9l6 6 6-6" fill="none" stroke={P.soft} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
    const listStyle = { margin: '10px 0 0', paddingLeft: 22, fontSize: 18, lineHeight: 1.6, color: P.text };
    const smallBtn = { ...pillBtn(false), height: 46, padding: '0 20px', fontSize: 16, fontWeight: 600, display: 'inline-flex', alignItems: 'center', textDecoration: 'none' };
    return (
      <div style={{ minWidth: 0, display: 'grid', gap: 24, alignContent: 'start' }}>
        <section style={card} aria-label="Political lean">
          <div style={{ padding: pad + ' 10px' }}>
            <div style={big}>Political lean</div>
            <div style={sub}>A direction, not a grade: neither good nor bad.</div>
            {polOk ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', marginTop: 14 }}>
                <span title={'On a scale from −6 (left) to +6 (right)'} style={{ fontFamily: SERIF, fontSize: narrowCard ? 54 : 64, lineHeight: 1, color: P.ink, fontVariantNumeric: 'tabular-nums' }}>{fmtLean(s)}</span>
                <span style={{ fontSize: 22, fontWeight: 700, color: lc, background: pillBg, padding: '8px 22px', borderRadius: 999, whiteSpace: 'nowrap' }}>{LEAN_BANDS[band].label}</span>
              </div>
            ) : (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontFamily: SERIF, fontSize: 36, lineHeight: 1.1, color: P.ink }}>Not political</div>
                <div style={{ fontSize: 18, color: P.soft, marginTop: 8 }}>No political or social-issue content was found.</div>
              </div>
            )}
            <div style={{ position: 'relative', height: 40, marginTop: 22 }} aria-hidden="true">
              <div style={{ position: 'absolute', left: 0, right: 0, top: 13, height: 14, borderRadius: 99,
                background: polOk ? 'linear-gradient(90deg,' + P.left + ',' + P.barMid + ' 50%,' + P.right + ')' : P.meterOff }} />
              {Array.from({ length: 2 * LEAN_MAX - 1 }).map((_, k) => {
                const v = k + 1 - LEAN_MAX;
                return <div key={v} style={{ position: 'absolute', left: ((k + 1) * 100 / (2 * LEAN_MAX)) + '%', top: v === 0 ? 8 : 13, height: v === 0 ? 24 : 14,
                  width: v === 0 ? 4 : 3, transform: 'translateX(-50%)', borderRadius: 2, background: v === 0 ? P.ink : (P.card === '#FFFFFF' ? '#FFFFFF' : '#18181B') }} />;
              })}
              {polOk && (
                <div style={{ position: 'absolute', left: pos + '%', top: 0, transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ width: 3, height: 6, background: P.ink }} />
                  <div style={{ width: 26, height: 26, borderRadius: 99, background: P.card === '#FFFFFF' ? '#FFFFFF' : '#18181B', border: '3px solid ' + P.ink, boxSizing: 'border-box' }} />
                  <div style={{ width: 3, height: 6, background: P.ink }} />
                </div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 20, fontWeight: 600, color: P.ink, marginTop: 6 }}>
              <span>Left <span style={{ fontWeight: 500, color: P.soft }}>(−6)</span></span>
              <span>Center <span style={{ fontWeight: 500, color: P.soft }}>(0)</span></span>
              <span>Right <span style={{ fontWeight: 500, color: P.soft }}>(+6)</span></span>
            </div>
          </div>
          {polOk && pol.explanation && (
            <div style={{ borderTop: '1px solid ' + P.cardLine, padding: pad }}>
              <div style={big}>Why this lean</div>
              <p style={{ fontSize: 19, lineHeight: 1.6, color: P.text, margin: '10px 0 0' }}>{pol.explanation}</p>
            </div>
          )}
          {polOk && nPolQuotes > 0 && (
            <div style={{ borderTop: '1px solid ' + P.cardLine }}>
              <button onClick={() => setLeanQOpen((v) => !v)} aria-expanded={leanQOpen}
                style={{ width: '100%', minHeight: 60, padding: '0 ' + (narrowCard ? 18 : 24) + 'px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: 'none', border: 0, cursor: 'pointer', fontSize: 20, fontWeight: 600, color: P.ink }}>
                {leanQOpen ? 'Hide quotes' : 'Show ' + nPolQuotes + (nPolQuotes === 1 ? ' quote' : ' quotes')}{chev(leanQOpen)}
              </button>
              {leanQOpen && <div style={{ padding: '0 ' + (narrowCard ? 18 : 24) + 'px 22px' }}>{polQuotes}</div>}
            </div>
          )}
        </section>

        <section style={card} aria-label="The 5 signals behind the score">
          <div style={{ padding: pad }}>
            <div style={big}>The 5 signals behind the score</div>
            <div style={sub}>Tap a row to see why · 0 means none, 10 means a lot</div>
          </div>
          {sigs.map((sg) => {
            const sc = Math.round(clamp(sg.d.score, 0, 10));
            const open = openDim === sg.key;
            return (
              <div key={sg.key} style={{ borderTop: '1px solid ' + P.cardLine }}>
                <button onClick={() => setOpenDim(open ? null : sg.key)} aria-expanded={open}
                  style={{ width: '100%', minHeight: 72, padding: '12px ' + (narrowCard ? 18 : 24) + 'px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: narrowCard ? 'wrap' : 'nowrap',
                    background: open ? P.open : 'none', border: 0, cursor: 'pointer', textAlign: 'left', color: P.ink }}>
                  <span style={{ flex: '1 1 150px', fontSize: 20, fontWeight: 600 }}>{sg.name}</span>
                  <span style={{ display: 'flex', gap: 3 }} aria-label={sc + ' out of 10'}>
                    {Array.from({ length: 10 }).map((_, i) => <span key={i} style={{ width: narrowCard ? 14 : 16, height: 24, borderRadius: 4, background: i < sc ? P.meter : P.meterOff }} />)}
                  </span>
                  <span style={{ width: 30, textAlign: 'right', fontSize: 26, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{sc}</span>
                  {chev(open)}
                </button>
                {open && (
                  <div style={{ padding: '4px ' + (narrowCard ? 18 : 24) + 'px 22px', background: P.open }}>
                    <div style={{ fontSize: 16, color: P.faint }}>{sg.hint}</div>
                    {sg.d.explanation && <p style={{ fontSize: 19, lineHeight: 1.6, color: P.text, margin: '10px 0 0' }}>{sg.d.explanation}</p>}
                    {renderQuotes(sg.d.quotes, sg.key)}
                  </div>
                )}
              </div>
            );
          })}
        </section>

        {(asArr(r.balance).length > 0 || asArr(r.caveats).length > 0) && (
          <section style={{ ...card, padding: pad, display: 'grid', gridTemplateColumns: w < 700 ? '1fr' : '1fr 1fr', gap: 24 }}>
            {asArr(r.balance).length > 0 && (
              <div>
                <div style={big}>Done fairly</div>
                <ul style={listStyle}>{asArr(r.balance).map((x, i) => <li key={i} style={{ marginBottom: 8 }}>{x}</li>)}</ul>
              </div>
            )}
            {asArr(r.caveats).length > 0 && (
              <div>
                <div style={big}>Things to keep in mind</div>
                <ul style={listStyle}>{asArr(r.caveats).map((x, i) => <li key={i} style={{ marginBottom: 8 }}>{x}</li>)}</ul>
              </div>
            )}
          </section>
        )}

        <div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <a href={'https://www.youtube.com/watch?v=' + rec.videoId} target="_blank" rel="noreferrer" style={smallBtn}>Open on YouTube</a>
            {feedAddr && (inFeed(rec.videoId) ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, fontSize: 16, color: P.soft }}>
                <button onClick={() => openItem('feed')} style={{ ...smallBtn }}>In your feed</button>
                <button onClick={() => unfeed(rec.videoId)} style={{ background: 'none', border: 0, padding: '10px 4px', color: P.soft, fontSize: 16, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }}>Remove from feed</button>
              </span>
            ) : (
              <button onClick={() => recordFeed(sel, rec)} style={smallBtn}>Add to my feed</button>
            ))}
            {canWrite === true && (
              <button onClick={() => reanalyze(sel)} disabled={!snips || !!running} style={{ ...smallBtn, opacity: !snips || running ? 0.5 : 1 }}>{reRunning ? 'Re-analyzing…' : 'Re-analyze'}</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 14, fontSize: 15, color: P.faint }}>
            <span>{[SRC_LABEL[rec.source] || rec.source, rec.segments ? rec.segments + ' lines' : '', rec.truncated ? 'transcript truncated' : '', [r.contentType, r.topic].filter(Boolean).join(' · ')].filter(Boolean).join(' · ')}</span>
            <button onClick={() => openItem('how')} style={{ background: 'none', border: 0, padding: 0, color: P.soft, fontSize: 15, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }}>How Slant works</button>
          </div>
          {job && job.reId === sel && renderJob()}
        </div>
      </div>
    );
  }

  function renderFeed() {
    // "Your history" (feed) page, redesigned 2026-10-24 for elderly readers to match the report page: large text, cards,
    // bear card + political lean card + 5-signal card, card list of videos. Same data and arithmetic as before.
    const narrow = w < 600;
    const two = w >= 760;
    const inv = P.card === '#FFFFFF' ? '#FFFFFF' : '#18181B';
    const padX = narrow ? 18 : 22;
    const card = { background: P.card, border: '1px solid ' + P.cardLine, borderRadius: 16 };
    const cap = { fontSize: 14, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: P.soft };
    const para = { fontSize: 17, lineHeight: 1.6, color: P.soft, margin: 0 };
    const sec = { marginTop: 40, maxWidth: 960 };
    const textBtn = { background: 'none', border: 0, padding: '10px 0', font: 'inherit', fontSize: 16, fontWeight: 600, color: P.ink, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 4, textDecorationColor: P.mid };
    const chip = (on) => ({ minHeight: 44, padding: '0 18px', borderRadius: 999, fontSize: 16, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 8,
      border: '1.5px solid ' + (on ? P.ink : P.cardLine), background: on ? P.ink : P.card, color: on ? inv : P.ink });
    const smallBtn = (primary) => ({ ...chip(primary), minHeight: 40, fontSize: 15, padding: '0 16px' });
    const pillBg = (b) => (b < 0 ? P.hlSoft : b <= 1 ? P.leftBg : b >= 3 ? P.rightBg : P.hlSoft);
    const bandPill = (v, big) => {
      if (v == null) return <span style={{ fontSize: big ? 20 : 14, fontWeight: 600, color: P.faint, background: P.hlSoft, padding: big ? '7px 20px' : '4px 12px', borderRadius: 999, whiteSpace: 'nowrap' }}>Not political</span>;
      const b = leanBand(r1(v));
      return <span style={{ fontSize: big ? 20 : 14, fontWeight: 700, color: leanColor(b, P), background: pillBg(b), padding: big ? '7px 20px' : '4px 12px', borderRadius: 999, whiteSpace: 'nowrap' }}>{LEAN_BANDS[b].label}</span>;
    };
    const meter = (v) => (
      <div style={{ display: 'flex', gap: 3, flex: 'none' }} aria-hidden="true">
        {Array.from({ length: 10 }).map((_, i) => <div key={i} style={{ width: 14, height: 14, borderRadius: 3, background: v != null && i < Math.round(v) ? P.meter : P.meterOff }} />)}
      </div>
    );
    const back = visitor ? <div style={{ padding: '18px 0 0' }} /> : (
      <div style={{ padding: '18px 0 20px' }}>
        <button onClick={closeItem} style={{ background: 'none', border: 0, padding: '6px 0', color: P.soft, fontSize: 16, fontWeight: 500, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <svg width="18" height="18" viewBox="0 0 14 14" aria-hidden="true"><path d="M8.5 3L4.5 7l4 4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          All videos
        </button>
      </div>
    );
    if (!feedAddr) return <div>{back}<p style={para}>Sign in to Mana to keep a feed.</p></div>;
    if (!feed) return <div>{back}<div style={{ color: P.faint, fontSize: 17 }}>Loading your feed…</div></div>;
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
    // Lean: political videos only (others have no lean score). Signals: every video that has the score.
    const avgOf = (vals) => ({ v: vals.length ? mean(vals) : null, n: vals.length });
    const polVals = entries.filter((e) => e.s.political && typeof e.s.lean === 'number').map((e) => clamp(e.s.lean, -LEAN_MAX, LEAN_MAX));
    const avgLean = avgOf(polVals);
    const avgDim = {};
    DIMS.forEach((d) => { avgDim[d.key] = avgOf(entries.filter((e) => e.s.dims && typeof e.s.dims[d.key] === 'number').map((e) => clamp(e.s.dims[d.key], 0, 10))); });
    const political = avgLean.n > 0;
    // The extension's mapping (scoresFromResult): non-political means L = 0; missing signals count as 0.
    const bearV = { L: political ? avgLean.v : 0, S: avgDim.sensationalism.v || 0, K: avgDim.loaded_language.v || 0,
      P: avgDim.ad_hominem.v || 0, U: avgDim.unsupported_claims.v || 0, O: avgDim.one_sided.v || 0 };
    const leanR = political ? r1(avgLean.v) : 0;
    const leanB = political ? leanBand(leanR) : -1;
    const leanLbl = political ? SLANT_BEAR.bearLeanLabel(avgLean.v) : 'Not political';
    const leanInk = political ? leanColor(leanB, P) : P.soft;
    // Drag preview: shown values follow the dragged bar; the saved averages above stay untouched.
    const PEEK_BEAR = { lean: 'L', one_sided: 'O', loaded_language: 'K', sensationalism: 'S', unsupported_claims: 'U', ad_hominem: 'P' };
    const leanPeek = peek && peek.key === 'lean';
    const leanShown = leanPeek ? r1(peek.v) : leanR;
    const leanOn = political || leanPeek;
    const shownV = peek ? { ...bearV, [PEEK_BEAR[peek.key]]: peek.v } : bearV;
    const pos = ((leanShown + LEAN_MAX) / (2 * LEAN_MAX)) * 100;
    const origPos = ((leanR + LEAN_MAX) / (2 * LEAN_MAX)) * 100;
    const dragInput = (key, min, max, val, name) => (
      <input type="range" min={min} max={max} step="0.1" value={peek && peek.key === key ? peek.v : val}
        aria-label={name + ', ' + val + '. Drag to preview the bear; it returns to the saved value when you let go.'}
        onChange={(e) => setPeek({ key, v: Number(e.target.value) })}
        onPointerUp={endPeek} onPointerCancel={endPeek} onMouseUp={endPeek} onTouchEnd={endPeek} onKeyUp={endPeek} onBlur={endPeek}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0, opacity: 0, cursor: 'ew-resize', touchAction: 'pan-y' }} />
    );
    const nVid = (n, adj) => n + ' ' + (adj ? adj + ' ' : '') + (n === 1 ? 'video' : 'videos');
    const bearLabel = 'Bias bear for the average of ' + nVid(entries.length) + ': ' + leanLbl + (political ? ' ' + fmtLean(leanR) : '');

    return (
      <div>
        {back}
        <div style={{ maxWidth: 760 }}>
          <div style={cap}>Your feed</div>
          <h1 style={{ fontSize: narrow ? 32 : 40, lineHeight: 1.15, fontWeight: 700, letterSpacing: '-0.01em', margin: '10px 0 12px', color: P.ink }}>Your history</h1>
          <p style={{ ...para, maxWidth: 640 }}>The average of Slant’s scores for the videos in your feed, drawn on the bias bear from Slant for Chrome. Every video you analyze in Slant or with Slant for Chrome stays here for {keepLabel}, private to your Mana account.</p>
          <div role="radiogroup" aria-label="Period" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 20 }}>
            {wins.map((x) => {
              const on = x.days === win.days;
              const c = feedAll.filter((e) => (e.lastAt || 0) >= Date.now() - x.days * DAY_MS).length;
              return <button key={x.days} role="radio" aria-checked={on} onClick={() => setFeedWin(x.days)} style={chip(on)}>{x.label}<span style={{ opacity: on ? 0.75 : 0.5, fontVariantNumeric: 'tabular-nums' }}>{c}</span></button>;
            })}
          </div>
        </div>

        <section style={{ marginTop: 28, maxWidth: 960, display: 'grid', gridTemplateColumns: two ? 'minmax(220px,280px) minmax(0,1fr)' : 'minmax(0,1fr)', gap: 16, alignItems: 'stretch' }}>
          <figure style={{ ...card, margin: 0, padding: '28px 20px 22px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <BearCanvas v={entries.length ? shownV : { L: 0, S: 0, K: 0, P: 0, U: 0, O: 0 }} scale={narrow ? 3.2 : 3.6} label={!entries.length ? 'Neutral bias bear: no videos in this period' : peek ? 'Bias bear preview while dragging' : bearLabel} />
            </div>
            <figcaption style={{ alignSelf: 'stretch', borderTop: '1px solid ' + P.cardLine, paddingTop: 18, textAlign: 'center' }}>
              {entries.length ? (
                <>
                  <div style={{ fontSize: 22, fontWeight: 700, color: leanInk, fontVariantNumeric: 'tabular-nums' }}>{political ? leanLbl + ' · ' + fmtLean(leanR) : leanLbl}</div>
                  <div aria-live="polite" style={{ fontSize: 15, color: peek ? P.ink : P.faint, fontWeight: peek ? 600 : 400, marginTop: 6 }}>{peek ? 'Preview · let go to return' : 'Average of ' + (political ? nVid(avgLean.n, 'political') : nVid(entries.length))}</div>
                </>
              ) : <div style={{ fontSize: 17, color: P.soft }}>No videos in this period</div>}
            </figcaption>
          </figure>

          <div style={{ minWidth: 0, display: 'grid', gap: 16, alignContent: 'start' }}>
            {entries.length === 0 ? (
              <div style={{ ...card, padding: padX }}><p style={para}>{feedAll.length ? 'No videos in this period. Choose a longer period above.' : (visitor ? 'Your feed is empty. Analyze a video with Slant for Chrome and it will show up here.' : 'Your feed is empty. Paste a YouTube link on the home page, or add videos that are already analyzed below.')}</p></div>
            ) : (
              <>
                <section style={{ ...card, padding: '18px ' + padX + 'px 16px' }} aria-label="Political lean">
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px 14px', flexWrap: 'wrap' }}>
                    <span style={cap}>Political lean</span>
                    <span style={{ fontSize: 15, color: P.faint }}>{political ? 'Mean of ' + nVid(avgLean.n, 'political') + ' · direction, not a grade' : 'No political videos in this period'}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px 16px', flexWrap: 'wrap', marginTop: 14 }}>
                    <span title={LEAN_SCALE_NOTE} style={{ fontSize: narrow ? 48 : 56, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', color: P.ink }}>{leanOn ? fmtLean(leanShown) : '—'}</span>
                    {leanOn && bandPill(leanShown, true)}
                    <span style={{ marginLeft: 'auto', fontSize: 15, color: P.faint }}>Bear: body color</span>
                  </div>
                  <div className="slant-drag" style={{ position: 'relative', height: 36, marginTop: 18 }}>
                    <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, top: 11, height: 14, borderRadius: 99,
                      background: leanOn ? 'linear-gradient(90deg,' + P.left + ',' + P.barMid + ' 50%,' + P.right + ')' : P.meterOff }} />
                    {leanPeek && political && <div aria-hidden="true" style={{ position: 'absolute', left: origPos + '%', top: 2, width: 2, height: 32, transform: 'translateX(-1px)', background: P.ink, opacity: 0.45 }} />}
                    {leanOn && (
                      <div aria-hidden="true" style={{ position: 'absolute', left: pos + '%', top: 0, transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', pointerEvents: 'none' }}>
                        <div style={{ width: 3, height: 6, background: P.ink }} />
                        <div style={{ width: 24, height: 24, borderRadius: 99, background: inv, border: '3px solid ' + P.ink, boxSizing: 'border-box' }} />
                        <div style={{ width: 3, height: 6, background: P.ink }} />
                      </div>
                    )}
                    {dragInput('lean', -LEAN_MAX, LEAN_MAX, leanR, 'Political lean')}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 17, fontWeight: 600, color: P.ink, marginTop: 6 }}>
                    <span>Left</span><span>Center</span><span>Right</span>
                  </div>
                </section>

                <section style={{ ...card, overflow: 'hidden' }} aria-label="The 5 signals">
                  <div style={{ ...cap, padding: '16px ' + padX + 'px 12px' }}>The 5 signals · average of {nVid(entries.length)}</div>
                  {DIMS.map((d) => {
                    const saved = avgDim[d.key].v == null ? null : r1(avgDim[d.key].v);
                    const v = peek && peek.key === d.key ? r1(peek.v) : saved;
                    return (
                      <div key={d.key} title={d.hint} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 10, padding: '13px ' + padX + 'px', borderTop: '1px solid ' + P.cardLine }}>
                        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                          <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.3, color: P.ink }}>{d.name}</div>
                          <div style={{ fontSize: 14, lineHeight: 1.3, color: P.faint, marginTop: 2 }}>Bear: {BEAR_PART[d.key].toLowerCase()}</div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginLeft: 'auto', flex: 'none' }}>
                          <div className="slant-drag" style={{ position: 'relative', flex: 'none', padding: '12px 0' }}>
                            {meter(v)}
                            {dragInput(d.key, 0, 10, saved == null ? 0 : saved, d.name)}
                          </div>
                          <div style={{ whiteSpace: 'nowrap', textAlign: 'right', minWidth: 72, fontVariantNumeric: 'tabular-nums' }} aria-label={v == null ? 'No score' : v + ' out of 10'}>
                            <span style={{ fontSize: 24, fontWeight: 700, color: P.ink }}>{v == null ? '—' : v}</span>{v != null && <span style={{ fontSize: 15, color: P.faint }}> / 10</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </section>
              </>
            )}
          </div>
        </section>
        {entries.length > 0 && (
          <p style={{ fontSize: 15, lineHeight: 1.6, color: P.faint, margin: '14px 0 0', maxWidth: 760 }}>
            Like the bear in Slant for Chrome: the eyebrows follow the highest of the three signals marked “eyebrows”, and the ear on the lean side grows with one-sidedness. Each number is a plain average of saved scores, rounded to one decimal. Drag any bar to preview how the bear changes; it returns to your averages when you let go, and nothing is saved.
          </p>
        )}

        {entries.length > 0 && (
          <section style={sec}>
            <div style={cap}>Videos · {entries.length}</div>
            <div style={{ ...card, overflow: 'hidden', marginTop: 12 }}>
              {(showAllFeed ? entries : entries.slice(0, 12)).map((e, i) => (
                <div key={e.videoId} className="slant-row" style={{ display: 'grid', gridTemplateColumns: (narrow ? '' : '64px ') + 'minmax(0,1fr) auto', gap: 16, padding: '14px ' + padX + 'px', borderTop: i ? '1px solid ' + P.cardLine : 0, alignItems: 'center' }}>
                  {!narrow && <div style={{ fontSize: 15, color: P.faint, fontVariantNumeric: 'tabular-nums' }}>{fmtDay(e.lastAt)}</div>}
                  <div style={{ minWidth: 0 }}>
                    <button onClick={() => openEntry(e)} style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', maxWidth: '100%', background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer', fontSize: 18, fontWeight: 700, lineHeight: 1.35, color: P.ink }}>{e.title || e.videoId}</button>
                    <div style={{ fontSize: 14, color: P.faint, marginTop: 4 }}>
                      {[e.author, narrow ? fmtDay(e.lastAt) : '', e.count > 1 ? e.count + ' times' : '', e.vias && e.vias['chrome-extension'] ? 'Chrome' : '', e.live ? '' : 'analysis removed, scores kept'].filter(Boolean).join(' · ')}
                      <button className="slant-del" onClick={() => unfeed(e.videoId)} style={{ background: 'none', border: 0, padding: '0 0 0 12px', color: P.soft, fontSize: 14, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }}>Remove</button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', alignItems: narrow ? 'flex-end' : 'center', gap: narrow ? 6 : 14 }}>
                    {bandPill(e.s.political ? e.s.lean : null)}
                    <span style={{ fontSize: 20, fontWeight: 700, minWidth: 48, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: P.ink }}>{e.s.political ? fmtLean(r1(e.s.lean)) : '—'}</span>
                  </div>
                </div>
              ))}
            </div>
            {entries.length > 12 && <button onClick={() => setShowAllFeed(!showAllFeed)} style={{ ...textBtn, marginTop: 6 }}>{showAllFeed ? 'Show fewer' : 'Show all ' + entries.length}</button>}
          </section>
        )}

        {canWrite === true && library.length > 0 && (
          <section style={sec}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ ...cap, flex: 1 }}>Already analyzed in Slant · {library.length} not in your feed</div>
              <button onClick={() => setShowLibrary(!showLibrary)} style={chip(false)}>{showLibrary ? 'Hide' : 'Add videos you’ve watched'}</button>
            </div>
            {showLibrary && (
              <div style={{ marginTop: 12 }}>
                <p style={{ ...para, fontSize: 16 }}>Add the ones you actually watched, so your averages include them.</p>
                <div style={{ ...card, overflow: 'hidden', marginTop: 12 }}>
                  {library.map((it, i) => {
                    const pol = it.result.political || {};
                    return (
                      <div key={it.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 16, padding: '14px ' + padX + 'px', borderTop: i ? '1px solid ' + P.cardLine : 0, alignItems: 'center' }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 18, fontWeight: 700, lineHeight: 1.35, color: P.ink }}>{it.title || it.videoId}</div>
                          <div style={{ fontSize: 14, color: P.faint, marginTop: 4 }}>{it.author}</div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', alignItems: narrow ? 'flex-end' : 'center', gap: narrow ? 8 : 14 }}>
                          {bandPill(pol.applicable ? leanScore(pol) : null)}
                          <button onClick={() => recordFeed(it.id, it)} style={smallBtn(false)}>Add</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        )}

        <section style={sec}>
          <div style={cap}>History</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
            <span style={{ fontSize: 17, color: P.ink, marginRight: 6 }}>Keep my feed for</span>
            {FEED_KEEP.map((k) => {
              const lose = feedAll.filter((e) => (e.lastAt || 0) < Date.now() - k.days * DAY_MS).length;
              return <button key={k.days} onClick={() => (lose ? setFeedConfirm({ keep: k.days, lose, label: k.label }) : setKeep(k.days))} style={chip(k.days === keepDays)}>{k.label}</button>;
            })}
          </div>
          {feedConfirm && feedConfirm.keep && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 14, fontSize: 16, color: P.soft }}>
              <span>This removes {feedConfirm.lose} {feedConfirm.lose === 1 ? 'video' : 'videos'} older than {feedConfirm.label}.</span>
              <button onClick={() => setKeep(feedConfirm.keep)} style={smallBtn(true)}>Remove and keep {feedConfirm.label}</button>
              <button onClick={() => setFeedConfirm(null)} style={smallBtn(false)}>Cancel</button>
            </div>
          )}
          <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 16 }}>
            {feedConfirm && feedConfirm.clear ? (
              <>
                <span style={{ color: P.soft }}>Delete all {feedAll.length} videos from your feed? The analyses themselves stay in Slant.</span>
                <button onClick={clearFeed} style={{ ...smallBtn(false), color: P.accent, borderColor: P.accent }}>Delete my feed</button>
                <button onClick={() => setFeedConfirm(null)} style={smallBtn(false)}>Cancel</button>
              </>
            ) : feedAll.length > 0 && <button onClick={() => setFeedConfirm({ clear: true })} style={textBtn}>Clear my feed</button>}
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
          <button onClick={visitor ? () => openItem('feed') : closeItem} style={{ background: 'none', border: 0, padding: 0, color: P.soft, fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M8.5 3L4.5 7l4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {visitor ? 'Your feed' : 'All videos'}
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
            <p style={{ ...para, marginTop: 22 }}><span style={term}>Five signals</span>, each from 0 (absent) to 10:</p>
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
        </article>
      </div>
    );
  }

  function renderDetail() {
    if (!items) return <div style={{ padding: '60px 0', color: P.faint, fontSize: 18 }}>Loading…</div>;
    if (!rec) {
      return (
        <div style={{ padding: '60px 0' }}>
          <div style={{ color: P.soft, fontSize: 18 }}>This analysis no longer exists.</div>
          <button onClick={visitor ? () => openItem('feed') : closeItem} style={{ ...pillBtn(false), height: 46, fontSize: 16, marginTop: 14 }}>{visitor ? 'Your feed' : 'All videos'}</button>
        </div>
      );
    }
    const wide = w >= 760;
    const short = isShort(rec.url);
    const tHeight = !wide ? 460 : short
      ? 'max(240px, calc(100vh - var(--mana-top-inset, 72px) - ' + shortH(true) + ' - 130px))'
      : 'max(280px, calc(100vh - var(--mana-top-inset, 72px) - 360px))';
    const card = { background: P.card, border: '1px solid ' + P.cardLine, borderRadius: 18, overflow: 'hidden' };
    const transcriptCard = (
      <section style={card} aria-label="Transcript">
        {wide && renderPlayer(rec.videoId, short, true)}
        <div style={{ padding: '18px 20px 10px', display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', borderBottom: '1px solid ' + P.cardLine }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: P.soft }}>Transcript</span>
          {located.marked.size > 0 && (
            <span style={{ fontSize: 15, color: P.faint, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 14, height: 14, borderRadius: 3, background: P.cite, display: 'inline-block' }} />{located.marked.size} quoted lines
            </span>
          )}
        </div>
        <TranscriptPanel snips={snips} paras={paras} marked={located.marked} activeSeg={active ? active.seg : null}
          onSeek={(i) => seekTo(i, 't' + i)} P={P} height={tHeight} />
      </section>
    );
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '18px 0 14px', flexWrap: 'wrap' }}>
          {canWrite === true ? (
            <button onClick={closeItem} style={{ background: 'none', border: 0, padding: '10px 0', color: P.soft, fontSize: 18, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <svg width="18" height="18" viewBox="0 0 14 14" aria-hidden="true"><path d="M8.5 3L4.5 7l4 4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
              All videos
            </button>
          ) : <span />}
          {canWrite === true && w >= 900 && renderInput(false)}
          {visitor && feedButton()}
        </div>
        {w >= 900 && job && !job.reId && <div style={{ marginTop: -4, marginBottom: 18 }}>{renderJob()}</div>}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: w < 600 ? 26 : 34, lineHeight: 1.2, fontWeight: 700, color: P.ink, margin: 0 }}>{rec.title || rec.videoId}</h1>
          <div style={{ fontSize: 18, color: P.soft, marginTop: 8 }}>{[rec.author, rec.duration ? fmtT(rec.duration) : ''].filter(Boolean).join(' · ')}</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: wide ? 'minmax(0,1.3fr) minmax(300px,1fr)' : 'minmax(0,1fr)', gap: 24, alignItems: 'start' }}>
          {!wide && <div style={{ borderRadius: 18, overflow: 'hidden' }}>{renderPlayer(rec.videoId, short, false)}</div>}
          {renderAnalysis()}
          <aside style={wide ? { position: 'sticky', top: 'calc(var(--mana-top-inset, 72px) + 12px)', alignSelf: 'start' } : {}}>
            {transcriptCard}
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="w-full" style={{ color: P.ink, paddingBottom: 'calc(var(--mana-bottom-inset, 80px) + 24px)' }}>
      <style>{'@keyframes slantspin{to{transform:rotate(360deg)}}.slant-spin{display:inline-block;animation:slantspin .8s linear infinite}' +
        '.slant-row .slant-del{opacity:0;transition:opacity .15s}.slant-row:hover .slant-del,.slant-row:focus-within .slant-del{opacity:1}' +
        '.slant-drag{border-radius:8px}.slant-drag:focus-within{outline:2px solid currentColor;outline-offset:4px}' +
        '.slant-row:hover img{opacity:.9}@media (prefers-reduced-motion: reduce){.slant-spin{animation-duration:2.4s}}'}</style>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '0 ' + (w < 600 ? 16 : 28) + 'px' }}>
        {sel === 'how' ? renderHow() : sel === 'feed' ? renderFeed() : sel ? renderDetail()
          : canWrite === true ? renderHome() : visitor ? renderFeed() : <div style={{ padding: '60px 0', color: P.faint, fontSize: 18 }}>Loading…</div>}
        {svc.error && !sel && canWrite !== false && (
          <div style={{ marginTop: 24, fontSize: 12, color: P.faint }}>{'Analysis unavailable: ' + svc.error.message}</div>
        )}
      </div>
    </div>
  );
}