
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
  { key: 'commercial', name: 'Commercial interest', hint: 'Sponsor reads, selling, undisclosed promotion' },
];
const SRC_LABEL = { captions: 'Creator captions', 'auto-captions': 'YouTube auto-captions', 'ai-transcription': 'AI transcription (no captions)' };

const SYSTEM = [
  'You are Slant, a careful, even-handed media-bias analyst. You read a YouTube transcript and assess how the content is slanted: the framing, selection and wording chosen by the creator, host or narrator. You judge presentation, not whether the conclusions are true, and you hold every side to the same standard.',
  '',
  'Rules:',
  '- Use only the transcript. Captions may contain transcription errors; do not penalize them.',
  '- Separate the creator\'s own voice from views they quote or report in order to rebut or explain them. Quoting a view is not endorsing it. Interviews and debates are judged on how the host frames and balances them.',
  '- Political lean is scored from -10 to +10: -10 strongly left/progressive, 0 centrist or balanced, +10 strongly right/conservative. Use the conventional US left-right axis unless the content concerns another country\'s politics; then map to that country\'s axis and name it in the label. If the video has no meaningful political or social-issue content, set applicable=false, score=0, label "Not political", confidence "high", and return no quotes.',
  '- Return all six other dimensions, scored 0-10 where 0 means absent, in this order: one_sided, loaded_language, sensationalism, unsupported_claims, ad_hominem, commercial. Calibrate: neutral explainers and straight news usually sit at 0-3; reserve 8-10 for pervasive, extreme cases. commercial covers sponsor reads, affiliate pitches, selling the creator\'s own products, or undisclosed promotion.',
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
  const s = Math.round(clamp(pol.score, -10, 10) * 10) / 10;
  return s === 0 ? 'Center · 0' : (s < 0 ? 'Left · ' : 'Right · +') + (s < 0 ? String(s).replace('-', '−') : s);
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
  const target = ok ? ((clamp(pol.score, -10, 10) + 10) / 20) * 100 : 50;
  const [pos, setPos] = React.useState(compact ? target : 50);
  React.useEffect(() => {
    if (compact) { setPos(target); return; }
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setPos(target); return; }
    const t = setTimeout(() => setPos(target), 120);
    return () => clearTimeout(t);
  }, [target, compact]);
  const h = compact ? 14 : 46;
  return (
    <div style={{ position: 'relative', height: h, width: '100%' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: compact ? 6 : 21, height: compact ? 2 : 4, borderRadius: 2,
        background: ok ? 'linear-gradient(90deg,' + P.left + ',' + P.mid + ' 50%,' + P.right + ')' : P.line, opacity: ok ? 0.6 : 1 }} />
      {!compact && Array.from({ length: 21 }).map((_, i) => (
        <div key={i} style={{ position: 'absolute', left: (i * 5) + '%', top: i % 5 === 0 ? 13 : 17, width: 1, height: i % 5 === 0 ? 20 : 12,
          background: i === 10 ? P.faint : P.line, transform: 'translateX(-0.5px)' }} />
      ))}
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
        {loc.status === 'missing' && <span style={{ fontSize: 12, color: P.faint }} title="This wording could not be matched in the transcript">not matched in transcript</span>}
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
    const un = FS.onValue(FS.ref(FS.db, analysesAddr), (s) => setItems(s.val() || {}));
    return () => un();
  }, [analysesAddr]);

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
    const u = new URL(window.location.href); u.searchParams.delete('slant');
    window.history.replaceState({}, '', u.toString()); setSel(null);
  };

  const [tx, setTx] = React.useState({});
  React.useEffect(() => {
    if (!sel || tx[sel] || !base) return;
    let live = true;
    FS.get(FS.ref(FS.db, base + '/transcripts/' + sel + '/snippets')).then((s) => {
      if (live) setTx((p) => ({ ...p, [sel]: asArr(s.val()) }));
    }).catch(() => live && setTx((p) => ({ ...p, [sel]: [] })));
    return () => { live = false; };
  }, [sel, base]);

  const [input, setInput] = React.useState('');
  const [job, setJob] = React.useState(null);
  const [tick, setTick] = React.useState(0);
  const running = job && job.phase !== 'error';
  React.useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const [active, setActive] = React.useState(null);
  const [play, setPlay] = React.useState({ start: 0, nonce: 0, auto: false });
  const [confirmDel, setConfirmDel] = React.useState(null);
  React.useEffect(() => { setActive(null); setPlay({ start: 0, nonce: 0, auto: false }); }, [sel]);

  const rec = sel && items ? items[sel] : null;
  const snips = sel ? tx[sel] : null;
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
          source: got.source, model: MODEL, segments: snipsN.length, duration: last ? last.t + last.d : 0, truncated, result: res,
          metadata: { type: 'entry', createdAt: t, updatedAt: t } }),
        ['transcripts/' + id]: { snippets: snipsN, metadata: { type: 'entry', createdAt: t, updatedAt: t } },
      });
      setTx((p) => ({ ...p, [id]: snipsN }));
      setJob(null); setInput('');
      openItem(id);
    } catch (e) {
      setJob((j) => ({ ...(j || {}), phase: 'error', error: (e && e.message) || String(e) }));
    }
  }

  async function reanalyze(id) {
    const r0 = items && items[id]; const s = tx[id];
    if (!r0 || !s || !oa.url) return;
    setJob({ phase: 'analyzing', started: Date.now(), vid: r0.videoId, reId: id });
    try {
      const { result: res, truncated } = await runAnalysis(oa.url, { title: r0.title, author: r0.author, source: r0.source }, s);
      await FS.update(FS.ref(FS.db, base + '/analyses/' + id), { result: clean(res), truncated, model: MODEL, 'metadata/updatedAt': Date.now() });
      setJob(null); setActive(null);
    } catch (e) { setJob((j) => ({ ...(j || {}), phase: 'error', error: (e && e.message) || String(e) })); }
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

  function renderInput(big) {
    return (
      <form onSubmit={(e) => { e.preventDefault(); if (!running && input.trim()) analyze(input); }}
        style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%', maxWidth: big ? 640 : 520, flexWrap: 'wrap' }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Paste a YouTube link" disabled={running}
          onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t && parseVideoId(t) && !running) { e.preventDefault(); setInput(t); analyze(t); } }}
          style={{ flex: '1 1 260px', minWidth: 0, height: big ? 46 : 38, padding: '0 18px', borderRadius: 999, border: '1px solid ' + P.line,
            background: P.field, color: P.ink, fontSize: big ? 15 : 13, outline: 'none' }} />
        <button type="submit" disabled={running || !input.trim()} style={{ ...pillBtn(true), height: big ? 46 : 38, padding: big ? '0 22px' : '0 16px',
          opacity: running || !input.trim() ? 0.5 : 1 }}>{running ? 'Working…' : 'Analyze'}</button>
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

  function renderRow(it) {
    const r = it.result || {};
    const d = it.metadata && it.metadata.createdAt ? new Date(it.metadata.createdAt) : null;
    return (
      <div key={it.id} className="slant-row" onClick={() => openItem(it.id)} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') openItem(it.id); }}
        style={{ display: 'grid', gridTemplateColumns: (w < 560 ? '96px' : '128px') + ' minmax(0,1fr)' + (w < 560 ? '' : ' 150px'), gap: 16,
          padding: '14px 0', borderTop: '1px solid ' + P.line, cursor: 'pointer', alignItems: 'center' }}>
        <img src={'https://i.ytimg.com/vi/' + it.videoId + '/mqdefault.jpg'} alt="" style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', borderRadius: 8, background: P.line }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: SERIF, fontSize: 16, lineHeight: 1.35, color: P.ink, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{it.title || it.videoId}</div>
          <div style={{ fontSize: 12, color: P.faint, marginTop: 4 }}>{[it.author, d && d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })].filter(Boolean).join(' · ')}</div>
          {r.headline && <div style={{ fontSize: 13, color: P.soft, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.headline}</div>}
          {w < 560 && <div style={{ fontSize: 12, color: P.faint, marginTop: 4 }}>{leanText(r.political)} · bias {Math.round(clamp(r.overall, 0, 10))}/10</div>}
        </div>
        {w >= 560 && (
          <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ width: 120 }} onClick={() => openItem(it.id)}><Axis pol={r.political} P={P} compact /></div>
            <div style={{ fontSize: 12, color: P.soft, fontVariantNumeric: 'tabular-nums' }}>{leanText(r.political)}</div>
            {confirmDel === it.id ? (
              <div style={{ display: 'flex', gap: 10, fontSize: 12 }}>
                <button onClick={() => remove(it.id)} style={{ background: 'none', border: 0, color: P.accent, cursor: 'pointer', fontSize: 12 }}>Remove</button>
                <button onClick={() => setConfirmDel(null)} style={{ background: 'none', border: 0, color: P.faint, cursor: 'pointer', fontSize: 12 }}>Keep</button>
              </div>
            ) : (
              <button className="slant-del" onClick={() => setConfirmDel(it.id)} style={{ background: 'none', border: 0, color: P.faint, cursor: 'pointer', fontSize: 12 }}>Remove</button>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderHome() {
    return (
      <div>
        <div style={{ padding: w < 600 ? '28px 0 8px' : '56px 0 12px' }}>
          <div style={label}>Slant</div>
          <h1 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: w < 600 ? 32 : 44, lineHeight: 1.1, letterSpacing: '-0.01em', margin: '14px 0 12px', color: P.ink }}>How slanted is this video?</h1>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: P.soft, maxWidth: 560, margin: '0 0 26px' }}>
            Paste a YouTube link. Slant reads the full transcript, scores political lean and five other kinds of bias, and shows the exact lines behind every score.
          </p>
          {renderInput(true)}
          {renderJob()}
        </div>
        {list.length > 0 && (
          <div style={{ marginTop: 44 }}>
            <div style={{ ...label, marginBottom: 6 }}>Analyzed · {list.length}</div>
            {list.map(renderRow)}
            <div style={{ borderTop: '1px solid ' + P.line }} />
          </div>
        )}
        {items && list.length === 0 && !job && (
          <div style={{ marginTop: 40, fontSize: 13, color: P.faint }}>Your analyses will collect here.</div>
        )}
      </div>
    );
  }

  function renderPlayer(vid) {
    const src = 'https://www.youtube-nocookie.com/embed/' + vid + '?rel=0&modestbranding=1&playsinline=1&start=' + play.start + (play.auto ? '&autoplay=1' : '');
    return (
      <div ref={playerRef} style={{ width: '100%', aspectRatio: '16/9', borderRadius: 12, overflow: 'hidden', background: '#000' }}>
        <iframe key={vid + '-' + play.nonce} src={src} title="YouTube video" style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
      </div>
    );
  }

  function renderQuotes(arr, prefix) {
    return asArr(arr).map((q, i) => {
      const key = prefix + i; const loc = located.m[key] || { seg: 0, status: 'missing' };
      return <QuoteItem key={key} q={q} loc={loc} snips={snips} P={P} active={active && active.key === key} onPlay={() => seekTo(loc.seg, key)} />;
    });
  }

  function renderAnalysis() {
    const r = result || {};
    const pol = r.political || {};
    const dims = asArr(r.dimensions);
    const byKey = {}; dims.forEach((d) => { byKey[d.key] = d; });
    const ov = clamp(r.overall, 0, 10);
    const reRunning = job && job.reId === sel && job.phase !== 'error';
    return (
      <div style={{ minWidth: 0 }}>
        <section>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 22, flexWrap: 'wrap' }}>
            <div>
              <div style={label}>Overall bias</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
                <span style={{ fontFamily: SERIF, fontSize: 56, lineHeight: 1, color: P.ink, fontVariantNumeric: 'tabular-nums' }}>{Math.round(ov * 10) / 10}</span>
                <span style={{ fontSize: 15, color: P.faint }}>/ 10 · {biasWord(ov)}</span>
              </div>
            </div>
          </div>
          <h2 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 26, lineHeight: 1.25, margin: '22px 0 10px', color: P.ink }}>{r.headline}</h2>
          <p style={{ fontSize: 15, lineHeight: 1.65, color: P.soft, margin: 0, maxWidth: 680 }}>{r.summary}</p>
          <div style={{ fontSize: 12, color: P.faint, marginTop: 12 }}>{[r.contentType, r.topic].filter(Boolean).join(' · ')}</div>
        </section>

        <section style={{ marginTop: 44 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <div style={label}>Political lean</div>
            <div style={{ fontSize: 12, color: P.faint }}>{pol.applicable ? pol.confidence + ' confidence' : ''}</div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, margin: '10px 0 8px', flexWrap: 'wrap' }}>
            <div style={{ fontFamily: SERIF, fontSize: 22, color: P.ink }}>{pol.applicable ? pol.label : 'No political content detected'}</div>
            <div style={{ fontSize: 14, color: P.soft, fontVariantNumeric: 'tabular-nums' }}>{pol.applicable ? leanText(pol) : ''}</div>
          </div>
          <Axis pol={pol} P={P} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: P.faint, letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: 4 }}>
            <span>Left −10</span><span>Center</span><span>Right +10</span>
          </div>
          {pol.explanation && <p style={{ fontSize: 15, lineHeight: 1.65, color: P.soft, margin: '18px 0 0', maxWidth: 680 }}>{pol.explanation}</p>}
          {renderQuotes(pol.quotes, 'p')}
        </section>

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
          <span>{[SRC_LABEL[rec.source] || rec.source, rec.segments ? rec.segments + ' lines' : '', rec.model, rec.truncated ? 'transcript truncated' : ''].filter(Boolean).join(' · ')}</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => reanalyze(sel)} disabled={!snips || !!running} style={{ ...pillBtn(false), height: 32, fontSize: 12, opacity: !snips || running ? 0.5 : 1 }}>{reRunning ? 'Re-analyzing…' : 'Re-analyze'}</button>
          <a href={'https://www.youtube.com/watch?v=' + rec.videoId} target="_blank" rel="noreferrer" style={{ ...pillBtn(false), height: 32, fontSize: 12, display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>Open on YouTube</a>
        </div>
        {job && job.reId === sel && renderJob()}
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
    const tHeight = wide ? 'max(260px, calc(100vh - var(--mana-top-inset, 72px) - 330px))' : 420;
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
          {!wide && renderPlayer(rec.videoId)}
          {renderAnalysis()}
          <aside style={wide ? { position: 'sticky', top: 'calc(var(--mana-top-inset, 72px) + 12px)', alignSelf: 'start' } : {}}>
            {wide && renderPlayer(rec.videoId)}
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
        {sel ? renderDetail() : renderHome()}
        {(ingress.error || oa.error) && !sel && (
          <div style={{ marginTop: 24, fontSize: 12, color: P.faint }}>
            {oa.error ? 'Analysis unavailable: ' + oa.error.message : 'Caption service offline; Slant will transcribe the audio instead.'}
          </div>
        )}
      </div>
    </div>
  );
}
