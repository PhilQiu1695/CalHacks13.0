# Slant for YouTube: install, pair, use

A small pixel bear on every YouTube video tells you how slanted the video is. Tap it to analyze the video; tap it again for a plain-language card, with a link to the video's full report on the Slant website. There is no side panel. Analyses run on your Slant backend in Mana (sandbox service `slant-ext`), with the same prompt, model, schema, transcript sources and quote checks as the Slant app, and every result is saved in your Slant history.

## Install (once per browser)

1. In Mana, open **Apps › Slant for Chrome** and click **Download extension**. Unzip `slant-for-youtube-1.4.0.zip`. You'll get a folder with `manifest.json` at its top level.
2. In Chrome (version 116 or newer), open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and choose that folder. Chrome notes that it can read your data on youtube.com: that is the bear, which reads only the page address and sends it to Slant only when you tap.
3. Optional: pin it (puzzle icon → pin next to **Slant for YouTube**). The toolbar button does the same as tapping the bear.

## Pair the browser (once)

1. In **Slant for Chrome**, click **Create pairing link**, then **Copy**. The link works once, for 10 minutes.
2. Open any YouTube video. The bear says **Set up Slant**: tap it. Slant's setup page opens in a new tab. (It's also under **Details › Extension options** in `chrome://extensions`.)
3. Paste the link, optionally rename the browser (for example, "Phil's laptop"), and click **Connect**. Slant switches back to your video and analyzes it.

The key lives only in that browser's local extension storage (never Chrome sync) and is shown under **Paired browsers** in Mana, where you can revoke it.

## Use it

On a YouTube video, Short or live replay, the bear sits at the top right.

- **Tap to analyze**: tap the bear (or press **Alt+Shift+S**). If Slant already analyzed the video, the saved result appears at once and costs nothing. Otherwise the label under the bear shows each real step (checking the video, reading captions, analyzing, saving) and the seconds elapsed. About 25 seconds with captions, longer with AI transcription. You can keep watching, switch tabs or analyze other videos meanwhile.
- **The result** shows in two places. The bear changes: its colour moves toward blue (left) or red (right), and its brows, eyes and ears react to the signals. The label says it in words, for example **Lean Left · Mild slant**.
- **Tap again for the card**, all on one centre line under the bear:
  - **Political lean**: the band in words (Left, Lean Left, Center, Lean Right, Right), a one-line meaning, and a left-to-right bar with a pin, for example "−1.6 of ±6". The scale and bands follow the AllSides Media Bias Meter; you don't need to know it to read the bar.
  - **How slanted**: a word (Minimal, Mild, Moderate, Strong, Extreme), the score "out of 10", and a bar from **0 · Fair and balanced** to **10 · Extreme**. It rates how the video makes its case, toward either side, not whether it's true.
  - **What drives the score**: the five signals from 0 to 10. Tap one for what it means and why this video got its score.
  - **Close** and **Full report ↗**. The full report opens this video's analysis on the Slant website, with the quotes behind every score, the transcript and Disagree?.
  - **Analyze again** (under the buttons) runs a fresh analysis after a confirmation. It replaces the saved result and uses credits.
- Tap the bear, **Close** or press **Escape** to hide the card.
- **Couldn't analyze**: tap the bear for the reason and, when it helps, **Try again**.

The bear remembers up to 50 videos you analyzed in this browser, so their results still show when you come back. That list stays in Chrome on this computer.

**Don't see the bear?** Reload any YouTube tab that was already open when you installed or updated the extension (Chrome adds the bear only to pages loaded afterwards). Check that `chrome://extensions` shows Slant for YouTube 1.4.0, switched on, with site access to youtube.com. The bear doesn't appear on YouTube's home page, search results or in full screen.

## When the connection link expires

Connection links are Mana ingress URLs. The console asks for 30-day links (Mana may issue shorter ones); the setup page shows the date and warns three days ahead. When it expires, the bear says **Reconnect Slant**:

1. In **Slant for Chrome** in Mana, click **Copy reconnect link**. Opening the page as the owner refreshes the link when needed.
2. Tap the bear: the setup page opens. Paste the link and click **Reconnect**. You don't need to pair again; the browser keeps its key, and the video you tapped is analyzed.

Renewal is manual. Nothing renews the link inside the extension automatically.

## Revoke a browser

In **Paired browsers**, click **Revoke**. That browser's next request is refused, and its bear asks to set Slant up again. **Disconnect** on the setup page only removes the key from that browser.

## Credits and limits

Every new analysis runs on the Slant owner's Mana credits: roughly 0.002 to 0.02 credits with captions, plus about 0.001 to 0.002 for AI transcription (from today's usage). Saved analyses cost nothing.

| Limit | Value |
|---|---|
| New analyses per browser | 20 per 24 hours |
| New analyses, all browsers | 40 per 24 hours |
| Running at once | 1 per browser, 2 overall (queue up to 6) |
| AI transcription (no captions) | videos up to 20 minutes |
| Caption-based analysis | videos up to 90 minutes |

The limits live in `backend/data/limits.json` on the sandbox (owner-side file).

## Team access

All three current Slant Editors also have Editor access to [Slant for Chrome](https://www.mana.space/home/6hDSPLYfOzdLths9GDTbTM7Y5ez2/apps/slant-extension). They can download the extension, create pairing links, copy the reconnect link and manage paired browsers. New analyses still use Phil’s Mana credits and the existing shared daily limits. Only the owner can renew an expired backend link.

## Your Slant feed

Videos analyzed in this browser go to your private feed in Slant (Your feed, on Slant's home page), which builds a report on your mix and an echo chamber check. A browser belongs to whoever created its pairing link. Browsers paired before 1.3.0: open Slant for Chrome in Mana and click **This is my browser** next to yours.

## What's new in 1.4.0 (October 24, 2026)

- **No more side panel.** The bear is the whole interface: tap to analyze, tap again for the card. Pairing and reconnecting moved to a small setup page that opens when you need it.
- **A clearer card.** Everything sits on one centre line under the bear, and the two buttons, **Close** and **Full report ↗**, are the same size. Political lean is a left-to-right bar with words, so the AllSides scale needs no explaining. "Slant 4/10" became **How slanted: Mild, 4.3 out of 10** on a bar from fair and balanced to extreme.
- **Several videos at once.** Each video keeps its own analysis, so you can start one, move on, and come back.
- **Updating from 1.3.x:** download 1.4.0 from this page, replace your extension folder with the new one, click **Reload** in `chrome://extensions`, then refresh any open YouTube tabs. You don't need to pair again.

## Earlier versions

- **1.3.2:** bolder bear colours (stronger blue for left, stronger red for right).
- **1.3.1:** Open in Slant moved to the top of the side panel.
- **1.3.0:** tap the bear for a details card; the full report moved to the Slant website; your Slant feed.
