# voice-livekit — the self-built voice engine

Phase 1 (skeleton) of the Retell → LiveKit migration. See `VOICE_MIGRATION_PLAN.md` at the repo root.

Retell is untouched and still serves production. This module runs **alongside** it (strangler-fig),
and today it does exactly one thing: answer a room in Hebrew and hold a conversation.

## The one thing to understand

**This agent is a separate program from the API server.** `npm run dev` starts Fastify; it does
*not* start the agent. LiveKit's SDK takes over the whole process (it forks a child per call and
owns shutdown), so the agent cannot live inside Fastify. That's why it has its own scripts, and
why `agent.ts` must never be imported by anything.

```
caller audio ─→ Silero VAD (is someone talking?)
             ─→ OpenAI gpt-realtime-whisper  (speech → Hebrew text, streaming)
             ─→ OpenAI gpt-5.4               (text → reply, streaming)
             ─→ Cartesia sonic-3             (reply → Hebrew audio, streaming)
```

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

`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `OPENAI_API_KEY`, `CARTESIA_API_KEY`,
`CARTESIA_VOICE_ID_PRIMARY`. See `.env.example`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Greeting sounds English-accented | `CARTESIA_VOICE_ID_PRIMARY` is not a Hebrew voice | Pick one at <https://play.cartesia.ai/voices> (filter: Hebrew), or try `CARTESIA_VOICE_ID_SECONDARY` |
| Agent talks over you mid-sentence | Silence-timer end-of-turn is too eager for Hebrew | Enable the multilingual turn detector — see the PHASE 2 comment in `agent.config.ts` |
| Agent replies to the wrong thing | Hebrew transcription is off | Set `OPENAI_REALTIME_MODEL=whisper-1` (slower, non-streaming, but proven) |
| LLM errors on the first turn | `gpt-5.4` may need the Responses API | Swap `openai.LLM` → `openai.responses.LLM` in `agent.config.ts` |

## Not built yet

Phone calls (Phase 3), tenant context + calendar booking (Phase 4), transcript persistence,
production deploy (Phase 6). This module currently writes nothing to the database.
