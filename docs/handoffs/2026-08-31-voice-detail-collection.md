# VOICE — the detail-collection call (2026-08-31 evening)

**Branch:** `feature/voice-detail-collection`, branched from `main` @ `7943a26` (the live build,
`Ct2UJ9LGdMK2`). **Not deployed.** Koren's decision, through the supervisor session.

**The call:** 2026-08-31 16:51, 357s, inbound from +972509788845.
`call-reports/calls-2026-08-31-third.md`. His verdict: *"השינויים טובים אבל בשלב משיכת הפרטים היא
התבלבלה וטעתה וסיימה את השיחה בלי לקחת פרטים."*

---

## In one paragraph, for Koren

The good news from that call stands: she never spoke a tool call, she never cut him off, she never
repeated herself, and the long silences are gone. What broke is the end. She told him the meeting
was booked when it was not — that is the serious one, because he is now expecting a call at 11:00
that nothing in any calendar knows about. Then she said twice that the only thing she still needed
was his email, when she had no phone number and no surname either, and finally said she had enough
and hung up with nothing but his first name. She also nearly ended the call at 79 seconds, for the
sole reason that he does not have a business yet.

I found a specific cause for each of those, and every one of them was our own text or our own code
telling her to do it — not the model going off on its own. All four are fixed, plus two smaller
things I found on the way. **None of it can be judged from here.** Whether she now sounds right at
the detail stage is a question only your ear on a real call can answer.

---

## Per defect: what I established, and how

### P0-1 — she said the meeting was booked when it was not

**Established.** The call ran four tool calls: two `capture_lead_info`, one
`check_calendar_availability` at 243s, `end_call` at 352s. `book_meeting` was **never called**. At
273s she said `קבענו לאחת עשרה` — *"we booked for eleven."*

The guard for exactly this already exists (`FALSE_BOOKING` in `speech-guard.ts`) and it **was armed
and running** — `allowBookingClaims` reads `rt.bookingCompleted`, which was false. It let the
sentence through because all five of its patterns are first-person **singular** (`קבעתי לך`,
`סגרתי לך`, `תקבל אישור`…) and she used the plural. `קבענו` is `קבעתי` with a different subject and
the identical claim.

**Changed.**

- `FALSE_BOOKING_WIDE` in `speech-guard.ts` — `קבענו`, `סגרנו`, `שריינתי`, `שריינו`, `נקבעה`,
  `רשמתי אותך`, `הפגישה קבועה/מסודרת/סגורה`. Deliberately **not** the present/future family
  (`בוא נקבע`, `אני קובעת`): those are how she legitimately offers and narrates, and one of them is
  `book_meeting`'s own filler line — a guard that ate our own filler would be worse than the bug.
- **A second replacement text.** The existing one ("I'll pass the request to the team") is right
  when there is no way to book at all. Said mid-collection on a tools call it would be a farewell
  followed by *"and what's your full name?"*. So a tools-enabled call that has not booked yet gets
  `אני צריכה עוד כמה פרטים לפני שאני קובעת` instead, which is true and leads into her next question.
- Prompt: the "NEVER claim a meeting is booked" section now names the plural and the other five
  forms, word for word with the guard, plus `check_calendar_availability` is not booking.
- New call-report metric `falseBookingClaims`. It should always read 0; the rewrite is silent to
  everyone (the caller hears a fluent sentence, the transcript records what was spoken), so without
  a number nobody would ever know it had happened.
- Kill-switch `VOICE_BOOKING_CLAIM_GUARD_WIDE`, default **on** — same argument as the tool-call leak
  guard: this failure has no acceptable version.

**Test (the required reproduction):** `speech-guard.test.ts` → *"the 273s false booking"*. It runs
her verbatim line through the shipped guard (proving it passes through) and through the fixed one
(proving it cannot), plus a boundary block that pins six legitimate booking sentences — including
the filler line — as untouched.

### P0-2 — "I only need the email", and hanging up with a first name

**Two causes, both ours, both established by replaying the real transcript through the real code.**

**(a) Rule 5's fingerprint is in her closing line.** The shipped prompt suggested
`"יש לי את הנייד שלךָ וזה מספיק — הצוות יחזור אליך עם הפרטים"`. She said
`"יש לי מספיק כדי להעביר לצוות. הם יחזרו אליךָ עם הפרטים להמשך"`. Reading the rule as it shipped:
its trigger named **no field** ("after two read-backs have failed, let *the field* go"), it put a
claim about a phone number in her mouth **without ever checking she had one**, and it ended
"close the call". She had two failed read-backs — of the **surname** — and applied all three.

**(b) The coach note told her to abandon the phone AND the email.** This is the stronger cause and
it was invisible until I replayed it. I ran her actual utterances through `FactMemory`:

| at | her line | phone asks | email asks |
|---|---|---|---|
| 294s | `אוקי. טריט, נכון? מה מספר הטלפון שלךָ?` | 1 | 0 |
| 300s | `בסדר. . מה מספר הטלפון שלךָ?` | **2** | 0 |
| 320s | `אוקי. שפיץ טריט, נכון? ומה כתובת המייל?` | 2 | 1 |
| 331s | `... מה כתובת המייל שלךָ?` | 2 | **2** |

`MAX_ASKS_PER_FACT` is 2 and neither field was held, so from 331s the note appended to her context
read, verbatim:

> *"You have already asked 2+ times for: **his phone number, his email address**. Do not ask again
> — asking a third time is the moment a caller decides he is talking to a machine. **Continue
> without it.**"*

Sixteen seconds later she said she had enough and called `end_call`. The counter was not wrong —
she really had asked twice. What was wrong is that "continue without it" has two readings and the
note only meant one of them, and nothing in it knew that `book_meeting` cannot run without a phone.

**Changed.**

- **Rule 5 rescoped.** Trigger names the EMAIL; the permission applies only once name, phone and an
  agreed time are already held; the action is `book_meeting` **in the same turn**, not a goodbye;
  and it now says in as many words that it is *never* a reason to end a call or to give up a name or
  a number. Plus: *"Never say you have a detail you do not have"*, naming both sentences she said.
  **`VOICE_BOOK_WITHOUT_EMAIL` is untouched** — Koren's round-8 `e5` verdict was the permission, and
  the permission was never the bug. Its suggested Hebrew line is now
  `"אני קובעת את זה עכשיו — הצוות יחזור אליך עם הפרטים"`, which keeps the tail he heard and drops
  the clause that asserted a field we did not have.
- **The exhaustion note now says which thing continues:** *"Continue the CALL without it: keep
  selling, keep booking … This is not a reason to end the call … whether you have enough to book is
  decided by the booking-state reminder and by the tool, never by this one."*
- **New `booking-note.ts`** — the structural fix, and the one I would keep if I could keep only one.
  A per-turn note read off the **tool runtime**, not off the transcript: whether `book_meeting` has
  succeeded, and which of its required arguments still have no value. Live only between the first
  availability check and a successful booking. It states *"NOTHING HAS BEEN BOOKED YET"*, names the
  missing required field, says the email is not one of them, and forbids the exact
  "only the email is missing" claim. When a booking exists it flips and says so, because the
  mirror-image failure (apologising for a meeting that is real) costs the lead his morning too.
  Kill-switch `VOICE_BOOKING_NOTE_ENABLED`.
- **We already had his phone number and were making him dictate it.** `rt.callerPhone` held
  `+972509788845` for the whole call. `book_meeting` takes `phone` from the model, so nothing
  downstream could supply it. The booking note now offers it back as a **confirmation** —
  *"המספר שאתה מתקשר ממנו, זה הנייד הנכון?"* — never as a substitution, because a man may want the
  demo on a different number and only he knows that. Inbound only. Kill-switch
  `VOICE_CALLER_PHONE_KNOWN_ENABLED`, separate from the note's own switch because **this is the one
  change here that alters what she says on every inbound call.**

**What I did NOT change, and why.** `MAX_ASKS_PER_FACT`, and the counting rule. Two asks six seconds
apart with only "טריט." between them is arguably one ask repeated — but every discriminator I could
write for that (a time cooldown; "did the caller speak in between") also collapses the 2026-08-29
asks at 16.5s / 28.9s / 42.2s into one, and that is the exact defect `FactMemory` was built for. The
counter stands; the wording carries the fix.

### P0-3 — the Hebrew surname spelled letter by letter and never assembled

**Established.** He spelled `ט · ר · י · ת` across two turns (`"עם ט-ר.  י."` then `"ת."`) and
nothing joined them; her next words were the garbled word she already had. Then two separate
mishearings, `טריט` and `שפיץ`, were concatenated into `"שפיץ טריט"` and read back as his name. His
surname is `שטרית` — one word.

**Does `email-dictation.ts` generalise? The shape yes, the code no** — and I want to be exact about
that rather than claim a reuse I did not make. Its character classes are `[A-Za-z]` throughout; its
ask patterns, its domain table and its `local@domain` read-back detector have no counterpart in a
name. Making one collector carry both would give it two ask-scopes that overlap inside Step 4 (she
asks for the name and the email forty seconds apart) and a letter buffer that could not say which
field it belonged to. So: **new `name-dictation.ts`**, same doctrine, ~200 lines.

The Hebrew problem is the opposite of the Latin one — a lone `S` is never a word, a lone Hebrew
letter might be. Except that it is not: Hebrew's one-letter words (ב, ל, כ, ה, ו, מ, ש) are
**prefixes**, written joined to the word they govern, so they never appear isolated in a transcript.
The rule is therefore "a Hebrew letter with no Hebrew character on either side of it", which reads
`ט` and `ר` out of `"עם ט-ר."` and leaves both letters of `עם` alone. Final forms are normalised on
the way in and restored on the last letter, so a man spelling `כ · צ` gets `כץ` back, not `כצ`.

The note states evidence, never a conclusion: the letters in order, the joined word, and — the bit
that catches the actual bug — *"you asked for ONE name, so these are competing mishearings of the
SAME word, never two words of one name. Do not join them together."* Kill-switch
`VOICE_NAME_DICTATION_ENABLED`. A rejected name is handed to `FactMemory.reject` exactly as a
rejected email is, so it can never be saved or spoken again.

### P1 — she tried to end the call at 79 seconds

**Established.** There is **no code path** that disqualifies: `call-state.ts` has no such
transition, no reflex fires there, and `end_call` was not called at 79s. It is entirely a reading of
Step 3. She also broke two of that section's existing rules doing it — the line she spoke is not the
fixed `disqualified` line (she improvised it), and she disqualified on **inquiry volume**, which the
paragraph directly above the disqualifiers already says never disqualifies anybody.

**What I could NOT establish:** whether the tenant's own `businessProfile` supplied
"פניות ראשונות או תהליך מכירה פעיל". The call report does not capture the built prompt, so the text
she was actually given on that call is unrecoverable. **That gap is worth closing and I did not
close it** — see "Not done" below.

**Changed.** A gate in front of Step 3 (`DISQUALIFY_GATE`), not a softening of it: **no disqualifier
was deleted or weakened**, and a test pins that all three plus the volume rule and the
general-uncertainty rule survive intact. Three conditions must hold first — all three mandatory
discovery questions answered, the objection addressed once and held, and what is left mapping onto a
real disqualifier. Plus *"'Not yet' is not 'no'"* naming his two actual answers, and *"never sign off
inside the first two minutes"*. Kill-switch `VOICE_LATE_DISQUALIFY_ENABLED`; a test asserts the
prompt with it off is byte-identical to the shipped one with the gate spliced out.

### P2 — the two observations

**`"בסדר. . מה מספר הטלפון שלךָ?"` — the empty sentence.** Checked against the metric stream as
instructed, and **the `אמ.`-in-isolation hypothesis is refuted**: the `אמ.` at 288.65s has its own
`tts_metrics` entry, ttfb 208ms, **duration 346ms**. It made a sound. The round-10/11 question is
still open.

I could **not** attribute the lone `.` to a producer. The report stores the spoken text, so the
model's raw output for that turn is gone, and both candidate rules (`stripIntroduction`,
`dropAckEcho`) return `''` or a clean slice on every trace I could reconstruct. Rather than guess, I
closed the class: `guardSpeech` now treats a punctuation-only sentence as silence, and names it in
`interventions` every time it fires so the producer stays findable.

**`consecutiveOpenerRepeats: 2` — I found a real escape, and it was also failing CI.**
`spoken-openers.test.ts`'s forty-turn end-to-end case is **flaky on clean `main`** — I measured 2
failures in 6 runs with my changes stashed, then 56 in 400 in-process. A 14% flake in `npm run
test:ci`, on a repo whose rule is to judge by exit code.

It is not a bad test. `AcknowledgementLedger.next` honoured `avoid` by skipping the blocked word —
and then, when every word **left** in a part-used deck was the blocked one, fell back to
`deck.pop()` and handed that very word over. Every one of the 56 failures was the same pair:
`אֶמ.` (the round-11 dictation nod) followed by `אמ.` (the round-10 receipt). `openerKey` strips
niqqud, so those are **one sound**; the tracker correctly asked for it to be avoided and the deck
gave it anyway. Fixed by refilling and re-drawing instead of popping the blocked card: **0 failures
in 400.** Governed by the existing `VOICE_OPENER_NO_REPEAT_ENABLED` (with `avoid` null the new
branch is unreachable), so no new flag.

This is very probably what the production `consecutiveOpenerRepeats: 2` was. **Whether it accounts
for both repeats is not established** — only a call report carrying the fix can say.

### One thing I found that nobody reported

`EmailDictation.note()` and the prompt's `EMAIL_COLLECTION` were **telling her opposite things**,
and the note was winning. Koren's round-8 verdict moved the email read-back to ENGLISH letters with a
letter count; the prompt was changed and the note was not, and the note is appended at the *tail* of
the context, thousands of tokens after the prompt. So on every call where the collector ran she was
being instructed to use the method he had already ruled against — with the test suite green, because
the test was pinning the contradiction (`expect(note).toMatch(/HEBREW/)`) rather than catching it.
Fixed, with the assertion inverted and a warning in both files to change them together.

---

## Definition of done

| gate | result |
|---|---|
| `npm run typecheck` | exit **0** |
| `npm run test:ci` | exit **0** — judged by exit code, run 3× (119 files, 1637 tests, 6 todo) |
| `npm run build` | exit **0** |
| `bash scripts/ci/territory-check.sh feature/voice-detail-collection` | **pass** |
| branch pushed | **NO — blocked by the permission system.** Commit is local. See the last line. |
| reproduction test for the 273s claim | `speech-guard.test.ts` → *"the 273s false booking"* |

Golden fixtures regenerated deliberately — three sections, justified in the commit and in
`system-prompt.persona.test.ts`'s own regeneration log. `diff` on the three files is those three
blocks and nothing else, verified before the note was written.

## Kill-switches added (all default to the value that fixes the defect)

| flag | off restores |
|---|---|
| `VOICE_BOOKING_CLAIM_GUARD_WIDE` | the five original false-booking patterns exactly |
| `VOICE_BOOKING_NOTE_ENABLED` | no booking-state note |
| `VOICE_CALLER_PHONE_KNOWN_ENABLED` | she asks him to dictate the number he is calling from |
| `VOICE_NAME_DICTATION_ENABLED` | no name-spelling note |
| `VOICE_LATE_DISQUALIFY_ENABLED` | the 2026-08-31 Step 3, byte for byte |

Two of these default to "not what we did yesterday", the same way `VOICE_BOOK_WITHOUT_EMAIL` and
`VOICE_TOOLCALL_LEAK_GUARD_ENABLED` do, and for the same reason: yesterday's behaviour is the defect.

---

## What only Koren's ear can settle

1. **Does she sound right at the detail stage now?** This is the whole point and no test touches it.
   The A/B page harness (`npm run voice:ab:call`) can render the new lines, but the flow itself needs
   a real call.
2. **Two Hebrew sentences have never been heard through the phone band.**
   `אני צריכה עוד כמה פרטים לפני שאני קובעת` (spoken by the guard when it rewrites a claim) and
   `המספר שאתה מתקשר ממנו, זה הנייד הנכון?` (the caller-ID confirmation). Both are ordinary sentence
   Hebrew built from words the prompt already speaks — there is no unscreened interjection in either
   — but a guard that only fires on a defect is a guard nobody has listened to.
3. **Reading his own number back to him.** Does it sound helpful or does it sound like surveillance?
   It is one flag either way.
4. **The disqualification gate may over-correct.** I made her slower to disqualify. A time-waster now
   gets further into the call than he did. That is the trade I chose; his ear on a bad-fit caller is
   the only way to know if it is the right one.

## Honest list of what is NOT verified

- **No call has been made on this branch.** Not a real one, not a synthetic one, not a browser one.
  Everything below the typecheck/test/build line is unproven behaviour.
- **Every prompt change is invisible to every test in this repo.** The tests prove the instruction is
  in the text. They do not prove gpt-5.4 obeys it on turn thirty of a live call — and the model had
  the *old* versions of all three of these rules in its context for the whole 16:51 call and ignored
  two of them.
- **The booking note, the name note and the caller-phone paragraph are advisory.** A note the model
  may ignore. The only hard enforcement added is the speech guard, which is why the guard is where
  the reproduction test points.
- **`FALSE_BOOKING_WIDE` is a regex list, not a parser.** She can still invent a Hebrew way of
  claiming a booking that is not on it. The booking note is the belt to that pair of braces; neither
  is a proof.
- **P1's root cause is only half established.** I proved there is no code path and that she broke two
  existing prompt rules. I could not read the prompt she was actually given, so I cannot rule out
  that the tenant's `businessProfile` contributed the wording.
- **The `.` in `"בסדר. . "` is fixed but not diagnosed.** I closed the class without finding the
  producer, and said so in the code.
- **`consecutiveOpenerRepeats`:** one real escape found and fixed. Whether it was both of that call's
  repeats is unknown.
- **Latency is untouched and still failing budget.** LLM TTFT 938ms median, dead air 1433ms median
  against a 1000ms budget. Nothing here helps it; two of the additions (the booking note, the name
  note) *add* tail tokens on turns where they fire, which is the same cache-preserving append the
  other coach notes use but is not free.

## Not done — worth someone's next session

- **The call report does not capture the built prompt.** That is why P1 is only half established, and
  it will block the next prompt-attribution question too. Storing a hash plus the resolved flag set
  would be cheap; storing the text is PII-adjacent (it carries the tenant's business profile) and
  needs a decision.
- **`book_meeting` still requires the model to supply a phone it could read from `rt.callerPhone`.**
  I fixed this by telling her the number rather than by changing the tool, deliberately: the tool
  silently defaulting to caller ID would book a meeting against a number nobody confirmed. If Koren
  wants it in the tool it is a small change, but it is his call.
- **The `אמ.`-in-isolation question from rounds 10/11 is still open.** This call did not answer it.

## Questions for architect

None blocking.

---

**Commit:** `804387c` on `feature/voice-detail-collection`, in the worktree
`.claude/worktrees/agent-a538d0bd2f5414ac9`.

**Push status: NOT PUSHED.** `git push -u origin feature/voice-detail-collection` was refused by the
permission system, so the commit exists only on this machine and `origin` has never seen this
branch. Nothing here is available to another session, to CI, or to a deploy until somebody pushes
it. That is the one item on the definition-of-done list that is not met, and it is not something I
can work around.
