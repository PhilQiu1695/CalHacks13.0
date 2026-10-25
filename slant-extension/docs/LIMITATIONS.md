# Known limitations (demo build)

- **Not a Web Store build.** It's loaded unpacked, needs Chrome 116+, and has only been tested in Chromium on Linux (see the test report).
- **Connection links expire** (30 days at most; the setup page shows the date). Renewal is manual: copy the reconnect link in Mana and paste it on the setup page. There is no automatic renewal.
- **The backend lives in your Mana sandbox.** If the sandbox restarts mid-analysis, that job is marked "interrupted", nothing is saved, and you can try again. A sleeping sandbox can make the first request slow.
- **YouTube sometimes blocks the sandbox.** Captions then fail and the video goes to AI transcription, which is slower and costs a little more. If YouTube also hides the video's length, Slant asks Gemini for the token count first (free), so the 20-minute cap still holds.
- **Credits:** everyone you pair uses the owner's Mana credits. The daily caps above bound it.
- **Saved analyses are reused** for any video Slant already analyzed, whoever ran it. They're labelled "Saved analysis" with their date. Use **Analyze again** for a fresh run.
- **Quotes, the transcript and feedback are on the full report.** The card is a summary; **Full report ↗** opens the saved analysis on the Slant website, where Disagree? lives. The extension has no user identity.
- **The 20 most recent analyses are kept in the browser** (the bear remembers the scores of 50). Older ones reopen from Slant's history when you tap the bear again, at no cost.
- **Chrome may pause the extension's background worker** during a long analysis. The bear nudges it every few seconds while it shows Analyzing, so the job resumes; a job is never submitted twice.
- **Fixed backend host:** the host permission covers `https://server-prod.mana.space/api/sandbox/ingress/*`. If Mana moves its ingress host, the extension needs an update.
- **Model variance:** the same video can score a little differently on each fresh analysis, as in the Slant app.
- **Shortcut:** Alt+Shift+S can clash with other extensions. Change it at `chrome://extensions/shortcuts`.
- **The bear sits over YouTube's right-hand column** (recommendations) at the top right of the window, and it can cover part of the video in theater mode. The open card covers more of that column; tap the bear or press Escape to hide it. The bear can't be moved or hidden yet.
- **Card on short windows:** the card scrolls inside itself when the window is too short to show it whole.
- **The bear needs youtube.com access,** so Chrome shows a "read your data on youtube.com" warning at install. The bear reads only the page address; analyses still start only when you click.
