# VOICE — ask memory: she asked the same question five times and the counter saw three

**Branch:** `feature/voice-ask-memory` (2 commits, based on `origin/main` @ `bf044d9`)
**Date:** 2026-09-02

---

## In plain language, for Koren

On your call yesterday at 14:56 the agent asked what your business is **five times**, and asked
who answers your enquiries **four times**. She has a memory that is supposed to notice that. It
saw three of the five business asks and **none** of the four process asks — the second one because
"who answers your enquiries" was not a question she had any memory of at all.

Two reasons, both now fixed:

1. Her memory recognised her questions by their exact wording, from a list somebody wrote down.
   She improvises. `"מה אתה עושה ביום-יום?"` is the same question as `"במה אתה עוסק?"` and the
   list did not have it.
2. Only four things were ever remembered — name, phone, email, business. The other four of your
   five mandatory discovery questions had no memory whatsoever.

She now recognises a question by **what it asks**, not by how it is worded. And — this is the part
that matters most to you — she distinguishes **asking again** from **going deeper**. At 343s she
said `"וכמה מהר אתם חוזרים בדרך כלל?"` four seconds after you had answered. That is her building on
your answer, which is what you want, and it is deliberately **not** counted against her.

**What this does not do:** it does not stop her asking. It makes the reminder she gets accurate.
Whether she actually behaves differently on a live call is a thing only your ear can settle.

---

## What shipped

### Commit 2 — `de372ea` the ask memory (`fact-memory.ts`)

- `FactField` grew from 4 to 8: added `process` (who answers enquiries and how fast),
  `frustration`, `closing` (phone / Zoom / in person), `volume` (enquiries per day).
- New `ASK_INTENTS` layer alongside the existing literal `ASK_PATTERNS`.
- New `observeCallerUtterance()`, wired in `agent.ts` from the same `ConversationItemAdded` hook
  the other caller-side observers use.
- Note gains one line naming what he has already answered; `!answered` also removes fields from
  the exhaustion list, so the note fires **less**, never more, on that path.
- Kill-switch `VOICE_ASK_INTENT_ENABLED` (default `true`), in `src/config/env.ts` and
  `.env.example`, additive only.

### Commit 1 — `86821d8` the coach note nobody received (`coach-note.ts`, `agent.ts`)

- **`registerTracker.note()` had been built on every turn since 2026-08-30 and was never joined
  into the note the model receives.** It was named in the gate condition and printed in the
  `coach_note` log line, which is why it looked alive. It was inert in production for three days.
- The local array in `injectCoachNote` is gone. `coach-note.ts` holds **one** ordered list that is
  both the registry and the join, with a compile-time exhaustiveness check: add a producer id to
  the type and forget the order array and the build fails.
- `report.recordCoachNote(...)` wired, via an `onCoachNote` callback on the agent (same shape as
  `onGateAViolation`) rather than threading the report into `injectCoachNote`.

---

## The measurement, before and after

Both real transcripts replayed turn by turn through the class
(`src/modules/channels/voice-livekit/ask-memory.replay.test.ts` is this replay, as a test).

### `call-reports/2026-09-01T11-56-17-832Z.json` — the 14:56 call

| field | before | after | asks counted at |
|---|---|---|---|
| business | **3** | **5** | 40s, 74s, 85s, 111s, 317s |
| process | **0** | **4** | 121s, 152s, 159s, 334s |
| frustration | 0 | 2 | 101s, 172s |
| closing | 0 | 1 | 217s |
| volume | 0 | 1 | 227s |
| name | 1 | 1 | 15s |

Not counted, deliberately: `343s "וכמה מהר אתם חוזרים בדרך כלל?"` and
`382s "…מי תופס את השיחות והפניות שנכנסות — אתה, או מישהו מהצוות?"`. Both come after his answer at
339s. 382s matches every keyword group `process` requires — it is excluded by the answer, not by a
regex tuned until it fell out.

### `call-reports/2026-09-01T12-33-41-747Z.json` — the 15:33 call (the control)

| field | before | after |
|---|---|---|
| business | 2 | 2 |
| process | 0 | 1 |
| frustration | 0 | 1 |
| closing | 0 | 1 |
| volume | 0 | 1 |

She asked each discovery question once here and he answered each one. **No field counts more than
once** — a detector that fired on this call would be producing the expensive kind of error.

With `VOICE_ASK_INTENT_ENABLED=false`, both calls reproduce the "before" column exactly.

---

## The trade-off I chose for intent matching, and why

The existing comment says the detector is deliberately under-inclusive because a false "you already
asked this" silences a legitimate question. That reasoning is right and I did not delete it. Rather
than widen the phrasing list — which widens the risk everywhere — the intent layer **narrows where
it may fire** and **demands more evidence when it does**:

1. **Question sentences only** (`isQuestionSentence` from `speech-guard.ts` — the project's one
   definition of a question, the same one the one-question-per-reply rule uses). Free accuracy: her
   summary at 392s, `"אז היום גם אתה וגם מישהו מהצוות מטפלים בזה."`, mentions every noun `process`
   cares about and is a statement, so it is never read.
2. **Co-occurrence, not keywords.** Every regex in a field's `requires` must match the *same*
   question sentence. `process` needs an interrogative AND a responder verb AND a target. This is
   what keeps `"איך זה נשמע לךָ?"` and `"כמה זמן ביום זה לוקח לךָ?"` out.
3. **Deepening is not re-asking.** Once the caller has answered, later questions on that topic are
   not counted at all.

**What it still misses, on purpose:** an improvisation sharing no keyword with its field, and any
question she asks without a question mark. Both are the under-inclusive side of the same choice.

---

## What only Koren's ear can settle

1. **Does she actually stop?** The note is advisory. It fired correctly after her third business
   ask on the 14:56 call and she asked twice more anyway. Counting five instead of three makes the
   note *earlier and more accurate*; it does not make it *obeyed*. Nothing in a test can tell you
   whether a more accurate reminder changes her behaviour on a live line.
2. **Is 382s really a follow-up?** I claim `"מי תופס את השיחות והפניות שנכנסות — אתה, או מישהו
   מהצוות?"` is her refining, not repeating, because he had just answered. You may hear it as a
   fifth ask. If you do, say so — the rule to change is the "answered" suppression, not the regex.
3. **Is the new note line worth its bytes?** `"He has ALREADY answered: …"` costs roughly 150–250
   bytes a turn once discovery is under way.

---

## What I could NOT verify — the honest list

- **No live call was made.** Everything here is transcript replay plus the unit suite. The
  synthetic caller was not run either. A clean replay does **not** prove she will not re-ask a real
  caller.
- **`MIN_ANSWER_WORDS = 4` is the weakest number in the change, and it is load-bearing.** It is
  what separates `"יש לי עסק"` (not an answer) from `"אנחנו בדרך כלל עונים"` (an answer). It is
  calibrated on two calls. A genuinely terse caller — `"אני עורך דין"` — will be read as not having
  answered, which counts one extra ask and fires the note earlier. `answerTokens` spares the closed
  questions (`"בזום."`) from that cost entirely, but the open ones are exposed.
- **The four new fields are never `established`.** I deliberately did not add
  `factMemory.establish('process', …)` to `capture-lead-info.tool.ts`, because the lines adjacent to
  where it would go are `salesGate.establish(...)` and belong to the other session tonight. The
  consequence: `#answered` is read off the caller's turns only. That is arguably better (on the
  14:56 call the model called `capture_lead_info` for the first time at 241s, four minutes in) but
  it is untested against a call where STT garbles his answer.
- **Only two calls.** Both are Koren playing a website-agency owner. Different verticals will use
  different words for the same answers, and the intent sets have not seen them.
- **`summary.coachNote` has never been produced by a real call.** The recorder is wired but its
  numbers only exist once someone calls in.
- I did **not** run `voice:dev`, `voice:test`, `voice:ab` or any TTS render. Nothing here changes
  what she says, only what she is reminded of.

---

## Coach-note bytes, measured as far as I could without a live call

- System prompt: **61,468 bytes** (54,966 chars) with tools enabled.
- Fact-memory's own note across the 14:56 call, replayed: first **318 B**, last **660 B**, peak
  **1,109 B** over 84 turns. Worst realistic case (all four identity/business facts established
  plus the answered line): **1,018 B**.
- So fact memory alone is **≈1.8% of the prompt at its peak**. That is noise, not a material share.
- The **full** coach note is larger — the phrase ledger, gate, engagement, slot and booking notes
  all append — and I cannot measure that without a call. `summary.coachNote.maxBytes` on the next
  real call is the number to read, against 61,468.

---

## Definition of done

| gate | result |
|---|---|
| `npm run typecheck` | exit **0** |
| `npm run test:ci` | exit **0** (judged by exit code; 126 files, 1803 passed, 6 todo, no `Errors` line) |
| `npm run build` | exit **0** |
| `bash scripts/ci/territory-check.sh feature/voice-ask-memory` | **OK** — VOICE lane + shared files only |
| pushed | `feature/voice-ask-memory` |

Shared files touched, additively only: `src/config/env.ts`, `.env.example`, `src/test/helpers.ts`,
`src/plugins/auth.test.ts` (the last two only to add the new flag to their env fixtures, which the
type otherwise rejects). No migration. No new `tenants.settings` key.

## Boundaries respected

Did not touch `sales-gate.ts`, `GATE_FACTS`, any sales-model section of `prompts/system-prompt.he.ts`,
or `PRONUNCIATION_FIXES` in `speech-guard.ts`. **No prompt text was added at all** — the note is
runtime-injected, so the 18 characters of headroom against the `sales-gate.test.ts` ceiling are
untouched. `speech-guard.ts` is imported (`isQuestionSentence`) and not edited.

## Questions for the architect

1. The **structural** reachability test is built (`coach-note.test.ts`) — the other session offered
   to delete their two source-grep tests in favour of it. I have not deleted them; that is theirs
   to do.
2. `capture-lead-info.tool.ts` is the natural place to `establish` the four new discovery fields
   from the model's own tool args, and it sits two lines from the other session's `salesGate`
   calls. Worth doing once their branch lands, by whoever holds that file then.
3. `<break time="0.35s"/>` is confirmed alive on Hebrew TTS and still unshipped (known-issues §16).
   Nothing in this change wanted a beat, so I did not use it.
