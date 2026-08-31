# 2026-08-31 — VOICE: nine notes from a ten-minute call, and the one habit behind four of them

Branch: `feature/voice-persona-notes`, branched from `main` @ `2896c99`. **Not merged, not deployed.**

Source: Koren's nine notes after the 11:37 production call in `call-reports/calls-2026-08-31.md`
(602s, **no booking despite the lead agreeing to a time**; `repeatedPhraseCount: 34`,
`repeatedOpenerCount: 4`, `fragmentedTurns: 8`, `duplicateReplies: 1`). That call ran against the
DEPLOYED agent `7cfa526`, which is **ten commits behind `main`** — see "already fixed, only
undeployed" below before reading any note as new.

**Gate.** `npm run typecheck` exit 0 · `npm run test:ci` **exit 0** (112 files, 1411 passed, 6 todo;
judged by exit code, and there is no `Errors` line) · `npm run build` exit 0 ·
`bash scripts/ci/territory-check.sh feature/voice-persona-notes` OK.

## 👉 THE PAGE FOR KOREN

```
tests\hebrew-tts-niqqud-ab\index-round7.html
```

33 clips, nine sections, sonic-3.5 at the production speed/volume (0.9 / 1.4). **Every card is the
same moment of your call twice: A is what you actually heard, B is what she says now.** Listen,
mark, press "צור סיכום", paste it back. This page judges PHRASING; it cannot tell you whether the
model will actually stop doing it on a call — see "what is unverified".

---

## The through-line, stated plainly

**Notes 1, 3, 6 and 9 are one defect wearing four hats.** She performs a *receipt ritual* before
nearly every sentence: acknowledge → mirror his words → validate his topic → announce what she is
about to do → and only then speak. Four independent string edits would have deleted four examples
and left the habit intact.

Three of the four had a **generator in our own text**, which is why the model was so consistent:

| note | the generator we were feeding it |
|---|---|
| 3 — "בניית אתרים זה תחום מעניין" | the Emotional Color surprise beat (`"וואלה? זה ממש מעניין."`), copied near-verbatim onto a man answering what he does for a living |
| 9 — "מחיר זה חשוב" | the objection playbook, literally: *"first ACKNOWLEDGE the concern in one short sentence"* and *"הכירי בכך שתקציב חשוב"* |
| 6 — "טוב, הבנתי" ×34 | **not the model at all.** Those are OUR words: two of the five members of `ACKNOWLEDGEMENTS_HE_WIDE`, which the agent speaks at the head of *every* turn before the model has written anything |
| 1 — "רק לוודא" | the detail-collection script in the prompt, both copies |

So the change is: one prompt section that names the habit (`## No Preamble`), the three generators
fixed at source, and the code half for note 6.

---

## Per note

### 1 — "רק לוודא" / "רק שאדע" · REMOVED EVERYWHERE (new work)

Not partially fixed on main: `616cee3` replaced only the *phone* read-back; the *name* read-back and
both name-ask lists still carried it, and the call shows all of them.

Removed from: both Step-4 detail scripts, both `nameAskVariants` lists (legacy + negation-safe), and
the handoff question (`"רק שאדע להעביר — …"` → `"על מה תרצה לדבר איתו?"`). The `## No Preamble`
section names every variant — `רק לוודא`, `רק שאדע`, `רק שאדייק`, `אני רוצה לוודא`, `רק כדי לדייק` —
and a test asserts none of them ever appears *in use*, only inside the ban.

**And it is measured, not asserted.** `roundtrip7.ts` put the three clips from your call through
synth → 8kHz phone band → Soniox:

```
NOTE  n1a_A  sent="רק לוודֵא — קורן, מה שם המשפחה?"   heard="רק לוודא: קורן, מה שם המשפחה?"
NOTE  n1b_A  sent="רק לוודֵא. אפס חמש אפס, …"          heard="רק לוועדה. 050-9788845?"
NOTE  n1c_A  sent="רק לוודֵא — קורן שטרית, נכון?"      heard="רק לוועדה, קורן שטרית, נכון?"
```

**Two of three came back as "רק לוועדה", one survived** — intermittent, which is exactly the
"לא תמיד נכון" you reported on 30.8. A fourth spelling attempt would be chasing a coin flip.
`speech-guard.ts`'s `לוודא → לוודֵא` rewrite is **deliberately left alone**: it is a general
pronunciation fix for the word in any sentence, and the phrase this note is about no longer exists in
the prompt for it to touch. Your call if you want it gone too.

### 2 — the comma in "נעים מאוד, קורן" · FIXED (new work)

Changed in Call Memory and in Step 2 to `"נעים מאוד קורן"`, plus a craft rule in Emotional Color
naming the class (a short set phrase is one phrase). The example `"מעולה, קורן."` in the Speech
Rhythm section went the same way.

⚠️ **This one had a code trap and it was nearly a silent regression.** `speech-guard.ts`'s
repeat-greeting removal (`VOICE_INTRO_ONCE_ENABLED`, shipped on main 30.8) matched
`נעים מאוד` only when followed by punctuation or the end of the sentence — **the comma was the only
thing telling it where the greeting ended.** Teaching her the comma-less form would have left that
guard passing all its tests while silently ceasing to fire on the exact sentence she now says. The
regex is now name-aware (it accepts the lead's established name as a terminator, as a whole word), and
five new tests pin it — including that `נעים מאוד לשמוע` and `נעים מאוד קורנפלקס` are still untouched.

### 3 — mirroring + compliment · FIXED at the generator (new work)

The Emotional Color surprise beat now reads: *"The caller shares something **genuinely** impressive
or unexpected … **His line of work is not a surprise.** 'אני בונה אתרים' is him answering the
question you asked; reacting to it as though it were remarkable is flattery, and he hears it as
flattery."* Plus the `## No Preamble` bullets for the echo and the compliment.

### 4 — filler doubling · A REAL CODE BUG, FIXED (new work)

`[21s] "טוב," … [23s] "אהה. רגע..."` — two mechanisms writing to the same position. `llmNode`
injects the opener at the head of the reply; the 2.5s think-timer arms a hesitation that `ttsNode`
glues in front of the model's words, and `withFiller`'s `leadIn` let the opener through *in front of
it*. Both fired.

New rule, one testable function: `allowsArmedFiller(opener)` — **only a `silent` opener leaves the
head of the breath free.** A receipt and a nod occupy it as completely as a hesitation does, and the
`hesitation` opener already cleared the armed one. Dropping it costs nothing: an armed filler is only
*charged* when spoken, so the call keeps its three for a turn that opens with nothing.

**Consequence, stated so nobody discovers it by surprise:** with `VOICE_INSTANT_ACK` on (production
default) an ack fires on every non-tool step, so the think-timer filler will now almost never be
spoken. Post-tool-call waits are still covered by the `hesitation` opener. If you want to hear more
hesitation, that is `VOICE_INSTANT_ACK=false`, not this switch.

### 5 — KEEP the emotional reaction and the opening slang · PROTECTED, AND PINNED

Nothing was removed. The `## No Preamble` section **ends** by naming both as untouched, with the
distinction that makes them different from the ritual: *"a feeling he actually expressed, not the
mere existence of his topic."* A test (`NOTE 5 — the two things he asked to KEEP…`) asserts that
`אוף... זה באמת מבאס.`, `אני מבינה... זה באמת מתסכל.`, the Emotional Color section, the Spoken
Register section and every one of the nine vocabulary words are still in the built prompt — and a
second test asserts the kill-switch removes the new section **and nothing else**.

On the local `natural_flow` run below she produced `אני מבינה.. . זה באמת מתסכל.` twice and a
register touch. Both survived.

### 6 — "טוב, הבנתי" must be earned · FIXED IN CODE (new work)

`הבנתי אותך.` / `טוב, הבנתי.` leave the every-turn deck (`ACK_COMPREHENSION_HE`). They are now
spoken only when **the caller's last turn actually carried something** — `callerSharedSubstance()`:
not a question, not a backchannel, at least 4 words — **and** the previous receipt was not also a
claim. The other three (`אוקיי. / אהה. / בסדר.`) are pure receipts and still fire every turn, because
they are true after anything.

Why 4 words: `"אני מתעסק בבניית אתרים"` is four and is the most substantive thing you said all call;
`"בכלל אני לבד."` is three and got a `טוב, הבנתי.` it had not earned.

Switch: `VOICE_ACK_EARNED_ENABLED` (default true). False restores the flat five-word deck exactly.

**Known limitation, measured:** the signal is the last *committed* caller item, so it can be one turn
stale — the same staleness the mid-dictation nod documents. On the local run this produced one claim
after a price question that should not have earned it. Frequency is still down hard (0 in the terse
call, 3 in ten turns of the talkative one, against "roughly every other turn" before).

### 7 — small talk before business · ADDED (new work)

A subsection in Step 2, between the name and the discovery bank. **The hard part is the tension with
note 3, and it is addressed head-on:** *"A preamble is a comment ON him that leads nowhere … Small
talk is an EXCHANGE: you say something with content of your own, he answers, and you have both
spoken. If your small talk turns out to be a compliment about his line of work, it is a preamble —
throw it away and ask him how his day is going instead."* Two sentences, one exchange, then business.

It fired on the first local run: `[38s] AGENT טוב, הבנתי. איך היום שלךָ עד עכשיו?`

### 8 — mandatory vs optional questions · THE STRUCTURAL ONE (new work)

**Prompt half.** The bank is split. MANDATORY (asked on every call, in this order): **his business ·
his daily inquiry volume · what he would improve.** OPTIONAL: who answers and how fast · how
customers reach him · what the product is. Nothing was dropped — all six intents and all thirty
phrasings survive, reordered, and a test lists one phrasing from each to prove it.

> **This split is my judgement and it is yours to overrule.** I picked the three that Step 3
> qualification actually reads (business fit, volume context, a real pain). If you would rather have
> "who answers the phone today" in the mandatory set, it is a reorder of one list.

**Code half.** `engagement.ts` — an `EngagementTracker` reading caller turn LENGTH, riding the
existing turn-boundary coach-note injection (`injectCoachNote`, alongside the phrase ledger and fact
memory) so it costs one tail item and no prompt-cache churn. `terse` (≤4 words/turn) → *"ask ONLY the
MANDATORY questions … move to offering the demo"*; `engaged` (≥11) → *"you may add one or two
OPTIONAL ones"*. It fires once per **change of level**, never per turn. Switch:
`VOICE_ENGAGEMENT_NOTE_ENABLED` (default true).

Word count rather than an LLM read: a model call would cost a round-trip on the one path already over
budget, to measure something a human judges instantly by how long the other person talks.

**A weakness the first local run exposed, and the fix.** Per-*item* averaging called `natural_flow` —
the most talkative scenario in the harness — TERSE, because Soniox split its opening sentence into
three committed items (`"היי."` · `"אה..."` · the real sentence). Your own call reported
`fragmentedTurns: 8`, so this is how real Hebrew calls behave. Items are now **coalesced exactly the
way the call report defines a fragment**: two caller items in a row with no reply between them are
one turn. Pinned by tests built from that run's verbatim transcript. **This fix has not itself been
re-run end to end** — see below.

### 9 — "מחיר זה חשוב" · FIXED at the generator (new work)

`call-state-lines.he.ts`: the playbook preamble is gone. It now opens *"Go straight to the answer —
no sentence in front of it telling him his concern is important"*, the price play says
*"אל תפתחי במשפט על כך שהמחיר חשוב — הוא יודע, בגלל זה הוא שאל"*, and the timing play lost
*"הכירי בעיתוי"*. This is Koren's content file; the note is newer than the content and overrules it.

---

## Already fixed on `main`, only UNDEPLOYED — do not re-fix

The deployed agent is `7cfa526`; `main` is `2896c99`, ten commits ahead. Two of them change how she
sounds and are **not in the call Koren judged**:

- **`a9fe9c7`** — the mid-dictation vocal nod (`dictation.ts`), and "introduce yourself once"
  (`speech-guard.ts`, `VOICE_INTRO_ONCE_ENABLED`). The `"050-"` → `"טוב, הבנתי."` interruption and
  the second `נעים מאוד` are already fixed.
- **`616cee3`** — the pausing rule with measured numbers, "איזה כיף" scoped to a landed booking, the
  *phone* read-back no longer opening `רק לוודא`, and "do not answer a half-finished dictation".

So: the `רק לוודֵא` in the transcript at 460/512/549s is partly a stale deploy — but only partly,
because the *name* read-back was never fixed, and note 1 says remove the phrase entirely, which
neither commit does. Everything else in the nine notes is genuinely new work.

**A deploy of `main` alone would already improve two of the things he heard.** It would not touch any
of the nine.

## How Koren's uncommitted edits were reconciled

He had three uncommitted edits to `system-prompt.he.ts` in `C:\AI Sales agent`. All three are applied
here, deliberately:

1. **`סגור` joins the slang bank, count → "These nine".** Applied. `SPOKEN_REGISTER_SLANG` is
   `['סבבה','אחלה','מעולה','בקטנה','על הדרך','סגור']` and the sentence says nine; a test pins that
   the number and the list move together.
   The bank's rule is that nothing enters unscreened, so it was screened **before** committing rather
   than after: `roundtrip7.ts`, three carriers, **3/3 came back as `סגור`**. Card `sg1` on the page is
   your ear on it. One side effect, flagged in the source: `hasRegisterTouch` matches by substring, so
   `"בוא נסגור"` now counts as a `סגור` touch (over-counting makes the nudge fire *less*, never more).
2. **`"בוא נ סגור"` typo.** His edit introduced a stray space; this branch has the correct
   `"בוא נסגור"`. Nothing to do beyond not reintroducing it — recorded so it is not "fixed" back.
3. **The two confirmation lines.** His phone read-back — `"חוזרת על המספר — אפס חמש אפס, …"` — is
   kept **verbatim**.

### The conflict, and how I resolved it

His edit #1 rewrote the name confirmation as **`"אני רוצה רגע לוודא — קורן שטרית, נכון?"`** — which
still contains `לוודא`, the phrase his own **note 1** says to delete and which the round-trip above
shows arriving as "רק לוועדה".

**Resolved toward the NOTE, which is newer than the edit.** The line now reads:

> `1. Full name — "מה השם המלא?" (if he already gave it at the start, just say it back to him: "קורן שטרית, נכון?")`

i.e. the detail *is* the sentence, with nothing in front of it. **Koren: if you want your wording
back, it is one string in two places** (`STEP4_NO_TOOLS` and `buildStep4Tools`) — but card `n1c` on
the page has both spoken side by side first.

## Fixture regeneration — the justification

`__fixtures__/prompt-default-{notools,tools,tools-noobjection}.txt` regenerated with
`npx tsx scripts/regen-prompt-fixtures.mts`. The full "which live call did I just change" is written
into the provenance note at the top of `system-prompt.persona.test.ts`, as the rule requires. In
short: the 2026-08-31 call, in the direction the nine notes asked for. Seven deliberate deltas — the
`## No Preamble` section, the verification preamble gone from every site, the comma-less greeting in
three places, the scoped surprise beat, the small-talk subsection, the MANDATORY/OPTIONAL split, and
`סגור` + "nine".

`greeting-default.txt` is **byte-identical** and was not regenerated. Every persona-owned section
(Role, FAQ, gender rules) was diffed and is unchanged — the only line in the diff that mentions
gender is a Step-2 sentence that moved for the comma, not for the rule. Every new byte is
independently pinned by `system-prompt.test.ts` (10 new tests).

## What I actually ran, and what it showed

Two local end-to-end runs against the LOCAL worker (`voice:dev`, dispatch `keren-dev`, explicit — it
cannot be handed a real inbound call; the safety fix is untouched and the worker was stopped
afterwards). Both wrote to the real DB, as every harness run does.

**`terse_caller`** (a new scenario, added for note 8 — eight monosyllabic answers; `short_answers` is
four utterances and never reaches discovery):

- Every one of her 8 turns opened with a bare receipt and went straight to substance. **Zero
  mirroring, zero compliments, zero `רק לוודא`, zero `טוב, הבנתי`.**
- The comprehension claim never fired — correct, no caller turn earned one.
- Engagement classified `terse` and the note injected: `coach_note … "engagement":"terse (1.8 words/turn)"`.
- Latency (harness figures, which run ~1–1.5s HIGH — never quote as product latency): dead air p50
  **2957ms**, p95 **3414ms**, 8/8 over the 1.2s bar, 0 cut-offs. Real product latency for this build
  is unmeasured; the last real reading is the 31.8 call's 1346ms median.

**`natural_flow`**: small talk fired (`איך היום שלךָ עד עכשיו?`), the empathy beat survived, the
price question was answered with no validating preamble, and the comprehension claim fired 3× in ten
turns (one of them on a question — the staleness above). Harness dead air p50 **2727ms**, p95
**3400ms**, 1 cut-off.

**Two pre-existing defects the runs surfaced, NOT caused by this change and NOT fixed here:**

1. **She asks for the name twice** when the caller never answers it (`"איך קוראים לךָ?"` then
   `"עם מי אני מדברת?"`) — `fact-memory` correctly logs *"already asked 2+ times"* and she asks
   anyway. Both runs.
2. **`natural_flow` answered "כמה זה עולה?" with the Unknown-Question fallback**
   (`"אין לי כרגע את המידע הזה"`) instead of the price play. Worth a look before the next deploy.

## What is UNVERIFIED — read this before quoting anything above

- **No real PSTN call was made, and nothing here is deployed.** I did not run `agent:deploy` and the
  deploy hazard on `main@ad2077b` still stands.
- **A prompt change is invisible to every test in this repo.** The 10 new prompt tests prove the
  instruction is *present and says what he asked for*. Whether gpt-5.4 obeys it on turn 30 of a real
  call is not something any of them can see. The two local runs are eight turns each with a synthetic
  caller who is far too fluent.
- **The round-7 page compares PHRASING, not behaviour.** A win on card `n3a` says the new sentence
  sounds better; it does not say she will write it.
- **The fragmented-turn fix for the engagement tracker has unit tests but has not been re-run end to
  end.** It landed after the two runs above, built from their transcripts.
- **The comprehension-claim signal can be one turn stale** (documented above, seen once).
- **`VOICE_ENGAGEMENT_NOTE_ENABLED` adds one system item to the tail per level change.** It follows
  the established `injectCoachNote` path, so prompt caching should be unaffected — but the cache hit
  rate on a call carrying this note has not been measured.
- **The mandatory/optional split will make some calls LONGER**, which cuts against the "90% of calls
  under 4 minutes" success criterion. Note 8 asked for it explicitly; watch it.

## Found but deliberately NOT changed

**`registerTracker.note()` is never injected.** `injectCoachNote` builds its note from
`[phraseNote, factNote]` only — the spoken-register nudge (`VOICE_REGISTER_NUDGE_ENABLED`, shipped
2026-08-30, with its own tests and env flag) has been **dead since it shipped**: the tracker observes
and counts, its note is never read. One line to fix (`src/modules/channels/voice-livekit/agent.ts`,
`injectCoachNote`).

I did not switch it on, because it would push in the opposite direction from note 4 — it exists to
ask for MORE register touches, on a call where Koren said the register/filler words were already too
frequent and doubled. That is a decision for him, not a side effect of this branch.

## Questions for architect / Koren

1. **Are the three MANDATORY questions the right three?** (business · volume · what he'd improve.)
2. **Do you want your `"אני רוצה רגע לוודא"` wording back** despite note 1 and the round-trip?
3. **Should the dead `registerTracker` nudge be switched on** now that the register section has been
   heard on a real call?
4. **The three receipt words are down to three again** (the wide bank was five). Over a 37-turn call
   that is ~12 uses each. Widening needs new words that are receipts after a QUESTION and are not
   openers she writes herself — the two obvious ones were exactly `הבנתי אותך` / `טוב, הבנתי`. Worth
   a round-8 screening if the repetition is audible.

## Next steps

- **ME (next voice session):** re-run `terse_caller` + `natural_flow` after the coalescing fix; look
  at the two pre-existing defects (double name ask, price answered by the unknown-question fallback).
- **VOICE:** nothing blocking. `main` alone would already fix two of the things he heard on 31.8.
- **KOREN:** open `tests\hebrew-tts-niqqud-ab\index-round7.html`, judge A vs B, press "צור סיכום",
  paste it back. Card `n1c` is where your own edit is on trial; card `sg1` is your `סגור`; the `n5`
  cards exist so you can tell me if I broke something you asked me to keep.
