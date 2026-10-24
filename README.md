# Slant

**How slanted is this video?** Paste a YouTube link and Slant reads the full transcript, scores political lean and five other kinds of bias, and shows the exact lines behind every score.

Built at CalHacks 13 with [Mana](https://www.mana.space).

<!-- TODO: add screenshot (docs/screenshot.png) and the public Mana app link -->

## What it does

- **Political lean** on a −10 (left) to +10 (right) scale, with confidence and an explanation
- **Five more bias signals**, each 0–10: one-sidedness, loaded language, sensationalism, unsupported claims, personal attacks, commercial interest
- **Receipts for every score:** each rating cites verbatim quotes, checked against the transcript; click one to play the video at that moment
- **Fair by design:** rates presentation (framing, selection, wording), not whether claims are true; lists what the video does fairly and the limits of the assessment

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
| [`docs/DESIGN.md`](docs/DESIGN.md) | Current design doc |
| [`docs/design-doc-v1.pdf`](docs/design-doc-v1.pdf) | Original pre-Mana design doc |

`slant/` is a source export from Mana. It uses Mana-provided APIs and is meant to run inside Mana, not standalone. See [`slant/README.md`](slant/README.md).

## Team

<!-- TODO: add names -->
Built by the CalHacks 13 team.
