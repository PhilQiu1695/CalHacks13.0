# Test report (October 24, 2026)

## 1.4.0: the bear is the whole interface (October 24, 2026)

No credits were spent: only saved analyses (cached) and the backend's simulated jobs were used, and the test keys were revoked. The backend's job log for the run shows no paid jobs.

**Automated:** backend 33 passing (unchanged); extension logic 7 passing, including new checks that the manifest has no side panel (permissions `activeTab`, `storage`; setup page as options page) and that the card states every score in words and links to the report safely.

**Real browser** (`tests/browser/run_card_tests.py`, Chromium headed under Xvfb, real mouse clicks, the bear's closed shadow root read through DevTools): 10 of 10.

| # | Scenario | Result |
|---|---|---|
| C1 | unpaired: the bear says 'Set up Slant'; a tap opens the setup page; pairing analyzes the waiting video (saved, free) | Pass |
| C2 | card: one centre line, lean spectrum + words, 'How slanted' 0–10 in words, five signals, equal Close / Full report buttons linking to this video's report | Pass |
| C3 | interactions: a signal expands its explanation and collapses; Escape, Close and a second bear tap all hide the card | Pass |
| C4 | toolbar shortcut Alt+Shift+S acts like a tap on the bear (opens and hides the card) | Pass |
| C5 | 'Analyze again' asks first, runs (simulated, free) with live steps, and a simulated result hides the report link | Pass |
| C6 | errors: out of credits shows the reason with Close only; a rate limit offers Try again, which recovers (saved, free) | Pass |
| C7 | Short: the bear and card work on /shorts/ with the same layout | Pass |
| C8 | the service worker is stopped mid-job: the bear's nudge resumes the same job (no second submission) | Pass |
| C9 | expired link: 'Reconnect Slant' opens the setup page in reconnect mode; pasting a reconnect link analyzes the waiting video (saved, free) | Pass |
| C10 | short window (1100×620): the card stays on screen and scrolls inside itself | Pass |

Two bugs were found and fixed during the run: after tapping a signal, Escape no longer closed the card (focus fell out of the card on redraw; focus is now kept and Escape works wherever focus is), and long signal names wrapped their arrow onto a second line.

Not covered: Google Chrome on macOS or Windows, YouTube's dark theme, and screen readers beyond the labels checked here.


Nothing below spent Mana credits on analyses. Cached videos and the backend's simulated jobs (test browsers only) stood in for paid runs. The two paid end-to-end runs still to do are proposed at the end.

## 1. Automated tests (sandbox)

**Backend: 29 passing** (`python -m unittest tests/test_backend.py`), with fake Firebase and fake providers:

- **Fidelity with the Slant app.** The Python port builds exactly the same model request as the app's own JavaScript, compared against reference outputs extracted from the live app. That covers the 68-line Saudi transcript and a 5,200-line transcript with Unicode, emoji and the 360,000-character truncation. It also covers the Gemini request, parsing of fenced, truncated and garbage transcripts, and timestamp formatting.
- **URL parsing.** A shared table of 47 URLs covers watch, Shorts, live, mobile and youtu.be links, plus look-alike hosts, userinfo tricks, ports, http, bad IDs and non-video pages.
- **Malformed model output.** Nine malformed reports (bad JSON, missing fields, wrong enums or types, extra keys) are rejected, and nothing is saved.
- **Provider errors.** 402 becomes "out of credits" (no retry), 429 "rate limited" (retry), 5xx a provider error (retry), and a timeout is retryable.
- **Auth.** Pairing codes are single-use and expire after 10 minutes. Keys are stored only as hashes, revocation works, and each browser can see only its own jobs.
- **Jobs.**
  - Idempotency: the same key returns the same job, and reusing it for another video conflicts.
  - Saved analyses are reused, including editor-saved records whose quotes are packed as text.
  - Duplicate in-flight requests from two browsers share one job and one paid run.
  - A fresh analysis keeps the record's Disagree? notes.
  - Limits: per-browser concurrency and daily caps, with saved results still opening at the cap.
  - Records are saved in the app's exact shape (Shorts keep `/shorts/`).
- **Length checks.** Long caption videos are refused. For AI transcription, the YouTube length is checked first, and when YouTube bot-blocks the sandbox the backend uses a Gemini token count. A truly unknown length is refused before any paid call. Private, age-restricted and removed videos are reported as unavailable.
- **Restarts.** A job running during a restart becomes "interrupted" (retryable); queued jobs resume; jobs past the time limit fail as timed out.
- **HTTP.** Missing or invalid keys get 401. A key sent as a bearer token isn't accepted. Owner routes refuse a forged user header when it isn't trusted. Oversized or non-object bodies are refused, and pairing attempts are rate-limited.

**Extension: 5 passing** (`node tests/test_extension.mjs`):

- The URL table matches the backend's exactly.
- Quote matching, lean bands and score words match the Slant app's own functions on the same inputs. The code is copied verbatim from the app by `scripts/build_core.py`.
- Connection links are validated: exact host, the `slant-ext` service and the expiry claim.
- The manifest has only `activeTab`, `sidePanel`, `storage` and one host permission, plus (since 1.2.0) the bear's content script on youtube.com and nothing else.
- No HTML-injection sinks (`innerHTML` and similar), no eval, and no remote scripts.

## 2. Live checks through the public Mana ingress URL

| Check | Result |
|---|---|
| `GET /healthz` through ingress (`inspect_ingress`) | 200, all hops healthy |
| Daemon reads Firebase without chat credentials | Sees the saved analyses |
| Daemon reaches the Mana router (OpenAI, Gemini) | Authorized; probe requests deliberately invalid, refused by the provider and not billed |
| Forged `X-Sender-Uid` header, no token | 403: ingress strips it |
| Real Firebase ID token | Owner identity forwarded |
| Pairing over ingress; reused code | Paired; the reused code is refused |
| Custom `X-Slant-Key` header through ingress | Accepted |
| Saved analysis via the API | Returned in 0.75 s with all 68 transcript lines |
| Wrong or revoked key | 401 |
| Expired, tampered or wrong-service link | 401 or 403 from the gateway, which the panel tells apart from a revoked key |
| Gemini token count on a YouTube URL from the sandbox | Works even while YouTube bot-blocks the sandbox: 16,663 tokens for 161 s; no billing event appeared |

## 3. Real browser: 11/11 scenarios passing

Playwright's Chromium 145 ran headed under Xvfb with the unpacked extension and the deployed backend. The toolbar action was fired by a real keyboard gesture (Alt+Shift+S through xdotool), which grants activeTab exactly like a click; the side panel was driven over DevTools. Run it yourself with `python tests/browser/run_browser_tests.py`; screenshots land in `tests/browser/shots/`.

| # | Scenario | Result |
|---|---|---|
| S1 | pair via pasted link; the pending toolbar click is analyzed (cached) | Pass |
| S2 | report: lean, slant score, signals, summary, quotes, disclosures | Pass |
| S3 | timestamp opens the cited moment in the same video's tab | Pass |
| S4 | SPA navigation keeps the old result labelled; its timestamps open a new tab; a click analyzes the new video | Pass |
| S4b | 'Analyze the current video' (in the panel) reads the tab's URL at click time | Pass |
| S5 | Short analyzed with the Short layout; a repeat click submits nothing | Pass |
| S6 | non-video pages show 'Open a YouTube video to analyze it.' | Pass |
| S7 | out-of-credits and rate-limit errors render; retry offered only when it helps | Pass |
| S8 | panel closed + service worker stopped mid-job: reopening resumes the same job | Pass |
| S9 | revoked key shows 'This browser was disconnected' and asks to pair again | Pass |
| S10 | expired link detected (by the panel and by the gateway); a reconnect link restores it with the same key | Pass |

**Tested in this run:**

- YouTube watch pages, a Short, and two non-video pages.
- SPA navigation (`history.pushState`, which is how YouTube moves between videos).
- Closing the panel and stopping the service worker during a job.
- Revoked keys, and expired links caught both by the panel and by the gateway.

## 4. Still to verify on your Mac

- Clicking the toolbar icon with the mouse in Google Chrome on macOS, and the side panel at your window size. Tests used Chromium on Linux and the keyboard shortcut, which is the same activeTab gesture.
- YouTube's own in-page navigation by clicking a recommended video (tests used pushState directly) and the dark theme.
- **Paid end-to-end (needs your OK):** one new captioned video and one new caption-less Short. They exercise the full captions path, the AI transcription path, saving a new record into Slant and the timings. See the proposal in chat.

## Update: version 1.1.0 (October 24, 2026)

- **Commercial interest removed.** Slant now reports five signals (one-sidedness, loaded language, sensationalism, unsupported claims, personal attacks).
- **Political lean now uses the AllSides Media Bias Meter scale, −6 to +6:** Left −6 to −3, Lean Left −2.99 to −1, Center −0.99 to +0.99, Lean Right +1 to +2.99, Right +3 to +6. The lean bar's band labels are sized to match.
- **All earlier analyses were deleted,** because they were scored on the old −10 to +10 scale. A backup is kept in Mana storage.
- The prompt, schema and shared panel code were regenerated from the updated app (spec 112fb44227be). Re-run: backend 29 passing, extension 5 passing (lean bands checked at the new boundaries). The browser scenarios were not re-run for this update; S2 now expects five signals.
- Paired browsers need the 1.1.0 download (Load unpacked again, or replace the folder and click reload in chrome://extensions).

## Update: version 1.2.0, the Slant bear (October 24, 2026)

A teammate's in-page bear (`content.js`, plus a message listener in `background.js` and the content script entry in the manifest), checked and integrated with fixes. Real Chromium, real mouse clicks on a real YouTube watch page, a saved (free) analysis, `tests/browser/bear_check.py`:

| Check | Teammate's version | Integrated |
|---|---|---|
| Clicking the bear opens the side panel | Pass | Pass |
| The panel analyzes that video (cached, lean −1.3) | Pass | Pass |
| The bear changes after the result | Pass (subtle: slightly bluer, label "Tap for details") | Pass, and the label says "Lean Left · Slant 3/10 · Mild" |
| A second click reuses the same job | Pass | Pass |
| Moving to another video resets the bear | Pass | Pass |
| Page script time with the bear on screen | 0.19 s per 5 s (60 redraws a second) | 0.03 s per 5 s (redraws only on change) |

Fixes made while integrating: the result is shown in words (lean band and Slant score, matching the app, test-checked); larger label text (15 px); no `innerHTML`; the bear stops saying "Analyzing" after 20 s if no analysis started (for example, setup not finished); storage errors after an extension reload are caught; no drawing in background tabs. Extension logic tests: 6 passing.

## Update: version 1.2.1 (October 24, 2026)

- Political lean is labelled with its scale everywhere: "AllSides scale, −6 to +6" next to the heading, "/ ±6" after the number, and −6, −3, −1, 0, +1, +3, +6 under the lean bar (same change in the Slant app). The bear's label reads, for example, "Right · +5.8 / AllSides scale, −6 to +6 / Slant 9/10 · Extreme · Tap for details".
- The bear now also appears on Shorts.
- Real Chromium (`tests/browser/bear_check.py`, saved analyses only): bear click opens the panel; watch page analyzed (+5.8, Right) and the bear shows it; second click reuses the job; navigating resets it; a Short (−0.5, Center) shows the bear, analyzes on click and shows the result. No console errors. Extension logic tests: 6 passing.
