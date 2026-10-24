# Slant: Video Bias Transparency Tool (Design Doc v2)

Replaces the [v1 MVP design doc](design-doc-v1.pdf). v2 matches what was actually built in Mana (`slant/`) and moves the team's focus to validation and one differentiating feature.

## Product

Slant takes a YouTube video (Shorts first) and shows how it is slanted: its political lean, five other bias signals, and the exact transcript quotes behind every score. It judges **presentation** (framing, selection, wording), not whether the conclusions are true.

Long-term vision is unchanged: a browser extension that helps people think critically while scrolling.

## Status: MVP is built

Slant runs as a Mana app. Source export lives in [`slant/`](../slant/README.md).

| Piece | File | Where it runs |
|---|---|---|
| Frontend, AI prompt, output schema, quote matching, storage | `slant/Slant.jsx` | Mana app (`apps/slant/app/code`) |
| Caption + metadata service | `slant/server.py` | Mana sandbox (`/workspace/yt-bias/server.py`), ingress route `yt-bias` |

`Slant.jsx` depends on Mana-injected APIs (`FS`, `useManaRouter`, `useIngressUrl`, `useTheme`, `relPathAddress`) and does not run outside Mana as-is.

## Pipeline

1. **Input:** user pastes a YouTube link (watch, Shorts, youtu.be, embed, live, or bare video ID).
2. **Transcript:**
   - `server.py` fetches captions with `youtube-transcript-api`, preferring creator English captions, then auto-generated English, then any language. Title and channel come from YouTube oEmbed.
   - **Fallback:** if there are no captions or the service is blocked/offline, Gemini (`gemini-3.8-flash`) transcribes the audio from the video URL.
3. **Analysis:** one LLM call (`gpt-6-astra` through the Mana router) with a fixed system prompt and a strict JSON schema. Input is title, channel, transcript source, and the timestamped, numbered transcript (truncated at 360k chars, flagged in caveats).
4. **Quote verification:** every quote the model returns is matched against the transcript (exact, then approximate on the first/last 6 words). Unmatched quotes are labeled "not matched in transcript".
5. **Output:** results page with overall score, lean axis, per-signal meters, quotes that seek the embedded player to that moment, and a highlighted transcript. Analyses and transcripts are saved to the Mana database; any analysis can be re-run.

## Output format

```jsonc
{
  "headline": "≤10-word verdict",
  "summary": "2–3 sentences",
  "topic": "...", "contentType": "...",
  "overall": 0-10,                     // departure from fair, balanced, evidence-based treatment
  "political": {
    "applicable": true,                // false → "Not political", score 0
    "score": -10..10,                  // −10 strongly left, 0 center, +10 strongly right
    "label": "...", "confidence": "low|medium|high",
    "explanation": "...",
    "quotes": [{ "seg": 12, "quote": "verbatim 6–35 words", "why": "one sentence" }]
  },
  "dimensions": [                      // each 0–10, 0 = absent
    { "key": "one_sided|loaded_language|sensationalism|unsupported_claims|ad_hominem|commercial",
      "score": 0-10, "explanation": "...", "quotes": [/* same shape */] }
  ],
  "balance": ["things the video does fairly"],
  "caveats": ["auto-captions, partial transcript, satire, ..."]
}
```

### Mapping to the AllSides 5-point spectrum

v1 planned to output AllSides labels directly. v2 keeps the finer −10..+10 score and maps it for comparison:

| Score | AllSides label |
|---|---|
| −10 to −6 | Left |
| −5.9 to −2 | Lean Left |
| −1.9 to +1.9 | Center |
| +2 to +5.9 | Lean Right |
| +6 to +10 | Right |

These cutoffs are a starting point; tune them on the validation set.

## Validation (top priority)

The biggest risk is that the LLM rater carries its own lean. v1 said "check manually"; v2 makes it measurable.

1. **Test set:** 15–20 Shorts from outlets AllSides rates, spread evenly across Left, Lean Left, Center, Lean Right, Right. Prefer videos with creator captions.
2. **Agreement:** map each Slant score to an AllSides label and compare with the outlet's rating. Report exact matches and within-one-category matches.
3. **Consistency:** run each video 3 times (Re-analyze) and report the spread of lean and overall scores.
4. **Symmetry:** check that errors don't skew in one direction (e.g. right-leaning outlets consistently rated further right than AllSides).
5. **Human check:** each teammate rates a subset blind; compare with Slant.

Caveat for the pitch: AllSides rates outlets, not individual videos, so some disagreement is expected and worth explaining case by case.

## Next feature (decision pending)

Pick one, based on which sponsor prize tracks we target:

- **Browser extension** (original vision): rating appears on YouTube while scrolling. Blocked on whether a Mana app can be called from outside Mana; today the AI calls go through `useManaRouter` inside the page. Ask the Mana team.
- **Claim checking** (Tavily or Bright Data): a separate "claims checked" section with sources. Keep it separate from the lean score, since Slant rates presentation, not truth.
- **Outlet context:** show the channel's AllSides rating next to Slant's video rating. Cheap, and doubles as live validation.

Later: video description and channel ownership as inputs, non-political content, long-form tuning.

## Risks and mitigation

| Risk | Mitigation |
|---|---|
| LLM rater carries its own lean | Validation plan above; symmetric test set; report results honestly |
| Labels harm a named creator | Descriptive wording tied to verified quotes; no verdicts like "misinformation"; "Done fairly" and "Caveats" sections; add a way to flag errors |
| YouTube blocks caption requests from cloud IPs | Gemini audio fallback; pre-analyze demo videos (saved results load instantly) |
| Analysis takes 20–60 s | Step-by-step progress UI already built; keep a finished analysis open as demo backup |
| Mana credits run out | Watch usage; pre-analyze demo set |
| Code locked into Mana | Source export in repo; extension/claim-check work done in this repo where possible |

## Changes from v1

- **Dropped:** Apify and yt-dlp (captions fetched directly; Gemini handles audio). Restore Apify only if targeting its prize track.
- **Not yet built:** fact-checking (Bright Data / Tavily), video description, ownership & transparency, browser extension.
- **Changed:** lean is −10..+10 with confidence (mapped to AllSides) instead of AllSides labels only; reliability replaced by six presentation signals.
- **Added:** verified, timestamped quotes for every score; balance and caveats; saved history and re-analysis.
- **Upgraded:** validation from "check manually" to a measurable plan.
