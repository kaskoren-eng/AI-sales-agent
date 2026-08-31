# VOICE — 2026-08-31 — round-11 verdicts applied

Branch `feature/voice-round11-verdicts`, commit `fbdc7fd`, branched from `main` at `bfcacd6`.
Every gate below was judged **by exit code**, never by reading a summary line.

| gate | result |
|---|---|
| `npm run typecheck` | **exit 0** |
| `npm run test:ci` | **exit 0** — 117 files, 1580 passed, 6 todo. No `Errors` line, no unhandled rejection in the log. |
| `npm run build` | **exit 0** |
| `bash scripts/ci/territory-check.sh feature/voice-round11-verdicts` | **exit 0** — "touched only its own lane + shared files" |

**Not deployed. Nothing on this branch has been on a phone call.**

---

## 1. n1 — the nod is now a bank of three, drawn at random

His verdict, verbatim: *"אופציות מעולות שאני רוצה שנשתמש בכל אחת מהם באופן רנדומלי: C, F, L"*.

```ts
export const DICTATION_NODS = ['אֶמ.', 'אהם.', 'אָה.'] as const;   // dictation.ts
```

`DICTATION_NOD` (singular) is gone. `chooseTurnOpener` takes `nods: readonly string[]` and an
injectable `random`, and `agent.ts` passes the bank.

### It uses the machinery that already exists, not a new one

The bank is filtered by the **same `avoidOpener` window every other opening sound goes through**
(`SpokenOpenerTracker` → `chooseTurnOpener`). No nod ledger, no second tracker. Two consequences
worth knowing:

- **The previous "silence" behaviour is gone as the normal path, and that is the point.** The
  round-10 session named the single constant as the cause: a phone number followed by an email said
  the same sound twice by construction, and the only repair available was to make the second nod
  silent. With three sounds and a window of one, the second dictation turn still nods. The silence
  branch is kept as a fail-safe for a bank cut back to one member, and is pinned by a test.
- **`אֶמ.` and the receipt `אמ.` are ONE key**, because `openerKey` strips niqqud. So a receipt on
  the previous turn correctly blocks that nod on this one. That is not a coincidence I relied on —
  it is asserted directly in `spoken-openers.test.ts`.

The special-casing the brief asked me to look at was in `turn-opener.ts` and `spoken-openers.ts`
prose, not in `SpokenOpenerTracker` itself. The tracker needed no change. The comments that said the
nod "has no rotation at all" were false after this and are rewritten.

### The niqqud proof — and the trap that is NOT the one the brief predicted

The brief expected the round-10 mechanism to work here: a scoped `PRONUNCIATION_FIXES` row keyed on
the unpointed text. **It cannot work, and I want to be exact about why rather than have someone
"restore" it later.**

`אֶמ.` stripped of its segol is `אמ.` — **byte-identical to the receipt `אמ.`** Koren chose on
round-10 card `f1`, which must stay unpointed. And `guardStream` splits on sentence terminators, so
the nod and the receipt both arrive at `guardSpeech` as the whole standalone chunk `"אמ."`. There is
no surrounding context to scope a rule on. Any row that repointed the nod would repoint the receipt
and revert a verdict he never gave.

So the fix is at the strip instead: `stripNiqqudExceptOwnSounds` in `speech-guard.ts` strips niqqud
everywhere **except** across an exact literal match of a `DICTATION_NODS` member. It is a literal
scan, not an assembled regex, because the bank members contain `.` and this is the one function
whose failure mode is a nod nobody can hear.

Pinned in `speech-guard.test.ts` on **what reaches Cartesia**, not on the bank. Independently
verified at codepoint level:

```
== NOD BANK: bank -> guardSpeech -> guardStream ==
bank   אֶמ.  U+05D0 U+05B6 U+05DE U+002E
guard  אֶמ.  U+05D0 U+05B6 U+05DE U+002E   IDENTICAL
stream אֶמ.  U+05D0 U+05B6 U+05DE U+002E   IDENTICAL
bank   אהם.  U+05D0 U+05D4 U+05DD U+002E
guard/stream                                IDENTICAL
bank   אָה.  U+05D0 U+05B8 U+05D4 U+002E
guard/stream                                IDENTICAL

== RECEIPT BANK (round 10 must be untouched) ==
אוקי. / אמ. / בסדר.                          all IDENTICAL, אמ. still UNPOINTED
== FILLER BANK (round-10 PRONUNCIATION_FIXES rows must still fire) ==
אֶממ... / רֶגַע... / שניה... / אֶה...          all IDENTICAL
== MODEL-EMITTED NIQQUD ON PROSE (must still be stripped) ==
שָׁלוֹם, אֲנַחְנוּ מַתְחִילִים.  ->  שלום, אנחנו מתחילים.   ["stripped model-emitted niqqud"]
```

`אָה.` also had to survive the round-10 rule `אה(?=\.{3}|…)` → `אֶה`. It does, because the nod
carries no ellipsis — the kamatz he chose is not overwritten with the segol he chose for a different
sound. Pinned.

### The thing that would have broken silently, and did not fail any test

`allowsArmedFiller` used to refuse a filler behind a nod **by accident**: the old nod `"אה אה."` led
on `אה`, which was a member of `THINKING_FILLERS_HE`, so it classified as a hesitation and the
same-act rule refused the pair.

His three nods land in **three different categories**:

| nod | lead token | `openingSoundCategory` |
|---|---|---|
| `אֶמ.` | `אמ` | `acknowledgement` (it is the receipt) |
| `אָה.` | `אה` | `hesitation` (a filler lead token) |
| `אהם.` | `אהם` | `unscreened` (in neither bank) |

So one of the three would have started **allowing** an armed hesitation behind it, mid-dictation, on
a caller halfway through reading out his phone number — and every pairing test in the repo would
still have passed. `allowsArmedFiller` now refuses on the opener **kind**, which is the fact that
actually matters, and a test asserts the three categories differ precisely so nobody "simplifies" it
back into a category check.

### The receipt-in-isolation question from round 10 §4 — checked, and it is narrower than feared

The previous session flagged that `אמ.` alone renders as near-silence and asked whether the receipt
path ever synthesizes it in isolation. What I can state from reading the code: `guardStream` **does**
flush `"אמ."` as its own sentence chunk (`sentenceEnd` matches the period), so it is a separate
string leaving our guard. What happens after that is the Cartesia plugin's `SentenceTokenizer` at
`minSentenceLength = 8` words, sending every segment under one `context_id` with `continue: true` —
so it is appended to a continuing synthesis context with the reply behind it, not sent as an
isolated request. **That is a code reading, not a measurement, and it is unchanged from round 10.**
It is still the first thing to listen for on the next real call. The nod, at least, is no longer
exposed to it: `אֶמ.` is pointed and measured at 1.04s.

---

## 2. p1 — no code change, and I want to be plain about the sequence

The task I was given said to **remove** `mayPairInOneBreath`'s stem-collision rule and its test,
because he had approved option A. Mid-task the coordinator sent a correction: he had reversed
himself.

> "My bad, it's better if the agent will reply 'אמ. רגע..' better than that option I've picked,
> because that option can cause potential problems."

So the verdict is **B** — `אמ. רֶגַע...`, the pair the rule already allows — and A remains refused.

**I had not yet touched the rule when the correction arrived, so nothing was removed and nothing was
restored.** The check from `fa2cb68` is byte-for-byte as it shipped.

What changed is the record around it. The comment used to say the guard was *"a prediction, not a
verdict"* and invited its own deletion; that invitation is spent, and the comment now carries his
words and the sequence (picked A, reversed to B). The test is renamed to name round-11 card `p1` as
its source and pins both directions: `אמ.` + `אֶממ...` refused, `אמ.` + `רֶגַע...` allowed.

The round trip agrees with him this once — A came back as a single collapsed `"אממ."` (the two
sounds *merged*), B came back as `"אממ, רגע,"` with both intact. That merge is plausibly the
"potential problem" he means. It is recorded as corroboration, not as the reason.

---

## 3. The prompt — one line, and it was a claim about us, not an instruction

`prompts/system-prompt.he.ts`, Spoken Register section, told the model:

> …each one was tested **through a real phone line** and heard back correctly…

**No word in that bank has ever been screened on a live PSTN call.** They were screened through the
8kHz phone *band*, and by two different instruments. It now reads:

> …each one was heard through the 8kHz phone band before it reached this list — most of them judged
> by ear, the rest transcribed back correctly — and an untested Hebrew interjection fails silently…

The force of the sentence was never in the words "phone line"; it is in the clause that follows,
which is unchanged. No rule, example, vocabulary item or permission moved.

**Three golden fixtures regenerated**, deliberately: `prompt-default-notools.txt`,
`prompt-default-tools.txt`, `prompt-default-tools-noobjection.txt`. The diff is **line 109 in each
and nothing else** — I printed the differing line numbers rather than trusting the write. The
justification is recorded in the header of `system-prompt.persona.test.ts`, where every previous
regeneration is recorded. `greeting-default.txt` is unchanged.

A code comment above the bank definition was overclaiming in the other direction ("every word …
Soniox round-trip") and now states which words were screened by which instrument.

---

## 4. Which strings are ear-chosen, which are transcript-only, and what is still unscreened

Read this table as the answer to "is the vocabulary settled".

| bank | strings | how it was screened |
|---|---|---|
| `DICTATION_NODS` | `אֶמ.` `אהם.` `אָה.` | **Ear.** Round-11 card `n1`, spoken alone, in position, through the 8kHz band. Transcripts printed but explicitly labelled weak. |
| `ACKNOWLEDGEMENTS_HE` | `אוקי.` `אמ.` `בסדר.` | **Ear.** Round-10 cards `f1`, `a1`, `a2`. |
| `ACK_COMPREHENSION_HE` | `הבנתי אותך.` `טוב, הבנתי.` | **Ear.** Round-10 cards `a3`, `a4` (kept). |
| `THINKING_FILLERS_HE` | `אֶממ...` `רֶגַע...` `שניה...` `אֶה...` | **Ear.** Round-10 cards `f2`–`f5`. |
| pairing rule (`אמ.` + `רֶגַע...` vs `+ אֶממ...`) | — | **Ear.** Round-11 card `p1`, after a reversal. |
| `EMOTIONAL_COLOR_DEVICES` | `וואלה` `אוף` `איזה כיף` | **Ear.** Rounds 4/4b listening verdicts. |
| `SPOKEN_REGISTER_SLANG` — first five | `סבבה` `אחלה` `מעולה` `בקטנה` `על הדרך` | **Machine only.** Round-5 Soniox round-trip. Koren has never been asked to judge these by ear. |
| `SPOKEN_REGISTER_SLANG` — `סגור` | | **Both.** His own word, round-7 round-trip 3/3 plus his ear on card `sg1` (which produced its position rule). |

**Is anything spoken on a call still unscreened? Yes — two categories, and neither is in a bank:**

1. **The five slang words above are transcript-screened only.** They come back from Soniox intact,
   which is a real gate (it is what caught `אוו`), but nobody has judged how they *sound*. If a
   listening round is ever wanted, that is the remaining gap in the register vocabulary.
2. **Everything the model writes itself** — every sentence of every reply. That is unbounded by
   design and no screening applies to it. The banks are only the fixed interjections.

`call-state-lines.he.ts` (reflex/hold/objection lines) is prose, not interjections, and is outside
what "screened vocabulary" has ever meant here.

---

## 5. What is UNPROVEN — read this part

1. **Nothing here has been on a phone call.** Every gate above is a type-checker, a unit test or a
   codepoint dump. His verdicts were given on A/B clips, not on a conversation.
2. **The nod bank has never been heard at a live turn boundary.** He heard each sound alone on the
   page. Whether three rotating nods read as natural *while a real person reads out a phone number*,
   with real hesitation and restarts, is untested. The synthetic caller cannot answer this — it is
   too fluent and its dead-air figure runs 1–1.5s high.
3. **`אמ.` in the RECEIPT position may still render near-silent.** Unchanged from round 10 §4. I read
   the plugin (one `context_id`, `continue: true`) and it argues the exposure is small; I did not
   run it. Only a call settles it.
4. **The prompt change is invisible to every test**, like every prompt change. If she starts
   inventing register words, that line is the first suspect and reverting it is one string.
5. **The three nods are not equally likely to be heard as one another's substitutes.** They are three
   genuinely different sounds (a closed-lip hum, a nasal two-beat, an open vowel), and the no-repeat
   rule will move between them freely. He approved all three individually; he has not heard them
   *alternating across turns*.
6. **`אהם.` classifies as `unscreened`** to `openingSoundCategory`, because that function reads the
   two banks and a nod is a third act. That is now harmless — `allowsArmedFiller` refuses on kind —
   but if anyone later calls `mayPairInOneBreath` with a nod directly, they will get a wrong answer
   for `אֶמ.`. It is guarded at the only current call site and documented at both.
7. **No new kill-switch.** `VOICE_DICTATION_NOD_ENABLED=false` remains the rollback and it restores
   the pre-nod behaviour (a full receipt mid-number — the original bug). There is deliberately no
   switch that restores "one nod instead of three", because the one nod was `אה אה.`, a string he
   rejected. Say so if that is the wrong call.
8. **No listening round was needed and none was run.** Every string that reaches Cartesia on this
   branch is one he has already heard. This is not a round 12.

---

## Questions for the architect

- **The five round-5 slang words are the last transcript-only strings she speaks.** Worth a listening
  card if there is ever a round 12 for another reason; not worth a round of its own.
- **`אֶמ.` (nod) and `אמ.` (receipt) are the same sound with and without a mark.** Both are his,
  chosen in different positions, and the code treats them as one key for repeat purposes — which is
  right. But it means the closed-lip hum is now reachable from two mechanisms, and if a call sounds
  hummy that is where to look first.

## Not deployed

`npm run agent:deploy` is Koren's call through the supervisor session. `main` is left deployable:
no schema change, no migration, no new env key, no shared-file edit.
