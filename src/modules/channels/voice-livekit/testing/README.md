# Synthetic caller — automated Hebrew voice testing

A fake Hebrew-speaking caller. It synthesizes speech with Cartesia, publishes it into a LiveKit
room as if it were a microphone, and measures how long the agent takes to answer.

**Why it exists:** before this, every latency measurement and every prompt change needed a human
to open a browser and talk Hebrew into a mic. That doesn't scale, and Phase 5 calls for 20+
scripted scenarios. It also catches changes that *look* like they work — see "what it caught".

## Running it

```bash
npm run voice:dev                    # terminal 1 — the agent must be running
npm run voice:test                   # terminal 2 — all scenarios
npm run voice:test -- short_answers  # one scenario
```

Output is dead air per turn — **the time from the caller finishing to the agent starting**, which
is the number a human actually feels and what "no dead air > 1.2s" is written against.

To sweep end-of-turn settings without touching code:

```bash
VOICE_VAD_MIN_SILENCE_MS=250 VOICE_ENDPOINTING_MIN_DELAY_MS=200 npm run voice:dev
```

## What it caught on day one

`semantic_vad` was committed as the fix for the 1.4s pause. It typechecked, the worker booted
clean, and it did **nothing** — `gpt-realtime-whisper` is transcription-only and the plugin logs
`Turn detection is not supported ... ignoring the provided turnDetection`. Measured end-of-turn
was identical with and without it. Without this harness that ships and we believe it's fixed.

## Read this before trusting a number

- **It is a relative instrument, not an absolute one.** Its dead-air figure runs ~1–1.5s higher
  than the agent's own internal metrics, because it also includes network transport, the receive
  jitter buffer, and a silence gate that skips the quiet fade-in of the agent's first frames.
  Use it to compare config A vs config B. Do **not** quote its absolute p95 as the product's
  latency — cross-check against the agent's own `latency eou_metrics/llm_metrics/tts_metrics`.
- **The caller is too fluent.** It speaks in one clean burst — no "אה", no mid-sentence pause, no
  restart. Real Hebrew speakers do all three, and those are exactly what break endpointing. The
  `hesitation` scenario approximates it with commas and ellipses, but Cartesia's pauses are
  shorter than a real person's. **A clean cut-off count here does NOT prove it won't cut off a
  real caller.**
- **It cannot judge whether the Hebrew sounds natural.** Only a human can. It measures timing and
  whether the agent replied — not quality.
- The caller uses the same Cartesia voice as the agent, so the agent hears its own timbre back.

## Files

| File | What it does |
|---|---|
| `speech.ts` | Cartesia Hebrew TTS → audio frames. Uses the websocket `stream()` path; the REST `synthesize()` path returns zero frames for Hebrew on sonic-3. |
| `synthetic-caller.ts` | Joins the room, publishes audio, times the agent's reply. |
| `scenarios.ts` | The scripted Hebrew conversations. |
| `run-scenarios.ts` | Runner + report. Exits non-zero if a turn goes unanswered. |

## Not this

For asserting on *what the agent says* (did it book? did it refuse to quote a price?), don't use
this — use LiveKit's `voice.testing` API (`session.run({userInput})`), which needs no audio at
all and is deterministic. That's the right tool for Phase 5 prompt regressions. This harness is
for anything involving *timing*, which text-mode cannot measure.
