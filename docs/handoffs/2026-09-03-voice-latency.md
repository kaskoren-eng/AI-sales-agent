# VOICE — latency: the median described no turn on the call

**Session:** voice-latency · **Branch:** `feature/voice-latency` (pushed, 3 commits, not merged)
**Worktree:** `C:/keren-latency` · **Deploys and cloud secrets: supervisor only, as always.**

---

## In plain language, for Koren

You asked to get the agent toward one second. Here is the honest arithmetic, measured on your own
production calls rather than on the harness.

**The 1.5-second average is three different waits averaged together, and only one of them can be
fixed by engineering.** On the 15:12 call of 2026-09-03 the six turns ran
553 / 1439 / 1478 / 1578 / 2877 / 3113 ms. The reported median, 1529ms, describes none of them.

| what happened on the turn | how long you waited | how many |
|---|---|---|
| she opened with one of OUR words (`בסדר.`) | **553 ms** | 1 of 6 |
| she waited for GPT and then spoke | **1439-1578 ms** | 3 of 6 |
| she ran a tool first (saving your details) | **2877-3114 ms** | 2 of 6 |

Three conclusions, in order of how much they matter:

**1. Under one second is only reachable on a turn she opens herself.** GPT's first token takes
~1070ms and no model in the family is faster (this was measured twice before, §3 of the
known-issues doc). Add the voice's own 290ms and ~200ms of pipeline and a turn that waits for GPT
lands at ~1.5s at best. That is not a bug to fix; it is the floor. The 553ms turn cleared the
budget because she started talking 612ms **before** GPT had written a word.

**2. The mechanism that does that works — it just fires on one turn in six.** And two of the three
slow non-tool turns were silenced by a rule you approved on 2 September: round 19 removed the
receipt from any turn where the caller asked a question. The reason given at the time was that the
receipt "was not arriving early anyway", so the change cost "the word, not the second". **That
measurement was wrong and its own authors retracted it the same day** (`testing/README.md`, the
rule-5 note): both sessions had paired the numbers in a way that could not see the effect. The
receipt is worth roughly **900ms**, and on ~35% of turns we are now choosing not to take it.

That is a product decision, not an engineering one, and it is yours — you rejected that `בסדר`
before an answer three times out of three by ear. **I have changed nothing about it.** The lever is
one cloud secret, `VOICE_ACK_SKIP_ON_QUESTION=false`, and the trade is: a short receipt in front of
an answer, against ~900ms of silence on a third of turns.

**3. The tool turns were costing a second, and that one I fixed.** Saving your details ran two
database round-trips *while you sat listening to nothing* — 880 to 1099ms on production calls, once
3927ms. It is now written in the background. Same words, same order, same row; the caller just
stops waiting for Postgres.

Nothing here has been deployed, and nothing changes how she sounds.

---

## What shipped (3 commits, `feature/voice-latency`, gate green on each)

| commit | what |
|---|---|
| `709b99c` | The per-turn latency table + `turn_opener` metric |
| `d5c66fa` | `voice_path` — brackets the gap between the turn committing and the voice speaking |
| `4666158` | `VOICE_ASYNC_LEAD_WRITES` — the database off the caller's clock |

Gate on the last commit: typecheck 0 · `test:ci` **exit 0** (132 files, **1975 passed**, +42 new) ·
build 0 · territory-check OK. No golden fixture regenerated; no prompt text touched.

### New instruments

- **`npm run latency:anatomy [file|all]`** — one row per caller turn: end-of-turn, dead air, first
  audio, model first token, TTS first byte, the unexplained remainder, inference steps, discarded
  drafts, prompt tokens, opener, class, tools. Runs over **old reports too**, so the three DeepDub
  cloud calls of 2 September were re-read without a deploy.
- **`summary.latency`** in every new report, and a `WHY IT WAS THAT LONG` block in
  `npm run call:report` splitting dead air by class.
- **`turn_opener`** — which sound opened each step (ack / nod / hesitation / silent) and the
  predicates that fed the decision. This is what turns "she chose not to speak first" and "she chose
  to and something held it" into two distinguishable things. Recorded at the call site by
  recomputing the same pure classifiers, so `turn-opener.ts` is untouched.
- **`voice_path`** — when the voice node was entered and when text reached it, both on the caller's
  clock. The second number has been computed on every turn since 2026-08-16 and had only ever gone
  to stdout.

### The measured baseline, for whatever comes next to be judged against

Four cloud calls, `deepdub/dd-etts-3.2`, gpt-5.4, endpointing 350/2500, preemptive TTS **off**:

```
eou            p50  351    p90  351     (the floor is VOICE_ENDPOINTING_MIN_DELAY_MS itself)
model_ttft     p50  992    p90 2042     17k prompt tokens/turn, 94% cached
tts ttfb       p50  268    p90  419
dead air       p50  511    p90 2705     — pooled, and the pooling is the problem
unexplained    165-236ms on GPT-bound turns  (deadAir - modelTtft - ttsTtfb)
```

**That last line is the reassuring one and it closes an old suspicion:** nothing is holding finished
text. Two earlier sessions suspected a hidden buffer between the guard and the voice; on the
GPT-bound turns the whole wait is accounted for by the model plus the voice plus ~200ms.

---

## For the supervisor — what needs a deploy or a secret, and what each proves

Nothing below is urgent enough to jump a queue, and none of it is mine to run.

1. **Deploy the branch** (after review/merge) to make `VOICE_ASYNC_LEAD_WRITES` live. Expected: tool
   turns fall from ~2900ms toward ~1900ms. Rollback is the secret `VOICE_ASYNC_LEAD_WRITES=false`,
   no redeploy. Watch `summary.leadWriteFailures` — it must read 0.
2. **`VOICE_PREEMPTIVE_TTS=true`** — a secret flip on the CURRENTLY DEPLOYED build, no deploy
   needed, and the report it produces can be analysed by `latency:anatomy` offline because the
   deployed build already records `first_audio_frame`, `dead_air` and `model_ttft`. It should take
   the voice's own 290ms off the GPT-bound turns (~1500 → ~1200ms). It is currently `false` for a
   reason that was later shown to be a measurement of a bug, not of the feature (`agent.config.ts`
   says so at the setting). **One call, then revert or keep — Koren's word, in his own window.**
3. **`VOICE_ENDPOINTING_MIN_DELAY_MS` 350 → 250** — worth 100ms on every turn. Abort on any rise in
   `fragmentedTurns` or any cut-off: §11 is the precedent where a better latency number meant a
   worse call. Koren approved this for after the two above, on a call he hears.

---

## Questions for the architect / Koren

- **The round-19 receipt rule is now the single largest latency item on the board** (~900ms on ~35%
  of turns) and the measurement that justified it was retracted. Re-open it as a listening question,
  or leave it? It is his ear against ~900ms, and I will not touch it either way.
- **A tool turn still pays a second inference** (~1s) after the tool returns, on top of the tool.
  Making her speak in the same step as the tool call is a prompt change, which this session is
  frozen out of.

## Not done, and why

- **DeepDub sentence-seam prefetch** (plan step 2): the adapter awaits each sentence's generation in
  turn, so a mid-reply seam can pay a fresh ~270ms first-byte. Not built: at the measured
  real-time factor of ~2.7x, a sentence finishes generating well before it finishes playing, so the
  seam is usually absorbed. Worth doing only if `agentGap` shows it on a call, and it is the one
  change here that could corrupt audio ordering.
- **The production-shaped LLM bench** (plan step 4): designed, not built. `bench:llm` sends a system
  prompt plus one message, and that shape is exactly what made `gpt-5.4-mini` look faster than it
  was on a real call. The bench Koren should be handed sends 30 turns of history and a warm cache.
- **A local A/B of preemptive TTS was run and is NOT reported as evidence.** Two things spoiled it:
  the worktree `.env` pins `VOICE_TTS_PROVIDER=cartesia`, so it measured the engine we left, and the
  synthetic caller fragments turns badly enough that the class split reads 16 rows of `unknown` on
  an 8-utterance scenario. Its own latency column and the report's dead air disagreed threefold.
  Recorded here so nobody re-runs it expecting an answer: **this question needs the cloud, and the
  cloud needs no deploy** (item 2 above).

## Territory

VOICE lane only, plus four shared files touched additively: `src/config/env.ts` (one new key),
`.env.example`, `package.json` (one script), `scripts/show-call-report.mjs`. Two test fixtures
(`src/test/helpers.ts`, `src/plugins/auth.test.ts`) gained the new env key, which the compiler
required. **New env key claimed: `VOICE_ASYNC_LEAD_WRITES` (VOICE).** No migration, no
`tenants.settings` key.

---

# 2026-09-06 — the prompt is not the lever, and the fixed lines are

Same session, continued after Koren's decisions: (a) a word chosen by the CODE without conversational
context is a bigger risk than latency, so it is the LAST option and not the first; (b) run the
preemptive-TTS test on production; (c) evaluate the techniques in an LLM-latency article he sent.

## 1. `bench:ttft` — and the answer that saved a session's work

`bench:llm` sends the system prompt plus ONE message. A real turn carries thirty items of history
and a note glued to the tail. That difference is not academic — it is what made `gpt-5.4-mini` look
faster than gpt-5.4 before it lost on a real call (known-issues §3). So the production-shaped bench
was built: arms interleaved and rotated, each warmed separately (the cache is a PREFIX cache, so
every changed prompt starts cold), and every arm's cache state read back off the stream's own usage
rather than assumed.

```
production shape (30 history + 1.5KB note)   777ms   13234 tokens (99% cached)
no coach note                                753ms   -24ms
largest note ever seen (4.7KB)               769ms    -8ms
no history at all                            801ms   +24ms
system prompt cut to 60%                     819ms   +42ms
system prompt cut to 30%                     714ms   -63ms    4736 tokens
CACHE COLD                                   784ms    +7ms       0% cached
7 tools attached + tool prompt               843ms   +66ms   16455 tokens
```

**Cutting the prompt by 64% moves the first token by less than the noise band.** So does deleting the
history, so does the largest coach note we have ever generated, and so does missing the cache
entirely. The tool definitions are the only input that reads above zero, and they are worth ~66ms.

Then the control that settles it, run separately: a **ten-token** prompt measured **1068ms**, and a
1200-token prompt **1033ms**, on the same machine within minutes of the 777ms above. Time to first
token is a fixed vendor-side cost — queue, model start, network — and is not a function of anything
we put in the prompt.

**Two consequences, and the first is the valuable one:**

- **Trimming the prompt is dead as a latency lever.** It was the obvious next move and it would have
  cost Koren line-by-line judgement over the agent's behaviour to buy nothing.
- **The prompt cache saves MONEY, not time** (0% cached measured +7ms). Keep it for the bill, and
  keep the PREFIX stable — but never justify a prompt decision by latency again.

`--model=` was added so a model can be judged on the shape it will actually run in. That knob is
Koren's; the instrument is now honest.

## 2. The article, evaluated against our own numbers

Koren sent a general LLM-latency guide. Ten techniques; against measurement most are already done or
dead here: streaming (shipped, and we go further — sentence by sentence into the TTS), token
reduction (dead, above), `max_tokens` (touches output; we are measured on the FIRST token), batching
(would ADD latency at one request per turn), parallelisation (done — the async lead writes), RAG
(irrelevant), speculative decoding (not ours to control).

**One idea in it was right and we were not doing it: caching.** Not response caching — every turn is
unique — but the audio for the lines that are not unique at all.

## 3. The fixed-line audio cache (`8a9f74c`)

A handful of the words the caller hears are not written by the model: the five acknowledgements, the
thinking fillers, the dictation nods, the six silence reflexes. They are constants in this repo,
screened by ear over a dozen rounds, spoken verbatim — and each was a fresh vendor generation at
224-314ms of first byte. On a turn that opens with an acknowledgement that is most of the 553ms.

Now synthesised once per worker and served from memory, behind `VOICE_TTS_AUDIO_CACHE` (default on).

**It creates no new seam**, which is the thing to check rather than assume: the adapter already
generates one sentence per call to `generate()`, so the acknowledgement and the sentence after it
were always two generations with a join between them. What it DOES change is that the clip is fixed
rather than redrawn — per-generation variance for that word disappears within a worker's lifetime.
**That is a thing to hear, not to reason about, and the flip stays gated on Koren's ear.**

The design decision worth keeping: **an allowlist, not a frequency cache.** A cache that learned what
repeats would eventually hold a caller's name, a phone number read back, an email spelled out — audio
of a real person's details, in memory, replayable on someone else's call. Eligibility is exactly
`buildFixedLineAllowlist()`, and a test asserts model text and caller details cannot enter.

Three silent failures handled: the key matches through NIQQUD but stores the EXACT text (the guard
points words on their way to the vendor, so an exact-match cache would miss on precisely these lines
— and a cache that never hits looks identical to one switched off); a SILENT generation is never
stored (both vendors answer an unusable request with silence rather than an error); a CANCELLED
generation is never stored (half a word cached is half a word forever).

The greeting is deliberately not eligible: assembled per tenant, so not a constant, and nobody is
waiting on it.

## 4. Where the budget stands now

```
dead air  =  first token  +  tts first byte  +  ~180ms pipeline
             ~990 (prod)     224-314            measured
```

| lever | state | worth |
|---|---|---|
| async lead writes | built, needs deploy | ~1s on tool turns |
| preemptive TTS | secret flip, requested | ~270ms on GPT-bound turns |
| fixed-line audio cache | built, needs an ear | ~270ms on receipt turns |
| endpointing 350 to 250 | secret, after the above | 100ms everywhere |
| prompt trimming | **DEAD — measured** | 0 |
| faster model | Koren's knob, instrument ready | unknown |
| a code-chosen opener | **last resort by his decision** | ~900ms |

**Honest projection: ~1.2s for a turn that waits for GPT, not 1.0s.** The first token is a fixed
vendor cost of ~800-1000ms and nothing we own moves it. Sub-second exists only on a turn she opens
herself — the option he has ranked last, and rightly: a word chosen without context is a permanent
risk against a temporary annoyance.

## 5. Still open

- The preemptive-TTS production test was requested from the supervisor session; no confirmation yet
  that it ran. It needs no deploy and no merge.
- The ~200ms between this bench (777-843ms) and production (992-1090ms) is unexplained. Not the
  prompt — that is now measured from both ends. Candidates: the worker's event loop under live
  audio, and the route out of eu-central. Named rather than guessed.
- Nothing on this branch has been heard on a call. The audio cache in particular must be listened to
  before it reaches a lead.
