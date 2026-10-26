# How it's built

**Project:** `/workspace/slant-extension` (sandbox) and **Apps › Slant for Chrome** in Mana (console, docs, downloads).

```
extension/   Manifest V3: background.js (service worker: runs jobs), content.js (the bear and its card), setup.html/css/js (options page), lib/ (ytid, api, dom, slant-core, bear), icons
backend/     server.py (stdlib HTTP on 127.0.0.1) + slant_ext/ (config, ytid, jsport, store, auth, providers, records, jobs)
spec/        extract_spec.js -> slant_spec.json (prompt, schema, models, from the live app) + golden.json (reference requests)
reference/   snapshots of the Slant app code the spec and core library were extracted from
tests/       test_backend.py, test_extension.mjs, browser/run_card_tests.py (1.6), browser/run_browser_tests.py (≤1.3 side panel; still holds shared helpers), fixtures/
scripts/     build_core.py (verbatim app helpers -> extension/lib/slant-core.js), package.py
```

**Flow (1.4+, no side panel):** a tap on the bear (`content.js`) sends `slant:analyze` with the page address to `background.js` (an in-page click doesn't grant activeTab); the toolbar button and Alt+Shift+S send `slant:toolbar` to the bear, which handles it as a tap. If the browser isn't connected (or its link expired), the worker remembers the tap in session storage and opens the setup page (`chrome.runtime.openOptionsPage`); after pairing, the setup page sends `slant:connected`, and the worker analyzes the waiting video and switches back to its tab. Otherwise the worker `POST /v1/jobs`es with a fresh idempotency key and polls `GET /v1/jobs/<id>`, saving each video's request in `chrome.storage.local.reqs[videoId]` (newest 20, transcripts dropped). The bear follows that entry. While it shows Analyzing it sends `slant:poke` every 5 s, which resumes polling (or re-sends an unanswered submit with the same key) if Chrome stopped the worker. Jobs run on the backend's worker pool:

1. oEmbed (title and availability).
2. The existing `yt-bias` caption service, on loopback.
3. If captions fail: the YouTube length check, or a Gemini token count when YouTube blocks the sandbox, then Gemini transcription.
4. gpt-6-astra analysis with Slant's strict schema.
5. A save into `apps/slant/app/analyses` and `transcripts` in the app's exact shape. Additive fields: `via`, `analysisVersion`.

**Reuse:**

- The prompt, schema, models, Gemini request and source labels come from the live app code (`spec/extract_spec.js`); `POST /v1/owner/spec/sync` re-extracts them when Slant changes.
- The quote matcher, timestamp format and lean bands are copied verbatim into `extension/lib/slant-core.js`.
- Editor-saved records (`quotesJson`) are unpacked like the app does.

**Auth:**

- Owner-minted pairing code (8 characters, single use, 10 minutes) → per-browser key `slk_…`. It's stored hashed with a pepper and sent as `X-Slant-Key`, never as a bearer token.
- **Personal routes** (`/v1/me/status`, `/v1/me/pairing-codes`, `/v1/me/credentials/<id>/revoke`): any signed-in Mana account. The console sends the person's Firebase ID token in `X-Slant-Id-Token`; `slant_ext/identity.py` verifies it here (RS256 against Google's published keys, audience `fully-generative`, issuer, expiry) and refuses guest (anonymous) sessions. If forward-auth also sent `X-Sender-Uid`, it must match the token. The account id comes only from the verified token. A pairing code records its account (and verified email); the browser it creates belongs to that account, which alone (with the team) can list or remove it.
- **Per-account limits** (`account_*` in limits): new analyses per 24 h counted across all the account's browsers, revoked ones included; one running analysis per account; at most 3 live browsers (checked when a code is created and again when it's redeemed); 2 live codes and 10 new codes per hour per account; 200 live codes overall. Codes are capped per account, so one person can't evict another's. Owner and Editors are exempt (cached 60 s). Each paid job records `public` (1 for a non-team account); the overall `global_daily` cap counts and limits only public jobs, so the team is never blocked by it.
- **The Slant website** (`POST /v1/me/analyze`, `GET /v1/me/jobs/<id>`, team only): the Slant app sends new analyses and Re-analyze here instead of calling AI providers from the page. Each team member gets a hidden keyless `web_` credential (never listed as a browser, no per-browser daily cap); records and feed entries are marked `via: app`; Re-analyze passes `recordId` so the exact report shown is updated.
- **Team routes** (`/v1/owner/*`): trust `X-Sender-Uid` only from Mana ingress forward-auth. The owner and named Editors of Slant for Chrome (including inherited write grants) may see all browsers (with who paired them), revoke any, link legacy browsers to their feed and sync the prompt. Current grants are read on every request; everyone else is refused. The sandbox admin token in `backend/data/admin.token` (mode 600) also remains supported.
- **The page** is `public_read` (logged-out visitors get a guest session and can download and read the docs and reconnect link); write access stays with the owner and Editors. Pairing secrets, keys and browser records live only in the backend's SQLite, never in Firebase.
- Provider keys never leave Mana's servers: the backend calls the Mana router with the sandbox identity.

**State:** SQLite (WAL) in `backend/data/`. Running jobs become interrupted on restart; queued jobs resume; a watchdog fails jobs older than 11 minutes.

**Ops:**

| Item | Value |
|---|---|
| Daemon | `slant-ext` (supervisord), port in `backend/data/port` |
| Logs | `/workspace/.mana/supervisord/logs/slant-ext.*.log` |
| Ingress route | `/slant-ext` |
| Restart after code edits | `supervisorctl restart slant-ext` |
| Admin CLI | `X-Slant-Admin: $(cat backend/data/admin.token)` against `http://127.0.0.1:$(cat backend/data/port)` |

**The bear and card (`content.js`, 1.6):** a content script on youtube.com /watch and /shorts/ pages, inside a closed shadow root (YouTube's CSS and scripts can't reach it). The bear's drawing is `lib/bear.js` (the team's ES module: `compose`, `draw`, `scoresFromResult`, `aggregate`). Content scripts can't `import` and the manifest exposes no web-accessible files, so `scripts/build_bear.py` inlines it into `content.js` between `BEGIN bear.js` / `END bear.js` markers as a `Bear` namespace (`package.py` runs it; `test_extension.mjs` fails on a stale copy). Edit the bear only in `lib/bear.js`. The bear, a pixel speech bubble (box-shadow pixel border, stepped clip-path arrow pointing up; 22 px monospace, 18 px sub-line) and the card share one column of min(380 px, 100vw − 32 px) and one centre line. The card is a scrolling body (scrollbar hidden) over a fixed footer with equal Close / Full report buttons; `fitCard()` caps it 16 px above the window's bottom edge. The screen-reader label still states lean and slant in words, since the bubble no longer does.
