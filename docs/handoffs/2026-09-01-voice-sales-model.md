# Handoff — Keren's sales model (VOICE)

**Session:** `ai-sales-agent-3d`, 2026-09-01. Planning + docs only — **no code was written and
no commit was made from this session.** `main` was at `e08ba1b` throughout.

**What shipped:** `docs/gtm/keren-sales-model.md` — the sales model, derived from Koren's two
PUSHER documents (a sales training guide and a conversation-structure playbook). Read it first;
this handoff only says where each piece of it lands in the code.

---

## The finding this exists to fix

**The prompt today runs a qualification form, not a sales conversation.** Its flow is
open → three factual questions → classify → book. Five of the eight moves a sales
conversation is made of are missing entirely: pain deepening, conditional solution
presentation, illustration, value linkage, and the interest check before the ask.

Proof from production, the 09:29 call on 2026-09-01 (`call-reports/2026-09-01T06-29-49-579Z.json`):

- `[68s]` lead: **"15"** — she took the number and moved to the next question. It resurfaced
  at `[365s]`, five minutes later, as decoration.
- `[97s]` lead: *"לא יודע, יש לנו המון שיחות. זה שואב לי זמן."* — he handed her the pain.
  She said *"אוף.. זה באמת שואב"* and went straight into a feature list.
- `[121s]` — the same generic pitch a web-design shop with 15 leads a day gets, and everyone
  else gets.
- `[175s]` (second call) — she asked for the meeting with no interest check anywhere in the call.

**Both facts were in her hands.** What was missing was the rule that says to use them.

---

## The architecture: one universal spine, per-tenant content

This is the part that makes the model reusable for future tenants, and it is the design
decision worth defending:

- **Spine** — 8 stages, 2 gates, the objection model, 7 decision rules. Written once, in the
  prompt and in code. Identical for every tenant.
- **Content** — power questions, pitch, mirror, illustration, value link, reframes, social
  proof. Per tenant, from `businessProfile`, filled at onboarding.

ClickScales is then simply the first instance of the template, not a special case.

---

## Where each piece lands

The codebase rule holds throughout: **prompt = guidance, code = enforcement, both on one env
flag.** A piece that ships with only one half is a bug by this repo's own convention.

| Piece | Prompt half | Code half | Reuse |
|---|---|---|---|
| **8 stages** | New `## Call Flow Overview` replacing [system-prompt.he.ts:1022-1028](../../src/modules/channels/voice-livekit/prompts/system-prompt.he.ts#L1022-L1028) | `CallStage` in [call-state.ts:22-28](../../src/modules/channels/voice-livekit/call-state.ts#L22-L28) gains `pain` and `presenting`; `STAGE_RANK` stays monotonic | `call-state.ts` is already advisory + monotonic — no new mechanism |
| **🚧 Gate A** (no product talk before 3 facts) | "One sentence, then a question back, when he asks early" | A coach note through `injectCoachNote` ([agent.ts:802-858](../../src/modules/channels/voice-livekit/agent.ts#L802-L858)), built exactly like [engagement.ts:278-302](../../src/modules/channels/voice-livekit/engagement.ts#L278-L302): reads fact-memory → *"חסר לך הכאב. אל תתארי את המוצר."* | `FactField` [fact-memory.ts:44](../../src/modules/channels/voice-livekit/fact-memory.ts#L44) gains `currentProcess`, `painPoint`; `captureLeadInfoSchema` [capture-lead-info.tool.ts:35](../../src/modules/channels/voice-livekit/tools/capture-lead-info.tool.ts#L35) gains `current_process` |
| **🚧 Gate B** (interest check before the ask) | "Ask how it sounds, then summarise what he said, then ask for the meeting" | v1 prompt-only. v2: a detector over her committed utterances — was an interest check spoken before the first `check_calendar_availability`? | The ask-detectors in [fact-memory.ts](../../src/modules/channels/voice-livekit/fact-memory.ts) are the same mechanism, matched against committed speech |
| **Objection model** (agree → ask → reframe) | Replaces the four plays in [call-state-lines.he.ts:100-105](../../src/modules/channels/voice-livekit/call-state-lines.he.ts#L100-L105) | — | The round-14 question/worry boundary **overrides** the agree step: a QUESTION goes straight to the answer |
| **7 decision rules** | New `## How She Decides` block inside `renderIdentity()` [persona.ts:213](../../src/modules/channels/voice-livekit/persona.ts#L213) | — | This is Phase 7 **W1**, finally with Koren's own source material |
| **mechanism → outcome** | One rule + the tenant's three `reframes` | — | — |
| **Per-tenant content** | `renderBusinessContext()` [system-prompt.he.ts:722](../../src/modules/channels/voice-livekit/prompts/system-prompt.he.ts#L722) renders the new slots | `readBusinessProfile()` [:755](../../src/modules/channels/voice-livekit/prompts/system-prompt.he.ts#L755) reads them, same defensive coercion | — |
| **Discovery bank** | Three new mandatory: business · current process · pain. **Volume moves to stage 4** | `engagement.ts` terse/engaged logic unchanged | [system-prompt.he.ts:1108-1132](../../src/modules/channels/voice-livekit/prompts/system-prompt.he.ts#L1108-L1132) |

---

## Build order

Gate A first. It is the largest behaviour change per unit of work, it is the direct fix for
the defect measured on a production call, and every later piece assumes it.

1. **Gate A** — schema field, fact-memory fields, coach note, prompt section, flag.
2. **Stages 4 + 5** — pain deepening and the conditional pitch. Gate A is meaningless without
   somewhere for the call to go once it opens.
3. **Stages 6 + 7 + Gate B** — illustration, value link, interest check, the summary close.
4. **Decision rules** in `renderIdentity()` — the character half.
5. **Per-tenant slots** — `businessProfile` extension + the four onboarding questions.
6. **Objection model** — last, because it touches the sentence Koren already judged by ear.

---

## Constraints — from the code's own headers, not negotiable

- **Token-neutral, ±5%**, asserted in `system-prompt.test.ts`. Phase 7 W7 already names what
  to delete to pay for this: the dead `SPEECH_RHYTHM_OWN_OPENER` branch (dead weight on every
  production call while `VOICE_INSTANT_ACK` is on), the duplicated "write your own words"
  discipline across `EMOTIONAL_COLOR` and `buildSpokenRegister`, and the duplicated `LINES_*`.
- **Every new Hebrew sentence is a listening-round card before it ships.** SUPERVISOR §8.1,
  written after ~600k tokens were spent building round-8 work Koren rejected on first listen.
  The cards are ready: every quoted line in Part ב of the model doc.
- **Every new sentence passes negation safety.** The 19:54 call ended because a `לא` dropped
  and inverted a sentence. The model doc's three reframes are already written in the positive
  for this reason, and the one known violation (`ואתה לא היחיד ששואל את זה`) is flagged as a
  deliberate, ear-judged exception (round-14 card `e2`).
- **Each block behind its own env flag, defaulting OFF** until the A/B passes.
- **`DEFAULT_PERSONA` is pinned byte-for-byte** by `system-prompt.persona.test.ts` — touching
  `renderIdentity()` means regenerating that fixture in the same commit.
- **`businessProfile` is a SHARED settings key** per CLAUDE.md. Extending its fields gets
  announced in the claims list in the same commit. No migration — it is JSON in settings.

---

## Verification

The existing ladder in `src/modules/channels/voice-livekit/testing/README.md`:

1. `npm test` — new cases in `prompts/system-prompt.verdicts.test.ts`, regenerated
   `__fixtures__`, the token-delta assertion.
2. `npm run voice:test -- natural_flow` and `-- terse_caller` — judge the `_phone.wav` clips.
3. Off the call report: `secondQuestionsDropped`, `repeatedPhraseCount`, `registerTouchPct`,
   plus a **new counter `gateAViolations`** — how many times she described the product before
   the gate opened. Without this counter the gate is unfalsifiable, and this repo has now had
   three separate metrics stay green through the exact defect they existed to catch.
4. Listening round 15 — one card per new sentence, A = today, B = the proposal.
5. **Two real PSTN calls last, not first.**

**Success is not a longer prompt.** On `natural_flow`: she does not describe the product
before she has his pain in his own words; she asks how it sounds before she asks for the
meeting; the close opens with what he said; and Koren says it sounds like a salesperson.

---

## Decided by Koren, 2026-09-01

1. **Social proof — build the slot, leave it empty.** She mentions no other customer at all
   until a story is cleared for quoting. An instruction to "give a customer example" with no
   example available is an instruction to invent one.
2. **Urgency points at his leads, never at his decision.** The playbook's fear-of-loss move
   (*"if we don't close now you'll go back to wasting time"*) does not ship. The version that
   does is factual about his market: *"מי שחוזר ראשון הוא זה שסוגר."*
3. **FIVE mandatory questions, set by Koren, who owns them.** He replaced the bank at
   [system-prompt.he.ts:1112-1119](../../src/modules/channels/voice-livekit/prompts/system-prompt.he.ts#L1112-L1119)
   with: business · who answers and how fast · what frustrates him ·
   **how his sales process works (phone / Zoom / in person)** · **new enquiries per day**.
   - Question 4 is new and is a *fit* question: a business that only closes in person is a
     different sale from one that closes on the phone.
   - **Volume returns to mandatory.** My earlier proposal dropped it; Koren put it back and it
     stands — on one condition. Decision rule #1 ("when he gives a number she does something
     with it before moving on") is what makes it a conversation rather than a form, and it
     must ship in the same change or the 09:29 defect returns intact.
   - ⚠️ **Five mandatory questions is a lot for a three-minute call.** With one-question-per-turn
     enforced that is five turns of discovery minimum, on top of the name, the small talk and
     pain deepening — and a terse caller now sits through all five. Measure call length on
     `natural_flow` and `terse_caller` before treating this as final. Do not drop a question
     without a number to justify it; if one must go, question 5 is the candidate, because
     volume is the only one that can be estimated without asking.

4. **She now ANSWERS the price question.** See below — this is the largest change and it
   crosses out of the voice lane.

## 🔄 Policy reversal — Keren may talk about price

Koren, 2026-09-01: the price is a **fixed monthly subscription with several packages**, and
*"the agent needs to be able to answer how much it costs."* The rule in
`docs/gtm/sales-process-he.md` line 54 — *"לעולם לא לתת לקרן לדבר על מחירים בשיחה"* — is
**withdrawn**.

**The mechanism already exists; no new architecture is needed.** `businessProfile.pricing` is
an existing slot rendered by `renderBusinessContext()`, and the objection play at
[call-state-lines.he.ts:102](../../src/modules/channels/voice-livekit/call-state-lines.he.ts#L102)
already says *"אם יש מידע תמחור ב-Business Context, הסתמכי רק עליו"*. Filling the slot for
the ClickScales tenant is what turns this on.

Four places change, and only one of them is voice-lane:

1. `docs/gtm/sales-process-he.md:54` — the blanket rule comes out. **GTM doc, not voice.**
2. `docs/gtm/client-onboarding-flow-he.md` Q6 — the default of "nothing" **stays for other
   tenants** and changes only for ClickScales. **GTM doc, not voice.**
3. `call-state-lines.he.ts:102` — keep *"אל תמציאי מחיר"* (still correct), and make the
   automatic redirect-to-demo conditional on the slot being empty. **Voice lane.**
4. The ClickScales tenant's `businessProfile.pricing` value. **Settings, not code.**

**Two hazards to carry into the build:**

- **A price spoken on the phone is a commitment.** Every booking claim already passes the
  `FALSE_BOOKING` guard in `speech-guard.ts`. A price claim has no equivalent guard. If she
  states a wrong number it reaches the lead's ear and cannot be retracted. Consider whether
  the pricing slot needs a read-only assertion that what she says appears verbatim in the
  configured value.
- **Spoken Hebrew numbers.** `speech-numbers.he.ts` handles round prices only
  (`PRICE_WORDS`, [:102-108](../../src/modules/channels/voice-livekit/speech-numbers.he.ts#L102-L108)).
  The package figures need an ear check before they are spoken on a live call.

**✅ Unblocked.** `docs/gtm/pricing-answers-he.md` arrived and is now **the single source for
every price sentence.** Do not copy a figure out of it into another document or into code
comments — a number in two places is a number that will diverge when pricing changes.

Its core is a **three-request ladder**: first ask → "price depends on volume, how many
enquiries a month?" · second ask → package name only, no shekels · third ask → **one opening
figure**, `אלף ארבע מאות ותשעים שקל`, framed as "starts at". She never states a final price,
never offers or hints at a discount, never prices against a competitor, and never does ROI
arithmetic with numbers she invented — only with a number the lead gave her.

**Three defects found while verifying it against `pricing-model.md`, all now recorded:**

1. **🔴 Month vs day — blocks the ladder's step 2.** Koren's mandatory question 5 asks
   enquiries **per day**; the package tiers (150 / 400) are **per month**. She would have to
   multiply in her head, mid-call, in Hebrew — which is exactly where a wrong number is born,
   and here a wrong number is a wrong package spoken to a lead. 15/day ≈ 450/month = custom
   tier; a factor-of-two slip drops him to the entry package. **Recommended fix: restate the
   tier table in per-day terms** (≤5 / 5–13 / 13+) so she compares rather than calculates.
   Needs Koren.
2. **The "how to say numbers" table carried three figures that do not exist in
   `pricing-model.md`** (2,900 / 5,400 / 1,500). It was illustrative, but a table showing how
   to write prices that contains wrong prices is precisely what gets copied into code.
   Corrected to the real figures.
3. **A hole in the package table itself, not in the pricing doc.** `pricing-model.md` covers
   ≤150, ≤400, then **1,000+**. Nothing covers **400–1,000** — which is a lead at 15–30
   enquiries a day, i.e. the core ICP. The ladder papers over it in wording; the hole is real
   and still open in `pricing-model.md`.

**The technical gap the pricing doc raises, with a recommendation:** the ladder needs memory
of how many times price was asked *this call*. Build it in code, not in the prompt.
`fact-memory.ts` already counts how many times **she** asked for each fact
(`MAX_ASKS_PER_FACT`) by matching patterns against what was actually spoken; a counter for
how many times **he** asked about price is the same mechanism pointed at the caller's turns,
delivered through `injectCoachNote` like every other note. A prompt-only ladder will fail the
way the name question failed on 2026-08-29 (asked three times) and the slot question failed
on 09:29 (asked four times) — that failure mode is why `fact-memory` exists. The difference
is the cost: there, a repeated question. Here, **a figure spoken too early that cannot be
taken back.**

## Still open

1. **The wording in Part ב of the model doc** — the Hebrew lines are my first draft, awaiting
   Koren's ear before any listening round is built. Producing clips for lines he would never
   say is the waste §8.1 exists to prevent. Three lines are now settled by him: the pitch
   drops the availability claim, the illustration drops "in Hebrew", and the robotic-objection
   reflection is confirmed and emphasised.
2. **The packages document**, for the pricing slot.

## Two wording corrections he made, and why they are correctness rather than taste

- **The pitch may not claim "evenings and Shabbat".** The hours the agent works are the
  business owner's decision, not a property of the product. The onboarding default is
  08:00–21:00 Sun–Thu, so for most tenants that claim would be **false**. Any availability
  claim must derive from the tenant's configured hours and appear only when they actually
  cover those times. Default: no availability claim at all.
- **The illustration drops "someone speaks to him in Hebrew"** — self-evident, and it was
  spending a clause on the one thing nobody doubts.
