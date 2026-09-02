# VOICE — the local test harness follows `VOICE_TTS_PROVIDER` (2026-09-02)

Branch: `feature/voice-harness-engine`. Not merged, not deployed.

## Why this exists

Koren decided today to move TTS from Cartesia to DeepDub. The local harness was Cartesia-hardcoded:
`testing/speech.ts` built `new cartesia.TTS(...)` by hand, and the A/B tools, the clarity tool, the
synthetic caller and the latency bench all went through it. On the day production flipped, every one
of them would have gone on producing **Cartesia** audio for a **DeepDub** agent — silently, with
nothing on the clip or the page to say so. That is the 2026-08-16 class of failure: no error, no
warning, just a measurement of something we do not ship.

## What shipped

**One place builds the TTS: `src/modules/channels/voice-livekit/testing/tts-engine.ts`.**
It does not re-implement the provider branch — it calls production's own `buildTTS()` from
`agent.config.ts` with a synthetic `Env`. A copy of the branch drifts; a call cannot.

### Now follows `VOICE_TTS_PROVIDER`

| Tool | Engine |
|---|---|
| `voice:ab` | configured, or `--engine=` |
| `voice:clarity` | configured, or `--engine=` |
| `voice:test` / `voice:ab:call` — the synthetic **caller's** voice | configured |
| `voice:test` / `voice:ab:call` — **her** voice (the reply audio) | the worker's own env, read back off the call report |
| `bench:tts` baseline | the row matching `VOICE_TTS_PROVIDER`, marked `(LIVE)` |

### Deliberately does NOT follow it

* **`bench:tts` itself.** It gained DeepDub arms (`realtime` and `realtime OFF`) *alongside* the
  Cartesia and ElevenLabs ones. Converting it to DeepDub would have destroyed the only instrument
  that can put engines head to head. What changed is the **baseline**: it used to be a hard-coded
  `LIVE` string on the Cartesia row, and is now whichever row matches the configured provider.
* **The explicit override**, everywhere: `--engine=`, `--model=`, `--voice=`, `--route=`. As a
  FLAG, not an env var — `loadEnv()` runs dotenv with `override: true`, so
  `VOICE_TTS_PROVIDER=deepdub npm run voice:ab` is a silent no-op.
* **`tests/hebrew-stt-corpus/`.** `scripts/generate-stt-test-corpus.ts` now imports from the new
  module, so it *would* follow the provider — but the committed corpus was generated on Cartesia
  and every STT WER number in this project is measured against that audio. There is a comment at
  the import saying so. **Do not regenerate it as a side effect of the flip.**
* **Production.** Nothing in `agent.ts`, the guard, `voice-mode.ts`, `speech-guard.ts` or
  `sales-gate.ts` was touched. No default moved. `VOICE_TTS_PROVIDER` is unchanged.

### Every clip is labelled with the engine that made it

Filename (`01_A_deepdub_dd-etts-3.2_exchange.wav`), a badge on each column, a header line naming
every engine on the page, a new `manifest.json` per run listing each clip against its engine, and —
the one that actually travels — the text the **צור סיכום** button emits, which is what gets pasted
into a chat and acted on days later.

Her engine is read out of the **agent's own call report** (`engineFromPipeline`), never assumed from
this process's env: on an A/B run a variant may legitimately override the provider, and that is
exactly the run where assuming would put the wrong engine on the clip. **With no call report the
label is `engine-unverified`**, a warning goes to the top of the page, and the runner says so on
stdout. Listen to such a clip if you like; do not attribute it.

### The speed/volume asymmetry

`VOICE_TTS_SPEED` and `VOICE_TTS_VOLUME` reach Cartesia (both routes) and nothing else. I invented
no DeepDub equivalent and dropped them from no output. Instead:

* `describeEngine()` carries `honoursSpeedVolume` and a `leverNote` that **quotes the values that
  were ignored** — a reader who cannot see what was asked for cannot tell "ignored" from "applied
  and made no difference";
* every tool prints it in its banner; the A/B page renders it;
* `bench:tts` marks each row `[speed/volume applied]` or `[speed/volume IGNORED by this engine]`;
* **`voice:clarity` refuses** to run its four-setting comparison on an engine that ignores the
  levers — four identical clips presented as an A/B manufactures a false answer, which is the exact
  failure the variant gates already exist to prevent. It renders one labelled reference clip;
  `--anyway` forces all four, `--engine=cartesia` runs them where they work.

`<break time="…"/>` needed nothing new — `pausesSupported()` already gates it. The descriptor now
surfaces it as `supportsPauseTags` so it is visible rather than remembered.

### A real bug this uncovered

Engines disagree on output rate: **Cartesia returns 24kHz, DeepDub returns 48kHz**, and the
synthetic caller publishes into a 24kHz `AudioSource` and pushed TTS frames into it raw. That
matched by luck. On DeepDub it would not have errored — the fake caller would simply have come out
at the wrong rate, which reads as *a broken agent*. `HarnessVoice.say(text, { rate })` resamples;
the caller asks for `CAPTURE_RATE`. Covered by a unit test.

Related: the harness now holds ONE TTS across all of a call's utterances and closes it. Previously
each utterance built its own engine (a websocket handshake per line; on DeepDub, a leaked socket per
line out of a two-socket pool).

### One production file touched, on purpose

`pipeline-observer.ts`: added `DEEPDUB_MODEL` and `ELEVENLABS_MODEL` to `PIPELINE_KEYS`.
`CARTESIA_MODEL` was the only TTS model observed, so a DeepDub call wrote a report that named the
provider and then printed *Cartesia's* model beside it — and the harness could only ever label a
clip `deepdub/` with nothing after it. Additive and observational: two non-credential keys in the
call report. The observer test asserts the count dynamically, so nothing was pinned to the old list.

## Verified

* `npm run typecheck` — **exit 0**
* `npm run test:ci` — **exit 0** (judged by exit code; 128 files, 1879 passed)
* `npm run build` — **exit 0**
* 25 new tests in `testing/tts-engine.test.ts`, including one that constructs the **real** DeepDub
  adapter through `buildTTS` and asserts `tts.provider === 'deepdub'` (no network — the pool is
  lazy), one that pins the 48k→24k resample, and a regression guard that **fails if any file in
  `testing/` constructs its own TTS again**.

## NOT verified — read this before quoting anything

* **No audio was rendered.** This worktree has no `.env`, so I could not run `voice:ab`,
  `voice:clarity`, `bench:tts`, `voice:test` or `voice:ab:call` even once. Nothing here has been
  proven against a live vendor: not the DeepDub path through `HarnessVoice.say()`, not the new
  bench rows, not the resample on real audio, not the filenames as actually written to disk.
  **The first person with a `.env` should run `npm run voice:ab` and `npm run bench:tts` before
  trusting a single clip from this harness.**
* **Nothing here was judged by ear**, and nothing here changes how she sounds. It changes which
  engine the *instruments* speak with.
* I did not touch `tests/hebrew-tts-niqqud-ab/` (three writers active there).

## For the architect / Koren

* **`tests/hebrew-tts-niqqud-ab/synth.py` still talks to Cartesia over curl.** It is the synthesizer
  under every listening round in that folder, so a round built with it now describes the engine we
  are leaving. It was explicitly out of scope for this task and I did not build a DeepDub path for
  it. **It needs one, and it needs sequencing around the three sessions writing clips there.**
* Every Cartesia-era verdict in that folder is unvalidated on DeepDub until re-heard: minimal
  niqqud, the pointed thinking fillers, number and time speech, the `<break>` pause lengths. The
  exception is audio we spliced ourselves — a breath is our audio on any engine.
* **Only Koren's ear can settle** whether the DeepDub voice at its own rate is as intelligible down
  the 8kHz band as Cartesia was at `VOICE_TTS_SPEED=0.85`. We tuned that lever for narrowband
  Hebrew and DeepDub does not have it. That is a real, unmeasured risk of the flip, and no bench in
  this repo can answer it.
