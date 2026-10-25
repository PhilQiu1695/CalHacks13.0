
const SERIF = "Georgia, 'Times New Roman', serif";
const ZIP = 'slant-for-youtube-1.4.0.zip';
const SRC_ZIP = 'slant-extension-source-1.4.0.zip';
const DOC_TABS = [['guide', 'Guide'], ['testReport', 'Test report'], ['demo', 'Demo script'], ['limitations', 'Limitations'], ['implementation', 'How it’s built']];

function palette(dark) {
  return dark ? {
    ink: '#F4F4F5', soft: 'rgba(244,244,245,0.66)', faint: 'rgba(244,244,245,0.42)', line: 'rgba(255,255,255,0.11)',
    surface: 'rgba(255,255,255,0.04)', accent: '#F07A5F', ok: '#7FB98B', bad: '#E58A7E', hl: 'rgba(240,122,95,0.16)',
  } : {
    ink: '#18181B', soft: 'rgba(24,24,27,0.66)', faint: 'rgba(24,24,27,0.42)', line: 'rgba(24,24,27,0.10)',
    surface: 'rgba(24,24,27,0.03)', accent: '#E8654A', ok: '#3D8A55', bad: '#C2473B', hl: 'rgba(232,101,74,0.12)',
  };
}

function linkExpiry(url) {
  try {
    const p = url.split('/ingress/')[1].split('/')[0].split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(p + '='.repeat((4 - (p.length % 4)) % 4))).exp * 1000;
  } catch (e) { return null; }
}
const fmtDate = (ms, withTime) => (ms ? new Date(ms).toLocaleString(undefined, withTime
  ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
function ago(ms, now) {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return fmtDate(ms);
}
function dur(ms) { if (!ms) return ''; const s = Math.round(ms / 1000); return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s'; }

function UserDiv() {
  const { theme } = useTheme();
  const P = palette(theme === 'dark');
  const ing = useIngressUrl('slant-ext', { ttlSeconds: 2592000 });
  const files = useStorageUrl('dist');
  const docsAddr = relPathAddress('docs');
  const [docs, setDocs] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [pair, setPair] = React.useState(null);
  const [busy, setBusy] = React.useState('');
  const [copied, setCopied] = React.useState('');
  const [confirm, setConfirm] = React.useState(null);
  const [tab, setTab] = React.useState('guide');
  const [showRevoked, setShowRevoked] = React.useState(false);
  const [now, setNow] = React.useState(Date.now());
  const base = ing.url || null;

  React.useEffect(() => {
    if (!docsAddr) return undefined;
    const un = FS.onValue(FS.ref(FS.db, docsAddr), (s) => setDocs(s.val() || {}));
    return () => un();
  }, [docsAddr]);
  React.useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const call = React.useCallback(async (method, path, body) => {
    const user = FS.auth.currentUser;
    if (!user) throw new Error('Sign in to manage Slant for Chrome.');
    const tok = await user.getIdToken();
    const r = await fetch(base + path, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || j.detail || ('Request failed (' + r.status + ')'));
    return j;
  }, [base]);

  const refresh = React.useCallback(async () => {
    if (!base) return;
    try { setStatus(await call('GET', '/v1/owner/status')); setErr(null); } catch (e) { setErr((e && e.message) || String(e)); }
  }, [base, call]);
  React.useEffect(() => { refresh(); const t = setInterval(refresh, 15000); return () => clearInterval(t); }, [refresh]);

  async function createPairing() {
    setBusy('pair');
    try { const j = await call('POST', '/v1/owner/pairing-codes', {}); setPair({ code: j.code, link: base + '#pair=' + j.code, expiresAt: j.expiresAt }); }
    catch (e) { setErr(e.message); }
    setBusy('');
  }
  async function revoke(id) {
    setBusy('revoke:' + id);
    try { await call('POST', '/v1/owner/credentials/' + id + '/revoke', {}); setConfirm(null); await refresh(); } catch (e) { setErr(e.message); }
    setBusy('');
  }
  async function claim(id) {
    setBusy('claim:' + id);
    try { await call('POST', '/v1/owner/credentials/' + id + '/claim', {}); await refresh(); } catch (e) { setErr(e.message); }
    setBusy('');
  }
  async function syncSpec() {
    setBusy('sync');
    try { await call('POST', '/v1/owner/spec/sync', {}); await refresh(); } catch (e) { setErr(e.message); }
    setBusy('');
  }
  async function copy(key, value) {
    const r = await copyText(value);
    setCopied(r === 'failed' ? 'failed:' + key : key);
    setTimeout(() => setCopied(''), 2000);
  }

  const label = { fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: P.faint, fontWeight: 500 };
  const pill = (primary) => ({ display: 'inline-flex', alignItems: 'center', gap: 8, height: 36, padding: '0 16px', borderRadius: 999, fontSize: 13,
    fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap', textDecoration: 'none', border: '1px solid ' + (primary ? P.ink : P.line),
    background: primary ? P.ink : 'transparent', color: primary ? (theme === 'dark' ? '#18181B' : '#FFFFFF') : P.ink });
  const small = { ...pill(false), height: 30, padding: '0 12px', fontSize: 12 };
  const linkBtn = { background: 'none', border: 0, padding: 0, color: P.soft, fontSize: 12, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 };
  const section = { marginTop: 34, paddingTop: 22, borderTop: '1px solid ' + P.line };
  const h2 = { fontFamily: SERIF, fontWeight: 400, fontSize: 22, lineHeight: 1.25, margin: '6px 0 10px', color: P.ink };
  const para = { fontSize: 14, lineHeight: 1.65, color: P.soft, margin: '0 0 10px' };
  const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: 1.5, wordBreak: 'break-all',
    background: P.surface, border: '1px solid ' + P.line, borderRadius: 10, padding: '10px 12px', color: P.ink };

  const linkExp = base ? linkExpiry(base) : null;
  const creds = (status && status.credentials) || [];
  const live = creds.filter((c) => !c.revoked_at);
  const revoked = creds.filter((c) => c.revoked_at);
  const jobs = ((status && status.jobs) || []).filter((j) => !j.simulate);
  const spec = status && status.spec;
  const online = !!status && !err;
  const zipUrl = files.url ? files.url + ZIP : null;
  const srcUrl = files.url ? files.url + SRC_ZIP : null;
  const pairLeft = pair ? Math.max(0, pair.expiresAt - now) : 0;
  const copyBtn = (key, value, text) => (
    <button onClick={() => copy(key, value)} style={small}>{copied === key ? 'Copied' : copied === 'failed:' + key ? 'Copy failed' : text || 'Copy'}</button>
  );
  const dot = (color) => <span style={{ width: 8, height: 8, borderRadius: 99, background: color, display: 'inline-block' }} />;

  function stateChip(j) {
    const t = j.state === 'done' ? (j.cached ? 'saved result' : 'new analysis') : j.state === 'failed' ? (j.error_code || 'failed').replace(/_/g, ' ') : j.state;
    const c = j.state === 'failed' ? P.bad : j.state === 'done' ? (j.cached ? P.faint : P.ok) : P.accent;
    return <span style={{ fontSize: 12, color: c, whiteSpace: 'nowrap' }}>{t}</span>;
  }

  const mdCss = '.slx-md{font-size:14px;line-height:1.65;color:' + P.soft + '}.slx-md h1{font-family:' + SERIF + ';font-weight:400;font-size:24px;color:' + P.ink + ';margin:4px 0 14px}'
    + '.slx-md h2{font-family:' + SERIF + ';font-weight:400;font-size:19px;color:' + P.ink + ';margin:26px 0 8px}.slx-md strong{color:' + P.ink + ';font-weight:600}'
    + '.slx-md table{border-collapse:collapse;width:100%;font-size:13px;margin:10px 0 16px}.slx-md th,.slx-md td{border-top:1px solid ' + P.line + ';padding:7px 8px;text-align:left;vertical-align:top}'
    + '.slx-md th{color:' + P.faint + ';font-weight:500;font-size:12px}.slx-md code{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:' + P.surface + ';padding:1px 5px;border-radius:5px}'
    + '.slx-md pre{background:' + P.surface + ';border:1px solid ' + P.line + ';border-radius:10px;padding:12px;overflow:auto}.slx-md pre code{background:none;padding:0}'
    + '.slx-md li{margin-bottom:5px}.slx-md a{color:' + P.ink + '}';

  return (
    <div className="w-full" style={{ color: P.ink }}>
      <style>{mdCss}</style>
      <div style={{ maxWidth: 780, margin: '0 auto', padding: '26px 22px 60px' }}>
        <div style={label}>Slant · Chrome extension</div>
        <h1 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 38, lineHeight: 1.1, letterSpacing: '-0.01em', margin: '10px 0 12px' }}>Slant for Chrome</h1>
        <p style={{ ...para, fontSize: 16, color: P.ink, maxWidth: 640 }}>
          A pixel bear on every YouTube video that shows how slanted it is: tap to analyze, tap again for a plain-language card and the full report. It runs on this Mana backend with Slant’s own prompt and checks, and every result lands in your Slant history.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', fontSize: 12.5, color: P.soft, marginTop: 6 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>{dot(online ? P.ok : err ? P.bad : P.faint)}{online ? 'Backend online' : err ? 'Backend unreachable' : 'Connecting…'}</span>
          {status && <span>v{status.version}</span>}
          {spec && <span>{spec.matches ? 'Prompt in sync with Slant' : spec.error ? 'Couldn’t check Slant’s prompt' : 'Slant’s prompt changed'}</span>}
          {linkExp && <span>Connection link valid until {fmtDate(linkExp)}</span>}
        </div>
        {(err || ing.error) && (
          <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 10, background: P.hl, fontSize: 13, lineHeight: 1.5 }}>
            {ing.error ? 'The backend link isn’t available: ' + ing.error.message : err}
          </div>
        )}

        <section style={section}>
          <div style={label}>1 · Install</div>
          <h2 style={h2}>Add it to Chrome</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', margin: '4px 0 14px' }}>
            {zipUrl ? <a href={zipUrl} download={ZIP} style={pill(true)}>Download extension</a> : <span style={{ ...pill(true), opacity: 0.5 }}>Preparing download…</span>}
            <span style={{ fontSize: 12, color: P.faint }}>{ZIP} · 35 KB · Chrome 116+</span>
          </div>
          <ol style={{ ...para, paddingLeft: 20 }}>
            <li>Unzip it. You’ll get a folder with <code>manifest.json</code> at the top.</li>
            <li>Open <code>chrome://extensions</code>, turn on <b>Developer mode</b>, click <b>Load unpacked</b> and pick that folder.</li>
            <li>Pin <b>Slant for YouTube</b> from the puzzle menu. On any YouTube video, click it or press <b>Alt+Shift+S</b>.</li>
          </ol>
        </section>

        <section style={section}>
          <div style={label}>2 · Pair a browser</div>
          <h2 style={h2}>Connect it to this backend</h2>
          <p style={para}>Create a link, then paste it on Slant’s setup page (tap the bear on any YouTube video to open it). A link works once, for 10 minutes, and gives that browser its own key, which you can revoke below. Videos analyzed in that browser go to your Slant feed, so create the link from your own Mana account.</p>
          {pair && pairLeft > 0 ? (
            <div>
              <div style={mono}>{pair.link}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 10 }}>
                {copyBtn('pair', pair.link, 'Copy pairing link')}
                <span style={{ fontSize: 12, color: P.faint }}>Code {pair.code} · expires in {Math.floor(pairLeft / 60000)}:{String(Math.floor((pairLeft % 60000) / 1000)).padStart(2, '0')}</span>
              </div>
            </div>
          ) : (
            <button onClick={createPairing} disabled={!base || busy === 'pair'} style={{ ...pill(true), opacity: !base || busy === 'pair' ? 0.5 : 1 }}>
              {busy === 'pair' ? 'Creating…' : pair ? 'Create a new pairing link' : 'Create pairing link'}
            </button>
          )}
        </section>

        <section style={section}>
          <div style={label}>Connection link</div>
          <h2 style={h2}>Reconnect a browser</h2>
          <p style={para}>The extension reaches this backend through a Mana link that expires{linkExp ? ' on ' + fmtDate(linkExp) : ''}. When the bear says <b>Reconnect Slant</b>, tap it, then paste this on the setup page. No re-pairing needed. Opening this page refreshes the link when it’s due.</p>
          {base ? copyBtn('reconnect', base, 'Copy reconnect link') : <span style={{ fontSize: 13, color: P.faint }}>Waiting for the link…</span>}
        </section>

        <section style={section}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <div style={{ ...label, flex: 1 }}>Paired browsers · {live.length}</div>
            {revoked.length > 0 && <button onClick={() => setShowRevoked(!showRevoked)} style={linkBtn}>{showRevoked ? 'Hide revoked' : 'Show ' + revoked.length + ' revoked'}</button>}
          </div>
          {live.length === 0 && <p style={{ ...para, marginTop: 10 }}>No browsers paired yet.</p>}
          {(showRevoked ? live.concat(revoked) : live).map((c) => (
            <div key={c.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '12px 0', borderTop: '1px solid ' + P.line, opacity: c.revoked_at ? 0.5 : 1 }}>
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{c.label}{c.test ? ' · test' : ''}</div>
                <div style={{ fontSize: 12, color: P.faint, marginTop: 2 }}>
                  Paired {fmtDate(c.created_at)} · used {ago(c.last_used_at, now)} · {c.newAnalysesLast24h || 0} new analyses today{c.revoked_at ? ' · revoked ' + fmtDate(c.revoked_at) : ''}
                </div>
                {!c.revoked_at && !c.test && (
                  <div style={{ fontSize: 12, color: P.faint, marginTop: 4, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    {c.feed === 'mine' && <span style={{ color: P.soft }}>Fills your Slant feed</span>}
                    {(c.feed === 'owner' || c.feed === 'other') && <span>Fills another person’s Slant feed</span>}
                    {(c.feed === 'none' || !c.feed) && <span>Not linked to anyone’s feed</span>}
                    {(c.feed === 'none' || !c.feed) && (
                      <button onClick={() => claim(c.id)} disabled={busy === 'claim:' + c.id} style={linkBtn}>{busy === 'claim:' + c.id ? 'Linking…' : 'This is my browser'}</button>
                    )}
                  </div>
                )}
              </div>
              {!c.revoked_at && (confirm === c.id ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: P.soft }}>Revoke this browser?</span>
                  <button onClick={() => revoke(c.id)} disabled={busy === 'revoke:' + c.id} style={{ ...small, color: P.bad, borderColor: P.bad }}>{busy === 'revoke:' + c.id ? 'Revoking…' : 'Revoke'}</button>
                  <button onClick={() => setConfirm(null)} style={small}>Cancel</button>
                </div>
              ) : <button onClick={() => setConfirm(c.id)} style={small}>Revoke</button>)}
            </div>
          ))}
        </section>

        <section style={section}>
          <div style={label}>Usage</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 28, marginTop: 12 }}>
            <div><div style={{ fontFamily: SERIF, fontSize: 30, lineHeight: 1 }}>{status ? status.usage.newAnalysesLast24h : '–'}<span style={{ fontSize: 15, color: P.faint }}>{status ? ' / ' + status.usage.globalDaily : ''}</span></div><div style={{ fontSize: 12, color: P.faint, marginTop: 6 }}>new analyses, last 24 h</div></div>
            <div><div style={{ fontFamily: SERIF, fontSize: 30, lineHeight: 1 }}>{status ? status.limits.per_browser_daily : '–'}</div><div style={{ fontSize: 12, color: P.faint, marginTop: 6 }}>per browser per day</div></div>
            <div><div style={{ fontFamily: SERIF, fontSize: 30, lineHeight: 1 }}>{status ? status.limits.max_minutes_ai : '–'}<span style={{ fontSize: 15, color: P.faint }}> min</span></div><div style={{ fontSize: 12, color: P.faint, marginTop: 6 }}>longest AI transcription</div></div>
          </div>
          <p style={{ ...para, marginTop: 14, fontSize: 13 }}>Every new analysis from a paired browser runs on your Mana credits, about 0.002 to 0.02 credits each. Saved analyses open without new charges.</p>
          {spec && !spec.matches && !spec.error && (
            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: P.soft }}>Slant’s prompt or settings changed since the backend loaded them.</span>
              <button onClick={syncSpec} disabled={busy === 'sync'} style={small}>{busy === 'sync' ? 'Syncing…' : 'Use the new version'}</button>
            </div>
          )}
        </section>

        <section style={section}>
          <div style={label}>Recent extension analyses</div>
          {jobs.length === 0 && <p style={{ ...para, marginTop: 10 }}>None yet.</p>}
          {jobs.slice(0, 8).map((j) => (
            <div key={j.id} style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '10px 0', borderTop: '1px solid ' + P.line }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.title || j.video_id}</div>
              {stateChip(j)}
              <span style={{ fontSize: 12, color: P.faint, whiteSpace: 'nowrap', width: 120, textAlign: 'right' }}>{[dur(j.total_ms), ago(j.created_at, now)].filter(Boolean).join(' · ')}</span>
            </div>
          ))}
        </section>

        <section style={section}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {DOC_TABS.map(([k, t]) => (
              <button key={k} onClick={() => setTab(k)} style={{ ...small, borderColor: tab === k ? P.ink : P.line, fontWeight: tab === k ? 600 : 500 }}>{t}</button>
            ))}
            {srcUrl && <a href={srcUrl} download={SRC_ZIP} style={{ ...small, marginLeft: 'auto' }}>Source code (.zip)</a>}
          </div>
          <div className="slx-md" style={{ marginTop: 18 }}>
            {docs ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{docs[tab] || ''}</ReactMarkdown> : <span style={{ color: P.faint }}>Loading…</span>}
          </div>
        </section>
      </div>
    </div>
  );
}
