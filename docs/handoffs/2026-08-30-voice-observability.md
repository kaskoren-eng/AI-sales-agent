# Voice — pipeline observability (2026-08-30)

**Branch:** `feature/voice-pipeline-observability` (off `main` @ bd4c88f) · worktree `C:/agent-voice`
**Scope:** observability and verification ONLY. No runtime behaviour, default or tuning value was
changed. Nothing was deployed.

**Gate:** `npm run test:ci` exit **0** — 106 files, 1292 passed, 6 todo (baseline: 105 / 1267).
`npm run typecheck` exit 0. `npm run build` exit 0.

---

## The question this answers

"Are the pipeline components connected and live?" could not be answered from a call. Four separate
things made it unanswerable, and they had different causes:

1. **`preemptiveTts` was invisible.** It reads `env.VOICE_PREEMPTIVE_TTS`; the variable is set on
   the cloud agent, `lk agent secrets` lists names only, nothing logged the value and no call report
   recorded it. The single largest remaining latency switch was in an unknown state in production.
2. **Turn detection was reported as requested, not resolved.** `AgentActivity` downgrades the mode
   to `undefined` at construction when its preconditions fail, with only a warning. The call report
   copied `env.VOICE_TURN_DETECTION` and called it the answer.
3. **`draftsDiscarded: 0` is ambiguous.** It reads identically whether every draft was used or no
   draft was ever made — a working feature and a dead one produce the same number.
4. **15 voice env keys are unset on the cloud agent**, including every kill-switch added in the last
   two days. They run on code defaults, and nothing said so.

## What shipped

`src/modules/channels/voice-livekit/pipeline-observer.ts` (new, plus `pipeline-observer.test.ts`,
18 tests), wired into `agent.ts`, persisted by `call-report.ts`, and surfaced by
`npm run call:report`.

### 1. One line at session start — `pipeline_resolved {...}`

Emitted **after** `session.start()`, which is the only moment the values are true: the SDK merges
its defaults at construction and the activity re-resolves turn detection at start.

Everything under `resolved` is **read back off the live session**, not off env:

| field | source |
|---|---|
| `turnDetection` | `AgentActivity.turnDetectionMode` — the value AFTER the SDK's downgrade checks |
| `endpointingMode / MinDelayMs / MaxDelayMs` | `sessionOptions.turnHandling.endpointing` |
| `preemptiveGeneration`, `preemptiveTts`, `maxSpeechDuration`, `maxRetries` | `sessionOptions.turnHandling.preemptiveGeneration` |
| `vadAttached`, `vadIsSdkDefault` | `activity.vad`, `activity.usingDefaultVad` |
| `sttLabel`, `llmLabel`, `ttsLabel` | the plugin instances the activity is actually holding |

A missing field yields `null`, never a plausible default — a future SDK rename must read as "we no
longer know", not as a confident wrong answer.

Alongside it, `configured` lists 36 pipeline settings and kill-switches with **`source: 'env' |
'default'`** for each, decided by whether `process.env[KEY]` is set. After `loadEnv()` a Zod default
and an explicit value are indistinguishable — which is precisely the ambiguity that made
`VOICE_PREEMPTIVE_TTS` unanswerable. `runningOnDefaults` is the derived list. No credential is in
the set, and a test asserts that.

### 2. The same object in the call report

`CallReportJson.pipeline`. A log line alone would have repeated the original mistake more slowly:
logs roll, and the call you want to attribute is usually last week's. The report is written to
stdout as `call_report_json` and to `call_learnings` per turn, so it survives a killed worker.

### 3. Counters that prove preemptive fired

`summary.preemptive`:

```
generation: draftsStarted, draftsUsed, draftsInvalidated, draftsUnaccounted,
            leadTimeMedianMs, leadTimeMaxMs
llm:        completed, cancelled, cancelledPromptTokens
tts:        completed, cancelled, charactersSynthesized, charactersDiscarded
```

**Method.** LiveKit emits no event for a draft. The only signals are three log messages inside
`AgentActivity` (`agent_activity.js`):

- `logger.info(… 'starting preemptive generation')` — a draft began
- `logger.debug({ preemptiveLeadTime }, 'using preemptive generation')` — the draft became the reply
- `logger.warn('preemptive generation enabled but chat context or tools have changed…')` — discarded

The middle one is at **DEBUG**, and the agent runs at `info`, so pino drops it before it reaches any
stream. Anything watching stdout would have counted starts, never uses, and reported a working
feature as dead. So the observer wraps the **logger object's methods** —
`globalThis[Symbol.for('@livekit/agents:logger')]`, which `AgentActivity` holds as a class field
`logger = log()` — intercepting the call ahead of pino's level filter and delegating verbatim.
Printed output is byte-for-byte unchanged. There is a test that proves the debug interception
against the real, initialised LiveKit logger.

`draftsUnaccounted = started − used − invalidated` catches the SDK's silent
`cancelPreemptiveGeneration()` path **and** a future message rename — the counters degrade to a
visible hole rather than to a flattering zero.

Separately, and independently of the logs, `LLMMetrics.cancelled` and `TTSMetrics.cancelled` (both
set from the generation's own abort signal, already on the `MetricsCollected` events we subscribe
to) give the measured cost: LLM calls paid for and never heard, and — with `charactersCount` — the
exact Cartesia characters synthesized into audio nobody heard.

### 4. `npm run call:report` shows all of it

A `PIPELINE AS RESOLVED` block, a `<-- DIFFERS from the requested mode` marker when the resolved
turn detection disagrees with the header, an explicit `NONE STARTED — the mechanism did nothing on
this call` line, and the discarded-characters figure. Reports written before today still render
(verified against a stripped report).

---

## What the next real call will tell us that it could not before

1. **Whether preemptive TTS is on.** `pipeline.resolved.preemptiveTts`, read off the running
   session. This is the fact that has been unavailable for weeks.
2. **Which turn-detection mode is actually running**, after the SDK's downgrade checks — and
   loudly, if it disagrees with what env asked for.
3. **Whether preemptive generation fires at all**, and how often it wins:
   `draftsStarted / draftsUsed / draftsInvalidated`, plus the median lead time of the drafts that
   survived — i.e. the milliseconds actually saved, per draft.
4. **What the drafting costs**, measured rather than argued: cancelled LLM calls with their input
   tokens, and cancelled TTS with its character count.
5. **Which 15+ settings are running on code defaults on that host**, listed by name.
6. **That the VAD reaching the session is ours** — `vadIsSdkDefault: false`. If it were ever true,
   every `VOICE_VAD_*` value in the config would be fiction, and nothing would have said so.
7. **Which STT / LLM / TTS plugin objects the activity is holding**, by their own labels — so a
   report can no longer name a provider that did not speak.

## Noise cancellation: the honest answer

**It is not provable, and I did not invent a signal for it.** `noiseCancellation.engaged` is the
literal string `'unprovable'`, deliberately not a boolean.

What the chain actually is, from reading `@livekit/noise-cancellation-node@0.1.10` and
`@livekit/rtc-node`:

- `TelephonyBackgroundVoiceCancellation()` returns a plain descriptor
  `{ moduleId: 'livekit.plugins.noise_cancellation', options: { modelPath: '…/inb.bvc.hs.c6.w.s.23cdb3.kef' } }`.
- The native plugin is loaded by a module-level `load()` that runs at **import time** and
  **swallows failure**: `catch (error) { console.error('Error loading noise cancellation plugin:', error) }`.
  The descriptor still returns successfully afterwards.
- The descriptor is passed through `session.start({ inputOptions })` → `room_io` → `AudioStream` →
  the Rust FFI as `audioFilterModuleId` + `audioFilterOptions`. **Nothing** in that path emits an
  event, a metric, a callback or an error saying "I am processing audio".

What IS checkable, and is now recorded per call: `attached` (the descriptor reached
`session.start`), `moduleId`, `modelPath`, `modelFileExists`, `pluginLibPath`, `pluginLibExists`.

Two useful deductions from that:

- `modelPath()` **throws** when the `.kef` is missing, and it is called inside the `session.start`
  argument list — so a missing model kills the call outright rather than degrading it silently.
  **A call that connects at all proves the model file is present.** The platform binaries are
  `optionalDependencies` (`noise-cancellation-linux-x64` etc.), so a cloud image built with
  `--no-optional` or on the wrong platform would fail loudly, not quietly.
- The **dylib** failure is the silent one, and it is the one that would leave the filter inert. The
  file-existence check is the closest available proxy and it is not proof.

**To actually prove engagement** you would need one of: (a) LiveKit exposing a filter-status field
on the audio stream — an upstream ask; (b) an A/B on the same line, one call with the filter and
one without, comparing `endOfTurnMedianMs` and `cutOffs` — the comment at `agent.ts` claims ~700ms
per turn rides on this and it has never been measured; or (c) capturing the agent-side audio frames
and measuring the noise floor, which is a build, not an observation. **Recommendation: (b)**, and it
costs two phone calls. Note that today it can only be tested by *removing* the filter, which is a
behaviour change and therefore out of scope for this branch.

## What else remains unprovable, and why

- **VAD parameters in force.** `silero.VAD` keeps its options in a `#private` field with no getter.
  We can prove a VAD instance reached the activity and that it is not the SDK's auto-provisioned
  default (`vadIsSdkDefault: false`), so `VOICE_VAD_MIN_SILENCE_MS` and
  `VOICE_VAD_ACTIVATION_THRESHOLD` did travel from env into `VAD.load()` one hop earlier — but the
  loaded model cannot be asked to confirm them.
- **Which speech handle a cancelled TTS belonged to.** `TTSMetrics` carries `speechId`, but the
  "starting preemptive generation" log line does not, so a cancelled synthesis cannot be attributed
  to a specific draft. With preemptive TTS OFF a cancelled synthesis means a barge-in; with it ON it
  also includes discarded drafts. The counter cannot separate them — the recorded switch state is
  what disambiguates it, which is exactly why both now land on the same call record.

## ⚠️ Found while instrumenting: `cutOffs` has never counted anything

`CallReport.#watchForCutOffs()` patches **`process.stderr.write`** looking for LiveKit's
`"stt end of speech received while vad is still in a speech segment"` warning. That warning is
emitted through LiveKit's pino logger, and `log.js` builds it as
`pino({…}, multistream([{ stream: pretty ? pinoPretty() : process.stdout }, …]))` — **stdout**.
Nothing in the agent SDK writes to stderr. So the counter is watching a stream the message never
crosses, on top of the already-documented reason that the warning only fires in `stt` turn-detection
mode while production runs `vad`.

`cutOffs: 0` therefore means nothing at all on any call recorded so far.

**Not fixed here** — that is a behaviour change to a number people read, and the fix should land
with whoever will re-read the calls it affects. `PreemptiveObserver` shows the durable pattern:
hook the logger object, not a byte stream. A one-line comment marking the defect is in
`call-report.ts`.

## Recommendation: is preemptive TTS worth an A/B?

**Yes — and it is now cheap, which it was not before.**

The case for re-opening it: it was switched off on a measurement taken while preemptive generation
was broken. Every preemptive TTS was then synthesising a draft that was thrown away — pure wasted
load, which is exactly what a slowdown looks like. The measurement described a bug, not the feature
(the comment in `agent.config.ts` says as much). Since then, draft invalidations fell 15 → 1 per
call. The last call reported `draftsDiscarded: 0`.

**Cost.** Two arms of ~5 real calls each, ~1 hour of Koren's time plus a redeploy between arms.
The money is Cartesia characters on discarded drafts — at ~$0.02/min of TTS this is cents, and
`preemptive.tts.charactersDiscarded` now bills it exactly instead of estimating it.

**Do this first, before either arm.** Take **one** call as-is and read `pipeline_resolved`:

- If `preemptiveGeneration: false` or `draftsStarted: 0`, **stop**. Preemptive generation is not
  running, and measuring preemptive TTS on top of a mechanism that never fires would reproduce the
  original mistake exactly. Fix that first.
- If `draftsStarted > 0` but `draftsUsed === 0`, also stop — see `docs/phase-4-known-issues.md` §14.
  Drafts against Soniox survive only on a strict transcript equality, and the trigger has never been
  made reliable. Preemptive TTS on a draft that is always discarded is pure cost.
- Only if `draftsUsed > 0` on a couple of calls is there something for preemptive TTS to accelerate.

**What counts as a win.** One number, decided in advance: `summary.deadAir.medianMs`, on ≥6 turns
per call, over ≥5 calls per arm. Cartesia's TTFB is ~466ms and is the largest remaining block of
dead air, so a real win looks like **≥200ms off the median with p90 no worse**. Guardrails that
void the result regardless of the median: any increase in `fragmentedTurns`, or
`charactersDiscarded` exceeding ~25% of `charactersSynthesized` (which would mean we are paying for
more audio than the caller hears). Do not read `worstCaseMs` — it is blind to overlap by
construction, and blind to overlap is blind to the entire mechanism under test.

**Kill-switch:** one env var, `VOICE_PREEMPTIVE_TTS`. Reverting is a redeploy.

---

## Next steps

- **KOREN** — take one real call on this branch's build and read the `pipeline_resolved` line (or
  `npm run call:report`). That single call settles the preemptive-TTS state, the resolved turn
  detection, and whether drafting fires at all. No deploy was done from here.
- **VOICE** — after that call: decide the preemptive-TTS A/B per the gate above; fix the `cutOffs`
  stream bug as its own change; consider the noise-cancellation A/B (two calls).
- **ME** — nothing outstanding on this branch. Gate is green; the branch is unmerged and touches no
  other workstream's territory (`voice-livekit/**` plus `scripts/show-call-report.mjs`).
