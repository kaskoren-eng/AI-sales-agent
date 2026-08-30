# Testing the voice agent without deploying and without phoning anyone

Four tiers, cheapest first. Pick the cheapest one that can answer your question — and read what each
one **cannot** prove before you quote it.

| Tier | Command | Costs | Wall clock | Answers |
|---|---|---|---|---|
| 1 · unit | `npm test` | nothing | seconds | pure logic: prompt assembly, phrase ledger, number speech, dispatch resolution |
| 2 · text-mode | `npm test` (`tool-flow.test.ts`) | nothing (FakeLLM) | ~1s | did the tools fire, in order, with the right arguments |
| 3 · one recorded call | `npm run voice:test` | ~1 call of STT+LLM+TTS | ~1 min/scenario | timing, and **an HTML page you listen to** |
| 4 · A/B, N variants | `npm run voice:ab:call -- <variants.json>` | N calls | ~75s per variant | A vs B, same script, side by side, with proof each variant ran |

Nothing here needs a deploy and nothing here places a phone call.

---

## FIRST: your laptop can no longer answer a customer's call

Before 2026-08-30, `npm run voice:dev` registered a worker with **no agent name**, which put it in
the same auto-dispatch pool as the production cloud agent (`CA_azGQ9uaLxpot`, whose "Dispatch Name"
in `lk agent list` is empty). LiveKit hands a new room to one worker from that pool — so a laptop
could be handed a real inbound customer call. That is why the rule was "never leave `voice:dev`
registered", and it made an all-day A/B session impossible.

It cut the other way too, and that half was invisible: **a synthetic-caller room was auto-dispatched
as well, so `npm run voice:test` was liable to be answered by PRODUCTION rather than by the code you
were testing.** Measured directly: a bare room created in this project had the cloud agent in it
within ~2 seconds.

Now:

* a local worker (`dev` / `connect` / `console`) registers under an explicit name, default
  `keren-dev` — explicit dispatch only, it can never be handed a real call;
* the cloud (`start`) is untouched — see `dev-dispatch.ts` for exactly why;
* the harness dispatches that name through the room-creating token's `RoomConfiguration.agents`,
  which **also suppresses auto-dispatch for that room** (measured: a room whose token named an agent
  nobody had registered got no agent at all, while the control room got production in 2s);
* the caller then checks the `lk.agent.name` attribute of whoever answered and **fails the run** if
  it is not the worker under test.

Knobs: `VOICE_DEV_AGENT_NAME=<name>` (two sessions on one machine), `VOICE_DEV_DEFAULT_DISPATCH=1`
(deliberately go back into the production pool — set it on both the worker and the runner).

---

## Tier 3 — one recorded call

```bash
npm run voice:dev                    # terminal 1 — leave it running, it is now safe to
npm run voice:test                   # terminal 2 — all scenarios
npm run voice:test -- short_answers  # one scenario
```

Prints dead air per turn, then writes, per scenario:

```
voice-test-runs/<timestamp>/<scenario>/index.html
```

Open it. One card per turn: what the caller said, what she said back (from her own call report),
a player for her reply, and its dead-air figure — plus a player for the whole call with both voices
on one timeline, and one for the greeting. Every clip is written twice: `*_phone.wav` at 8kHz (what
a caller hears — **judge this one**) and the 24kHz studio version behind a details toggle.

## Tier 4 — A/B, N variants

```bash
cp src/modules/channels/voice-livekit/testing/variants.example.json my-test.json
# edit it, then:
npm run voice:ab:call -- my-test.json                  # scenario from the file
npm run voice:ab:call -- my-test.json short_answers    # or name one
```

It starts and stops its own worker per variant, so you do **not** run `voice:dev` for this. Output:

```
voice-test-runs/<timestamp>-<scenario>/index.html
```

Same page, but one column per variant per turn, a radio to pick a winner, a note box, and a
**צור סיכום** button that emits a pasteable verdict. There is a latency table above the cards.

A variant is a label plus env overrides:

```json
{
  "scenario": "baseline_latency",
  "variants": [
    { "key": "A", "label": "היום", "env": {} },
    { "key": "B", "label": "איטי יותר", "env": { "VOICE_TTS_SPEED": "0.85" } }
  ]
}
```

Anything in the env schema works. The ones worth A/B-ing:

* **voice**: `VOICE_TTS_SPEED`, `VOICE_TTS_VOLUME`, `CARTESIA_VOICE_ID_PRIMARY`, `CARTESIA_MODEL`,
  `VOICE_TTS_PROVIDER`
* **turn-taking**: `VOICE_VAD_MIN_SILENCE_MS`, `VOICE_ENDPOINTING_MIN_DELAY_MS`,
  `VOICE_ENDPOINTING_MAX_DELAY_MS`, `VOICE_VAD_ACTIVATION_THRESHOLD`, `VOICE_TURN_DETECTION`
* **LLM**: `VOICE_LLM_MODEL`, `VOICE_LLM_REASONING_EFFORT`, `VOICE_LLM_SERVICE_TIER`,
  `VOICE_MAX_HISTORY_ITEMS`, `VOICE_PREEMPTIVE_TTS`
* **prompt-affecting**: `VOICE_INSTANT_ACK`, `VOICE_SPOKEN_REGISTER_ENABLED`,
  `VOICE_FACT_MEMORY_ENABLED`, `VOICE_NEGATION_SAFETY`, `VOICE_STATE_MACHINE_ENABLED`,
  `VOICE_PHRASE_LEDGER_ENABLED`, `VOICE_ACK_LEDGER_ENABLED`

**Editing the Hebrew prompt TEXT is not a variant.** The prompt is built in TypeScript and its
fixtures are pinned byte-for-byte; changing wording still means changing code and re-running.

### Why a variant can't silently do nothing

`src/config/env.ts` calls `dotenv.config({ override: true })`, so **`.env` beats the shell**:
`VOICE_TTS_SPEED=0.9 npm run voice:dev` does nothing, silently. Two identical clips labelled A and B
is the worst possible outcome of an A/B — it manufactures a false answer and looks like a real one.
So variants travel by a different road (`env-overlay.ts`: a JSON file named by `VOICE_TEST_OVERLAY`,
a key that is not in `.env` and therefore survives, applied to `process.env` *after* dotenv), and the
run refuses to lie about it:

1. two variants with identical overrides → refuses to start;
2. an env key the schema does not define → refuses to start (`--allow-unknown-keys` to override);
3. the worker prints the overlay it applied, and the runner echoes it;
4. the agent that answered must be the worker under test, by `lk.agent.name`;
5. **after the calls, each variant's declared values are compared against what the agent's own
   `describePipeline()` recorded on that call** (`call-reports/*.json`). A mismatch prints
   `IDENTICAL: …` on the page and exits non-zero.

Gate 5 is the only one that is proof rather than inference.

---

## Read this before trusting a number

* **These are comparison figures, not product latency.** The harness's dead air runs ~1–1.5s higher
  than the agent's own metrics, because it includes network transport, the receive jitter buffer,
  and a silence gate that skips the quiet fade-in of her first frames. Compare A against B with it.
  Cross-check absolutes against `latency eou_metrics/llm_metrics/tts_metrics` in the call report.
  The HTML page says this at the top so nobody quotes it by accident.
* **The caller is too fluent.** One clean burst, no "אה", no restart. Real Hebrew speakers do all
  three and those are what break endpointing. `hesitation` approximates it with commas and
  ellipses, but Cartesia's pauses are shorter than a person's. **A clean cut-off count here does NOT
  prove it won't cut off a real caller.**
* **It cannot judge whether the Hebrew sounds natural.** Only a human can — which is why the page
  exists. Listen to the `_phone` clips, not the studio ones.
* **The caller uses the same Cartesia voice as the agent**, so the agent hears its own timbre back.
* **Runs hit the real database.** These calls write `call_learnings`, conversations and usage rows
  exactly as any web call does. That was true before this change too; it is not new, but it is real.
* **First turn of a run is slow.** A freshly started worker's first reply carries cold-start cost
  (Silero, DB probe, first LLM connection). Compare turn 2 onward, or discard turn 1.

## Files

| File | What it does |
|---|---|
| `dev-dispatch.ts` | Which dispatch pool the worker joins. The production-safety fix. |
| `env-overlay.ts` | How an A/B variant reaches the agent past `.env`'s dotenv override. |
| `speech.ts` | Cartesia Hebrew TTS → audio frames. Websocket `stream()`; REST returns zero frames for Hebrew on sonic-3. |
| `synthetic-caller.ts` | Joins the room, publishes audio, times the reply, **records both sides**. |
| `scenarios.ts` | The scripted Hebrew conversations. |
| `run-scenarios.ts` | Tier 3: runner + console report + HTML page. |
| `ab-runner.ts` | Tier 4: spawns a worker per variant, runs the same scenario, proves the variants differed. |
| `variants.ts` | Variant file format and the three refuse-to-lie checks. |
| `transcript-align.ts` | Pairs her words with the turn they answered. Not index-based — see the file. |
| `report-html.ts` | Writes the WAVs and renders the page. |
| `wav.ts` | PCM helpers: phone-band downsample, line noise, take validation. |

## What this harness caught

* `semantic_vad` was committed as the fix for the 1.4s pause. It typechecked, the worker booted
  clean, and it did **nothing** — `gpt-realtime-whisper` is transcription-only and the plugin logs
  `Turn detection is not supported … ignoring the provided turnDetection`. Measured end-of-turn was
  identical with and without it.
* That `voice:test` could be answered by the production cloud agent instead of the local worker
  (2026-08-30) — i.e. some past "local" measurements were measurements of production.
