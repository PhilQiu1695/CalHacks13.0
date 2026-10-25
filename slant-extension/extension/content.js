// Slant bear: a small pixel bear that floats at the top right of a YouTube watch page or Short. It is the whole interface:
// there is no side panel.
//   idle      -> neutral bear, "Tap to analyze"
//   analyzing -> bear bobbing, "Analyzing…" with the current step
//   done      -> bear reshaped by the analysis (body color, eyebrows, eyes, ears); a tap opens the details card
//   failed    -> sleepy bear, "Couldn't analyze"; a tap opens the card with the reason and Try again
//   setup     -> "Set up Slant": a tap opens the extension's setup page (pairing / reconnect)
// A tap asks the background worker to analyze (or reopen) this video; the worker runs the job on the Slant backend and
// saves its progress in chrome.storage.local ("reqs", one entry per video), which the bear follows.
// The card says everything in words with plain scales, so the bear's look is never the only cue. Lean bands and score
// words mirror the Slant app (LEAN_BANDS, leanBand, biasWord in lib/slant-core.js); tests/test_extension.mjs checks they match.
// All text is inserted as text nodes, never as HTML.
(() => {
  if (window.__slantBear) return;
  window.__slantBear = true;

  const CACHE_KEY = 'bearCache';          // videoId -> scores + card details, so a bear you already analyzed keeps its shape.
  const ENABLE_CACHE = true;
  const CACHE_MAX = 50;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- pixel bear ----------
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

  // ---------- reading the analysis ----------
  const NEUTRAL = { L: 0, S: 0, K: 0, P: 0, U: 0, O: 0 };
  const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v).sort((a, b) => a - b).map((k) => v[k]) : []);
  const DIMS = [
    ['one_sided', 'O', 'One-sidedness', 'Leaves out or strawmans other views'],
    ['loaded_language', 'K', 'Loaded language', 'Charged, pejorative or flattering wording'],
    ['sensationalism', 'S', 'Sensationalism', 'Exaggeration, alarm, outrage framing'],
    ['unsupported_claims', 'U', 'Unsupported claims', 'Assertions without evidence or sourcing'],
    ['ad_hominem', 'P', 'Personal attacks', 'Targets people rather than their arguments'],
  ];
  function scoresFromResult(r) {
    if (!r) return null;
    const by = {};
    arr(r.dimensions).forEach((d) => { if (d && d.key) by[d.key] = clamp(d.score, 0, 10); });
    const pol = r.political || {};
    return { L: pol.applicable ? clamp(pol.score, -6, 6) : 0, S: by.sensationalism || 0, K: by.loaded_language || 0,
             P: by.ad_hominem || 0, U: by.unsupported_claims || 0, O: by.one_sided || 0,
             political: !!pol.applicable, overall: clamp(r.overall, 0, 10) };
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
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  // Everything the card shows, taken from a finished job. Kept small: it is also cached per video.
  function detailsFromJob(job) {
    const payload = job.result || {};
    const rec = payload.record || {};
    const r = rec.result || {};
    const by = {};
    arr(r.dimensions).forEach((d) => { if (d && d.key) by[d.key] = d; });
    const a = job.analysis || {};
    return {
      headline: str(r.headline, 160),
      dims: DIMS.map(([key]) => ({ key, score: clamp(by[key] && by[key].score, 0, 10), why: str(by[key] && by[key].explanation, 420) })),
      url: typeof payload.manaUrl === 'string' && /^https:\/\/www\.mana\.space\//.test(payload.manaUrl) ? payload.manaUrl : '',
      simulated: !!(payload.simulated || job.simulated),
      kind: job.simulated ? 'simulated' : job.cached ? 'saved' : job.mode === 'fresh' ? 'fresh' : 'new',
      at: a.updatedAt || a.createdAt || job.finishedAt || Date.now(),
    };
  }
  // Watch pages and Shorts (the same 11-character video id in both).
  function videoId() {
    if (location.pathname === '/watch') { const v = new URLSearchParams(location.search).get('v'); return /^[\w-]{11}$/.test(v || '') ? v : null; }
    const m = location.pathname.match(/^\/shorts\/([\w-]{11})(?:[/?#]|$)/);
    return m ? m[1] : null;
  }
  function stateFromReq(req) {
    if (!req) return { kind: 'idle' };
    if (req.error && req.error.conn) return { kind: 'setup', reason: req.error.code === 'not_paired' ? 'not_paired' : 'expired' };
    const job = req.job;
    if (!job) return req.error ? { kind: 'failed', error: req.error } : { kind: 'analyzing', since: req.createdAt };
    if (job.state === 'done') {
      const r = job.result && job.result.record && job.result.record.result;
      const sc = scoresFromResult(r);
      return sc ? { kind: 'done', scores: sc, details: detailsFromJob(job) }
                : { kind: 'failed', error: { code: 'record_missing', message: 'The saved analysis is no longer available.', retryable: true } };
    }
    if (job.state === 'failed') return { kind: 'failed', error: job.error || { code: 'internal', message: 'The analysis failed.', retryable: true } };
    if (req.error && req.error.polling) return { kind: 'failed', error: req.error };
    const active = arr(job.stages).find((s) => s && s.status === 'active');
    return { kind: 'analyzing', since: job.startedAt || job.createdAt || req.createdAt, skew: (job.serverNow || 0) && job._recv ? job._recv - job.serverNow : 0,
             step: job.state === 'queued' ? 'Waiting to start' : (active && active.label) || 'Analyzing slant', coalesced: !!job.coalesced };
  }
  const ERR_TITLE = {
    video_unavailable: 'Can’t analyze this video', too_long: 'This video is too long', insufficient_credits: 'Out of Mana credits',
    rate_limited: 'Slant is busy', busy: 'Slant is busy', daily_limit: 'Daily limit reached', network: 'Can’t reach Slant',
    backend_down: 'Slant is offline right now', malformed_output: 'The analysis came back incomplete', interrupted: 'The analysis was interrupted',
    timeout: 'The analysis took too long', length_unknown: 'Couldn’t check the video’s length', no_speech: 'No speech found',
    transcription_failed: 'Transcription failed', transcription_unreadable: 'Transcription failed', provider_error: 'The AI service had a problem',
    provider_timeout: 'The AI service took too long', not_found: 'This job is gone', record_missing: 'This analysis was deleted',
    unsupported_url: 'Not a YouTube video', analysis_failed: 'The analysis was refused', internal: 'Something went wrong',
  };

  // ---------- UI (closed shadow DOM so YouTube's CSS and scripts cannot touch it) ----------
  // One column, one centre line: the bear, its label and the card share the same axis and width.
  const host = document.createElement('div');
  host.id = 'slant-bear-host';
  host.style.cssText = 'position:fixed;top:64px;right:16px;z-index:2147483000;display:none;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.col{width:336px;display:flex;flex-direction:column;align-items:center;gap:8px;font:400 14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1c1830;-webkit-font-smoothing:antialiased}',
    '.col>*{pointer-events:auto}',
    '.wrap{display:flex;flex-direction:column;align-items:center;gap:8px;cursor:pointer;background:none;border:0;padding:0;font:inherit;color:inherit}',
    'canvas{width:120px;height:155px;image-rendering:pixelated;filter:drop-shadow(0 6px 10px rgba(30,20,60,.35));transition:transform .15s}',
    '.wrap:hover canvas,.wrap:focus-visible canvas{transform:translateY(-3px)}',
    '.wrap:focus-visible{outline:3px solid #7b5cc8;outline-offset:4px;border-radius:14px}',
    // the label under the bear
    '.tip{display:flex;flex-direction:column;align-items:center;gap:1px;background:#fff;border:1px solid #ddd6c8;border-radius:14px;padding:7px 16px;box-shadow:0 2px 10px rgba(30,20,60,.16);text-align:center;max-width:336px}',
    '.tip[hidden]{display:none}',
    '.t1{font-weight:650;font-size:15px;white-space:nowrap}.t2{font-size:12.5px;color:#5b5568;white-space:nowrap}.t2:empty{display:none}',
    // the card
    '.card{width:336px;background:#fff;border:1px solid #ddd6c8;border-radius:18px;box-shadow:0 10px 30px rgba(30,20,60,.18),0 1px 3px rgba(30,20,60,.08);max-height:calc(100vh - 64px - 155px - 24px);overflow-y:auto;overscroll-behavior:contain}',
    '.card[hidden]{display:none}',
    '.sec{padding:16px 20px}.sec+.sec{border-top:1px solid #eee9de}',
    '.hl{font-weight:650;font-size:15.5px;line-height:1.35;text-wrap:pretty}',
    '.eyebrow{font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6b6478}',
    '.row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
    '.big{font-size:21px;font-weight:700;letter-spacing:-.01em;line-height:1.2;margin-top:4px}',
    '.aside{font-size:13px;color:#5b5568;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.expl{font-size:13px;color:#4a4458;margin-top:10px;text-wrap:pretty}',
    // lean spectrum: five AllSides bands, the video's band in full colour
    '.spec{position:relative;margin-top:16px;padding-top:6px}',
    '.bands{display:grid;grid-template-columns:3fr 2fr 2fr 2fr 3fr;gap:3px}',
    '.bands i{height:10px;border-radius:3px;opacity:.28}.bands i.on{opacity:1}',
    '.bands i:first-child{border-radius:6px 3px 3px 6px}.bands i:last-child{border-radius:3px 6px 6px 3px}',
    '.pin{position:absolute;top:0;width:18px;height:18px;margin-left:-9px;border-radius:50%;background:#fff;border:3px solid #1c1830;box-shadow:0 1px 3px rgba(0,0,0,.25)}',
    '.ends{display:flex;justify-content:space-between;margin-top:6px;font-size:12px;color:#5b5568}',
    '.ends span{flex:1;text-align:center}.ends span:first-child{text-align:left}.ends span:last-child{text-align:right}',
    // slant score: 0 to 10 with word steps
    '.track{position:relative;height:10px;border-radius:6px;background:#eee9de;margin-top:14px;overflow:hidden}',
    '.fill{position:absolute;left:0;top:0;bottom:0;border-radius:6px;background:#1c1830}',
    '.steps{position:absolute;inset:0;display:grid;grid-template-columns:2.5fr 2fr 2fr 2fr 1.5fr}',
    '.steps b{border-right:2px solid #fff}.steps b:last-child{border-right:0}',
    // signals
    '.sigs{margin-top:8px}',
    '.sig{display:grid;grid-template-columns:1fr auto 22px;align-items:center;gap:10px;width:100%;padding:7px 0;background:none;border:0;font:inherit;color:inherit;cursor:pointer;text-align:left}',
    '.sig:focus-visible{outline:2px solid #7b5cc8;outline-offset:2px;border-radius:6px}',
    '.sig .nm{font-size:14px;white-space:nowrap}.sig .nm:after{content:"›";color:#9a93a8;display:inline-block;margin-left:6px;transition:transform .15s}.sig[aria-expanded="true"] .nm:after{transform:rotate(90deg)}',
    '.meter{display:flex;gap:2px}.meter i{width:7px;height:8px;border-radius:2px;background:#e6e1d6}.meter i.on{background:#1c1830}',
    '.num{text-align:right;font-variant-numeric:tabular-nums;font-weight:600;font-size:13.5px}',
    '.why{font-size:13px;color:#4a4458;padding:0 0 8px;text-wrap:pretty}.why .hint{color:#6b6478;font-style:italic}',
    '.scale-note{font-size:12px;color:#6b6478;margin-top:2px}',
    // actions: always a pair of equal buttons, or one full-width button
    '.acts{display:grid;grid-template-columns:1fr 1fr;gap:10px}.acts.one{grid-template-columns:1fr}',
    '.btn{display:flex;align-items:center;justify-content:center;gap:6px;height:42px;padding:0 14px;border-radius:999px;font:600 14px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;cursor:pointer;text-decoration:none;border:1px solid #d3cbbb;background:#fff;color:#1c1830;white-space:nowrap}',
    '.btn.primary{background:#1c1830;border-color:#1c1830;color:#fff}',
    '.btn:hover{filter:brightness(.97)}.btn.primary:hover{filter:brightness(1.15)}',
    '.btn:focus-visible{outline:3px solid #7b5cc8;outline-offset:2px}',
    '.foot{margin-top:12px;text-align:center;font-size:12px;color:#6b6478}',
    '.lnk{background:none;border:0;padding:0;font:inherit;color:#4a3a8c;text-decoration:underline;text-underline-offset:2px;cursor:pointer}',
    '.lnk:focus-visible{outline:2px solid #7b5cc8;outline-offset:2px;border-radius:3px}',
    '.confirm{margin-top:12px;padding:12px;border-radius:12px;background:#f6f3ec;font-size:13px;color:#4a4458;text-align:left}',
    '.confirm .acts{margin-top:10px}.confirm .btn{height:36px;font-size:13px}',
    '.err-msg{font-size:13.5px;color:#4a4458;margin-top:6px;text-wrap:pretty}',
    '@media (prefers-reduced-motion: reduce){canvas{transition:none}.wrap:hover canvas{transform:none}.sig .nm:after{transition:none}}',
  ].join('');
  const col = document.createElement('div'); col.className = 'col';
  const btn = document.createElement('button');
  btn.className = 'wrap'; btn.type = 'button';
  const cv = document.createElement('canvas'); cv.width = 48; cv.height = 62;
  const tip = document.createElement('div'); tip.className = 'tip';
  const tipMain = document.createElement('span'), tipSub = document.createElement('span');
  tipMain.className = 't1'; tipSub.className = 't2';
  tip.append(tipMain, tipSub); btn.append(cv, tip);
  const card = document.createElement('div'); card.className = 'card'; card.hidden = true; card.id = 'slant-details';
  card.setAttribute('role', 'region'); card.setAttribute('aria-label', 'Slant analysis');
  btn.setAttribute('aria-controls', 'slant-details');
  col.append(btn, card);
  root.append(style, col);
  const ctx = cv.getContext('2d');
  let cur = { kind: 'idle' }, timer = 0, lastFrame = '', pendingUntil = 0, expanded = false, openSig = null, confirmAgain = false, connOk = null;

  // ---------- tiny DOM helpers (text only) ----------
  function el(tag, cls, text, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, String(attrs[k]));
    return e;
  }
  function button(text, cls, onClick, id) {
    const b = el('button', 'btn' + (cls ? ' ' + cls : ''), text, { type: 'button', id });
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }
  function reportLink(url) {
    const a = el('a', 'btn primary', 'Full report ↗', { href: url, target: '_blank', rel: 'noopener noreferrer', id: 'slant-report' });
    a.setAttribute('aria-label', 'Open the full report for this video on the Slant website (new tab)');
    return a;
  }
  function acts(...items) {
    const list = items.filter(Boolean);
    const d = el('div', 'acts' + (list.length === 1 ? ' one' : ''));
    d.append(...list);
    return d;
  }
  const fmtLean = (s) => (s === 0 ? '0' : (s > 0 ? '+' : '−') + Math.abs(s));
  const fmtDay = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const LEAN_INK = { Left: '#2452d0', 'Lean Left': '#2f5ea8', Center: '#4a3a8c', 'Lean Right': '#b23a2f', Right: '#c42c2c' };
  const BAND_COLORS = ['rgb(58,112,246)', 'rgb(138,166,242)', 'rgb(183,156,237)', 'rgb(240,154,154)', 'rgb(238,74,74)'];
  const LEAN_SENTENCE = { Left: 'Leans clearly to the left.', 'Lean Left': 'Leans somewhat to the left.', Center: 'Close to the political center.',
                          'Lean Right': 'Leans somewhat to the right.', Right: 'Leans clearly to the right.' };
  const BAND_INDEX = { Left: 0, 'Lean Left': 1, Center: 2, 'Lean Right': 3, Right: 4 };

  // ---------- the card ----------
  function leanSection(sc) {
    const s = el('div', 'sec');
    s.append(el('div', 'eyebrow', 'Political lean'));
    if (!sc.political) {
      s.append(el('div', 'big', 'Not political'), el('div', 'expl', 'This video isn’t about politics or social issues, so there’s no left or right lean to place.'));
      return s;
    }
    const lean = Math.round(clamp(sc.L, -6, 6) * 10) / 10, band = bearLeanLabel(lean);
    const top = el('div', 'row');
    const word = el('div', 'big', band); word.style.color = LEAN_INK[band];
    top.append(word, el('span', 'aside', fmtLean(lean) + ' of ±6'));
    s.append(top, el('div', 'expl', LEAN_SENTENCE[band]));
    const spec = el('div', 'spec', null, { role: 'img', 'aria-label': 'Lean ' + fmtLean(lean) + ' on a scale from −6 (left) to +6 (right): ' + band });
    const bands = el('div', 'bands');
    BAND_COLORS.forEach((c, i) => { const b = el('i', i === BAND_INDEX[band] ? 'on' : ''); b.style.background = c; bands.append(b); });
    const pin = el('div', 'pin'); pin.style.left = ((lean + 6) / 12 * 100) + '%';
    spec.append(bands, pin);
    const ends = el('div', 'ends', null, { 'aria-hidden': 'true' });
    ends.append(el('span', null, '← Left'), el('span', null, 'Center'), el('span', null, 'Right →'));
    s.append(spec, ends, el('div', 'scale-note', 'Scale from −6 to +6 and its five bands follow the AllSides Media Bias Meter.'));
    return s;
  }
  function slantSection(sc) {
    const s = el('div', 'sec');
    const v = clamp(sc.overall, 0, 10), word = bearScoreWord(v);
    s.append(el('div', 'eyebrow', 'How slanted'));
    const top = el('div', 'row');
    top.append(el('div', 'big', word), el('span', 'aside', (Math.round(v * 10) / 10) + ' out of 10'));
    const track = el('div', 'track', null, { role: 'img', 'aria-label': 'Slant score ' + (Math.round(v * 10) / 10) + ' out of 10: ' + word });
    const fill = el('div', 'fill'); fill.style.width = (v * 10) + '%';
    const steps = el('div', 'steps'); for (let i = 0; i < 5; i++) steps.append(el('b'));
    track.append(fill, steps);
    const ends = el('div', 'ends', null, { 'aria-hidden': 'true' });
    ends.append(el('span', null, '0 · Fair and balanced'), el('span', null, '10 · Extreme'));
    s.append(top, track, ends,
      el('div', 'expl', 'How far the video departs from fair, balanced treatment, toward either side. It rates how the case is made, not whether it’s true.'));
    return s;
  }
  function signalsSection(d) {
    const s = el('div', 'sec');
    const top = el('div', 'row'); top.append(el('div', 'eyebrow', 'What drives the score'), el('span', 'aside', '0 to 10'));
    const list = el('div', 'sigs');
    d.dims.forEach((dm, i) => {
      const [, , name, hint] = DIMS[i];
      const n = Math.round(clamp(dm.score, 0, 10)), open = openSig === dm.key;
      const row = el('button', 'sig', null, { type: 'button', 'aria-expanded': String(open), 'data-dim': dm.key });
      const meter = el('span', 'meter', null, { 'aria-hidden': 'true' });
      for (let k = 0; k < 10; k++) meter.append(el('i', k < n ? 'on' : ''));
      row.append(el('span', 'nm', name), meter, el('span', 'num', n));
      row.setAttribute('aria-label', name + ', ' + n + ' out of 10');
      row.addEventListener('click', (e) => { e.stopPropagation(); openSig = open ? null : dm.key; renderCard(); });
      list.append(row);
      if (open) { const w = el('div', 'why'); w.append(el('span', 'hint', hint + '. ')); if (dm.why) w.append(document.createTextNode(dm.why)); list.append(w); }
    });
    s.append(top, list);
    return s;
  }
  function doneCard(st) {
    const d = st.details || { dims: DIMS.map(([key]) => ({ key, score: 0, why: '' })), url: '', kind: 'saved', at: 0 };
    if (!d.dims) d.dims = DIMS.map(([key, k]) => ({ key, score: st.scores[k] || 0, why: '' }));
    const parts = [];
    if (d.headline) { const h = el('div', 'sec'); h.append(el('div', 'hl', d.headline)); parts.push(h); }
    parts.push(leanSection(st.scores), slantSection(st.scores), signalsSection(d));
    const last = el('div', 'sec');
    last.append(acts(button('Close', '', () => setExpanded(false), 'slant-close'), d.url && !d.simulated ? reportLink(d.url) : null));
    const foot = el('div', 'foot');
    const what = { saved: 'Saved analysis', new: 'New analysis', fresh: 'Fresh analysis', simulated: 'Simulated test result · not saved' }[d.kind] || 'Analysis';
    foot.append(document.createTextNode(what + (d.at && d.kind !== 'simulated' ? ' · ' + fmtDay(d.at) : '') + ' · '));
    const again = el('button', 'lnk', 'Analyze again', { type: 'button', id: 'slant-again' });
    again.addEventListener('click', (e) => { e.stopPropagation(); confirmAgain = true; renderCard(); });
    if (!confirmAgain) foot.append(again); else foot.lastChild.textContent = foot.lastChild.textContent.replace(/ · $/, '');
    last.append(foot);
    if (confirmAgain) {
      const c = el('div', 'confirm', 'Run a fresh analysis of this video? It replaces the saved result in your Slant history and uses Mana credits.');
      c.append(acts(button('Cancel', '', () => { confirmAgain = false; renderCard(); }), button('Run again', 'primary', () => { confirmAgain = false; analyze('fresh'); }, 'slant-confirm-again')));
      last.append(c);
    }
    parts.push(last);
    return parts;
  }
  function failedCard(st) {
    const e = st.error || {};
    const s = el('div', 'sec');
    s.append(el('div', 'eyebrow', 'Not analyzed'), el('div', 'big', ERR_TITLE[e.code] || 'Something went wrong'),
      el('div', 'err-msg', e.message || 'Try again in a moment.'));
    if (e.code === 'insufficient_credits') s.append(el('div', 'expl', 'Slant runs on its owner’s Mana credits. Saved analyses still open.'));
    const last = el('div', 'sec');
    last.append(acts(button('Close', '', () => setExpanded(false), 'slant-close'), e.retryable ? button('Try again', 'primary', () => analyze('retry'), 'slant-retry') : null));
    return [s, last];
  }
  function renderCard() {
    const canOpen = cur.kind === 'done' || cur.kind === 'failed';
    card.hidden = !(expanded && canOpen);
    tip.hidden = !card.hidden;                 // the card replaces the label, so only one box sits under the bear
    btn.setAttribute('aria-expanded', String(!card.hidden));
    if (card.hidden) return;
    const keepScroll = card.scrollTop;
    const focused = root.activeElement;                  // keep keyboard focus on the same control across a redraw
    const focusKey = focused && card.contains(focused) ? (focused.id || (focused.dataset && focused.dataset.dim) || '') : '';
    card.textContent = '';
    card.append(...(cur.kind === 'done' ? doneCard(cur) : failedCard(cur)));
    card.scrollTop = keepScroll;
    if (focusKey) {
      const again = card.querySelector('#' + CSS.escape(focusKey)) || card.querySelector('[data-dim="' + CSS.escape(focusKey) + '"]');
      if (again) again.focus({ preventScroll: true });
    }
  }
  function setExpanded(on) {
    expanded = on; if (!on) { openSig = null; confirmAgain = false; }
    lastFrame = ''; paint(); renderCard();
    if (!on) safe(() => btn.focus({ preventScroll: true }));
  }

  // ---------- the label under the bear ----------
  function texts(st, ts) {
    if (st.kind === 'done') {
      const sc = st.scores, lean = sc.political !== false ? bearLeanLabel(sc.L) : 'Not political';
      return { main: lean + ' · ' + bearScoreWord(sc.overall) + ' slant', color: LEAN_INK[lean] || '#1c1830', sub: 'Tap for details' };
    }
    if (st.kind === 'analyzing') {
      const dots = '.'.repeat(1 + (Math.floor(ts / 400) % 3));
      const secs = st.since ? Math.max(0, Math.round((Date.now() - (st.skew || 0) - st.since) / 1000)) : 0;
      return { main: 'Analyzing' + dots, color: '#1c1830', sub: (st.step || 'Starting') + (secs ? ' · ' + secs + ' s' : '') };
    }
    if (st.kind === 'failed') return { main: 'Couldn’t analyze', color: '#1c1830', sub: 'Tap for details' };
    if (st.kind === 'setup') return st.waiting ? { main: 'Finish setup', color: '#1c1830', sub: 'in the Slant tab that just opened' }
      : { main: st.reason === 'expired' ? 'Reconnect Slant' : 'Set up Slant', color: '#1c1830', sub: 'Tap to connect this browser' };
    return { main: 'Tap to analyze', color: '#1c1830', sub: 'See how slanted this video is' };
  }

  function paint() {
    const ts = performance.now();
    if (cur.kind === 'analyzing' && pendingUntil && Date.now() > pendingUntil) { pendingUntil = 0; refresh(); }
    const bob = reduce ? 0 : (Math.floor(ts / (cur.kind === 'analyzing' ? 280 : 600)) % 2);
    const tx = texts(cur, ts);
    const frame = cur.kind + '|' + bob + '|' + tx.main + '|' + tx.sub + '|' + JSON.stringify(cur.scores || null);
    if (frame === lastFrame) return;                     // nothing visible changed: skip the redraw
    lastFrame = frame;
    const v = cur.kind === 'done' ? cur.scores : NEUTRAL;
    const { grid, pal } = compose(v, { sleepy: cur.kind === 'failed', oy: bob });
    ctx.clearRect(0, 0, W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = grid[y][x]; if (c) { ctx.fillStyle = pal[c]; ctx.fillRect(x, y, 1, 1); } }
    tipMain.textContent = tx.main; tipMain.style.color = tx.color; tipSub.textContent = tx.sub;
  }
  function setState(next) {
    const sameDone = cur.kind === 'done' && next.kind === 'done';
    cur = next;
    const tx = texts(next, 0);
    const opens = next.kind === 'done' || next.kind === 'failed';
    btn.setAttribute('aria-label', 'Slant: ' + (next.kind === 'analyzing' ? 'Analyzing' : tx.main) + '. ' +
      (opens ? (expanded ? 'Tap to hide details' : 'Tap for details') : tx.sub));
    if (!opens) expanded = false;
    if (!sameDone) confirmAgain = false;
    lastFrame = '';
    paint();
    renderCard();
    if (next.kind === 'done' && ENABLE_CACHE) cacheResult(videoId(), next.scores, next.details);
  }
  function show(on) {
    host.style.display = on ? 'block' : 'none';
    const run = on && !document.hidden;                  // no work while hidden or in a background tab
    if (run && !timer) { lastFrame = ''; paint(); timer = setInterval(tick, 140); }
    if (!run && timer) { clearInterval(timer); timer = 0; }
  }
  let lastPoke = 0;
  function tick() {
    paint();
    // While analyzing, nudge the worker every few seconds: Chrome may have stopped it, and the nudge resumes the job.
    if (cur.kind === 'analyzing' && Date.now() - lastPoke > 5000) {
      lastPoke = Date.now();
      safe(() => chrome.runtime.sendMessage({ type: 'slant:poke', url: location.href }).catch(() => {}));
    }
  }
  document.addEventListener('visibilitychange', () => show(host.style.display === 'block'));

  // ---------- storage ----------
  const safe = (fn) => { try { return fn(); } catch (e) { return undefined; } };      // extension reloaded: context invalidated
  async function sget(key) { try { return (await chrome.storage.local.get(key))[key]; } catch (e) { return undefined; } }
  async function getReq(vid) { const reqs = (await sget('reqs')) || {}; return reqs[vid] || null; }
  async function cacheResult(vid, scores, details) {
    if (!vid) return;
    try {
      const c = (await sget(CACHE_KEY)) || {};
      c[vid] = { scores, details: details || null, at: Date.now() };
      const keys = Object.keys(c).sort((a, b) => c[b].at - c[a].at);
      keys.slice(CACHE_MAX).forEach((k) => delete c[k]);
      await chrome.storage.local.set({ [CACHE_KEY]: c });
    } catch (e) { /* extension reloaded */ }
  }
  async function readCache(vid) {
    if (!ENABLE_CACHE || !vid) return null;
    const c = (await sget(CACHE_KEY)) || {};
    return c[vid] && c[vid].scores && c[vid].scores.overall != null ? c[vid] : null;
  }
  async function connProblem() {
    const conn = await sget('conn');
    if (!conn || !conn.key) return 'not_paired';
    if (conn.linkExp && Date.now() > conn.linkExp) return 'expired';
    return null;
  }
  async function refresh() {
    const vid = videoId();
    if (!vid) { show(false); expanded = false; return; }
    if (!host.isConnected) document.documentElement.appendChild(host);
    show(true);
    let st = stateFromReq(await getReq(vid));
    if (st.kind === 'idle') { const c = await readCache(vid); if (c) st = { kind: 'done', scores: c.scores, details: c.details }; }
    if (st.kind === 'idle') { const p = await connProblem(); if (p) st = { kind: 'setup', reason: p, waiting: cur.kind === 'setup' && cur.waiting }; }
    if (st.kind === 'idle' && pendingUntil && Date.now() < pendingUntil) st = { kind: 'analyzing', step: 'Starting', since: Date.now() };
    if (st.kind !== 'idle' && st.kind !== 'analyzing') pendingUntil = 0;
    if (videoId() !== vid) return;                       // navigated while reading storage
    setState(st);
  }

  // ---------- actions ----------
  function analyze(mode) {
    if (!videoId()) return;
    if (mode !== 'retry' || cur.kind !== 'done') { expanded = false; }
    pendingUntil = Date.now() + 20000;                   // instant feedback; the saved request takes over
    setState({ kind: 'analyzing', step: 'Starting', since: Date.now() });
    safe(() => chrome.runtime.sendMessage({ type: 'slant:analyze', url: location.href, mode }, (r) => {
      if (chrome.runtime.lastError) { pendingUntil = 0; refresh(); return; }
      if (r && r.setup) { pendingUntil = 0; setState({ kind: 'setup', reason: r.setup === 'not_paired' ? 'not_paired' : 'expired', waiting: true }); }
    }));
  }
  function onTap() {
    const vid = videoId();
    if (!vid) return;
    if (cur.kind === 'done' || cur.kind === 'failed') { setExpanded(!expanded); return; }   // tap to show, tap again to hide
    if (cur.kind === 'analyzing') return;
    if (cur.kind === 'setup') {
      setState({ ...cur, waiting: true });
      safe(() => chrome.runtime.sendMessage({ type: 'slant:open-setup', url: location.href }).catch(() => {}));
      return;
    }
    analyze('auto');
  }
  btn.addEventListener('click', onTap);
  // Escape hides the card wherever focus is (focus can sit on the page after a tap). YouTube still sees the key.
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && expanded && host.style.display === 'block') setExpanded(false); }, true);
  safe(() => chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'slant:toolbar') onTap(); }));
  safe(() => chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.reqs) {
      const vid = videoId();
      const a = ch.reqs.oldValue && ch.reqs.oldValue[vid], b = ch.reqs.newValue && ch.reqs.newValue[vid];
      if (JSON.stringify(a || null) !== JSON.stringify(b || null)) refresh();
    }
    if (ch.conn) refresh();
  }));
  let lastUrl = location.href;
  const onNav = () => { if (location.href !== lastUrl) { lastUrl = location.href; expanded = false; refresh(); } };
  window.addEventListener('yt-navigate-finish', onNav);
  setInterval(onNav, 800);                                                               // fallback when YouTube skips the event
  refresh();
})();
