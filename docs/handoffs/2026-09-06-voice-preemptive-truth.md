# VOICE — preemptive TTS: making the docs match the code (2026-09-06)

Branch `feature/voice-preemptive-truth`, off `origin/main` @ `6da76a8`. Not merged, not deployed.

## Bottom line

**Deliverable 2 of the brief was already built and shipped on `main`.** The call report has carried
the resolved preemptive flags and full draft accounting since commit `6550e03`
(*"observe(voice): say what the pipeline actually resolved to, and prove the drafts fired"*). I did
not rebuild it. I **mutation-tested it instead**, because the brief's real question was "is this
instrument one of the five dead ones" — it is not. Seven mutations, seven reds (table below).

What was genuinely wrong was the documentation, in three places badly enough to mislead, and one of
those was **flatly false**. That is what this branch fixes. **No behaviour changed:** every
TypeScript diff on this branch is comment-only (verified — see "Diff shape" below).

## Answers to the original question

**`VOICE_PREEMPTIVE_TTS` is not a Cartesia thing and needs no porting to DeepDub.** It is a LiveKit
session option (`turnHandling.preemptiveGeneration.preemptiveTts`) applied to whatever `buildTTS()`
returned. There is no `=== 'cartesia'` anywhere on that path. The supervisor's reading was correct.

I verified the cost counter survives the engine change too, which was the live risk: `charactersCount`
and `cancelled` are emitted by LiveKit's **`SynthesizeStream` base class**
(`node_modules/@livekit/agents/dist/tts/tts.js:286-288`), where `charactersCount` is just the input
text's length. Our hand-written `DeepdubSynthesizeStream` extends that base and calls `markStarted()`,
so it emits the same metrics as the official Cartesia/ElevenLabs plugins. **The draft-cost counter was
not silently zeroed by the DeepDub flip.**

## What I changed

| File | Change |
|---|---|
| `src/config/env.ts` (~394) | `VOICE_PREEMPTIVE_TTS` comment: mechanism instead of Cartesia's number; states it is not provider-gated; dated provenance for every figure; points at the per-call report as the only honest source, and names the dotenv `override:true` trap as the reason. **Comment-only, additive.** |
| `voice-livekit/agent.config.ts` (~149) | Same for the `preemptiveTts` block. Marks the ~466ms as historical-to-Cartesia; says plainly no cloud-production DeepDub ttfb exists. Corrects the cost paragraph: the "~$0.02/min, therefore noise" arithmetic was Cartesia list price, so the cost side is **unquantified**, not small. |
| `voice-livekit/agent.config.ts` (~167) | The orphaned *"The voice. CARTESIA sonic-3 ... the ONLY model that speaks Hebrew intelligibly"* docblock, relabelled HISTORICAL. The ElevenLabs verdict in it is still load-bearing and is kept. |
| `voice-livekit/agent.config.ts` (~264) | **The flatly false one.** `buildTTSFromEnv` said *"NOT default — ... so Cartesia keeps serving until a decision is made."* The decision was made on 2026-09-02; `VOICE_TTS_PROVIDER` defaults to `deepdub`. That comment told the reader the opposite of what the code does. |
| `voice-livekit/README.md` (~18) | Pipeline diagram said `Cartesia sonic-3`; prose said the DeepDub adapter *"is deliberately not the default."* Both inverted since the flip. |
| `voice-livekit/agent.ts` (~861, ~1301) | `Cartesia reports ~240ms` → past tense, dated as pre-flip. `the actual Cartesia bill` → the engine `VOICE_TTS_PROVIDER` selected, plus the base-class finding above. |
| `voice-livekit/pipeline-observer.ts` (~407) | `PreemptiveCounters.tts` doc: engine-agnostic by construction; who bills is `resolved.ttsLabel`; **characters, not shekels** — DeepDub's per-character price is unverified against an invoice. |
| `scripts/show-call-report.mjs` | Two renders (below). The only functional change on the branch. |

### The two rendering additions

1. **`tts engine <value> (chosen on this host | CODE DEFAULT — nobody set it)`** in the PIPELINE
   block. This data (`pipeline.configured.VOICE_TTS_PROVIDER`) was already collected and never
   displayed. It is the line that answers *who is billing for the discarded drafts below*.
2. **`(billed by <ttsLabel>)`** appended to the `TTS thrown away` line. Deliberately characters and
   an engine name, never a money figure — converting it would invent the one number nobody has.

Both follow the file's existing convention: guarded by presence, so a report written before the
field existed **renders nothing rather than `0` or a guess**. Verified against a synthetic
old-shape report (`pipeline` and `summary.preemptive` deleted) — both lines absent, exit 0.

3. The duplicate-replies advice said `Set VOICE_PREEMPTIVE_TTS=false.` Following that as a shell
   export is a **silent no-op** when the key is present in `.env`, which is the exact mechanism that
   made this flag run as TRUE for weeks. It now says to set it in `.env` (or the cloud secret set),
   and to confirm from the PIPELINE block rather than from the file you just edited.

## Mutation table — proving the instrument is alive

Baseline: 53 tests green across `pipeline-observer.test.ts` + `call-report.test.ts`. Each mutation
was applied to the **source of the field**, tests run, then reverted.

| # | Mutation (the "comfortable answer") | Test that went red |
|---|---|---|
| M1 | `describePipeline` hardcodes `preemptiveTts: true` | `describePipeline — resolved` › *returns nulls rather than guesses when the SDK moves a field* |
| M2 | `describePipeline` hardcodes `preemptiveTts: false` | + *reports preemptive TTS from the SDK options — the switch nobody could read in production* (2 red) |
| M3 | `sourceOf` always returns `'env'` (everything looks deliberately chosen) | *separates a value that was CHOSEN from one that fell through to a default*; *names every kill-switch...*; *treats an empty string as unset* (3 red) |
| M4 | `PreemptiveObserver` never increments `#started` — the always-0 counter | *distinguishes "every draft was used" from "no draft was ever made"*; *counts a draft the SDK invalidated...*; *surfaces a draft that vanished...*; *passes every log call through untouched* (4 red) |
| M5 | `charactersDiscarded += 0` — discarded drafts look free | *counts wasted LLM and TTS work from the SDK's own `cancelled` flag* |
| M6 | `CallReport` ignores the attached counters (built-and-never-read) | *reads the counters LIVE...*; *separates a feature that worked from one that never ran* (2 red) |
| M7 | `CallReport` drops the pipeline snapshot from the JSON | *persists the resolved pipeline...*; *survives the JSON round-trip that is the only channel out of a cloud worker* (2 red) |

Every field the brief asked for has a test that fails when its source is broken.

## What the fields do and do NOT prove

**They prove:** the value the running `AgentSession` actually held after `start()` (`resolved.*`,
read back off the SDK — stronger than the resolved `env` the brief asked for, because it survives an
SDK downgrade); whether a key was chosen on the host or fell through to a code default
(`configured.*.source`); and that drafts were started, used, invalidated, or vanished
(`summary.preemptive.generation`).

**They do NOT prove:**

- **That your shell export took effect.** `sourceOf` reads `process.env` *after* dotenv ran with
  `override: true`, so a `.env` value that beat a shell export is reported as `source: 'env'`. It
  distinguishes *chosen vs defaulted*, never *which of two chosen values won*. The report tells you
  the value that ran, which is the question that matters — but do not read `source: 'env'` as "my
  export worked".
- **Cost in money.** `charactersDiscarded` is characters. DeepDub's per-character price is unverified
  against an invoice, so nobody can currently convert this to shekels.
- **That preemptive TTS is worth it on DeepDub.** No cloud-production DeepDub ttfb has ever been
  recorded. The 403ms / 466ms figures now cited in the comments are both **laptop-RTT**
  measurements from 2026-09-02.
- **That `draftsUnaccounted > 0` is a bug.** It also catches a renamed SDK log message — which is
  the design: the counters go to zero rather than lying, and `draftsUnaccounted` makes that visible.
- The agent-side wiring (`agent.ts:1149-1150`, `1310`, `1502`, `2220-2233`) is verified **by
  inspection plus production evidence**, not by a test — `agent.ts` is the LiveKit entrypoint and
  is not importable by tests. The evidence is the 2026-09-02 verification call recorded in
  `docs/handoffs/2026-09-02-voice-breathing.md`: a real report carried `ttsLabel deepdub.TTS`,
  `VOICE_TTS_PROVIDER=deepdub source=env`, and 6 discarded drafts. **This remains the one link in
  the chain with no automated guard.**

## Stale Cartesia references I did NOT touch

Confident these are correct as-is (they compare engines or name an env var explicitly, rather than
asserting Cartesia is the current engine): `bracket-net.ts:8,21`; `speech-guard.ts:900,1471`;
`call-report.ts:505-513`; `voice-mode.ts` `pausesSupported()` (untouched by instruction, and
load-bearing); `testing/clarity-ab.ts`; `testing/latency-bench.ts:13` (attributes its number).

Left deliberately, **listed rather than fixed** — a batch of comments that describe a *pipeline
position* ("the point text is handed to Cartesia") where the engine name is now merely stale rather
than wrong. Fixing them is ~8 edits across `speech-guard.ts`, this repo's largest voice file, and
would have buried a 6-file review in churn: `speech-guard.ts:29,66,73,275,483,1589,1603,1618`;
`repeat-guard.ts:142`; `dictation.ts:63`; `prompts/thinking-fillers.he.ts:34`;
`prompts/acknowledgements.he.ts:46`; `persona.ts:45`. **Worth a single dedicated sweep.**

Also left: `README.md:72`, a troubleshooting row keyed on `CARTESIA_VOICE_ID_PRIMARY`. Still correct
if you are running Cartesia; there is no DeepDub equivalent row, which is the actual gap.

## Where I disagreed with the brief

1. **Deliverable 2 was already done.** Everything requested — `preemptiveTtsEnabled`,
   `preemptiveGenerationEnabled`, draft started/used/discarded accounting, and the
   `undefined`-aware rendering in `show-call-report.mjs` — shipped in `6550e03`. Building it again
   would have duplicated a live instrument.
2. **`ttsProvider` should NOT be added to the report.** The brief said to check first and not
   duplicate; it is already carried three ways — `pipeline.configured.VOICE_TTS_PROVIDER` (with
   source), `pipeline.resolved.ttsLabel`, and `config.ttsModel` (prefixed `deepdub/`,
   `elevenlabs/`). I rendered the first instead of adding a fourth copy.
3. **"You do not know DeepDub's first-byte figure" is not quite right — but the caution was.**
   Two measurements exist and are recorded in `docs/handoffs/2026-09-02-voice-breathing.md`: 403ms
   median in-call ttfb (17 segments, 324-589) and 466ms warm median on `bench:tts`. Both are
   laptop-RTT. So the honest comment is not "unmeasured" but "measured twice, on a laptop, never in
   the cloud" — which I wrote, with provenance. The instruction not to invent a number was right;
   "unmeasured" would itself have been slightly false.
4. **The dotenv reading was right, with one refinement** worth recording: the trap is not only that
   an override is a no-op, it is that `sourceOf` cannot detect it afterwards (see "do NOT prove").

## Questions for architect

- **Is `VOICE_PREEMPTIVE_TTS` worth turning on for DeepDub?** Unanswerable from here: the last real
  measurement was Cartesia's, taken while preemptive generation was broken. Needs one cloud call
  with it on and one with it off, read from `pipeline.resolved.preemptiveTts` — not from `.env`.
- **DeepDub per-character price against a real invoice.** Until that exists, `charactersDiscarded`
  cannot be turned into a number Koren can act on.
- The `speech-guard.ts` Cartesia-name sweep above: worth its own small branch, or leave it?

## Gates

`npm run typecheck` 0 · `npm run test:ci` 0 (139 files, 2094 passed, 6 todo) · `npm run build` 0 ·
`bash scripts/ci/territory-check.sh feature/voice-preemptive-truth origin/main` 0.
`test-results.xml` not committed. No migration generated (`db:generate` never run).

### Diff shape

6 files, +119/-27. Non-comment diff on all four `.ts` files is **empty** — verified by filtering
comment lines out of `git diff -U0`. The only functional change on the branch is
`scripts/show-call-report.mjs`, which prints.
