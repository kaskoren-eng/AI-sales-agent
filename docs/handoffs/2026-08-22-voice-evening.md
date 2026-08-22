# Voice — 2026-08-22 (evening): the R2.1 acceptance call, and four bugs it exposed

Branch `feature/voice-rag-r1`, worktree `C:/keren-rag`. Follows
[2026-08-22-voice.md](2026-08-22-voice.md), which covered building R2.1.

## The headline

**R2.1 passed its acceptance criterion.** An 8-minute, 34-turn real call booked a meeting, and TTFT
did not drift with context:

```
minute   1     2     3     4     5     6     7     8
TTFT  1174   964   911   896   796   921  1111  1130
ctx   3500  5291  5708  6386  6589  7275  7713  8589
```

Context nearly doubled; TTFT is flat. Slot footprint stayed **0–620 tokens** against a 1,040 ceiling,
no watermark trips, growth **169 tokens/inference** against R2's 293. R2 reached 8,306 tokens by
minute 4; this call needed eight minutes to reach 8,428.

**And the same call showed R2.1 was quietly adding ~240ms to every knowledge turn and occasionally
dropping the answer entirely.** Four fixes below. All committed, none verified by ear — that needs a
call.

## What the call cost us, concretely

At 271s the caller asked **"כמה זה עולה?"** and she answered *"אין לי כרגע את המידע הזה"* — the most
valuable question in a sales call, with the price sitting in the knowledge base. The log at that
second:

```
19:41:39  rag_slot {"wait":300,"deadlineExpired":true,"chunks":0}
```

Not an isolated miss. Across the call: **4 of 32 slots expired (12.5%**, against the 3% threshold we
agreed to revisit at**)**, and every non-expired slot waited a **median 239ms**. The simulation had
reported median 1ms and zero expiries.

## 1. The prefetch was orphaned — `b82c2e0`

`prefetch` keys the cache on the **interim** transcript. `resolve` asks for the **preflight** text,
which is longer. Keyed on exact text the two never match, so every turn discarded a warm lookup and
started a cold one on the critical path.

**Why the simulation could not have caught it.** Synthetic TTS speech produces an interim identical
to the final, so the exact key hit every time. Only real speech, which pauses mid-sentence, produces
the mismatch. The verifier run on the pre-fix log now reports it directly: `prefix reuse 0 of 32`.

`resolve` now reuses an in-flight lookup started for a prefix of the utterance — usually the same
question missing its last word, and already ~150ms in flight, so the wait is what *remains* of it.
Thresholds (70% coverage, 12 chars) are conservative: a miss costs one embedding, a false reuse
answers the wrong question. Coverage is measured against the text actually embedded, never the map
key, so reuse cannot chain a short prefix into covering a long utterance.

`bestPrefixCoverage` is logged whether or not reuse fires, **so the next tuning pass reads the
threshold off real data instead of guessing at it twice.** If reuse fails at a steady 0.6, the floor
is too high; if the best candidate is routinely 0.2, Soniox interims arrive too sparsely for prefix
reuse to be the answer at all and the fix is elsewhere.

## 2. `answering_agent` was swallowing short questions — `61c4d2a`

Found while auditing why the rule fired 11 times in one simulated call. It skipped any reply of four
words or fewer after she asked for contact details, assuming answers are short and questions are
long. Hebrew does not honour that: `כמה זה עולה?` is three words. So is `מה תנאי היציאה?`.

Any of those arriving right after `מה השם המלא?` was silently un-grounded — the expensive failure the
gate exists to prevent, produced by the gate itself. The rule now also requires that the turn not ask
anything (question mark, or a Hebrew interrogative as a **whole** word — `מה` is a substring of
`משהו`). Question marks alone are not enough; Soniox drops them.

The audit was only possible after noticing `rag_skipped` logged nothing but `{stage, reason}`. It now
also logs word count and whether the turn asked something — **shape, never content**, since the turns
this gate declines are precisely the ones carrying names, phones and emails.

## 3. She recites the whole chunk — `64f5284`

The grounding rules said what she may say and never how much. Both calls show 77-, 54- and 52-word
answers to one-fact questions, where the hand-tuned FAQ bank the KB replaced answered in one
sentence. Asked the price, she returns the price, then the inclusions, then the per-lead overage,
then the languages, then the CRM sync.

Added a one-or-two sentence / ~40 word cap, "use only the fact that answers the question asked", an
explicit ban on reciting lists nobody asked for, and a worked example — an abstract "be brief" was
already implied and already ignored. Costs 185 words of resident prompt (2,469 → 2,654), paid once
into the cached prefix. The non-RAG prompt is unchanged byte for byte.

The first draft of the example wrote **ClickScales' real prices into a multi-tenant prompt**,
reintroducing the second source of truth for pricing that `slimKnowledge` exists to delete.
`knowledge-settings.test.ts` caught it. The `## KNOWLEDGE` block had no tests at all, which is how it
shipped half-specified; it now has ten.

⚠️ **This one is the least verified of the four.** Tests prove the instruction is present, which is
the necessary half. Whether she obeys it is a model behaviour only a real call can judge.

## 4. `duplicateReplies` read 0 on a call that had one — `2ac656a`

She spoke a 40-word sentence, the caller asked something else, and 18s later she began the identical
sentence again and was cut off. The counter required exact equality, and the truncated copy differed.

**Checked against the known artefact before believing it**, because this metric has been wrong in the
other direction: it once read 4 on a call where she repeated nothing, and preemptive TTS was disabled
over it. The distinguishing evidence:

```
19:40:33  speech_7c105f92-077  playout completed without interruption
19:40:51  speech_413934cf-897  playout completed with interrupt
```

A draft echo shares one speech handle and produces one playout. This is two of each, and 33
transcript lines against 35 TTS segments rules out an inflated transcript.

Prefix match now counts it, floored at 40 characters — well above the 2-4 word opener the prompt
mandates, so two answers both starting `מעולה.` are not flagged. That floor is what keeps this from
recreating the original false alarm by a new route.

## Also changed in the verifier

- **Asserts the prefetch is used**, so this failure stops being silent.
- **Splits discarded preemptive drafts by cause.** A barge-in invalidates the draft legitimately and
  LiveKit logs it identically; counting them together failed the acceptance call over a caller who
  interrupted himself — a red line for healthy behaviour, which is how a verifier stops being read.

## State

- 988 tests pass. KB eval **95% top-3** (gate 80%), unchanged. No schema change.
- `rag_full_call` simulation re-run on the fix: **19/19**, no regression.
- **Local worker is stopped.** It shares a dispatch pool with the production DID `+972555070922`, so
  it should not sit unattended.

## Open, in priority order

1. **A real call to confirm all four.** Nothing here is verified by ear. Watch `reusedPrefix` and
   `awaitedMs` in the log — high reuse with a low wait is fix #1 working — and listen for whether her
   answers actually got shorter.
2. **Why she repeated herself at all.** She regenerated the same answer for a *new* question. Not a
   RAG issue. Worth a look, not blind.
3. **Response latency is still ~2.0s** (EOU 595ms + TTFT 922ms + TTS TTFB 508ms) against the <1s
   target. Removing the 240ms slot wait helps; endpointing and TTFT are each doing about half the
   remaining damage.
4. **Repeated questions.** Phone asked 4×, email 3× on the earlier call. Endpointing and
   fragmentation, not RAG.
5. **pgvector on production Railway is still unverified.** Gates any deploy; migration 0014 runs
   `CREATE EXTENSION vector` pre-boot.
6. **The Cartesia `language` fix** (`sonic-3.5` missing from `MODELS_ACCEPTING_LANGUAGE`) affects
   production and is worth shipping independently of RAG.

## Questions for architect

- **The 300ms resolve deadline.** It bound on essentially every turn before fix #1. If prefix reuse
  brings the median wait near zero, the deadline stops mattering; if `bestPrefixCoverage` shows
  interims arriving too sparsely, we are choosing between a longer deadline (latency) and more
  un-grounded answers (quality). I would rather decide that on the next call's numbers than now.
- **KB pricing is still placeholder.** Koren said he would update it. Worth confirming before any
  call that is meant to demo pricing answers.
