# Known limitations (demo build)

- **Not a Web Store build.** It's loaded unpacked, needs Chrome 116+, and has only been tested in Chromium on Linux (see the test report).
- **Connection links expire** (30 days at most; the setup page shows the date). Renewal is manual: copy the reconnect link in Mana and paste it on the setup page. There is no automatic renewal.
- **The backend lives in your Mana sandbox.** If the sandbox restarts mid-analysis, that job is marked "interrupted", nothing is saved, and you can try again. A sleeping sandbox can make the first request slow.
- **YouTube sometimes blocks the sandbox.** Captions then fail and the video goes to AI transcription, which is slower and costs a little more. If YouTube also hides the video's length, Slant asks Gemini for the token count first (free), so the 20-minute cap still holds.
- **Credits:** every paired browser, from any Mana account, uses the owner's Mana credits. Per-account, per-browser and overall daily caps bound it.
- **A Mana account is the identity.** Anyone can create a Mana account, so per-account limits slow abuse rather than prevent it; the overall daily cap is the real ceiling.
- **Saved analyses are reused** for any video Slant already analyzed, whoever ran it. They're labelled "Saved analysis" with their date. The bear no longer offers **Analyze again** (removed in 1.6); the owner and Editors can use **Re-analyze** on the report in the Slant app.
- **Quotes and the transcript are on the full report.** The card is a summary; **Full report ↗** opens the saved analysis on the Slant website.
- **The 20 most recent analyses are kept in the browser** (the bear remembers the scores of 50). Older ones reopen from Slant's history when you tap the bear again, at no cost.
- **Chrome may pause the extension's background worker** during a long analysis. The bear nudges it every few seconds while it shows Analyzing, so the job resumes; a job is never submitted twice.
- **Fixed backend host:** the host permission covers `https://server-prod.mana.space/api/sandbox/ingress/*`. If Mana moves its ingress host, the extension needs an update.
- **Model variance:** the same video can score a little differently on each fresh analysis, as in the Slant app.
- **Shortcut:** Alt+Shift+S can clash with other extensions. Change it at `chrome://extensions/shortcuts`.
- **The bear sits over YouTube's right-hand column** (recommendations) at the top right of the window, and it can cover part of the video in theater mode. The open card covers more of that column; tap the bear or press Escape to hide it. The bear can't be moved or hidden yet.
- **Card on short windows:** the card body scrolls inside itself when the window is too short to show it whole (on a typical laptop window about three signals show before scrolling). The scrollbar is hidden by design, so nothing signals that more is below.
- **The bear needs youtube.com access,** so Chrome shows a "read your data on youtube.com" warning at install. The bear reads only the page address; analyses still start only when you click.
