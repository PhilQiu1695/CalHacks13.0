
// Evaluates the live Slant app's non-UI helpers (everything before `function palette`) with a stubbed fetch,
// and writes (1) slant_spec.json: the exact prompt, schema and constants, (2) golden.json: request bodies and
// parse results the Python backend must reproduce.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const CODE = arg('--code', path.join(ROOT, 'reference/slant-app.jsx'));
const OUT_SPEC = arg('--out-spec', path.join(ROOT, 'spec/slant_spec.json'));
const GOLDEN = !argv.includes('--no-golden');
const code = fs.readFileSync(CODE, 'utf8');
const head = code.slice(0, code.indexOf('function palette'));
const captured = [];
let nextResponse = null;
const fetchStub = async (url, opts) => { captured.push({ url, body: JSON.parse(opts.body) }); return nextResponse; };
const names = ['MODEL', 'GEM_MODEL', 'MAX_CHARS', 'DIMS', 'SRC_LABEL', 'LEAN_BANDS', 'SLANT_EXPLAINER', 'SYSTEM', 'SCHEMA',
  'fmtT', 'locate', 'buildIndex', 'norm', 'parseVideoId', 'leanScore', 'leanBand', 'fmtLean', 'biasWord', 'geminiTranscript', 'runAnalysis',
  'unpackResult', 'packResult'];
const M = new Function('fetch', head + '\nreturn {' + names.join(',') + '};')(fetchStub);
const ok = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });

(async () => {
  // Gemini transcription request + parse cases
  nextResponse = ok({ candidates: [{ content: { parts: [{ text: '[{"t":0,"text":"Hello there."},{"t":4.5,"text":"Second line."}]' }] } }] });
  const g1 = await M.geminiTranscript('https://ROUTER', 'abcdefghijk');
  const gemReq = captured.pop();
  const gemCases = [
    { name: 'plain', parts: [{ text: '[{"t":0,"text":"Hello there."},{"t":4.5,"text":"Second line."}]' }] },
    { name: 'fenced+thought', parts: [{ text: 'thinking', thought: true }, { text: '```json\n[{"t":"1.5","text":"  A  "},{"t":3,"text":""},{"t":7,"text":"B"}]\n```' }] },
    { name: 'truncated', parts: [{ text: '[{"t":0,"text":"one"},{"t":5,"text":"two"},{"t":9,"text":"thr' }] },
    { name: 'garbage', parts: [{ text: 'not json at all' }] },
  ];
  const gemGolden = [];
  for (const c of gemCases) {
    nextResponse = ok({ candidates: [{ content: { parts: c.parts } }] });
    try { gemGolden.push({ name: c.name, parts: c.parts, out: await M.geminiTranscript('https://ROUTER', 'abcdefghijk') }); }
    catch (e) { gemGolden.push({ name: c.name, parts: c.parts, error: e.message }); }
    captured.pop();
  }
  // Analysis request bodies: the Saudi transcript, and a long synthetic one that triggers truncation
  const fxPath = path.join(ROOT, 'tests/fixtures/saudi.json');
  const fx = fs.existsSync(fxPath) ? JSON.parse(fs.readFileSync(fxPath, 'utf8')) : { snips: [{ t: 0, d: 1, text: 'x' }], meta: {} };
  const content = JSON.stringify({ headline: 'h' });
  nextResponse = ok({ choices: [{ message: { content } }] });
  const a1 = await M.runAnalysis('https://ROUTER', fx.meta, fx.snips);
  const body1 = captured.pop().body;
  const long = Array.from({ length: 5200 }, (_, i) => ({ t: i * 3.7, d: 3.5, text: 'Line ' + i + ' with\u00a0unicode \u2014 caf\u00e9 \ud83d\ude00 and  spaces\t' + 'x'.repeat(40) }));
  nextResponse = ok({ choices: [{ message: { content } }] });
  const a2 = await M.runAnalysis('https://ROUTER', { title: '', author: 'Chan', source: 'ai-transcription' }, long);
  const body2 = captured.pop().body;
  if (GOLDEN) fs.writeFileSync(path.join(ROOT, 'tests/fixtures/long.json'), JSON.stringify({ snips: long, meta: { title: '', author: 'Chan', source: 'ai-transcription' } }));

  const spec = {
    source: 'apps/slant/app/code (live), extracted ' + new Date().toISOString(),
    MODEL: M.MODEL, GEM_MODEL: M.GEM_MODEL, MAX_CHARS: M.MAX_CHARS, DIMS: M.DIMS, SRC_LABEL: M.SRC_LABEL, LEAN_BANDS: M.LEAN_BANDS,
    SLANT_EXPLAINER: M.SLANT_EXPLAINER, SYSTEM: M.SYSTEM, SCHEMA: M.SCHEMA,
    GEMINI_REQUEST: gemReq.body, GEMINI_PATH: gemReq.url.replace('https://ROUTER', ''),
    ANALYSIS_TRUNCATION_NOTE: '\nNote: only the first part of the transcript fits; say so in caveats.',
  };
  fs.writeFileSync(OUT_SPEC, JSON.stringify(spec, null, 1));
  if (GOLDEN) fs.writeFileSync(path.join(ROOT, 'spec/golden.json'), JSON.stringify({
    gemini: gemGolden, analysisSaudi: { body: body1, truncated: a1.truncated }, analysisLong: { body: body2, truncated: a2.truncated },
    fmtT: [0, 9.9, 61, 3599, 3600, 3661.7, 86399].map((s) => [s, M.fmtT(s)]),
  }));
  console.log('spec ok', M.MODEL, M.GEM_MODEL, 'system', M.SYSTEM.length, 'schema keys', Object.keys(M.SCHEMA.properties).length,
    '| gemini path', spec.GEMINI_PATH, '| long truncated', a2.truncated, '| golden gemini', gemGolden.map((g) => g.name + ':' + (g.error ? 'err' : g.out.length)).join(' '));
})().catch((e) => { console.error('EXTRACT FAILED', e); process.exit(1); });
