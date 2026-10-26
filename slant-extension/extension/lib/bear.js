// bear.js: the Slant bear as a standalone ES module (no DOM needed except draw()).
//
//   scoresFromResult(record.result)  -> { L, S, K, P, U, O }     one video
//   aggregate([scores, scores, ...]) -> { L, S, K, P, U, O, n, nPolitical, meanAbsLean, spread }   many videos
//   draw(canvas, scores, opts)       -> paints the bear on a 48x62 canvas (CSS: width 240px; image-rendering: pixelated)
//
// Score meaning (all 0..10 except L):
//   L lean -6..+6 (body color) | S sensationalism, K loaded language, P personal attacks (eyebrows, highest of three)
//   U unsupported claims (eyes) | O one-sidedness (ears: the ear on the lean side grows)

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
export function compose(v, opt) {
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


const NEUTRAL = { L: 0, S: 0, K: 0, P: 0, U: 0, O: 0 };
const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
export function scoresFromResult(r) {
  if (!r) return null;
  const by = {};
  arr(r.dimensions).forEach((d) => { if (d && d.key) by[d.key] = clamp(d.score, 0, 10); });
  const pol = r.political || {};
  return { political: !!pol.applicable, L: pol.applicable ? clamp(pol.score, -6, 6) : 0, S: by.sensationalism || 0, K: by.loaded_language || 0,
           P: by.ad_hominem || 0, U: by.unsupported_claims || 0, O: by.one_sided || 0 };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Average a person's whole history into one bear.
//  - L is averaged over political videos only (applicable === true). Non-political videos have no lean.
//  - S, K, P, U, O are averaged over every analyzed video.
//  - meanAbsLean tells you how far from center the videos were on average. A viewer who watches strong-left and strong-right
//    videos has L near 0 (looks "balanced") but a large meanAbsLean, so show both numbers, not only the bear.
export function aggregate(list) {
  const rows = (list || []).filter(Boolean);
  const pol = rows.filter((r) => r.political !== false);
  const leans = pol.map((r) => r.L);
  const out = { n: rows.length, nPolitical: pol.length,
    L: Math.round(mean(leans) * 10) / 10, meanAbsLean: Math.round(mean(leans.map(Math.abs)) * 10) / 10,
    S: mean(rows.map((r) => r.S)), K: mean(rows.map((r) => r.K)), P: mean(rows.map((r) => r.P)),
    U: mean(rows.map((r) => r.U)), O: mean(rows.map((r) => r.O)) };
  const m = leans.length ? out.L : 0;
  out.spread = Math.round(Math.sqrt(mean(leans.map((x) => (x - m) ** 2))) * 10) / 10;   // how mixed the lean of the videos is
  return out;
}

export function draw(canvas, v, opt) {
  const ctx = canvas.getContext('2d'), { grid, pal } = compose(v, opt);
  canvas.width = W; canvas.height = H;
  ctx.clearRect(0, 0, W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = grid[y][x]; if (c) { ctx.fillStyle = pal[c]; ctx.fillRect(x, y, 1, 1); } }
}
