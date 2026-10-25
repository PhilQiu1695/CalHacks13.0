# How it's built

**Project:** `/workspace/slant-extension` (sandbox) and **Apps › Slant for Chrome** in Mana (console, docs, downloads).

```
extension/   Manifest V3: background.js (service worker: runs jobs), content.js (the bear and its card), setup.html/css/js (options page), lib/ (ytid, api, dom, slant-core), icons
backend/     server.py (stdlib HTTP on 127.0.0.1) + slant_ext/ (config, ytid, jsport, store, auth, providers, records, jobs)
spec/        extract_spec.js -> slant_spec.json (prompt, schema, models, from the live app) + golden.json (reference requests)
reference/   snapshots of the Slant app code the spec and core library were extracted from
tests/       test_backend.py, test_extension.mjs, browser/run_card_tests.py (1.4), browser/run_browser_tests.py (≤1.3 side panel; still holds shared helpers), fixtures/
scripts/     build_core.py (verbatim app helpers -> extension/lib/slant-core.js), package.py
```

**Flow (1.4, no side panel):** a tap on the bear (`content.js`) sends `slant:analyze` with the page address to `background.js` (an in-page click doesn't grant activeTab); the toolbar button and Alt+Shift+S send `slant:toolbar` to the bear, which handles it as a tap. If the browser isn't connected (or its link expired), the worker remembers the tap in session storage and opens the setup page (`chrome.runtime.openOptionsPage`); after pairing, the setup page sends `slant:connected`, and the worker analyzes the waiting video and switches back to its tab. Otherwise the worker `POST /v1/jobs`es with a fresh idempotency key and polls `GET /v1/jobs/<id>`, saving each video's request in `chrome.storage.local.reqs[videoId]` (newest 20, transcripts dropped). The bear follows that entry. While it shows Analyzing it sends `slant:poke` every 5 s, which resumes polling (or re-sends an unanswered submit with the same key) if Chrome stopped the worker. Jobs run on the backend's worker pool:

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
- Console routes trust `X-Sender-Uid` only from Mana ingress forward-auth (a verified Firebase ID token from the console). The owner and named Editors of Slant for Chrome (including inherited write grants) may manage pairing, reconnect links, browsers and prompt sync. Current grants are read on every request; read-only visitors are refused. The sandbox admin token in `backend/data/admin.token` (mode 600) also remains supported.
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

**The bear and card (`content.js`):** a content script on youtube.com /watch and /shorts/ pages, inside a closed shadow root (YouTube's CSS and scripts can't reach it). The bear, its label and the card share one 336 px column and one centre line; the card replaces the label while open. Card sections: headline; political lean (band word, one-line meaning, five-band bar with a pin, "of ±6", AllSides credit); how slanted (word, "out of 10", 0–10 bar from fair and balanced to extreme); the five signals (tap for hint and explanation); equal Close / Full report ↗ buttons (the report link is the analysis `manaUrl`, accepted only on www.mana.space, opened with noopener); Analyze again with confirmation. All text is inserted as text nodes. A 50-video cache (`bearCache`) keeps scores and card details. Lean bands and score words mirror `lib/slant-core.js`; `tests/test_extension.mjs` checks they match. Real-browser suite: `tests/browser/run_card_tests.py [extension dir]` (free: saved analyses and simulated jobs only).
