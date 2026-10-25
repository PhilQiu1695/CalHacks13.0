// Slant service worker. There is no side panel: this worker starts analyses on the Slant backend and follows them, and the
// bear on the YouTube page shows the result. It acts only on an explicit tap (the bear, the toolbar button or Alt+Shift+S).
// No tab monitoring, no history beyond the last few analyses' scores, no analysis on navigation.
//
// State, in chrome.storage.local:
//   conn            this browser's connection (setup page)
//   reqs[videoId]   { id, videoId, url, isShort, idemKey, mode, createdAt, jobId, job, error }  (newest 20; transcripts dropped)
// and in chrome.storage.session:
//   pending         a tap made before this browser was connected; analyzed as soon as it is.
import { parseYouTube } from './lib/ytid.js';
import * as api from './lib/api.js';

const ACTIVE = new Set(['queued', 'running']);
const isActive = (job) => !!job && ACTIVE.has(job.state);
const newKey = () => 'ext_' + crypto.randomUUID().replace(/-/g, '');
const CONN_ERRORS = new Set(['link_expired', 'link_invalid', 'unauthorized', 'not_paired']);
const MAX_REQS = 20;
const polling = new Map();          // videoId -> { timer, fails }

chrome.runtime.onInstalled.addListener(() => { chrome.storage.local.remove('req').catch(() => {}); });   // 1.3 side-panel state

// ---------- storage ----------
async function getReqs() { return (await chrome.storage.local.get('reqs')).reqs || {}; }
async function getReq(vid) { return (await getReqs())[vid] || null; }
let writing = Promise.resolve();
function putReq(req) {                 // serialized read-modify-write, so parallel videos never overwrite each other
  writing = writing.then(async () => {
    const reqs = await getReqs();
    reqs[req.videoId] = req;
    Object.keys(reqs).sort((a, b) => (reqs[b].createdAt || 0) - (reqs[a].createdAt || 0)).slice(MAX_REQS).forEach((k) => delete reqs[k]);
    await chrome.storage.local.set({ reqs });
  }).catch(() => {});
  return writing;
}
// Transcripts are only needed on the full report, so they are never stored here.
function slim(job) {
  if (!job) return job;
  const j = { ...job, _recv: Date.now() };
  if (j.result && typeof j.result === 'object') { j.result = { ...j.result }; delete j.result.snippets; }
  return j;
}

// ---------- jobs ----------
async function connState() {
  const conn = await api.getConn();
  if (!conn || !conn.key) return 'not_paired';
  if (api.linkExpired(conn)) return 'link_expired';
  return null;
}

async function start(video, mode) {
  stopPoll(video.videoId);
  const req = { id: crypto.randomUUID(), videoId: video.videoId, url: video.canonicalUrl, isShort: !!video.isShort,
                idemKey: newKey(), mode: mode || 'auto', createdAt: Date.now(), jobId: null, job: null, error: null };
  await putReq(req);
  await submit(req);
  return req;
}

async function submit(req) {
  try {
    const { debug, conn } = await chrome.storage.local.get(['debug', 'conn']);    // debug: test browsers only (set by the test harness)
    const extra = debug && debug.simulate && conn && conn.test ? { simulate: debug.simulate } : undefined;
    const res = await api.submitJob(req.url, req.idemKey, req.mode, extra);
    const cur = await getReq(req.videoId);
    if (!cur || cur.id !== req.id) return;
    cur.jobId = res.job.id; cur.job = slim(res.job); cur.error = null;
    await putReq(cur);
    if (isActive(res.job)) schedulePoll(cur.videoId, 1200);
  } catch (e) {
    const cur = await getReq(req.videoId);
    if (!cur || cur.id !== req.id) return;
    cur.error = { code: e.code, message: e.message, retryable: !!e.retryable, conn: CONN_ERRORS.has(e.code) };
    await putReq(cur);
  }
}

function stopPoll(vid) { const p = polling.get(vid); if (p) clearTimeout(p.timer); polling.delete(vid); }
function schedulePoll(vid, ms) {
  const p = polling.get(vid) || { timer: 0, fails: 0 };
  clearTimeout(p.timer);
  p.timer = setTimeout(() => poll(vid), ms);
  polling.set(vid, p);
}

async function poll(vid) {
  const p = polling.get(vid) || { timer: 0, fails: 0 };
  const req = await getReq(vid);
  if (!req || !req.jobId || !isActive(req.job)) { stopPoll(vid); return; }
  try {
    const { job } = await api.getJob(req.jobId);
    const cur = await getReq(vid);
    if (!cur || cur.id !== req.id) { stopPoll(vid); return; }
    p.fails = 0;
    cur.job = slim(job); cur.error = null;
    await putReq(cur);
    if (isActive(job)) schedulePoll(vid, 1500); else stopPoll(vid);
  } catch (e) {
    const cur = await getReq(vid);
    if (!cur || cur.id !== req.id) { stopPoll(vid); return; }
    if (CONN_ERRORS.has(e.code)) {
      cur.error = { code: e.code, message: e.message, retryable: false, conn: true, polling: true };
      await putReq(cur); stopPoll(vid); return;
    }
    if (e.code === 'not_found') {
      cur.job = null; cur.jobId = null; cur.idemKey = newKey();
      cur.error = { code: 'not_found', message: 'Slant’s backend no longer has this job (it may have been reset). Your Slant history is unaffected.', retryable: true };
      await putReq(cur); stopPoll(vid); return;
    }
    p.fails += 1;
    polling.set(vid, p);
    if (p.fails > 6) {
      cur.error = { code: e.code, message: e.message, retryable: true, polling: true };
      await putReq(cur); stopPoll(vid); return;
    }
    schedulePoll(vid, Math.min(20000, 1500 * 2 ** p.fails));
  }
}

// Called on every tap and on the bear's periodic nudge while it shows "Analyzing": resumes a job the worker lost when Chrome
// stopped it, and re-sends a submit that never reached the backend (the same idempotency key makes that safe).
async function resume(vid) {
  const req = await getReq(vid);
  if (!req || polling.has(vid)) return;
  if (req.jobId && isActive(req.job)) schedulePoll(vid, 0);
  else if (!req.jobId && !req.error) submit(req);
}

// What a tap does. mode: 'auto' (show the saved or running analysis, else start one), 'fresh' (re-analyze), 'retry'.
async function tap(video, mode, tabId) {
  const problem = await connState();
  if (problem) {
    await chrome.storage.session.set({ pending: { video, tabId: tabId == null ? null : tabId, at: Date.now() } });
    await chrome.runtime.openOptionsPage();
    return { setup: problem };
  }
  const cur = await getReq(video.videoId);
  if (mode === 'auto' && cur && cur.job && (isActive(cur.job) || cur.job.state === 'done')) { resume(video.videoId); return { ok: true }; }
  if (mode === 'retry' && cur && cur.error && cur.error.polling && cur.jobId && !cur.error.conn) {
    cur.error = null; await putReq(cur); schedulePoll(video.videoId, 0); return { ok: true };
  }
  if (mode === 'retry' && cur && !cur.jobId && cur.error && !cur.error.conn) {
    cur.error = null; await putReq(cur); submit(cur); return { ok: true };
  }
  start(video, mode === 'fresh' ? 'fresh' : (cur && cur.mode) || 'auto');
  return { ok: true };
}

// After pairing or reconnecting on the setup page: analyze the tap that was waiting, and resume anything a dead link stopped.
async function afterConnect() {
  const { pending } = await chrome.storage.session.get('pending');
  await chrome.storage.session.remove('pending');
  const reqs = await getReqs();
  for (const r of Object.values(reqs)) {
    if (r.error && r.error.conn) { r.error = null; await putReq(r); if (r.jobId) schedulePoll(r.videoId, 0); else submit(r); }
  }
  if (pending && pending.video && Date.now() - pending.at < 30 * 60000) {
    await tap(pending.video, 'auto', pending.tabId);
    if (pending.tabId != null) chrome.tabs.update(pending.tabId, { active: true }).catch(() => {});
    return { returnedTo: pending.tabId };
  }
  return {};
}

// ---------- entry points ----------
// The toolbar button and Alt+Shift+S: on a YouTube video, the same as tapping the bear; anywhere else, the setup page.
chrome.action.onClicked.addListener((tab) => {
  const video = parseYouTube(tab.url || '');            // readable because the click granted activeTab
  if (!video) { chrome.runtime.openOptionsPage(); return; }
  chrome.tabs.sendMessage(tab.id, { type: 'slant:toolbar' }).catch(() => tap(video, 'auto', tab.id));
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return;
  // The bear runs on youtube.com; the setup page is an extension page (opened in a tab, so sender.tab is set for both).
  const fromPage = !!sender.tab && typeof sender.url === 'string' && sender.url.startsWith('https://www.youtube.com/');
  const fromSetup = typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  const video = fromPage && typeof msg.url === 'string' && /^https:\/\/www\.youtube\.com\/(watch\?|shorts\/)/.test(msg.url) ? parseYouTube(msg.url) : null;
  let work = null;
  if (msg.type === 'slant:analyze' && video) work = tap(video, ['auto', 'fresh', 'retry'].includes(msg.mode) ? msg.mode : 'auto', sender.tab.id);
  else if (msg.type === 'slant:poke' && video) work = resume(video.videoId).then(() => ({ ok: true }));
  else if (msg.type === 'slant:open-setup' && fromPage) work = chrome.storage.session.set({ pending: video ? { video, tabId: sender.tab.id, at: Date.now() } : null })
    .then(() => chrome.runtime.openOptionsPage()).then(() => ({ ok: true }));
  else if (msg.type === 'slant:connected' && fromSetup) work = afterConnect();
  if (!work) return;
  work.then((r) => reply(r || { ok: true }), (e) => reply({ error: String((e && e.message) || e) }));
  return true;
});

globalThis.__slantBg = { getReqs, polling: () => [...polling.keys()] };   // for the browser tests
