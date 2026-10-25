# Slant

**How slanted is this video?** Paste a YouTube link and Slant reads the full transcript, scores political lean and five other kinds of bias, and shows the exact lines behind every score.

Built at CalHacks 13 with [Mana](https://www.mana.space).

<!-- TODO: add screenshot (docs/screenshot.png) and the public Mana app link -->

## What it does

- **Political lean** on the AllSides Media Bias Meter scale, −6 (left) to +6 (right), with its five bands (Left, Lean Left, Center, Lean Right, Right), confidence and an explanation
- **Slant score**, 0 (fair and balanced) to 10 (extreme): how far the presentation departs from fair treatment, toward either side
- **Five bias signals**, each 0–10: one-sidedness, loaded language, sensationalism, unsupported claims, personal attacks
- **Receipts for every score:** each rating cites verbatim quotes, checked against the transcript; click one to play the video at that moment
- **Fair by design:** rates presentation (framing, selection, wording), not whether claims are true; lists what the video does fairly and the limits of the assessment
- **Your feed:** videos you analyze build a private feed with an echo chamber report
- **Slant for YouTube (Chrome extension):** a pixel bear on every YouTube video; tap it to analyze, tap again for a plain-language card and a link to the full report

## How it works

```
YouTube link
   │
   ▼
Caption service (server.py) ──no captions?──▶ Gemini transcribes the audio
   │
   ▼
LLM analysis: fixed prompt + strict JSON schema
   │
   ▼
Quote verification against the transcript
   │
   ▼
Results page + saved history (Mana database)
```

Details: [docs/DESIGN.md](docs/DESIGN.md).

## Repo layout

| Path | What |
|---|---|
| [`slant/Slant.jsx`](slant/Slant.jsx) | The Mana app: UI, analysis prompt, JSON schema, quote matching, storage |
| [`slant/server.py`](slant/server.py) | Caption + metadata service (runs in the Mana sandbox) |
| [`slant/NOTES.md`](slant/NOTES.md) | Current implementation notes for the app |
| [`slant-extension/`](slant-extension/) | Slant for YouTube, the Chrome extension (Manifest V3), its backend, console page, tests and docs. Start with [`docs/GUIDE.md`](slant-extension/docs/GUIDE.md) |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Current design doc |
| [`docs/design-doc-v1.pdf`](docs/design-doc-v1.pdf) | Original pre-Mana design doc |

`slant/` is a source export from Mana. It uses Mana-provided APIs and is meant to run inside Mana, not standalone. See [`slant/README.md`](slant/README.md).

## Chrome extension

[`slant-extension/extension/`](slant-extension/extension/) loads unpacked in Chrome 116+ (`chrome://extensions` → Developer mode → Load unpacked). A pixel bear sits on every YouTube video and Short: tap it to analyze, tap again for a card with the political lean on a left-to-right bar, how slanted the video is (0–10, in words), the five signals, and a link to the full report in Slant. Analyses run on the extension backend ([`slant-extension/backend/`](slant-extension/backend/)) in the Mana sandbox, with the same prompt, schema and quote checks as the app, and are saved to the same Slant history.

How it's built: [`IMPLEMENTATION.md`](slant-extension/docs/IMPLEMENTATION.md). Tests: backend (33), extension logic (7) and a real-browser suite (10 scenarios); see [`TEST-REPORT.md`](slant-extension/docs/TEST-REPORT.md). The backend's secrets and database (`slant-extension/backend/data/`) are not in this repository.

## Team

<!-- TODO: add names -->
Built by the CalHacks 13 team.
