# Slant for YouTube: install, pair, use

A small pixel bear on every YouTube video tells you how slanted the video is. Tap it to analyze the video; tap it again for a plain-language card, with a link to the video's full report on the Slant website. There is no side panel. Analyses run on your Slant backend in Mana (sandbox service `slant-ext`), with the same prompt, model, schema, transcript sources and quote checks as the Slant app, and every result is saved in your Slant history.

## Install (once per browser)

1. In Mana, open **Apps › Slant for Chrome** and click **Download extension**. Unzip `slant-for-youtube-1.6.0.zip`. You'll get a folder with `manifest.json` at its top level.
2. In Chrome (version 116 or newer), open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and choose that folder. Chrome notes that it can read your data on youtube.com: that is the bear, which reads only the page address and sends it to Slant only when you tap.
3. Optional: pin it (puzzle icon → pin next to **Slant for YouTube**). The toolbar button does the same as tapping the bear.

## Pair the browser (once)

Anyone with a Mana account can do this; no Editor access needed. Open the [Slant for Chrome page](https://www.mana.space/home/6hDSPLYfOzdLths9GDTbTM7Y5ez2/apps/slant-extension) and sign in to Mana if you aren't already (guest sessions can download and read, but can't pair).

1. In **Slant for Chrome**, click **Create pairing link**, then **Copy**. The link works once, for 10 minutes.
2. Open any YouTube video. The bear says **Set up Slant**: tap it. Slant's setup page opens in a new tab. (It's also under **Details › Extension options** in `chrome://extensions`.)
3. Paste the link, optionally rename the browser (for example, "Phil's laptop"), and click **Connect**. Slant switches back to your video and analyzes it.

The key lives only in that browser's local extension storage (never Chrome sync) and is shown under **Your browsers** in Mana, where you can remove it. The browser belongs to the Mana account that created the link: only that account (and the Slant team) can see or remove it.

## Use it

On a YouTube video, Short or live replay, the bear sits at the top right.

- **Tap to analyze**: tap the bear (or press **Alt+Shift+S**). If Slant already analyzed the video, the saved result appears at once and costs nothing. Otherwise the speech bubble under the bear shows each real step (checking the video, reading captions, analyzing, saving) and the seconds elapsed. About 25 seconds with captions, longer with AI transcription. You can keep watching, switch tabs or analyze other videos meanwhile.
- **The result** shows on the bear: its colour moves toward blue (left) or red (right), and its brows, eyes and ears react to the signals. The bubble says **Tap me for results**.
- **Tap again for the card**, all on one centre line under the bear and its speech bubble:
  - **Political lean**: the score in large type (for example **−1.6**), its band as a coloured pill (Left, Lean Left, Center, Lean Right, Right), and the five AllSides bands in colour with a marker and the band names underneath. The scale (−6 to +6) and bands follow the AllSides Media Bias Meter. Videos that aren't about politics say **Not political**.
  - **Other signals**: one-sidedness, loaded language, sensationalism, unsupported claims and personal attacks, each as "x / 10" with a 10-step bar.
  - **Close** and **Full report ↗**, two equal buttons that stay at the bottom of the card while it scrolls. The full report opens this video's analysis on the Slant website, with the overall Slant score, the quotes behind every score and the transcript.
- Tap the bear, **Close** or press **Escape** to hide the card.
- **Couldn't analyze**: tap the bear for the reason and, when it helps, **Try again**.

The bear remembers up to 50 videos you analyzed in this browser, so their results still show when you come back. That list stays in Chrome on this computer.

**Don't see the bear?** Reload any YouTube tab that was already open when you installed or updated the extension (Chrome adds the bear only to pages loaded afterwards). Check that `chrome://extensions` shows Slant for YouTube 1.6.0, switched on, with site access to youtube.com. The bear doesn't appear on YouTube's home page, search results or in full screen.

## When the connection link expires

Connection links are Mana ingress URLs. The console asks for 30-day links (Mana may issue shorter ones); the setup page shows the date and warns three days ahead. When it expires, the bear says **Reconnect Slant**:

1. In **Slant for Chrome** in Mana, click **Copy reconnect link** (anyone can copy it). Opening the page as the owner refreshes the link when needed; if the link on the page has expired too, the Slant team has to renew it.
2. Tap the bear: the setup page opens. Paste the link and click **Reconnect**. You don't need to pair again; the browser keeps its key, and the video you tapped is analyzed.

Renewal is manual. Nothing renews the link inside the extension automatically.

## Remove a browser

In **Your browsers**, click **Remove**. That browser's next request is refused, and its bear asks to set Slant up again. **Disconnect** on the setup page only removes the key from that browser. The Slant team sees every browser under **All paired browsers** and can remove any of them.

## Credits and limits

Every new analysis, from any account, runs on the Slant owner's Mana credits: roughly 0.002 to 0.02 credits with captions, plus about 0.001 to 0.002 for AI transcription (from today's usage). Saved analyses cost nothing and don't count toward any limit.

| Limit | Value |
|---|---|
| New analyses per Mana account | 20 per 24 hours, across all its browsers (removed ones included, so re-pairing doesn't reset it) |
| Browsers per Mana account | 3 paired at once |
| Pairing links per account | 2 live at once, 10 per hour |
| New analyses per browser | 100 per 24 hours |
| New analyses, all public accounts together | 200 per 24 hours (the Slant team isn't counted or capped) |
| Running at once | 1 per browser and per account, 2 overall (queue up to 6) |
| AI transcription (no captions) | videos up to 20 minutes |
| Caption-based analysis | videos up to 90 minutes |

The owner and Editors of Slant for Chrome (the Slant team) aren't limited per account or by the 200-per-day public cap; the per-browser limit and running-at-once limits still apply. The limits live in `backend/data/limits.json` on the sandbox (owner-side file; restart `slant-ext` after editing).

## Team access

The page is public (view only). Signed-in Mana accounts pair and manage only their own browsers. The owner and the three Slant Editors (Editor access to [Slant for Chrome](https://www.mana.space/home/6hDSPLYfOzdLths9GDTbTM7Y5ez2/apps/slant-extension)) also get the team view: every paired browser with the verified email of the account that paired it, overall usage and prompt sync. New analyses use Phil’s Mana credits. Only the owner can renew an expired backend link.

## Your Slant feed

Videos analyzed in this browser go to your private feed in Slant (Your feed, on Slant's home page), which builds a report on your mix and an echo chamber check. A browser belongs to whoever created its pairing link. Browsers paired before 1.3.0: open Slant for Chrome in Mana and click **This is my browser** next to yours.

## What's new in 1.6.0 (October 25, 2026)

- **A new look for the bear's words.** Under the bear, a pixel-style speech bubble points up at it: **Tap me to analyze**, then **Analyzing…** with the current step and a seconds counter in large type, then **Tap me for results** / **Tap me again to hide**. The bear itself now comes from the team's `bear.js` (same drawing as before).
- **A simpler, larger card.** Political lean as a big number, a coloured pill and the AllSides colour scale with band names; the five signals as large "x / 10" bars; equal **Close** and **Full report ↗** buttons. "How slanted", the headline, the tap-to-explain signals and **Analyze again** were removed (the overall score and the explanations are on the full report). The card scrolls without a visible scrollbar.
- Still no side panel. A teammate's 1.5.2 build (with a side panel) was briefly the download on this page; 1.6.0 replaces it and keeps the 1.4 setup page and background analysis.
- **Updating:** download 1.6.0, replace your extension folder, click **Reload** in `chrome://extensions`, then refresh open YouTube tabs. You don't need to pair again.

## What's new in 1.4.1 (October 24, 2026)

- **Your feed on the setup page.** Once a browser is connected, its setup page (right-click the extension icon › Options) has a **Your feed** section with an **Open your feed ↗** button. It opens your feed on Slant, where you can see the average lean of the videos you've analyzed. The feed shown is the one for the Mana account signed in to that browser.
- **Updating from 1.4.0:** download 1.4.1, replace your extension folder, and click **Reload** in `chrome://extensions`. You don't need to pair again.

## What's new in 1.4.0 (October 24, 2026)

- **No more side panel.** The bear is the whole interface: tap to analyze, tap again for the card. Pairing and reconnecting moved to a small setup page that opens when you need it.
- **A clearer card.** Everything sits on one centre line under the bear, and the two buttons, **Close** and **Full report ↗**, are the same size. Political lean is a left-to-right bar with words, so the AllSides scale needs no explaining. "Slant 4/10" became **How slanted: Mild, 4.3 out of 10** on a bar from fair and balanced to extreme.
- **Several videos at once.** Each video keeps its own analysis, so you can start one, move on, and come back.
- **Updating from 1.3.x:** download 1.4.0 from this page, replace your extension folder with the new one, click **Reload** in `chrome://extensions`, then refresh any open YouTube tabs. You don't need to pair again.

## Earlier versions

- **1.3.2:** bolder bear colours (stronger blue for left, stronger red for right).
- **1.3.1:** Open in Slant moved to the top of the side panel.
- **1.3.0:** tap the bear for a details card; the full report moved to the Slant website; your Slant feed.
