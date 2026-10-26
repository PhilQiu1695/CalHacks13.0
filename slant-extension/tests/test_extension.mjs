// Extension logic tests (Node): URL parsing parity with the backend, quote matching parity with the Slant app,
// connection-link parsing, manifest permissions, and a static check for HTML-injection sinks.  Run: node tests/test_extension.mjs
import fs from 'fs';
import path from 'path';
import assert from 'assert/strict';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } } };
const { parseYouTube, watchAt } = await import(path.join(EXT, 'lib/ytid.js'));
const core = await import(path.join(EXT, 'lib/slant-core.js'));
const api = await import(path.join(EXT, 'lib/api.js'));
const results = [];
const test = (name, fn) => { fn(); results.push(name); };

test('URL cases match the backend table', () => {
  for (const [url, want, short] of JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/ytid_cases.json'), 'utf8'))) {
    const got = parseYouTube(url);
    assert.equal(got ? got.videoId : null, want, url);
    if (want) { assert.equal(got.isShort, short, url); assert.ok(got.canonicalUrl.startsWith('https://www.youtube.com/'), url); }
  }
  assert.equal(watchAt('lmjHE8CEhPM', 61.9), 'https://www.youtube.com/watch?v=lmjHE8CEhPM&t=61s');
});

test('quote matching and score helpers equal the Slant app’s own functions', () => {
  const code = fs.readFileSync(path.join(ROOT, 'reference/slant-app.jsx'), 'utf8');
  const head = code.slice(0, code.indexOf('function palette'));
  const app = new Function('fetch', head + '\nreturn { fmtT, buildIndex, locate, leanScore, leanBand, fmtLean, biasWord };')(() => {});
  const snips = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/saudi.json'), 'utf8')).snips;
  const a = app.buildIndex(snips), b = core.buildIndex(snips);
  const quotes = [
    { seg: 2, quote: 'Riyadh Airport is closed and we figured' }, { seg: 50, quote: 'riyadh airport is CLOSED!' },
    { seg: 9, quote: 'More and more people are taking the land route out of Saudi Arabia' },
    { seg: 9, quote: 'More and more people are taking a completely different road' }, { seg: 3, quote: 'totally invented sentence nowhere' },
    { seg: 'x', quote: '' }, { seg: 999, quote: 'driving through the desert right now. I need to get to Dubai.' }, null,
  ];
  for (const q of quotes) assert.deepEqual(core.locate(b, snips, q), app.locate(a, snips, q), JSON.stringify(q));
  assert.equal(core.locate(b, snips, quotes[0]).status, 'exact');
  assert.equal(core.locate(b, snips, quotes[3]).status, 'partial');
  assert.equal(core.locate(b, snips, quotes[4]).status, 'missing');
  for (const sec of [0, 9.9, 61, 3599, 3600, 3661.7, 'x', -5]) assert.equal(core.fmtT(sec), app.fmtT(sec));
  for (const v of [-10, -6, -3, -3.04, -2.96, -1, -0.96, 0, 0.95, 1, 2.94, 2.96, 3, 6, 10, 'x', null]) {
    const pol = { score: v };
    assert.equal(core.leanScore(pol), app.leanScore(pol));
    assert.equal(core.leanBand(core.leanScore(pol)), app.leanBand(app.leanScore(pol)));
    assert.equal(core.fmtLean(core.leanScore(pol)), app.fmtLean(app.leanScore(pol)));
  }
  for (const v of [0, 2.4, 2.5, 4.5, 6.5, 8.5, 10]) assert.equal(core.biasWord(v), app.biasWord(v));
});

test('the bear’s labels match the Slant app', () => {
  const src = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
  const grab = (name) => src.slice(src.indexOf('function ' + name + '('), src.indexOf('\n  }\n', src.indexOf('function ' + name + '(')) + 4);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, Number(v) || 0));
  const bear = new Function('clamp', grab('bearLeanLabel') + '\n' + grab('bearScoreWord') + '\nreturn { bearLeanLabel, bearScoreWord };')(clamp);
  for (const v of [-10, -6, -3, -3.04, -2.96, -1.04, -1, -0.96, 0, 0.95, 1, 2.94, 2.96, 3, 6, 10, 'x', null])
    assert.equal(bear.bearLeanLabel(v), core.LEAN_BANDS[core.leanBand(core.leanScore({ score: v }))].label, 'lean ' + v);
  for (const v of [0, 2.4, 2.5, 4.5, 6.5, 8.5, 10, 'x']) assert.equal(bear.bearScoreWord(v), core.biasWord(v), 'word ' + v);
});

test('connection links are validated', () => {
  const jwt = (c) => 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify(c)).toString('base64url') + '.c2ln';
  const good = 'https://server-prod.mana.space/api/sandbox/ingress/' + jwt({ service: 'slant-ext', exp: 2000000000 }) + '/slant-ext';
  let p = api.parseLink(good + '#pair=abcd-ef12');
  assert.equal(p.base, good); assert.equal(p.code, 'abcd-ef12'); assert.equal(p.exp, 2000000000000);
  p = api.parseLink(good + '/');
  assert.equal(p.base, good); assert.equal(p.code, null);
  assert.equal(api.parseLink(' abcd-ef12 ').code, 'ABCD-EF12');
  assert.ok(api.parseLink('https://evil.example/api/sandbox/ingress/' + jwt({ service: 'slant-ext' }) + '/slant-ext').error);
  assert.ok(api.parseLink('https://server-prod.mana.space/api/sandbox/ingress/' + jwt({ service: 'yt-bias' }) + '/slant-ext').error);
  assert.ok(api.parseLink('https://server-prod.mana.space/api/sandbox/ingress/' + jwt({ service: 'slant-ext' }) + '/yt-bias').error);
  assert.ok(api.parseLink('http://server-prod.mana.space/api/sandbox/ingress/' + jwt({ service: 'slant-ext' }) + '/slant-ext').error);
  assert.ok(api.parseLink('not a link').error);
  assert.equal(api.linkExpired({ linkExp: Date.now() - 1 }), true);
  assert.equal(api.linkExpired({ linkExp: Date.now() + 60000 }), false);
});

test('manifest keeps permissions minimal', () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual([...m.permissions].sort(), ['activeTab', 'storage']);
  assert.equal(m.side_panel, undefined, 'no side panel');
  assert.deepEqual(m.options_ui, { page: 'setup.html', open_in_tab: true });
  assert.deepEqual(m.host_permissions, ['https://server-prod.mana.space/api/sandbox/ingress/*']);
  // The only content script is the bear: YouTube pages only, one file, no extra permissions.
  assert.deepEqual(m.content_scripts, [{ matches: ['https://www.youtube.com/*'], js: ['content.js'], run_at: 'document_idle' }]);
  for (const k of ['optional_permissions', 'web_accessible_resources', 'externally_connectable']) assert.equal(m[k], undefined, k);
  assert.equal(m.background.type, 'module');
  for (const f of [m.background.service_worker, m.options_ui.page, ...Object.values(m.icons)]) assert.ok(fs.existsSync(path.join(EXT, f)), f);
});

test('the card states the lean in words, the five signals, and links to the report', () => {
  const src = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
  for (const s of ['Full report ↗', 'Political lean', 'AllSides scale', 'Not political', 'Other signals', "' / 10'", 'out of 10', 'Close',
                   'Tap me to analyze', 'Tap me for results', 'Tap me again to hide', 'scrollbar-width:none'])
    assert.ok(src.includes(s), 'card text: ' + s);
  assert.ok(/target: '_blank', rel: 'noopener noreferrer'/.test(src), 'report link opens safely in a new tab');
  assert.ok(src.includes("/^https:\\/\\/www\\.mana\\.space\\//"), 'only Slant website links');
});

test('the bear in content.js is the current lib/bear.js (run scripts/build_bear.py after editing it)', () => {
  const src = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
  const bear = fs.readFileSync(path.join(EXT, 'lib/bear.js'), 'utf8');
  const start = src.indexOf('  const Bear = (() => {\n'), end = src.indexOf('    return { compose, draw, scoresFromResult, aggregate, W, H };');
  assert.ok(start > 0 && end > start, 'generated bear block present');
  const inlined = src.slice(start + '  const Bear = (() => {\n'.length, end).split('\n').map((l) => l.replace(/^    /, '')).join('\n').trimEnd();
  assert.equal(inlined, bear.replace(/^export /gm, '').trimEnd(), 'content.js holds a stale copy of lib/bear.js');
  assert.ok(!/function compose\(/.test(src.slice(0, start)) && !/function compose\(/.test(src.slice(end)), 'no second copy of the drawing code');
});

test('no HTML injection sinks, dynamic code or remote scripts', () => {
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)));
  walk(EXT);
  for (const f of files.filter((f) => /\.(js|html)$/.test(f))) {
    const src = fs.readFileSync(f, 'utf8');
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'importScripts', 'chrome.scripting'])
      assert.ok(!src.includes(bad), path.relative(EXT, f) + ' uses ' + bad);
    for (const m of src.matchAll(/<script[^>]*src="([^"]+)"/g)) assert.ok(!/^https?:/.test(m[1]), 'remote script in ' + f);
    for (const m of src.matchAll(/import[^'"]*['"]([^'"]+)['"]/g)) assert.ok(m[1].startsWith('./'), 'non-local import ' + m[1] + ' in ' + f);
  }
});

console.log('extension logic tests passed: ' + results.length + '\n - ' + results.join('\n - '));
