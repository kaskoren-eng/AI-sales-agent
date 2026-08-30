# VOICE — the test loop: A/B the agent without deploying (2026-08-30)

Branch `feature/voice-test-loop`, off `main@93a9f92`. Testing infrastructure only: **no agent
behaviour changed, `prompts/system-prompt.he.ts` untouched, no schema/migration, no deploy.**

---

## The commands Koren runs

**Listen to one call, with the current config:**

```bash
npm run voice:dev      # terminal 1 — leave it running all day, it is now safe (see below)
npm run voice:test     # terminal 2
```

→ opens as `voice-test-runs/<timestamp>/<scenario>/index.html`

**A/B two or more configs against the same scripted conversation:**

```bash
cp src/modules/channels/voice-livekit/testing/variants.example.json my-test.json
# edit my-test.json — a label plus env overrides per variant
npm run voice:ab:call -- my-test.json
```

→ opens as `voice-test-runs/<timestamp>-<scenario>/index.html`. Do NOT run `voice:dev` for this one;
it starts and stops its own worker per variant.

The page is the round-6 pattern: one card per turn, one column per variant, a player, a latency
figure, radio buttons to pick a winner, a note box, and **צור סיכום** to emit a pasteable verdict.

Example of a page produced by a real run on this branch:
`voice-test-runs/2026-08-30T10-45-06-310Z-hesitation/index.html` (gitignored — regenerate it).

---

## What shipped

### 1. A laptop can no longer answer a paying customer's call

`WorkerOptions` had no `agentName`, so `npm run voice:dev` registered into the **default dispatch
pool** of the `clickscales` project — the same pool the production cloud agent is in. Confirmed
with `lk agent list`: `CA_azGQ9uaLxpot`'s **Dispatch Name column is empty**. LiveKit hands a new
room to one worker from that pool, so an inbound customer call could land on a laptop.

**The half nobody had noticed cuts the other way:** synthetic-caller rooms were auto-dispatched too,
so `npm run voice:test` was liable to be answered by the CLOUD agent rather than the local worker —
i.e. some past "local" measurements were measurements of production. I measured this directly:
a bare room created in this project had `agent-AJ_gpfEGSfDUepp` with `lk.agent.name: ""` in it
within ~2 seconds.

Now a local worker (`dev`/`connect`/`console`) registers under an explicit name (default
`keren-dev`, `VOICE_DEV_AGENT_NAME` to change it) and therefore only receives explicit dispatch.
`src/modules/channels/voice-livekit/testing/dev-dispatch.ts`.

**Why the cloud path is provably unchanged, and how I verified it:**

* The cloud image's last line is `CMD ["node", "dist/.../agent.js", "start"]` (Dockerfile.agent).
  `start` is not one of `dev|connect|console`, so `resolveWorkerAgentName()` returns `''`.
* In `@livekit/agents/dist/worker.js` (installed version, read directly, lines 172–184) the
  constructor resolves the name as
  `LIVEKIT_AGENT_NAME_OVERRIDE ?? (agentName || LIVEKIT_AGENT_NAME) ?? ''`.
  The previous code passed **no** `agentName`, i.e. the default parameter `agentName = ""`.
  `''` is falsy, so passing it explicitly lands on the **identical branch** — same env precedence,
  same registered name, same `agent_name_is_env` flag sent to LiveKit.
* `dev-dispatch.test.ts` asserts `resolveWorkerAgentName(['node','agent.js','start'], {})` is `''`,
  and that `download-files`, a bare invocation, and `start --simulation` are also `''`.
* The one place it could have gone wrong: reading only the FIRST non-flag argument, which makes
  `--log-level debug dev` resolve to `''`. Caught in review, fixed, and asserted. The resolver now
  errs toward "do not take a real call" in every ambiguous case.
* The cloud agent's secrets do not include `LIVEKIT_AGENT_NAME` (`lk agent secrets`, names only),
  which is consistent with the empty Dispatch Name — but the argument above does not depend on that.

**One dev-only behaviour change, stated plainly:** local workers now get `numIdleProcesses: 1`.
`dev` mode defaults to 0, so the first call forks a cold job process and pays the whole tsx +
googleapis + drizzle import cost first — measured at >15s, long enough that the caller gave up and
reported "no agent joined" on a run where the agent was merely late. Production passes `undefined`
and keeps the SDK default (`min(cores, 4)`).

Escape hatch, deliberately loud: `VOICE_DEV_DEFAULT_DISPATCH=1` puts a local worker back into the
production pool (set it on both the worker and the runner).

### 2. Runs are recorded, not just timed

`synthetic-caller.ts` now keeps the audio and returns it: per-turn agent reply, the greeting, and a
**mixed whole-call track with both voices placed by wall clock**, so the dead air you are measuring
is audible in the recording rather than edited out by concatenation. Every clip is written twice —
`*_phone.wav` at 8kHz (what a caller hears; judge this one) and the 24kHz studio version behind a
details toggle.

Transcript text comes from the agent's own `call-reports/*.json`, paired to turns by
`transcript-align.ts` — by runs of consecutive same-role lines, **not** by index. Index pairing is
wrong on real data and I hit it on the first run: a reply arrives as two assistant lines (a thinking
filler committed separately), and the STT splits one caller utterance into several user lines, so
turn 1's audio got captioned with turn 2's text. The test fixture is copied verbatim out of that run.

The page carries the "~1–1.5s high, comparison instrument only" caveat in a box at the top, in
Hebrew, so it cannot be quoted as product latency by accident.

### 3. The A/B runner

`npm run voice:ab:call -- <variants.json> [scenario]`. Runs the same scenario once per variant
against a worker it starts and stops itself, sequentially (parallel workers on one laptop contend
for CPU and the latency column stops meaning anything).

**How a variant reaches the agent, and why the obvious way does not work.** `src/config/env.ts` runs
`dotenv.config({ override: true })`, so `.env` beats the shell and `VOICE_TTS_SPEED=0.9 npm run
voice:dev` silently does nothing. dotenv's override only clobbers keys **present in `.env`**, so a
key that is not in `.env` survives — `VOICE_TEST_OVERLAY`, naming a JSON file of overrides, applied
to `process.env` *after* dotenv by `testing/env-overlay.ts`, which `agent.ts` imports first. Because
the values land in `process.env`, every later `loadEnv()` in every module sees them and the pipeline
observer reports them with `source: 'env'`.

**Five gates, so a run cannot quietly compare a thing with itself:**

1. two variants with identical overrides → refuses to start (`assertVariantsDiffer`);
2. an env key the schema does not define → refuses to start (`unknownEnvKeys`, `--allow-unknown-keys`
   to override);
3. the worker prints the overlay it applied; the runner echoes it;
4. the agent that answered must be the worker under test, checked via the `lk.agent.name` participant
   attribute — an empty name means a default-dispatch worker, i.e. production, and fails the run;
5. **after the calls, each variant's declared values are compared against what the agent's own
   `describePipeline()` recorded on that call.** A mismatch prints `IDENTICAL: …` on the page and
   exits non-zero.

Gate 5 is the only one that is proof rather than inference. Its first version compared variant A's
observed value against variant B's and flagged equality — which fired a **false alarm on the first
real run**, on a variant that had deliberately set a key to the value `.env` already had. Comparing
each variant against its own declaration has no blind spot in either direction. That regression is
now a test.

### Files

New: `testing/dev-dispatch.ts`, `testing/env-overlay.ts`, `testing/variants.ts`,
`testing/ab-runner.ts`, `testing/report-html.ts`, `testing/transcript-align.ts`,
`testing/variants.example.json`, and tests for the first three plus transcript-align (22 new tests).
Changed: `agent.ts` (two lines of wiring + the dev prewarm), `testing/synthetic-caller.ts`,
`testing/run-scenarios.ts`, `testing/README.md`, `package.json` (adds `voice:ab:call`),
`.gitignore` (`voice-test-runs/`), and `src/config/env.ts` — **additive only**: one exported
`ENV_KEYS` derived from the schema. `.env.example` documents ~110 of ~200 keys and is missing
`VOICE_TTS_SPEED` and `VOICE_TTS_VOLUME`, so validating variant keys against it rejected the two
most obvious things to A/B.

---

## Measured cost and runtime, from the real runs on this branch

| Tier | Wall clock | Paid API calls |
|---|---|---|
| unit + text-mode (`npm run test:ci`) | 20s, 110 files / 1354 tests | none — FakeLLM |
| `npm run voice:test` | ~40–60s per scenario after the worker is up | 1 call: Cartesia caller TTS + Soniox + gpt-5.4 + Cartesia agent TTS |
| `npm run voice:ab:call` | **~75s per variant**, incl. worker boot/teardown (measured: 2 variants × 2 turns = 2 min 34s end to end) | 1 call per variant |

A call of this size is seconds of TTS/STT and a handful of short gpt-5.4 turns — cents, not dollars.
The dominant cost is Koren's wall-clock, and it is now ~75s per variant instead of a deploy.

---

## Tier 4 (design only — NOT built, deliberately)

Text-mode behavioural assertions via `voice.testing`'s `session.run({ userInput })`, following
`testing/tool-flow.test.ts`. No audio, no STT, no TTS; LLM tokens only; runs inside `npm test`.
This is the tier that should have caught the four bugs from Koren's last call.

**Important design point:** `tool-flow.test.ts` uses `FakeLLM`, which is deterministic and free but
**cannot reproduce any of these bugs** — they are all things the real model does. So tier 4 splits:

**4a — free, deterministic, runs in CI.** Pure-function tests against the modules that already own
these behaviours. No LLM at all.

| Bug from the call | Assert on | Where |
|---|---|---|
| she asked for the name three times | `FactMemory` marks `name` captured after turn 1; the prompt's "already known" block contains it thereafter | `fact-memory.ts` (+ `buildSystemPrompt`) |
| "נעים מאוד" mid-call | a greeting-register phrase used after turn 1 is refused | `phrase-ledger.ts` / `register-tracker.ts` |
| a confirmed name overwritten by STT garbage | `FactMemory` refuses to replace a CONFIRMED value with a low-confidence one; requires an explicit correction | `fact-memory.ts` |
| ack/slang repetition | `AcknowledgementLedger` never returns the same ack twice within N turns | `prompts/acknowledgements.he.ts` |

**4b — real LLM, tokens only, NOT in CI.** A separate script (`npm run voice:script`, say) that
drives `session.run({ userInput })` against the real `gpt-5.4` with the real system prompt and real
tools, over a scripted Hebrew conversation, and asserts on the emitted messages:

1. `name_asked_once` — across an 8-turn script where the caller gives the name at turn 2, no later
   assistant message contains a name-request pattern (`איך קוראים ל`, `מה השם`, `השם שלך`).
2. `no_greeting_after_opening` — no assistant message after index 0 contains `נעים מאוד`,
   `שלום, מדברת`, or the intro sentence.
3. `name_survives_stt_noise` — turn 2 gives "קורן", turn 4 is deliberate STT garbage that looks like
   a name ("קורנטיטרי"); assert the booking tool call and any confirmation still carry "קורן", and
   that she asked for confirmation rather than silently switching.
4. `no_repeated_ack` — no acknowledgement token opens two assistant messages in the same run.
5. `no_price_quote` — "כמה זה עולה?" never yields a number followed by ₪/שקל.
6. `tool_order` — the existing hot-lead flow, but with the real LLM choosing, not FakeLLM.

Why not in CI: non-deterministic and it spends money on every push. It belongs next to
`bench:llm` — run on demand, before a prompt change ships. Assertions 1–5 should be written as
"scored, reported, and exits non-zero on a hard violation", with 3 runs per script so a single
unlucky sample does not block a change.

**Estimated cost:** ~40 short gpt-5.4 turns per full pass ≈ well under a cent of tokens, seconds of
wall clock. This is the cheapest tier by a wide margin and should be built next.

---

## What I could NOT verify

* **That the cloud agent still answers inbound calls after this change.** The argument above is
  static — argv, the SDK's constructor, and the Dockerfile — plus unit tests. Nothing was deployed
  (I was told not to), so the first real proof is the first inbound call after the merge deploy.
  If it were wrong, the symptom would be immediate and total: no inbound call answered. **Watch the
  first call after deploy.**
* **Whether `RoomConfiguration.agents` suppressing auto-dispatch is contractual.** LiveKit's docs do
  not state it either way; I measured it (control room got production in 2s, room with an
  agent-named token got nobody in 15s) and it is what the harness relies on. If LiveKit changes it,
  the symptom is two agents in a test room — which gate 4 (`lk.agent.name`) would catch as a wrong
  answer rather than silently corrupting a comparison.
* **Prompt TEXT as a variant.** Only prompt-AFFECTING env switches are variable
  (`VOICE_INSTANT_ACK`, `VOICE_SPOKEN_REGISTER_ENABLED`, `VOICE_FACT_MEMORY_ENABLED`,
  `VOICE_NEGATION_SAFETY`, `VOICE_STATE_MACHINE_ENABLED`, …). Free-text wording changes still need a
  code edit, because the prompt is built in TypeScript and its fixtures are pinned byte-for-byte. A
  `VOICE_PROMPT_SUFFIX`-style hook would fix that and is a deliberate design decision I did not take
  unilaterally — it is a change to what the agent says.
* **The absolute latency numbers.** Unchanged instrument, unchanged caveat: ~1–1.5s high. Also the
  FIRST turn of any run carries cold-start cost; compare from turn 2.
* **Cross-platform teardown.** `stopWorker` uses `taskkill /T /F` on Windows and a process-group kill
  elsewhere. Only the Windows path was exercised.
* **Test calls write to the real database** (`call_learnings`, conversations, usage rows) exactly as
  any web call does. That was already true of `voice:test`; it is not new, but an all-day A/B session
  will produce noticeably more of these rows than before.

## Questions for architect

1. **Should A/B runs write to production?** They already did, but the volume is about to go up a lot.
   Options: a `VOICE_TEST_TENANT_ID` that routes harness calls to a throwaway tenant, or a
   `usage-metering: exempt` marker on harness-originated calls. Not decided unilaterally — it
   touches billing.
2. **`VOICE_PROMPT_SUFFIX` (or similar) for A/B-ing prompt wording** — genuinely useful for the work
   Koren is about to do, and genuinely a lever that changes what the agent says in production if
   anyone sets it. Worth a claim in CLAUDE.md before anyone builds it.
