# Testing the voice agent without deploying and without phoning anyone

Five tiers, cheapest first. Pick the cheapest one that can answer your question — and read what each
one **cannot** prove before you quote it.

| Tier | Command | Costs | Wall clock | Answers |
|---|---|---|---|---|
| 1 · unit | `npm test` | nothing | seconds | pure logic: prompt assembly, phrase ledger, number speech, dispatch resolution |
| 2 · text-mode | `npm test` (`tool-flow.test.ts`) | nothing (FakeLLM) | ~1s | did the tools fire, in order, with the right arguments |
| 3 · one recorded call | `npm run voice:test` | ~1 call of STT+LLM+TTS | ~1 min/scenario | timing, and **an HTML page you listen to** |
| 4 · A/B, N variants | `npm run voice:ab:call -- <variants.json>` | N calls | ~75s per variant | A vs B, same script, side by side, with proof each variant ran |
| 5 · **talk to it yourself** | `npm run voice:session` | 1 call, as long as you talk | seconds to start | everything a script cannot: does it *feel* right, does it interrupt you, can you get a word in |

## Before you run any of them: which question is this, and can the instrument see it?

Twice in one week a measurement here survived its own arithmetic and died on Koren's ear, and both
times the instrument was working correctly — it simply could not see the thing that mattered.

- **Round 15.** The Soniox round-trip returned the identical string for all five `נוח` candidates.
  Not a failure: Hebrew is written without vowels, so `נוֹחַ` and `נַח` ARE the same three letters.
  The transcriber cannot see a difference a listener hears in the first syllable.
- **Round 16.** The duration table said speed 0.78 buys +13.7% over 0.90, and it does. Koren could
  not tell them apart, and on the transition card chose the clip with no rate change at all. The
  table measured a real thing that turned out not to be the thing that decides.

So state, before the round is built: **what can this instrument answer, and what can only he?**

| The question is about… | The instrument | What it cannot do |
|---|---|---|
| a WORD coming out wrong | Soniox round-trip (`roundtripNN.ts`) | see anything Hebrew spelling does not encode — vowels, gender on ל"ה verbs, stress |
| a TAG being read aloud instead of honoured | the same round-trip | say whether the resulting silence sounds like a beat or a dropout |
| a PAUSE existing at all | `pause_probe.py`, clip duration | say whether it is the right length, or in the right place |
| any of the above **on the engine we actually ship** | nothing, until the harness synthesizes through it | be assumed from a Cartesia clip — see the provider note below |
| a DELIVERY sounding human | **his ear, on a listening page** | be replaced by any of the above |
| WHEN a sound starts, relative to the model | `call-reports/*.json` — but read the pairing note below | say *why* it starts there; that needs timing inside `ttsNode`, which nobody has built |

> ⚠️ **EVERY ROW ABOVE IS SCOPED TO THE ENGINE THAT MADE THE CLIP.** Koren decided on 2026-09-02
> to move TTS from Cartesia to DeepDub. `synth.py` — the synthesizer under every listening round in
> `tests/hebrew-tts-niqqud-ab/` — talks to Cartesia, so **a round built with it now describes a
> voice we are leaving**, and its verdicts do not transfer. That is not a flaw in the instrument;
> it is the instrument answering honestly about the engine it was pointed at. Point it at DeepDub
> before the next round, and treat every Cartesia-era verdict as unvalidated until re-heard:
> minimal niqqud, the pointed thinking fillers, number and time speech, and the `<break>` pause
> lengths. The one thing that does NOT need re-hearing is anything we synthesize ourselves — a
> spliced breath is our audio on any engine.

And one arithmetic rule that comes out of the same week: **a single clip is not evidence of a
duration.** Cartesia's take-to-take variation on one Hebrew sentence is ~1.1×, so a lone clip that
looks 8% faster is inside the noise. Four takes and a median, or do not quote the number
(`phase-4-known-issues.md` §9 has the tables).

Nothing here needs a deploy and nothing here places a phone call.

---

## Tier 5 first: just talk to it

```bash
npm run voice:dev        # terminal 1 — the agent, with whatever you just changed
npm run voice:session    # terminal 2 — opens a page in your browser
```

Click **התחל שיחה**, allow the microphone, talk. The page is served off your own machine at
`http://localhost:3010` (`--port=` to move it) and needs neither the API server nor the dashboard.

**The banner at the top is the point.** It reads `lk.agent.name` off whoever picks up:

* **green** — the worker in terminal 1 answered. What you are hearing is your change.
* **red** — an unnamed agent answered, which on this project means the **deployed cloud agent**.
  Anything you conclude from that call is a conclusion about production.

That distinction is not paranoia: `voice:test` rooms used to be auto-dispatched to the cloud agent,
so past "local" measurements were measurements of production. Believe the banner.

Flags: `--cloud` (deliberately talk to the DEPLOYED agent instead — the banner turns red and that is
correct), `--tenant=<uuid>` (default: `VOICE_WEBHOOK_TENANT_ID`, then `PLATFORM_TENANT_ID`),
`--port=`, `--no-open`.

### The same thing from the dashboard Simulator

`POST /api/v1/voice/web-call` also accepts `{"agent":"local"}`, which puts the local worker's name in
the token's `RoomConfiguration.agents`. It needs **both** that field and `VOICE_WEB_CALL_LOCAL_AGENT=1`
on the API process, so a deployed API refuses it. Every response now carries a `dispatch` block
(`mode`, `agentName`, `expectAgentName`, `note`) naming who is expected to answer. With no opt-in the
minted token is byte-for-byte what it always was, so the production Simulator is untouched.

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

Open it. **The whole call comes first** — both voices on one timeline, end to end — because
naturalness cannot be judged from isolated replies. Below it, one card per turn, and the card's
main player is the EXCHANGE: the caller's line, the real measured silence, then her reply. Her reply
on its own is one click away under "רק התשובה שלה". Every clip is written twice: `*_phone.wav` at
8kHz (what a caller hears — **judge this one**) and the 24kHz studio version behind a details toggle.

Turn 1 of every run is labelled as cold-start and should not be compared against.

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

### The broken instrument returns the comfortable answer

**Twice on 2026-09-02, a measurement bug produced exactly the result we were hoping for.** Not a
wild number that announced itself — the plausible, welcome one. Both were caught by disagreeing
with someone else, not by looking wrong:

- Reading ack timing out of the call reports, adding `durationMs` to a stamp that already *was*
  the first-token time reported **"median −50ms, 52.9% of turns early"** — i.e. it manufactured the
  very effect under test. The correct pairing says +668ms and 7.7%.
- Probing whether DeepDub honours `<break>`, handing a `Buffer` to `toPhoneRate` (which takes an
  `Int16Array`) resampled bytes as samples, so Soniox heard noise and returned **empty transcripts
  for every clip** — which reads as "the tag was silently dropped", the harmless outcome. It is
  not: the engine SPEAKS the tag (known-issues §18).

The shape is the same both times: **the failure mode of the instrument coincided with the answer
that would have let the work stand.** So before believing a result that lets you keep what you
built —

1. **Run the instrument against a known answer first.** A clip whose text you already know, a turn
   whose timing you can read off the transcript by hand. An empty or garbled read is a broken
   instrument until proven otherwise, never a finding.
2. **State which outcome is convenient before you look.** If the measurement lands there, that is
   when to re-derive it, not when to write it down.
3. **A null result deserves more scrutiny than a positive one**, because "no effect" is what nearly
   every wiring bug returns.


* **These are comparison figures, not product latency.** The harness's dead air runs ~1–1.5s higher
  than the agent's own metrics, because it includes network transport, the receive jitter buffer,
  and a silence gate that skips the quiet fade-in of her first frames. Compare A against B with it.
  Cross-check absolutes against `latency eou_metrics/llm_metrics/tts_metrics` in the call report.
  The HTML page says this at the top so nobody quotes it by accident.
* **The caller is too fluent.** One clean burst, no "אה", no restart. Real Hebrew speakers do all
  three and those are what break endpointing. `hesitation` approximates it with commas and
  ellipses, but Cartesia's pauses are shorter than a person's. **A clean cut-off count here does NOT
  prove it won't cut off a real caller.** If you want to judge how she *sounds over a whole call*,
  use `natural_flow` (8 turns, wanders, self-corrects, pushes back) — `hesitation` is two utterances
  and cannot show whether she repeats herself or greets twice. And if you want to judge how she
  handles a real human, use tier 5 and be one.
* **It cannot judge whether the Hebrew sounds natural.** Only a human can — which is why the page
  exists. Listen to the `_phone` clips, not the studio ones.
* **The caller uses the same Cartesia voice as the agent**, so the agent hears its own timbre back.
* **Runs hit the real database.** These calls write `call_learnings`, conversations and usage rows
  exactly as any web call does. That was true before this change too; it is not new, but it is real.
* **First turn of a run is slow.** A freshly started worker's first reply carries cold-start cost
  (Silero, DB probe, first LLM connection). Compare turn 2 onward, or discard turn 1.

### Reading turn timing out of a call report: two ways to answer a different question

Measured 2026-09-02, on the question of whether the instant acknowledgement actually arrives ahead
of the model. It does not — 391 paired turns across 18 reports put her first audio a median of
**+668ms AFTER** the first token, with only **7.7%** of turns starting before it. (An independent
run over 51 reports got +542ms and 15%: different samples, same conclusion.)

Getting there took two wrong pairings, and **both flatter the result** — anyone re-running this
will reach for the same two shortcuts, so they are written down rather than re-discovered:

1. **`model_ttft.atMs` IS the first-token moment. Do not add `durationMs` to it.** `recordMetric`
   stamps `atMs = Date.now() - startedAt` at the instant it is called, and `onModelFirstToken`
   fires when the token arrives; `durationMs` is the retrospective TTFT. Adding them double-counts
   a whole second. That error alone reports "median −50ms, 52.9% of turns early" — it manufactures
   the exact effect under test.
2. **Do not pair on `spokeAtMs >= model_ttft.atMs`.** An early receipt is *by definition* spoken
   before the first token, so that filter deletes the thing being measured and leaves you
   describing the turns where nothing happened early.

**Pair on the turn, not on either endpoint.** Anchor each turn at its `eou_metrics` stamp: first
token = the first `model_ttft` after that EOU, first audio = the first assistant `spokeAtMs` after
the same EOU, and require both to fall before the NEXT EOU so a turn cannot borrow its neighbour's
audio. That answers the question asked.

What the report still cannot tell you is **where the time goes** — only that the receipt is not
early. `ttsNode` is uninstrumented; closing it properly means timing inside it.

## Files

| File | What it does |
|---|---|
| `dev-dispatch.ts` | Which dispatch pool the worker joins, and which agent answers a browser session. The production-safety fix. |
| `local-session.ts` | Tier 5: a localhost page you talk to the local agent from. Serves `local-session-page.ts`. |
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
* That the whole-call recording it produced was **unlistenable** (2026-08-30). It was mixed one
  received frame at a time, placed at `arrivalTime - frameDuration`; frames arrive from the jitter
  buffer in bursts, so they landed on top of each other. Measured on a real 31s call: 2734 segments,
  1790 overlapping, **13.7 seconds of audio summed on top of itself** and 882 clipped samples. The
  per-turn clips had a different problem — the agent publishes a track for the whole call, so a
  captured "reply" began with all the silence while the caller was talking: **6.34s and 5.98s of
  leading silence on two 2.5s replies.** Both are fixed; `recording.test.ts` pins them.
