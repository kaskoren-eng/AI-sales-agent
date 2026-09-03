# Phase 7 — Persona and Humanization Plan

Status: PLAN, not implemented. Written 2026-08-30 after Koren asked for a real character and
rules that make the agent sound like a person instead of a robot.

Sources reviewed: LiveKit, "Prompting voice agents to sound more realistic"; Vapi prompting guide.
Both were read against the prompt we actually ship (`prompts/system-prompt.he.ts`, 901 lines) and
against the enforcement code that already exists (`phrase-ledger.ts`, `register-tracker.ts`,
`speech-guard.ts`, `thinking-fillers.he.ts`, `fact-memory.ts`).

Decisions taken with Koren before writing this:
- Persona depth: **traits as audible behaviours**. No invented biography.
- Disfluencies: **yes, but every Hebrew token passes the round-5 screening gate first.**
- Scope: prompt + few-shot examples + code + a measured verification pass.

---

## 0. Constraints that shape everything below

Most of the advice in both articles was written for English on a wideband connection. Four of our
constraints delete or invert it, and every work item below is written inside them.

1. **SSML `<break>` and emotion tags do nothing here.** The LiveKit post's central mechanism is
   `<break time="300ms"/>` plus `<emotion value="peaceful"/>`. Verified 2026-08-26 on sonic-3.5:
   Cartesia's tags are silently ignored on Hebrew (`round4`), which matches their support answer.
   Our equivalent already exists and is measured: **punctuation is the pause API** — a comma buys
   ~0.18s and can vanish when streamed; a full stop, an em-dash or an ellipsis buy 0.25-0.5s and
   survive (`EMOTIONAL_COLOR`). Any pause we want is written as `.`, `—` or `...`, never as a tag.
2. **An unscreened Hebrew interjection fails silently.** `חח` was read as the letter khet; `אוו`
   vanished entirely. This is why `REGISTER_VOCABULARY` is a closed list of nine words, and it is
   why no disfluency token from either article enters the prompt before it has gone through
   synth → 8kHz phone band → Soniox round-trip (`tests/hebrew-tts-niqqud-ab/round5.py`).
3. **Every token in the system prompt is latency on every turn.** Vapi says this explicitly and our
   own history confirms it: the prompt being long is what made `MAX_FILLERS_PER_CALL` necessary.
   Phase 7 must be roughly **token-neutral**. Every section added is paid for by a section
   compressed or deleted.
4. **She must disclose that she is an AI, in the greeting, verbatim** (`buildGreeting`, EU AI Act
   Art. 50 / SB 1001, and the website already promises it). So the goal is not "pass for a human".
   The goal is **a machine that is pleasant to talk to** — which is a different and more defensible
   target, and it is the reason no invented biography is going in.

---

## 1. Gap analysis — articles vs. what we ship

| Technique (LiveKit / Vapi) | Status today | Action |
|---|---|---|
| Short turns, one question at a time | Shipped (`SPEECH_RHYTHM`, Step 2) | keep |
| Spoken-form numbers | Shipped, in code (`speech-numbers.he.ts`) — stronger than the prompt rule both articles suggest | keep |
| No markdown / stage directions | Shipped (`EMOTIONAL_COLOR` last line) | keep |
| Identity lock, guardrails, prompt-extraction defence | Shipped, ahead of both guides (`CRITICAL SECURITY RULES`) | keep |
| Thinking noise while the model is slow | Shipped in code with a ceiling of 3 and a 45s cooldown | tune (W5) |
| Anti-repetition | Shipped (`phrase-ledger.ts`) — neither article has this | keep |
| Register / light slang | Shipped + tracked (`register-tracker.ts`) | keep |
| **Personality as observable behaviour** | **MISSING** — `renderIdentity()` is a job description plus three gender tables. Zero character. | **W1** |
| **Disfluency: stutter, self-correction, restart** | **MISSING** — we have hesitation *before* a reply, never inside one | **W2** |
| **Few-shot transcripts** | **MISSING** — the prompt has phrase examples, not one dialogue | **W3** |
| **Tone matching to caller energy** | **MISSING** | **W4** |
| **Rapport / banter handling** | **MISSING** — a personal aside from the lead has no rule at all | **W4** |
| **Turn budget for the whole call** | **MISSING** — Vapi prescribes 7-9 | **W6** |
| Laughter | Deliberately BANNED, correctly (round 4b) | keep the ban |

The headline: **everything the articles say about mechanics we already do, often better and in
code. Everything they say about *character* we do not do at all.** That is the whole gap, and it
is exactly what Koren heard.

---

## 2. Work items

### W1 — Character, written as audible behaviour
`persona.ts :: renderIdentity()`

Replace the bare job description with 5-6 traits, each stated as something the caller can HEAR,
per the LiveKit rule that "friendly" is unusable and "starts sentences with And/But/So" is not.
Draft traits (Hebrew lines go in the prompt; rationale stays in the doc comment):

- **Fast, not rushed** — she answers the question asked, then stops. She never lists three benefits
  when one lands.
- **Concrete over impressive** — she reaches for a number or a small example, not an adjective.
- **She admits the edge of what she knows** — "זה כבר משהו שאני לא רוצה לנחש עליו" beats a
  confident guess. (This one also reduces hallucination pressure, so it pays twice.)
- **She reacts before she answers** — the feeling first, the content second. Already half-present in
  `EMOTIONAL_COLOR`; here it becomes part of who she is rather than a beat list.
- **She has opinions inside her lane** — asked which of two options fits him, she picks one and says
  why. A salesperson with no preference sounds like a form.
- **She does not oversell** — if he is not a fit she says so. This is already the Step-3 behaviour;
  naming it as character makes it survive elsewhere in the call.

Hard boundary, written into the section: **no biography.** No age, no hometown, no "I used to work
in...". If asked personal questions she deflects warmly and truthfully — she is an AI agent, she
knows it, and it is not a sore subject. This is a rule, not a suggestion: an invented life story
contradicts the disclosure spoken 4 seconds earlier and reads as deception the moment it is caught.

Per-tenant: the trait block is a `persona` field with the ClickScales set as default, so it moves
with `voiceId`/`speed` when a tenant configures their own agent. Same plumbing as `renderIdentity`
uses today; no new mechanism.

### W2 — Disfluency inside the reply, gated by screening
`prompts/` + a new `round7.py`

Both articles converge here: real speech self-corrects. Our version has to survive Hebrew TTS, so
it ships in two steps.

**Step A — screening (blocking).** Candidate tokens, synthesized in the carrier sentence they would
actually be spoken in (round 6 already established that a bare clip is not the thing you hear on a
call), through the 8kHz band, transcribed back:
- restart: `בעצם`, `רגע —`, `או, רגע`
- self-correction: `יותר נכון`, `בעצם, בוא נגיד ככה`
- soft stutter: `אני— אני`, `זה— זה` (the em-dash is the mechanism; a repeated word with a comma
  buys no pause, per constraint 1)
Anything that does not come back intact is discarded, and the discard is recorded. Round 4b's
lesson is the whole reason this step exists.

**Step B — prompt section**, only for what survived. Written with the redundancy the LiveKit post
insists on: the rule, then annotated examples, then a restatement of the frequency cap.

**Frequency: at most ONE disfluency per reply, and not in consecutive replies.** This is a
deliberate departure from Vapi's "2-4 per turn". Vapi is describing an English casual agent; our
own `MAX_FILLERS_PER_CALL` history is the counter-evidence — 21 hesitations in 7 minutes made her
sound *less* human, not more, and Koren caught it on the first call. Start at one, measure, raise
only if the recording is flat.

**Never inside a fact.** Same rule the register already carries: a price, a time, a name and an
email stay clean. A stutter in a phone number is a call the lead has to repeat.

### W3 — Three few-shot transcripts
`prompts/system-prompt.he.ts`

The prompt has zero example dialogue, which both guides name as a top-three failure. Add three
short Hebrew transcripts, each 4-6 turns, drawn from real call reports in `call-reports/` rather
than invented:
1. **Happy path** — discovery → qualified → slot offered → booked.
2. **Edge case** — the lead is interested but has no time now; a callback is recorded.
3. **Error recovery** — `check_calendar_availability` fails, she says so honestly and offers the
   handoff.

Each transcript is annotated in-line with WHY a turn is written the way it is (`— קצר, כי הוא ענה
קצר`). Both articles say bare examples get imitated verbatim; annotated ones teach the rule.

Budget: these are the most expensive addition in the plan. They are what constraint 3 is paid with —
see W7.

### W4 — Tone matching and rapport
`prompts/system-prompt.he.ts`, one compact section

- **Match his size.** Crisp, one-word answers → shorter turns, fewer register words, move faster.
  Chatty → she can take a beat and riff once. This generalizes a rule `EMOTIONAL_COLOR` already
  states for joy ("joy that outruns what just happened sounds performed") into the whole call.
- **A personal aside gets ONE beat, then back to the task.** He mentions he is swamped: one short
  human reaction, no anecdote (an anecdote requires a biography, which W1 forbids), then the next
  question.
- **Banter / "are you a real person?"**: one honest, light beat and continue. She is not defensive
  about it. This is a real, frequent moment on our calls and currently has no rule at all.
- **Hard off-topic** stays with the existing redirect.

### W5 — Code: the enforcement half
Each of these exists because a prompt rule alone has already failed at least once in this repo.

- **`register-tracker.ts` → generalize to a `humanness-tracker`.** It already counts register
  touches per reply. Add the two Phase-7 signals: disfluency used this turn, and turn length in
  words. Same turn-boundary note, no new machinery.
- **Turn-length nudge.** When three consecutive replies exceed ~35 words, append a note. Long
  monologues are Vapi's pitfall #5 and the single most robotic thing on a recording.
- **Fillers: keep the ceiling, fix the pronunciation.** Round 6 (`fl`) is already screening
  `אהה`/`אוהה`/`אההא`. Phase 7 does not touch `MAX_FILLERS_PER_CALL` — it consumes round 6's result.
- **Bug, unrelated but adjacent:** `agent.config.ts` hard-codes `model: 'cartesia/sonic-3'` on the
  `inference` route while `.env` runs `sonic-3.5`. Switching `VOICE_TTS_ROUTE` silently downgrades
  the model. One-line fix: read `env.CARTESIA_MODEL`. Do it in this branch.

### W6 — Turn budget
Vapi prescribes 7-9 turns. Ours is a Hebrew B2B discovery call with a booking flow, so the honest
number is higher; take it from data rather than from the article. Compute the turn count of the
calls in `call-reports/` that ended in a booking, and write the median into the Call Flow Overview
as a target ("רוב השיחות האלה נסגרות בערך ב-N תורות"). A target the model can see is what stops
the drift; a number copied from a US scheduling agent is not.

### W7 — Pay for the tokens
Constraint 3. Candidates, in order of confidence:
- `SPEECH_RHYTHM_OWN_OPENER` and the ack-injected variant overlap heavily; with `VOICE_INSTANT_ACK`
  defaulting on, the own-opener branch is dead weight on every production call.
- `EMOTIONAL_COLOR` and `buildSpokenRegister` both explain the "write your own words, never copy"
  discipline in full. State it once.
- The five `LINES_*` negation-safe lines are duplicated across two tables.
Target: net token delta within ±5%. Measure it, do not estimate it — the built prompt is
deterministic and `system-prompt.test.ts` can assert the length.

---

## 3. Verification — the part that decides whether any of this shipped

Vapi's line is the right one: *"Validate prompt changes against a representative test set, not
single calls. Probabilistic regressions don't show up in one-off testing."* This repo has the
harness for it already.

1. **Unit gate.** Methodology rule #1 in `system-prompt.he.ts`: no edit lands without
   `system-prompt.test.ts` updated in the same commit. Every new section gets an assertion, and the
   token-budget assertion from W7 is one of them.
2. **Screening gate (W2 Step A).** `round7.py`. Nothing enters the prompt unscreened.
3. **Synthetic calls.** `testing/synthetic-caller.ts` + `scenarios.ts` — run the three W3 scenarios
   plus a hostile one, N=5 each, before and after. Machine-countable metrics: median words per
   reply, repeated 4-grams per call, register touches per reply, disfluencies per call, turns to
   booking.
4. **Listening A/B.** `npm run voice:ab` on the same script, before/after, through the phone band.
   Blind, as rounds 3-5 were. Koren's ear is the acceptance test; the metrics above only decide
   what is worth putting in front of it.
5. **Two real PSTN calls** last, not first.

**Rollback:** each of W1/W2/W4/W6 ships behind its own env flag, defaulting OFF until the A/B
passes. Same discipline as `VOICE_ACK_LEDGER_ENABLED` / `VOICE_INTRO_ONCE_ENABLED`.

---

## 4. Sequence

1. W7 measurement + the `sonic-3` route bug (small, unblocks the budget)
2. W2 Step A screening — long-lead, run it first
3. W1 character + W4 tone/rapport (prompt, one branch)
4. W3 transcripts, pulled from real call reports
5. W2 Step B, using whatever survived screening
6. W5 tracker + turn-length nudge
7. W6 from call-report data
8. Verification ladder, in order

W1, W3 and W4 are independent of the screening result, so they can proceed while `round7.py` runs.

---

## 5. Open questions for Koren

- **The trait list in W1 is a product decision, not an engineering one.** The six above are a draft
  from how ClickScales already positions itself; they should be his words before they ship.
- **Where does the character live long-term** — hard-coded ClickScales default, or a per-tenant
  field in the dashboard from day one? W1 assumes the field exists with a default. If the dashboard
  work is far out, the field can be internal-only at first.
- **How honest about being an AI, mid-call?** The greeting discloses it. If a lead asks again at
  minute four, the current prompt has no line for it. W4 proposes: light, honest, one beat, move on.
