# VOICE — round 19: the first half-second of her turn

Branch `feature/voice-turn-openers`. Five verdicts, one mechanism, plus a measurement that
undermines a claim this module has been making for a month.

## What Koren decided, and what shipped

| card | his pick | what she said on the 10:53 call | what she will say |
|---|---|---|---|
| o1 | B | `בסדר. כן. זה מספר שהלקוחות…` | `כן.. זה מספר שהלקוחות…` |
| o2 | B | `בסדר. אם יש אצלך מערכת…` | `כן.. אם יש אצלך מערכת…` |
| o3 | D | `בסדר. נוֹחַ לךָ מחר…` | `אז נוֹחַ לךָ מחר…` |
| o4 | C | `יש לי, סבבה, אחת עשרה פנויה — זה מתאים לךָ?` | `יש לי אחת עשרה פנויה. מתאים לךָ?` |
| f1 | B | `אמ.` then 1.45 s of nothing | `אמ. רֶגַע...` then ~0.57 s |

## The design problem, and what I chose

**The receipt is committed before the model has written a word, so nothing knows yet whether the
reply will be an agreement.** The two options on the table:

**Rejected — let the ack fire and have a guard drop it.** This is not merely expensive, it is
impossible in the direction needed. The ack IS the first text chunk; `startSegment()` and therefore
`ttsNode` run on it, so by the time the model writes `כן` the `בסדר` is already synthesised and on
the wire. `dropEchoedOpener` works only because it edits the MODEL's text, which is still upstream —
applied here it could only delete the `כן`, i.e. delete the answer.

**Chosen — suppress the receipt when the caller's last turn was a question, and let the model's own
opener be the first sound.** `callerTurnAwaitsAnswer` (engagement.ts) sits beside the two predicates
that already shape this decision, and `chooseTurnOpener` gains one branch that returns `silent`,
ordered after the two branches Koren judged by ear (tool-call hesitation, dictation nod) so it can
never take a step away from them. The model then writes `כן..` / `אז` itself — where it is the
answer, not a receipt, and cannot commit to an agreement she has not made.

**This is deliberately NOT "put כן back in the deck".** `"כן."` was in `ACKNOWLEDGEMENTS_HE` until
2026-08-29 (`מה המצב, קרן?` → `כן.`). Putting it back would be worse than that defect, not equal to
it: a caller asking `יש לכם ניסיון עם חברות הובלה?` would hear *yes* before anything had decided
whether the answer was yes.

### What it costs — and the finding that made it cheap

The stated price of dropping a receipt is the ~620 ms it buys ahead of the model's first token.
**It is not buying that today.** Across 449 assistant turns in 51 call reports, her first audio
starts a **median of +542 ms AFTER** the `model_ttft` stamp, and only 15% of turns start before it.
`dead_air` minus the same turn's `model_ttft` has a median of **+622 ms** — dead air tracks the
model plus TTS first byte, exactly as it would with no receipt at all. On the one turn where the
receipt was its own segment (10:53 @ 221 s), its synthesis began at 221115 ms and the model's first
token landed at 221094 ms: 21 ms apart.

So the measured cost of this change is **the word, not the second**.

**I did not fix that, and it is the most important thing in this handoff.** Something between
`llmNode`'s `start:` enqueue and Cartesia is holding the injected chunk until the model responds
(`preemptiveTts: false` is a candidate; so is the SDK's `await Agent.default.llmNode()` not
resolving until the LLM streams). Diagnosing it needs instrumentation inside `ttsNode`, not more
report reading. If it is ever fixed, this change starts costing a real 620 ms on question turns and
`VOICE_ACK_SKIP_ON_QUESTION=false` is the lever.

### Blast radius, stated plainly

35% of her turns in the corpus follow a question, and **139 of the 255 receipts she actually spoke
(55%) sit on one**. This partly reverses conclusion 12, whose `QUESTION → true` clause was justified
by the latency the measurement above says is not there. Three cards out of three, his ear agrees.

## f1 — the timing, derived rather than picked

The 1.6 s on the clip is a **tool-call hole**: step 1 emitted `check_calendar_availability` and the
receipt alone, the tool ran 265 ms, and a whole second inference followed. Measured from the
transcript's own `spokeAtMs`/`spokeUntilMs`, the caller sat through **1452 ms** on that turn, and a
**median of 1779 ms** across 81 opener-alone turns in 51 reports (p25 1409). Nothing can make that
hole shorter.

**Why the pair never fired.** `withFiller` returns early when the step produced no model words —
written for the 2026-08-29 orphan bug — so the armed hesitation was dropped and card A was the only
reachable behaviour. It now speaks the hesitation *behind the receipt* on exactly that step, which
is not an orphan but the second half of one breath, and the pair `mayPairInOneBreath` has permitted
since round 7.

**The number.** Measured off his own clips: `r19_f1_A_head` = 560 ms, `r19_f1_B_head` = 1440 ms, so
`רֶגַע...` costs **880 ms** of sound. That leaves:

- **572 ms** of wait on the exact turn he judged (his target: ~500 ms) — met
- **~899 ms** at the corpus median — not met. I could not reach 500 ms here without *delaying* the
  opener, which I deliberately did not do.

**`VOICE_THINKING_FILLER_MS` — a recommendation, not a change.** Prod runs **600** (cloud secret;
`.env` says 2500 and `.env.agent` says 1200 — three values, only the cloud one live). 600 ms is
below the **minimum** observed `model_ttft` (657 ms), so the think-timer arms on essentially every
turn — the opposite of "a turn where the answer arrives early should get no filler at all". From the
`model_ttft` distribution (p10 771 / med 932 / **p75 1108** / p90 1564, n=584) the value that arms
only on the slowest quarter is **1100 ms**. I changed no default and no secret: I do not deploy, and
`.env` beating the shell means a local override proves nothing.

**The tool-call pair deliberately does not depend on that timer.** It draws from the same
three-per-call ledger at the moment the step is *known* to be words-less, so raising the timer
cannot make Koren's f1 verdict land intermittently.

## Prompt — what was added and what paid for it

The live prompt grew by **200 characters** (55522 → 55722), after +655 of additions and −455 of
deletions. Two deletions, both justified rather than convenient:

1. *"On a turn whose answer is one short line, nothing is spoken for you … You cannot tell which
   kind of turn you are on, and you do not need to."* — a paragraph that describes a distinction it
   then says she cannot observe and need not act on, and which round 19 makes actively **wrong**:
   on a question turn nothing is spoken for her AND she must supply `כן..`/`אז`.
2. *"Either one has already been spoken for you, or the moment did not call for one at all…"* — a
   justification the new exception contradicts.

**A correction on the budget.** The ±5% ceiling in `sales-gate.test.ts` is `on.length / off.length`
where the only difference is `salesModel` — it measures the *sales model's share* of the prompt, not
the prompt's size. My text is in the instant-ack Speech Rhythm and Spoken Register sections, which
render in **both** halves of that ratio, so it spends none of the 11 characters of headroom that
actually remain there. Measured before and after: **0.04979 → 0.04979, unchanged.** The real cost is
absolute tokens on every turn, which is why it was paid for anyway.

The golden fixtures under `__fixtures__/` are **byte-identical** and were not regenerated: they
build with `instantAck = false`, and every edit is inside an `instantAck`-gated section.

## Kill-switches (module convention: on by default, `=false` restores)

- `VOICE_ACK_SKIP_ON_QUESTION` — off restores the receipt on a question turn.
- `VOICE_TOOL_FILLER_PAIR_ENABLED` — off restores "no model words, no hesitation".
  `VOICE_FILLER_PAIRING_ENABLED=false` disables it too and remains the coarser exact rollback.

## Verified

`npm run typecheck` exit 0 · `npm run test:ci` **exit 0** (126 files, 1844 passed — judged by exit
code, not by grepping the summary) · `npm run build` exit 0 · territory check on the branch.

## What I could NOT verify — only a live call settles these

1. **Whether she actually writes `כן..` and `אז`.** The prompt tells her to; nothing tests that a
   model obeys. Prompt regressions are invisible to tests. **This is the main risk of the commit.**
2. **Whether the removed receipt leaves an audible hole.** The measurement says it should not,
   because the receipt was not arriving early — but that measurement is inferred from report
   timestamps, not from listening.
3. **Whether `אמ. רֶגַע...` sounds right in the position it now occupies.** He approved the SOUND on
   a constructed clip with a synthetic 1600 ms gap. On a real call the gap is ~570 ms and the pair
   is the last thing before the answer.
4. **The corpus-median wait is ~900 ms, not 500 ms.** Tool-call turns with a slower second inference
   will still feel long.
5. **`VOICE_THINKING_FILLER_MS`.** Nothing in this commit changes it. 1100 ms is a recommendation
   from the distribution; the live value is a cloud secret and stays 600 until Koren changes it.
6. **The 55% receipt removal is a corpus estimate**, from a `?` in the Soniox transcript. A caller
   who asks without an audible question mark keeps the receipt.
7. **No audio was rendered for this change.** Every wording here is one Koren already chose on the
   round-19 page; nothing new was invented that needs his ear first.

## Questions for the architect

- Do we want the **receipt-does-not-arrive-early** defect investigated next? If the instant-ack is
  genuinely inert, three sessions of design rest on a mechanism that is not running, and fixing it
  would change the cost of several shipped decisions at once.

## Not touched

`PRONUNCIATION_FIXES` in `speech-guard.ts`, `sales-gate.ts`, `GATE_FACTS`, the sales-model prompt
sections, and `tests/hebrew-tts-niqqud-ab/` (read only — no writes, no renames).
