# VOICE — 2026-09-01, the seven defects from the 09:29 call

Branch: `feature/voice-call5-defects` (from `main` @ `e08ba1b`). Not deployed. Koren is holding the
deploy to ship this with another session's work and a website change.

Gate, by exit code: `npm run typecheck` 0 · `npm run test:ci` 0 (122 files, 1719 passed, 6 todo) ·
`npm run build` 0 · `scripts/ci/territory-check.sh` pass.

---

## What I established, defect by defect

### 1. Three identical openings, and a counter that read zero

**Established, not assumed.** The report's own metric stream shows THREE separate generations —
`llm_metrics` at 207149, 209354 and 211136ms, each with its own `model_ttft` (778 / 767 / 775ms) and
its own `tts_metrics`. Nothing replayed a buffered reply. The caller interjected four times in nine
seconds — "לשתף איתו פרטים.", "ירצו לדבר ישירות עם בן אדם.", "זה לא יעשה לי עבודה כפולה?" — every
one a facet of the same objection, and gpt-5.4 answered each from the top with the same
prompt-supplied empathy opener. **The peer session's hypothesis is right: an interrupted turn is
restarted from the top rather than continued.**

**Why the counter was green.** `duplicateReplies` compared committed transcript lines with `===`.
The three lines are three different strings: the first carries the acknowledgement `llmNode` injects
("אוקי. "), and the truncation point moved by one word between the second and the third. Exact
equality is *structurally* blind to a restart, because a restart is never byte-identical — the
interruption picks where it stops and it lands somewhere new every time.

Fixed both halves:
- **The counter.** `isRestartOf` (new `repeat-guard.ts`) compares on a normalised token prefix after
  stripping the injected opener. `duplicateReplies` is widened to include restarts and
  `restartedReplies` reports that half on its own, so a whole reply said twice and a restarted turn
  stay distinguishable. **The test you asked for is `call5-defects.test.ts` → "replays 205/209/212s
  and the report now SEES it"**: it feeds the three real strings through `CallReport` and asserts
  `restartedReplies === 2`. A sibling test asserts the old `===` test is still 0 on the same input.
- **The behaviour.** `SpokenSentenceLedger` + a suppression step in `guardStream`: a sentence already
  sent to the TTS inside 30s is not sent again. `VOICE_REPEAT_GUARD_ENABLED`, default on.

**⚠️ One thing I could NOT settle, and you should know it before you read the transcript again.**
The SDK's own speaking clocks say she was audible for **273ms, 449ms and 555ms** on those three
turns (`startedSpeakingAt`/`stoppedSpeakingAt` on the committed messages) — nowhere near long enough
to say a thirteen-word sentence. So the caller almost certainly heard the sentence *begin* three
times, not finish three times. Which of the two it was can only be settled from the recording, and
nothing serves LiveKit recordings yet. It is a real, audible repetition either way; I am flagging it
because the transcript overstates it.

### 2. The scheduling loop — the one that ended the call

**Established.** A time preference is **not a tracked fact at all**. `FactMemory`'s field union is
`'name' | 'phone' | 'email' | 'business'`; `bookingNote`'s required list is `['name', 'phone']`,
because the model passes `slot_datetime` straight from `check_calendar_availability` and the slot
never appears as a missing argument. So neither the ask counter nor the "already established" note
had anything to say. The hole is structural, not a degraded instruction.

New `slot-memory.ts` (`VOICE_SLOT_MEMORY_ENABLED`, default on) tracks **day, part of day and hour**
from his own words plus her asks, and puts a turn-boundary note in front of the model quoting his
sentence verbatim. Replaying the real 161–293s sequence, the note fires from his "באיזה שעות בבוקר?"
at 177s onward — i.e. before the third ask, which is the first one that was wrong.

**The other booking dimensions, since you asked:** DURATION is never asked of the caller —
`check_calendar_availability` picks it and parks it on `lastCheckedDurationMinutes`; no hole.
CHANNEL (Zoom) is stated, not asked; on this call the LEAD asked *her* and she answered once; no
hole. Only the three time dimensions were re-asked, and all three are now tracked.

### 3. She accepted the ending and reversed it

**Established: neither the tool nor the gate did this — the model wrote both turns.** The report's
`toolCalls` array is complete and timestamped, and its only two `end_call` entries are at 474935ms
and 477394ms, both `reason: "other"`, both after the booking failures. `endCallRefusals` is 0, so
the gate never ran either. Nothing closed the call at 320s and nothing refused to.

Fix: a sentence that **proposes** a stop ("עדיף שנעצור כאן", "בוא נסיים פה") with no `end_call`
behind it is rewritten into `אתה רוצה שנעצור כאן?` — the gate's own confirmation question, your
round-14 `c1=D` verdict. The two turns then read as one person: she asks whether to stop, and her
next turn offers to carry on differently. A farewell is untouched, and the rule is skipped once
`end_call` has been invoked or a booking has succeeded (the prompt has her say goodbye *before*
calling end_call, so a booked call must be able to close itself).
`VOICE_STOP_ANNOUNCE_GUARD_ENABLED`, default on. **This does not make her end calls more readily —
it converts an unbacked announcement into a question.**

Also worth knowing: the 320s turn was audible for **170ms** by the same speaking clock, and the
recovery reply began 1.05s later and ran 9.4s. The eleven seconds in the transcript are commit
times, not silence.

### 4. Two near-identical apologies

**Established: neither is a fixed line in this repo.** Both are gpt-5.4 paraphrasing one prompt
instruction — *"apologize briefly, say a natural variation of «אעביר לצוות ונחזור אליך לתיאום
מדויק»"* — obeyed twice, because `book_meeting` failed three times (454710, 456705, 474020ms). Their
second halves are word-for-word identical. The repeat guard from defect 1 makes it one; there is a
test on the two real sentences.

Two things I did **not** do and want on the record: I did not re-fix the booking failure (already
fixed on main in `e08ba1b`), and I did not change the tool. But **the prompt's "do not retry the
same tool more than once in a row" was overrun — three calls in twenty seconds.** That instruction
is currently unenforced. Worth a decision next round; I left it alone to keep the blast radius off
the live booking path.

### 5. `אחלה` describing the product

**Established: the rule reached the prompt, and the prompt also taught the violation.** Both
`VOICE_SPOKEN_REGISTER_ENABLED` and `VOICE_CALL4_PROMPT_ENABLED` were on for both calls, and the
fixtures pin the round-13 `s2` text. But the Spoken Register section — three hundred lines above it
— offered **"זה עובד אחלה בדיוק במקרים כמו שלך."** as a worked example of the register. On the 09:43
call she said "זה עובד אחלה למי שמקבל פניות" — that example with its tail swapped.

Scoping, decided and stated:
- `[164s] זה עובד אחלה למי שמקבל פניות` — **a violation.** Verbatim the shape you flagged.
- `[293s] מחר בבוקר יכול לעבוד אחלה` — **acceptable.** That is an ARRANGEMENT, which your own note
  says is fine ("Fine about an arrangement or an answer"). Left alone.
- `[413s] אחלה. חוזרת על הנייד` — **not the product rule.** That is slang as an OPENER, which the
  register section already forbids ("never as the first word"). Not fixed here; noted below.

**Instruction was not enough**, so it is enforced: `unambiguousProductClaim` swaps the slang for
`מעולה` when a claim verb is immediately followed by it (`עובד/מתאים/עוזר/מסתדר/רץ` + `אחלה|סבבה`).
One word, same grammar, same rhythm — and `מעולה` is the word you named for this position.
`VOICE_PRODUCT_CLAIM_SLANG_GUARD`, default on. The prompt example is fixed in the same commit.

### 6. The empathy variant you did NOT choose

**Established, and it is not what the brief assumed.** The prompt did not merely *show* her the
rejected wording — it **instructed her to prefer it**: *"Until he has heard both, prefer the positive
form when you compose your own."* Round 14 settled `e2=A` six days after that sentence was written,
and the round-14 commit (`ba01136`) never retired it. She obeyed a stale instruction.

The paragraph is rewritten: it records that you heard both and kept your own, it no longer quotes
the rejected sentence anywhere, and it no longer quotes the retired instruction either. The negation
warning survives for anything NEW she composes. A verdicts test now asserts the rejected string is
absent from all three prompt variants.

**The general audit you asked for — judgement, stated.** I removed exactly two things and kept the
rest, on this rule (now written into the `system-prompt.he.ts` header as methodology rule #2):

- **Keep — a BANNED STRING, named so the ban is checkable.** `רק לוודא`, `מחיר זה חשוב`, `אין מצב`,
  the comma inside `נעים מאוד, קורן`, the receipt-ritual list. The rule *is* the string; a ban
  nobody can name is a ban nobody can verify, and the `רק לוודא` ban cannot even be explained
  without quoting the word that comes back as `רק לוועדה`. None of these is a complete alternative
  to an approved line, so there is nothing attractive to copy.
- **Keep — a "not this / this" pair showing a SHAPE.** The comma-chain example. The counter-example
  IS the rule.
- **Remove — a complete, natural, speakable ALTERNATIVE to a line you chose by ear.** That is the
  only class that has ever cost a call, and it cost one. Describe what was rejected; do not print it.

Two removals under that rule: the `e2` rewrite, and the `זה עובד אחלה...` register example (which
was not even labelled as rejected — it was a positive example contradicting a later ban).

### 7. Eleven chopped sentences — **I did not touch the threshold**

**What the two calls actually say, and it is not what the report's recommendation implies.**

- The caller's median turn was **4 words on BOTH calls**, and **55% / 56%** of his turns were four
  words or fewer. He did not speak in shorter bursts on the long call.
- Fragmentation rate: **11 in 60 caller turns (18%) vs 1 in 16 (6%)**. On 16 turns, 18% predicts
  ~2.9. **One fragment is a smaller sample of the same behaviour, not a better-behaved call.** The
  09:43 control does not demonstrate that fragmentation is fixed, and nothing I ship should be
  credited with protecting a figure that was never significant.
- `endOfTurnMedianMs` is **351 on both calls** against a 350ms floor — the endpointer fires at its
  minimum on essentially every turn.
- The measurable pauses inside a chopped thought run **385–1186ms, median ≈ 700ms**. The floor sits
  below the pause a thinking caller leaves mid-thought.

**So: a fixed silence threshold cannot serve both callers, and I am not shipping a number.** Raising
the floor to ~700ms would hold roughly half of these together and would add ~350ms to the dead air
of *every* turn, on a median already 1470ms against a 1000ms budget. That trades one complaint for
another, which is what you said not to do.

What I shipped instead is the measurement, because it did not exist: the call report now carries a
`fragmentation` block — sample count, median, max, and a `caughtAt` sizing table (how many of this
call's fragments a 500/700/900/1200ms floor would have held together). Two of the eleven gaps on the
09:29 call are unusable (165s and −451s, from stitched STT hypotheses) and are excluded rather than
averaged in.

**What would actually serve both, and what I propose:** ADAPTIVE endpointing — a longer wait only on
a turn that *looks* unfinished, so the cost is paid where it is already being paid. Hebrew has no
turn-detector model (dead end, don't reopen), but the signal is in the text: he ends the fragments
with trailing markers — "לא יודע, יש לנו המון שיחות. **זה.**", "אני חושב **ש. גם וגם. כל.** כן."
A screened lexicon of Hebrew trailing conjunctions and hesitations, applied to the STT final, would
separate "he stopped" from "he paused". That is a piece of work with its own risk and its own round
of verification, and I did not start it inside this batch.

---

## What only your ear can settle

1. **Whether suppressing a restarted sentence sounds right.** When she is cut off mid-empathy and
   the caller keeps talking, her next reply now skips straight to the substance. I believe that is
   better than hearing "זה חשש הגיוני, וה—" three times. It is a judgement about how a person
   recovers from being interrupted, and only a call will tell you.
2. **Whether the stop-announcement rewrite lands.** "אתה רוצה שנעצור כאן?" is your round-14 pick,
   but you have heard it as a *gate refusal*, not as a replacement for a sentence she had already
   started saying. It may sound abrupt in that position.
3. **`אחלה` as a bare opener** (`[413s] אחלה. חוזרת על הנייד`). The register section forbids slang in
   first position; I did not enforce that, because I am not sure a bare receipt is a problem at all
   and enforcing it would touch the opener machinery. Your call.

## Do I need a round 15?

**No.** No new Hebrew is spoken anywhere in this change.
- `אתה רוצה שנעצור כאן?` — round 14, `c1=D`, already yours.
- `מעולה` in place of `אחלה` in a product claim — round 13 `s2` names `מעולה`/`מצוין`/`טוב מאוד` as
  the words for that position; the swap says nothing you have not heard.
- The empathy line she now uses is your `e2=A` wording, unchanged.
- The two coach notes (slot memory, repeat guard) are English, read by the model, never spoken.

The one thing worth a second opinion is the *prompt example* `"זה עובד מעולה בדיוק במקרים כמו שלך."`
— every word is screened and the shape is one you approved, but I composed the sentence. It is an
example the prompt explicitly tells her never to copy verbatim, so I did not send it to a round.

## Honest list of what is NOT verified

- **No call was made.** Not a live PSTN call, not a synthetic one, not a browser session. Every claim
  above about behaviour is from unit tests and from re-reading the two call reports.
- **A prompt change is invisible to every test in this repo.** The verdicts tests prove the rejected
  wording is gone and the new wording is present. They cannot prove gpt-5.4 obeys it on turn thirty.
  Defects 5 and 6 are prompt-and-code; defect 6 is prompt-only and therefore unproven by definition.
- **The slot-memory extraction is a handful of regexes over Soniox output on a phone line.** It will
  sometimes read a day out of a sentence that was about something else. That is why the note quotes
  his own sentence rather than only asserting the value — but a false positive would put a wrong
  claim in front of the model. Not seen in testing; not proven absent.
- **The repeat guard suppresses speech.** I bounded it as hard as I could — questions exempt, short
  reactions exempt, a caller asking to hear it again exempt, and a fallback that speaks the sentence
  anyway rather than let a whole reply go silent — but a wrongly suppressed sentence is a real cost
  and I have not heard one.
- **I did not measure the latency effect.** Suppressing the first sentence of a reply delays her
  first audio on that turn until the second sentence completes. It should be rare; I did not
  quantify it.
- **`fragmentation.caughtAt` is a sizing table, not a recommendation.** It has been computed on
  synthetic input in a test and on my own reading of one call's JSON; it has never run live.
- **The 273/449/555ms audibility figures** come from the SDK's `startedSpeakingAt`/`stoppedSpeakingAt`
  on committed messages. I read the SDK source to confirm what those fields mean
  (`agent_activity.cjs`, the interruption branch), but I could not check them against audio.

## Files

New: `repeat-guard.ts`, `slot-memory.ts`, `call5-defects.test.ts`.
Changed: `speech-guard.ts`, `call-report.ts`, `agent.ts`, `prompts/system-prompt.he.ts` (+ the three
golden fixtures, regenerated deliberately — `git diff -U0` on them is exactly the two intended
blocks and nothing else), `prompts/system-prompt.verdicts.test.ts`, `src/config/env.ts`,
`.env.example`, and the two test env fixtures that enumerate every flag.

Four kill-switches, all default to the new behaviour, all documented in `env.ts` with the sequence
they come from: `VOICE_REPEAT_GUARD_ENABLED`, `VOICE_SLOT_MEMORY_ENABLED`,
`VOICE_STOP_ANNOUNCE_GUARD_ENABLED`, `VOICE_PRODUCT_CLAIM_SLANG_GUARD`.

No schema change, no migration, no settings key.

## Questions for architect

- The prompt's "do not retry the same tool more than once in a row" is unenforced and was overrun
  three times on this call. Enforce it in `timedTool` (a repeated identical failure returns a
  different instruction), or leave it to the prompt?
- Adaptive endpointing (defect 7) is the only real answer to fragmentation and it is its own piece
  of work. Worth scheduling before the next batch of ear-defects, or after?
