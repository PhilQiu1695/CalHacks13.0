// Slant setup page (the extension's Options page). Pairing, reconnecting and disconnecting this browser live here; the
// analysis itself is shown by the bear on YouTube. Opens automatically when the bear is tapped before this browser is connected.
import { h, clear } from './lib/dom.js';
import * as api from './lib/api.js';

const app = document.getElementById('app');
const st = { conn: null, link: '', label: '', busy: false, error: null, done: null, editing: false, showHow: false };
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
function defaultLabel() {
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || '';
  return 'Chrome' + (p ? ' on ' + p : '');
}
const LIMITS = [
  ['Auto-captions', 'YouTube’s automatic captions mishear names and words, and videos without captions are transcribed by AI, which can slip too.'],
  ['Short videos', 'A Short or a brief clip gives little to go on, so its scores rest on a handful of lines.'],
  ['Satire', 'Comedy, irony and impressions can read as slant even when the creator is joking.'],
  ['AI raters can carry their own lean', 'The ratings come from an AI model, which can have leanings and blind spots of its own. Read a score as a sourced opinion, not a verdict.'],
  ['Transcript only', 'Visuals, music, editing and on-screen text aren’t considered.'],
];

function mode() {
  const c = st.conn;
  if (!c || !c.key) return 'pair';
  if (st.revoked) return 'revoked';
  if (api.linkExpired(c)) return 'expired';
  return 'connected';
}

async function connect(m) {
  st.error = null;
  const p = api.parseLink(st.link);
  if (p.error) { st.error = p.error; render(); return; }
  st.busy = true; render();
  try {
    if ((m === 'expired' || m === 'update') && st.conn && st.conn.key && !p.code) {
      if (!p.base) throw new api.ApiErr('bad_link', 'Paste the reconnect link from Slant for Chrome in Mana.');
      const sess = await api.session(p.base, st.conn.key);
      st.conn = { ...st.conn, base: p.base, linkExp: p.exp, appUrl: sess.appUrl || st.conn.appUrl };
    } else {
      const base = p.base || (st.conn && st.conn.base);
      if (!base) throw new api.ApiErr('bad_link', 'Paste the whole pairing link. It starts with https://server-prod.mana.space/…');
      if (!p.code) throw new api.ApiErr('bad_link', 'This link has no pairing code. In Mana, click “Create pairing link” and copy the whole link.');
      const res = await api.pair(base, p.code, (st.label || defaultLabel()).slice(0, 40));
      const sess = await api.session(base, res.credential);
      st.conn = { base, key: res.credential, credentialId: res.credentialId, label: res.label, test: !!res.test, pairedAt: Date.now(),
                  linkExp: p.exp != null ? p.exp : (st.conn && st.conn.linkExp) || null, appUrl: sess.appUrl || null };
    }
    await api.setConn(st.conn);
    st.revoked = false; st.link = ''; st.busy = false; st.editing = false;
    const r = await chrome.runtime.sendMessage({ type: 'slant:connected' }).catch(() => ({}));
    st.done = r && r.returnedTo != null ? 'returned' : 'connected';
    render();
  } catch (e) {
    st.busy = false;
    st.error = e.code === 'unauthorized' ? 'This browser’s key no longer works. Paste a new pairing link instead.'
      : e.code === 'link_expired' ? 'That link has already expired. Copy a fresh one in Mana.' : e.message;
    if (e.code === 'unauthorized') st.revoked = true;
    render();
  }
}

async function disconnect() {
  await api.setConn(null);
  st.conn = null; st.done = null; st.editing = false; st.error = null;
  render();
}

function linkForm(m) {
  const box = h('textarea', { class: 'field', id: 'link', 'aria-label': 'Slant link', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'https://server-prod.mana.space/api/sandbox/ingress/…' });
  box.value = st.link;
  box.addEventListener('input', () => { st.link = box.value; });
  const label = h('input', { class: 'field', id: 'label', maxlength: '40', 'aria-label': 'Name for this browser' });
  label.value = st.label || defaultLabel();
  label.addEventListener('input', () => { st.label = label.value; });
  const pairing = m === 'pair' || m === 'revoked';
  return h('div', { class: 'mt' }, box,
    pairing && h('div', { class: 'mt' }, h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Name for this browser'), label),
    st.error && h('div', { class: 'err', role: 'alert' }, st.error),
    h('div', { class: 'row mt' },
      h('button', { class: 'btn primary', id: 'connect', disabled: st.busy, onclick: () => connect(m) },
        st.busy ? 'Connecting…' : pairing ? 'Connect' : m === 'update' ? 'Update link' : 'Reconnect'),
      m === 'update' && h('button', { class: 'btn', onclick: () => { st.editing = false; st.error = null; render(); } }, 'Cancel')));
}

function viewConnect(m) {
  const title = { pair: 'Connect this browser', revoked: 'This browser was disconnected', expired: 'Reconnect this browser' }[m];
  const intro = {
    pair: 'Slant sends the YouTube video you choose to your Slant backend in Mana, and the bear on the video shows how slanted it is.',
    revoked: 'Its key was removed in Slant for Chrome, or stopped working. Pair it again to keep using Slant.',
    expired: 'The link this browser uses to reach Slant has expired. Copy the reconnect link in Mana and paste it below. You won’t need to pair again.',
  }[m];
  const steps = m === 'expired'
    ? ['In Mana, open Apps › Slant for Chrome.', 'Click “Copy reconnect link”.', 'Paste it below and click Reconnect.']
    : ['In Mana, open Apps › Slant for Chrome.', 'Click “Create pairing link” and copy it.', 'Paste it below and click Connect. A pairing link works once, for 10 minutes.'];
  return h('section', { class: 'card', id: 'setup', 'data-mode': m },
    h('div', { class: 'label' }, 'Setup'), h('h1', null, title), h('p', { class: 'prose' }, intro),
    h('ol', { class: 'steps' }, steps.map((t) => h('li', null, t))),
    linkForm(m),
    m === 'expired' && h('div', { class: 'mt' }, h('button', { class: 'link', onclick: () => { st.revoked = true; st.error = null; render(); } }, 'Pair again instead')),
    h('p', { class: 'note' }, 'New analyses run on the Mana credits of the person who owns this Slant backend. Saved analyses open without new charges.'));
}

// Link to this browser's feed on Slant (the Slant page address the backend returned when the browser paired, plus ?slant=feed).
function feedUrl(c) {
  try { const u = new URL(c && c.appUrl); if (u.protocol !== 'https:') return null; u.searchParams.set('slant', 'feed'); return u.toString(); }
  catch { return null; }
}

function viewFeed(c) {
  const url = feedUrl(c);
  if (!url) return null;
  return h('section', { class: 'card', id: 'feed' },
    h('div', { class: 'label' }, 'Your feed'),
    h('p', { class: 'prose' }, 'Every video you analyze with our extension is saved to your feed on Slant, where you can view the average lean of the media you consume.'),
    h('div', { class: 'row mt' },
      h('a', { class: 'btn primary', id: 'open-feed', href: url, target: '_blank', rel: 'noopener' }, 'Open your feed ', h('span', { 'aria-hidden': 'true' }, '↗'))));
}

function viewConnected() {
  const c = st.conn;
  const soon = c.linkExp && c.linkExp - Date.now() < 3 * 86400000;
  return h('div', null,
    st.done && h('section', { class: 'card', id: 'connected-now', role: 'status' },
      h('div', { class: 'label' }, 'Connected'),
      h('h1', null, st.done === 'returned' ? 'You’re set. Your video is being analyzed.' : 'You’re set.'),
      h('p', { class: 'prose' }, st.done === 'returned'
        ? 'Go back to your YouTube tab: the bear shows the result in about half a minute. You can close this tab.'
        : 'Open any YouTube video or Short and tap the bear at the top right. You can close this tab.')),
    h('section', { class: 'card', id: 'status' },
      h('div', { class: 'label' }, 'This browser'),
      h('dl', { class: 'kv' },
        h('dt', null, 'Connected as'), h('dd', null, c.label || 'this browser'),
        c.linkExp ? h('dt', null, 'Link valid until') : null, c.linkExp ? h('dd', null, fmtDate(c.linkExp)) : null),
      soon && h('p', { class: 'err' }, 'This connection link expires soon. Copy a fresh reconnect link in Mana and update it here.'),
      st.editing ? linkForm('update') : h('div', { class: 'row mt' },
        h('button', { class: 'btn', id: 'update-open', onclick: () => { st.editing = true; st.error = null; render(); } }, 'Update connection link'),
        h('button', { class: 'btn', id: 'disconnect', onclick: disconnect }, 'Disconnect')),
      h('p', { class: 'note' }, 'Disconnecting removes the key from this browser only. To revoke it, use Paired browsers in Slant for Chrome in Mana.')),
    viewFeed(c),
    h('section', { class: 'card' },
      h('div', { class: 'label' }, 'How to use it'),
      h('p', { class: 'prose' }, 'Open a YouTube video or Short and tap the bear at the top right (or press Alt+Shift+S). Tap it again for the details, and open the full report for quotes and the transcript.')));
}

function viewHow() {
  return h('section', { class: 'card how' },
    h('button', { class: 'link', 'aria-expanded': String(st.showHow), onclick: () => { st.showHow = !st.showHow; render(); } },
      st.showHow ? 'Hide how Slant works' : 'How Slant works'),
    st.showHow && h('div', null,
      h('p', null, h('b', null, 'Political lean'), ', from −6 (left) to +6 (right), with five bands: Left, Lean Left, Center, Lean Right and Right. The scale and bands follow the AllSides Media Bias Meter, on the conventional US axis unless the video is about another country’s politics.'),
      h('p', null, h('b', null, 'How slanted'), ', from 0 (fair and balanced) to 10 (extreme): how far the presentation departs from fair, balanced treatment, toward either side. A Center video can still score high, and a clearly partisan one can score low if it argues fairly.'),
      h('p', null, h('b', null, 'It rates presentation, not truth.'), ' Slant judges how a video makes its case, not whether its claims are true. It isn’t a fact-checker.'),
      h('p', null, h('b', null, 'Scores cite verified quotes.'), ' On the full report, every quote is checked against the transcript before it’s shown.'),
      LIMITS.map(([t, d]) => h('p', null, h('b', null, t + '.'), ' ' + d))));
}

function render() {
  clear(app);
  const m = mode();
  app.append(
    h('div', { class: 'brand' }, h('img', { src: 'icons/icon128.png', alt: '' }),
      h('div', null, h('div', { class: 'name' }, 'Slant for YouTube'), h('div', { class: 'sub' }, 'How slanted is this video?'))),
    m === 'connected' ? viewConnected() : viewConnect(m),
    viewHow());
}

chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.conn && !st.busy) { st.conn = ch.conn.newValue || null; render(); } });
api.getConn().then((c) => { st.conn = c; render(); });
globalThis.__slantSetup = { state: () => JSON.parse(JSON.stringify(st)) };
