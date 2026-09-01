# VOICE — 2026-09-01 — the twelve conclusions from the 19:54 call

Branch: `feature/voice-call4-conclusions` (from `main` @ `cb81226`)
Source call: `call-reports/calls-2026-08-31-fourth.md` · raw `call-reports/2026-08-31T19-54-51-237Z.json`
Listening page he judged: `tests/hebrew-tts-niqqud-ab/round13.json`
New listening page, NOT yet judged: `tests/hebrew-tts-niqqud-ab/index-round14.html`

**Nothing is deployed.** `npm run agent:deploy` is Koren's decision through the supervisor.

---

## For Koren, in one page

She hung up on you at 4½ minutes because she misheard her own voice coming back down the line.
She had said *"if it still feels wrong to you…"*, you spoke over her before she finished, and the
half-second the phone line brought back — `כן, מרגיש לך` — was her own words with the `לא` missing.
She read that as you saying yes, and said goodbye. Ninety-six seconds earlier she had recorded you
as a **hot** lead.

That can no longer happen. Ending a call because a lead is not interested now needs you to actually
say so. If she believes the call should end and you have not said it, she has to ask —
**"שאסגור את זה כרגע?"** — and wait. She never asks that more than twice, so if you really do want
off the phone you always get off it, and asking to be taken off the call list still works instantly
(that is a legal obligation and it is not delayed for anything).

Your five listening verdicts are all in: the greeting lost its two commas, `בקטנה` is corrected,
product claims use `מעולה`, and when you voice a worry she now says the concern is a reasonable one
before she answers it. Your other seven notes are in as well — she asks one question per turn (that
one is enforced in code, not just asked for), she finds out whether you have a business before
asking about it, she stops jumping to the next question, and she will not tell a caller about her
own instructions again.

**Three things I need your ear on**, all on one page —
`tests/hebrew-tts-niqqud-ab/index-round14.html`:

1. **The sentence she asks instead of hanging up.** It fires at the exact moment we nearly lost you.
   If it sounds abrupt, it will lose the call anyway.
2. **A collision inside your own choice.** The empathy line you picked — *"ואתה לא היחיד ששואל את
   זה"* — hangs on one small `לא`. That is the exact word the phone line dropped in the sentence
   that ended the last call. If it drops here, she tells the caller *"you are the only one who asks
   that"*. I shipped your wording unchanged; card `e2` puts it next to a version that cannot invert.
3. **The opener.** Your twelfth conclusion is in: she only leads with a short "אוקי./בסדר." when the
   answer she is about to give is long. On the last call that would have removed 11 of her 22
   receipts, including three turns where the whole thing she said was one word.

**What I could not check:** none of this has been on a phone call. Every prompt change is invisible
to every test we have — the tests prove the words are in her instructions, never that she follows
them on turn thirty. The hang-up fix is real code and has a test that replays the actual 260-second
sequence, so that one I can stand behind.

---

## Per conclusion — what I established, and what I changed

### 1. `טוב, הבנתי` at the wrong moment — DIAGNOSED, and it was not the substance test

**Established from the call report, not by reading code.** Five comprehension claims were spoken
(50s, 118s, 178s, 208s, 270s). Four followed a caller turn that `callerSharedSubstance` rejects — a
question, a question, a question, and a three-word turn. So the test was correct and was being
asked about the wrong sentence.

Line up each claim with the turn BEFORE the one it followed and all four pass. The mechanism is
preemptive generation: `llmNode` runs during the end-of-turn wait (17 of 24 drafts used on this
call) while `agent.lastUserUtterance` is written from `ConversationItemAdded`, which fires when the
turn COMMITS. The field is one turn behind on every drafted step. `agent.ts` already carried the
words *"same source and same staleness as midDictation above"* — the staleness was known and had
never been priced.

**Changed:** the substance test now reads the last user message out of `chatCtx` — the turn the
model is actually answering, correct by construction, draft or no draft. No second suppressor.
`latestCallerText` in `engagement.ts`; kill-switch `VOICE_ACK_EARNED_FROM_CONTEXT`.

**Deliberately not changed:** `midDictation` still reads the stale field. It is the same defect, but
the dictation nod is a behaviour Koren judged by ear on round 11 and this commit does not touch it.
Worth a separate commit.

**Also found and NOT fixed:** the 178s claim was legitimately earned, and the problem there was
different — she spoke it as a whole turn while he was still talking. That is a turn-taking issue,
not an acknowledgement issue.

### 2. Sentence shape (`p1`) — prompt rule, and no fixed line needed reshaping

His pick was three short sentences, not one sentence with the commas stripped, and the section says
so explicitly with his example. The measured fact is in the prompt: a comma is a real ~180ms pause
but a long comma chain drops roughly three of five, while full stops and dashes survive.

**I audited every fixed Hebrew line in the module for comma chains and found none** —
`SILENCE_NUDGE_HE`, `SILENCE_WRAP_HE`, `HOLD_CHECKBACK_HE`, the voicemail message, the five
negation-safe lines and both booking-guard truths are all short sentences already. Every comma chain
on the call was MODEL-composed, which is why this had to be prompt guidance and why it introduces no
unheard speech.

### 3. `בקטנה` (`s1`) — the bank was screened for sound and never for meaning

His string is in verbatim. The wider lesson is the fix: **every one of the nine screened words now
carries a gloss** in the prompt saying what it means and, where it matters, what it does not
(`בקטנה` is not "briefly"; `על הדרך` is not a road; `סגור` is not a shut business; `אוף` never near
good news). Nothing he approved was deleted — `בקטנה` is still in `SPOKEN_REGISTER_SLANG` and a test
pins that it is.

### 4. Product claims (`s2`) — a scoping rule, not a weakening

Slang is for rapport; a claim about what we sell takes `מעולה` / `מצוין` / `טוב מאוד`. The Spoken
Register quota still stands and the prompt says so — it is met in the sentences around the claim.

### 5. Empathy first (`e1`) — and the boundary with round-7 note 9, written down

His `e1` pick is a sentence of understanding in front of the answer. Round-7 note 9 deleted exactly
such a sentence. **Both are right and the prompt now states the difference:** a comment on his TOPIC
("price matters") hands him back his own subject; recognition of his FEAR ("you are not the only one
who asks that") tells him something he did not know. The test is written into the prompt — *if you
deleted your first sentence, would he lose anything?*

`buildObjectionPlaybook`'s opening paragraph said the opposite and would have contradicted this, so
it was split along the same line and is gated by the same flag. They can never be live separately.

⚠️ **His chosen sentence violates the negation-safety rule and I shipped it anyway.** `אתה לא היחיד
ששואל את זה` inverts to *you are the only one who asks that* if the `לא` drops — the identical
failure to the one that ended this call. It is his wording, chosen by ear, so it stands; the
collision is documented in the prompt beside it, the negation-safe alternative is named, and both
are on round 14 card `e2`. **Only his ear settles this.**

### 6. Two questions in one sentence — ENFORCED, not only instructed

A reply carrying two question sentences now has the second dropped before it is spoken
(`guardStream`, counted as `secondQuestionsDropped`). The first survives — dropping the first would
leave her answering a question she never asked. The either/or form he approved
(`בבוקר, או אחר הצהריים?`) is one sentence with one mark and is untouched.

### 7. She assumed he had a business — discovery rule

The prompt now asks the open form first (`יש לךָ עסק משלךָ?`) and uses his own `s1` wording once a
business is established. It also names the opposite failure from the 16:51 call: "no business yet"
is an ANSWER, and the Step 3 gate already forbids disqualifying on it. New Hebrew → round 14 `b1`.

### 8. Jumping to the next question — the rule was the wrong shape

She asked "how many enquiries a day" at 59s, 66s, 216s and 234s and never got an answer: neither
waiting nor letting go. The prompt now separates the two halves — **never open a NEW topic while a
mandatory question is unanswered**, at most two asks in the whole call (which is the Call Memory
ceiling, named as the same rule so the model does not see two), then say so once and move on. An
unanswered mandatory question is explicitly not a disqualifier. New Hebrew → round 14 `m1`.

### 9. The configuration leak — established as OUR OWN PROMPT, paraphrased

*"אני פשוט מתארת את זה בשפה יומיומית"* and *"אני מדברת ככה כי זה טבעי לי בשיחה"* are a Hebrew
paraphrase of the Spoken Register section, which opens *"Your Hebrew must sound like everyday SPOKEN
Hebrew"*. Not a hallucination — a leak of the section next door.

Security rule 2 already forbade revealing her instructions and was lost for the ordinary reason: she
did not recognise "the way I talk" as one of them. The prompt now names it, and there is a code half
in the speech guard (`SELF_NARRATION`), which **drops the sentence rather than rewriting it** — a
replacement would be unheard Hebrew and there is nothing to replace it with. Narrow by construction:
`אני מתוכנתת` is caught, `הסוכן מתוכנת לענות לפניות` is not, and saying she is an AI is explicitly
untouched (tested).

### 10. The hang-up — P0, and the mechanism

**Established:** `end_call` had no gate of any kind in code. The 79-second disqualification on the
16:51 call was gated by prompt text only (`DISQUALIFY_GATE`), which is the same defect nine hours
earlier — so a second prompt paragraph was not the answer.

The overlap is **measured**, not inferred: his turn ran 259248–259693ms, hers 243477–260013ms, from
the SDK's own per-message speaking clock, which `CallReport` was already storing and nothing was
reading. Her sentence had no terminator: she was cut off mid-conditional.

**Built:** `end-call-gate.ts` — a pure module, so the 260-second sequence is a unit test. A
disqualifying `end_call` (`not_qualified` / `not_interested` only) is refused when the caller's last
turn overlapped her speech, or is an echo of her own last words, or contains no unambiguous decline
and she has not yet asked. The refusal hands the model a sentence to say instead of a goodbye, and
quotes her own `capture_lead_info` qualification back at her when it contradicts the ending.

**What it never touches:** `opt_out` fires immediately, always — a legal instruction does not wait
for a confirmation round-trip. `meeting_booked`, `bad_time`, `callback_requested`, `wrong_person`
and `other` all pass through. And it stops refusing after two, so a caller can always get off the
phone.

**The negation half:** the prompt now forbids building a conditional on a `לא` and says an
unfinished sentence cannot have been answered. `לא` alone is deliberately NOT a decline signal in
the gate — on this call the question it would have been answering was an unfinished conditional.

### 11. — covered by 5 above (his conclusion 11 is the `e1` verdict).

### 12. The Speech Rhythm rule — weakened to conditional, in BOTH halves

**Which variant is live: settled, from the transcript, not from the env default.**
`VOICE_INSTANT_ACK` is **ON** in production. Three independent proofs, all in the 19:54 transcript
and none possible with the flag off:

- `אמ.` opens five of her turns. That spelling exists only in `ACKNOWLEDGEMENTS_HE` (round 10) — the
  model has no reason to invent it.
- Two committed assistant messages are nothing but `בסדר.` (195s, 272s) — the injected receipt on a
  step where the model wrote no text.
- `טוב, הבנתי.` is byte-identical to `ACK_COMPREHENSION_HE`.

**The evidence pointing the other way is a mislabelled metric, and this is worth knowing.** The
report prints `first sound out … the acknowledgement, ahead of GPT` for `llmTtftMedianMs`. That
field is the **LLM plugin's own stopwatch** (`llm.js monitorMetrics`), measured on the raw provider
stream — it cannot see our injected string at all. It reads 927ms next to a `modelTtftMedianMs` of
928ms because the two measure the same thing by two routes. **Do not conclude anything about
`VOICE_INSTANT_ACK` from that pair.** I have not fixed the label; it is DASHBOARD-adjacent tooling
(`scripts/show-call-report.mjs`) and out of this commit's scope. Flagged below.

**So the frequency change had to be in the code**, and it is: `chooseTurnOpener` gains
`needsThinkingTime`. The receipt is spoken when the caller asked something or gave ≥10 words, and
the step opens silent otherwise. The prompt moved with it, in both variants, and now explains that
this is **latency-optimal rather than a latency sacrifice** — the opener covers the ~930ms gpt-5.4
takes, and on a one-line reply there is no gap to cover, so it was pure cost.

**Threshold measured against the call, not chosen:** replaying all 22 turns turns 22 receipts into
11, and the eleven removed include all three stray one-word agent turns. Pinned in a test that
replays the transcript, so if the threshold drifts the test says so.

**On redundancy (your point 3): nothing became redundant and I removed nothing.** The three
suppressors — `dropEchoedOpener`, `SpokenOpenerTracker`, the earned/deck ledger — exist because FOUR
producers write to the head of a reply (deck, nod, filler, model) and all four still do. What
changed is how often producer #1 fires; the no-repeat rule matters *more* now, not less. Claiming a
simplification here would have been tidy and false.

**Also observed, not fixed:** she writes her own opener anyway despite the ban — `אחלה.` at 35s,
`צודק.` at 66s and 88s, `מעולה, תודה.` at 15s. The instant-ack prompt variant has forbidden this
since it shipped. That is a prompt instruction being ignored under context load, and it is the
strongest argument that a fourth suppressor would not have helped either.

---

## Files

**New:** `end-call-gate.ts` + test · `call4-conclusions.test.ts` · `tests/hebrew-tts-niqqud-ab/round14.py`,
`round14.json`, `index-round14.html`, 15 `r14_*.wav`

**Changed:** `prompts/system-prompt.he.ts` · `persona.ts` · `call-state-lines.he.ts` ·
`speech-guard.ts` · `engagement.ts` · `turn-opener.ts` · `agent.ts` · `call-report.ts` ·
`tools/end-call.tool.ts` · `tools/tool-context.ts` · `compliance/ai-disclosure.ts` ·
`src/config/env.ts` + `.env.example` (additive only) · `src/test/helpers.ts`, `src/plugins/auth.test.ts`
(env fixtures) · four `__fixtures__/` golden files.

### Golden fixtures — regenerated deliberately, all four

Including `greeting-default.txt`, which had been byte-identical since 2026-08-17. It moved because
Koren's ear moved it on round-13 card `g1`: two commas out, no word changed. The regeneration note
in `system-prompt.persona.test.ts` names the four blocks that moved and `git diff -U1` shows those
four and nothing else — I checked the diff shape before writing the note, not after.

The **greeting template for other tenants** got the same two-comma edit. It is literally the same
sentence with a different name, and his verdict was about punctuation; leaving it would mean
ClickScales' agent sounds better than every other tenant's for no statable reason.

### Kill-switches (all default to today's behaviour being ON; OFF restores 2026-08-31 exactly)

`VOICE_END_CALL_CONFIRM_ENABLED` · `VOICE_ACK_EARNED_FROM_CONTEXT` · `VOICE_ONE_QUESTION_ENABLED` ·
`VOICE_SELF_NARRATION_GUARD_ENABLED` · `VOICE_CALL4_PROMPT_ENABLED` · `VOICE_ACK_ONLY_WHEN_NEEDED`

`VOICE_CALL4_PROMPT_ENABLED` moves the prompt section **and** the objection playbook's opening
paragraph together — they are opposite sides of one question and must never be live separately.
`VOICE_ACK_ONLY_WHEN_NEEDED` moves the prompt **and** `chooseTurnOpener` together, for the same
reason.

### New call-report metrics

`endCallRefusals` + `endCallRefusalReasons` · `secondQuestionsDropped` · `selfNarrationDropped`.
The first is the only one where non-zero is the mechanism WORKING; the other two should read zero.

---

## Verification — exactly what I ran

| gate | result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run test:ci` | **exit 0** — 121 files, 1688 passed, 6 todo. Judged by exit code; no `Errors` line in the output |
| `npm run build` | exit 0 |
| `bash scripts/ci/territory-check.sh feature/voice-call4-conclusions` | see below |
| 260s hang-up reproduction | `end-call-gate.test.ts` — 13 tests, replays the real transcript and the real speaking timestamps through the real `CallReport` |

The hang-up test drives `CallReport.lastCallerTurn()` rather than hand-feeding
`overlappedAgentSpeech: true`. That distinction is the point: a hand-fed test would prove the branch
works, never that the report can actually see the overlap.

## What is UNPROVEN

- **No call has been made.** No `voice:dev`, no synthetic call, no browser session, no PSTN. Every
  behavioural claim above is a claim about code and prompt text.
- **Every prompt change is invisible to every test.** The tests prove the instruction is present.
  They cannot prove gpt-5.4 obeys it on turn thirty, and the model demonstrably ignored the
  no-own-opener instruction on this very call.
- **Fifteen new Hebrew clips are unheard.** Round 14 is generated and header-verified (I checked all
  15 RIFF sizes independently of `wavcheck`), but nobody has listened to them. In particular
  `שאסגור את זה כרגע?` will be spoken to real leads at the most fragile moment of a call.
- **The `e2` collision is open.** His `e1` wording is shipped and it can invert.
- **The echo test is crude and unmeasured.** `echoesAgentTail` was written against one real example.
  A false positive costs one confirmation question; that is the direction it is biased in, but its
  false-positive rate on real calls is unknown.
- **`saysExplicitDecline` is a word list.** A caller who declines in wording it does not know gets
  asked "שאסגור את זה כרגע?" once. Cheap, but it is one extra turn on a call he wanted to end.
- **`isSelfNarration` was tested against the two real sentences plus invented ones.** No corpus
  sweep — I did not check the 44 archived call reports for other phrasings of the same leak.
- **The one-question guard has never seen a booking flow.** Dropping the second question is right on
  discovery; whether it ever removes something load-bearing during detail collection is untested on
  a call.
- **`VOICE_INSTANT_ACK`'s actual cloud value is inferred, not read.** I proved it from the transcript
  and it is not in the report's "running on code defaults" list, which means it was set explicitly —
  but I never read the 45 LiveKit secrets, so I cannot quote the value.
- **The acknowledgement may be buying less latency than documented.** On this call dead air ran to a
  1600ms median against a 1491ms "serial total" — i.e. roughly what you would predict with NO early
  acknowledgement at all, not the ~620ms the feature promises. I did not chase this: it needs
  instrumentation that can time the injected string against the caller's clock, which does not exist
  and which the mislabelled `llmTtftMedianMs` cannot provide. **This is the next thing worth
  building** and it may make the whole instant-ack mechanism look different.

## Questions for the architect

1. **`scripts/show-call-report.mjs` prints a wrong label** — `first sound out … the acknowledgement,
   ahead of GPT` is the LLM plugin's own ttft and has never measured the acknowledgement. It already
   caused one wrong inference this session. The script is ops tooling; whose lane fixes it?
2. **Is the instant acknowledgement earning its keep at all?** See the dead-air figure above. This
   wants a measurement before anyone tunes anything else on the latency path.
3. **Round-14 `e2`** needs Koren's ear before the next deploy: his own empathy wording can invert on
   a phone line, in exactly the way that ended this call.
