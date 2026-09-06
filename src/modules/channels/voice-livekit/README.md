# voice-livekit — the self-built voice engine

**Live in production since 2026-07-29.** This is the only voice engine — the previous vendor
was removed from the repo entirely. See `VOICE_MIGRATION_PLAN.md` at the repo root for how it got
here and why.

## The one thing to understand

**This agent is a separate program from the API server.** `npm run dev` starts Fastify; it does
*not* start the agent. LiveKit's SDK takes over the whole process (it forks a child per call and
owns shutdown), so the agent cannot live inside Fastify. That's why it has its own scripts, and
why `agent.ts` must never be imported by anything.

```
caller audio ─→ Silero VAD (is someone talking?)
             ─→ Soniox stt-rt-v5   (speech → Hebrew text, streaming; semantic end-of-turn)
             ─→ OpenAI gpt-5.4     (text → reply, streaming)
             ─→ DeepDub dd-etts-3.2 (reply → Hebrew audio, streaming)
```

STT is **Soniox, not OpenAI** — semantic WER 4.3% vs 34.9% on real Hebrew calls. Do not "fix"
it back.

TTS is **DeepDub since 2026-09-02** — `VOICE_TTS_PROVIDER` defaults to `deepdub` after it won a
blind Hebrew A/B 6:1. Cartesia and ElevenLabs adapters remain behind the same env var. This line
used to say the opposite ("a DeepDub adapter exists ... and is deliberately not the default"),
which was true until the flip and then sat here misinforming people; if you flip the engine again,
this paragraph is part of the change. See `docs/phase-4-known-issues.md` before touching either.

## Files

| File | What it is |
|---|---|
| `agent.ts` | The entrypoint LiveKit executes. Calls `cli.runApp()` — **do not import this file.** |
| `agent.config.ts` | Builds the STT/LLM/TTS pipeline from env. Safe to import (tests use it). |
| `prompts/system-prompt.he.ts` | The Hebrew system prompt. Never edit without a regression test. |

## Running it

One-time, after `npm install`:

```bash
npm run voice:download     # fetches the Silero VAD + turn-detector model weights
```

Then:

```bash
npm run voice:dev          # registers with LiveKit Cloud and waits for a call
```

Leave it running and open <https://cloud.livekit.io> → your project → **Agents** → **Launch
Console** → **Start a session**. You talk through the browser.

> **There is no terminal-mic mode in the Node SDK.** The Python SDK's standalone `console`
> command does not exist here — Node's `console` subcommand means "attach to a local TCP broker"
> and requires `--connect-addr`. The browser Agent Console above is the local test path.

Each turn prints its real latency, which is what the Phase 2 budget (P95 < 800ms) is measured
against — `endOfUtteranceDelayMs` (how long before we judged the caller finished), `ttftMs`
(LLM first token), `ttfbMs` (TTS first audio):

```
latency llm_metrics ttftMs=412 durationMs=1180
latency tts_metrics ttfbMs=96 durationMs=740
```

## Required env

`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `OPENAI_API_KEY`, `SONIOX_API_KEY`,
`STT_PROVIDER=soniox`, `CARTESIA_API_KEY`, `CARTESIA_VOICE_ID_PRIMARY`. See `.env.example`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Greeting sounds English-accented | `CARTESIA_VOICE_ID_PRIMARY` is not a Hebrew voice | Pick one at <https://play.cartesia.ai/voices> (filter: Hebrew), or try `CARTESIA_VOICE_ID_SECONDARY` |
| Long pause before the agent answers | Silence-timer end-of-turn (measured 1.3–2.5s). **The multilingual turn detector does NOT support Hebrew** — see the PHASE 2 comment in `agent.config.ts` for what does | Try OpenAI `semantic_vad` |
| Agent replies to the wrong thing | Hebrew transcription is off | Confirm `STT_PROVIDER=soniox` — the OpenAI STT path is far worse in Hebrew (34.9% vs 4.3% semantic WER) |
| LLM errors on the first turn | `gpt-5.4` may need the Responses API | Swap `openai.LLM` → `openai.responses.LLM` in `agent.config.ts` |

## What's here

Phone calls over the Zadarma SIP trunk, six agent tools (calendar check, booking, lead capture,
end-call), the conversation state machine + reflexes, speech-guard, compliance (recording notice
+ AI disclosure), per-call `CallReport`, and the browser web-call path used by the dashboard
Simulator. Transcripts and analysis persist to `call_learnings` and `conversations`.
