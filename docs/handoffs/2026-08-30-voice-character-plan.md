# 2026-08-30 — Voice: defect fixes + character work (plan)

Written by the supervisor session from the call report of **2026-08-29 18:30 UTC**, the first
call against `5meaUhgLvoq4` (= `ad730fd`). Every claim below is quoted from that transcript.
Koren's five complaints are all real; two are worse than he described.

Measured this call vs the 08-29 morning call: EOU 351ms (=), LLM TTFT **1021ms** (was 1145ms),
TTS TTFB 236ms (=), **dead-air median 1536ms** (was 1708ms), p90 **2050ms** (was 2685ms).
So the humanization merge did not regress latency — it improved slightly. Everything below is
about behaviour, not speed, except P1-3.

---

## P0-1 — She lost the lead's identity, then adopted a hallucinated one

The single worst defect. Sequence, verbatim:

| t | who | text |
|---|---|---|
| 16490 | KEREN | `אהה. קודם כל — איך קוראים לךָ?` |
| 28895 | KEREN | `… רק שאדע עם מי אני מדברת?` |
| 42176 | KEREN | `… איך קוראים לךָ?` |
| 47019 | lead | `אם דיברנו על זה כבר, קרן, אני קורן` ("we already covered this — I'm Koren") |
| 54149 | KEREN | `אוקיי. נעים מאוד, קורן.` |
| 103531 | lead | `טל, אוזן` ← **STT garbage, not a name** |
| 109172 | KEREN | `נעים מאוד, טל.` ← **she renamed the lead** |

Two distinct failures:

**(a) She asked for the name three times before getting it.** Nothing stopped her re-asking a
question already on the table. The lead had to tell her they'd covered it — the exact moment a
caller decides they are talking to a machine.

**(b) She then overwrote a CONFIRMED name with STT noise.** `capture_lead_info` fired twice
(@90946, @103904); the second call is where `טל` entered. A name the lead stated plainly and she
acknowledged was replaced by a fragment from a garbled turn, with no confirmation and no
precedence rule.

**Do:** make already-captured facts suppress the question that asks for them, and make an
established fact harder to overwrite than to set — a confirmed name should require explicit
correction from the lead ("actually it's X"), never a bare noun in a noisy turn. Consider whether
`capture_lead_info` should ever be allowed to *replace* a non-null field mid-call.

**Done when:** a name given once is never asked for again, and a garbled turn cannot rename an
identified lead.

---

## P0-2 — The value proposition inverts when spoken

She said it correctly: `ועוזרים לא לפספס לידים` ("and help you NOT miss leads"). What the lead
heard, in his own next words: `מה עוזרים לו לפספס?` ("help him to MISS?"). Koren heard the same
inversion independently.

The negation `לא` is not surviving delivery — swallowed between `ועוזרים` and `לפספס`. She then
spent a whole turn repairing it (@42176), which is a turn of selling lost to a phonetics problem.

This is the highest-stakes line in the script: dropped, it advertises the opposite of the product.

**Do:** stop relying on an unstressed `לא` carrying the meaning. Prefer positive phrasing that
cannot invert (`דואגים שכל פנייה תקבל מענה` — "we make sure every enquiry gets answered") or give
the negation prosodic weight. Check the same risk anywhere else meaning hangs on a single
unstressed particle.

**Done when:** the value proposition cannot be misheard as its own opposite, verified by ear on a
real call — not by reading the transcript, which was always correct.

---

## P1-1 — Repetition is real; the counter says otherwise

`repeatedPhraseCount: 0`, yet in 8 turns: `אהה.` ×2, `בסדר.` ×2, `אוקיי.` ×2 — six of her turns
opened with one of three words. Koren hears that as repetition and he is right.

The ledger counts *phrases* and does not track **acknowledgements**, so the metric reads clean
while the call sounds mechanical. A metric that stays green through the defect it exists to catch
is worse than no metric.

**Do:** bring acks under the anti-repetition ledger, and widen the bank. Fix the counter too —
if `repeatedPhraseCount` had counted these it would have shown 3.

---

## P1-2 — The gap after a tool call is 5–6s, not the ~2–2.5s estimated

| ack | tool | next real sentence | gap |
|---|---|---|---|
| `אוקיי.` @90896 | `capture_lead_info` @90946 (979ms) | @97082 | **6.2s** |
| `בסדר.` @103441 | `capture_lead_info` @103904 (1074ms) | @109172 | **5.7s** |

The previous session predicted ~2–2.5s and named `capture_lead_info`'s ~1s blocking write as the
lever. The real gap is more than double that, so the write is only part of it — measure where the
rest goes before changing anything.

Its own recommendation still stands and is now clearly worth doing: `capture_lead_info` is pure
bookkeeping the model never reads back, yet the caller waits for it. Making it non-blocking
changes when `rt.leadId` resolves for a later `book_meeting` and would hide write failures, so it
needs its own switch and tests.

---

## P1-3 — Slang appeared, but below the threshold where anyone notices

Two instances in 8 turns: `זה אחלה לעסקים` (@83979), `וואלה, מעניין` (@97082). The quota asked
for every second or third reply. Koren perceived none, and perception is the acceptance test.

Also: **`וואלה` is not in the round-5 screened bank** (`סבבה, אחלה, מעולה, בקטנה, על הדרך`). The
model is inventing register words. Harmless here; not something to leave unbounded.

---

## P2 — The character work Koren actually asked for

> *"build a better character for the agent … by enhancing the way the LLM model OpenAI thinks and
> what kind of output it makes."*

The defects above are bugs. This is different: it is about **how the model reasons before it
speaks**, not about patching individual lines. Levers available, cheapest first:

1. **Prompt architecture.** Today the persona is descriptive ("you are Keren, you are warm").
   Descriptive traits produce averaged output. Decision rules produce character — what she does
   when she does not know, when interrupted, when someone is curt, when someone is chatty.
2. **`VOICE_LLM_REASONING_EFFORT` and `VOICE_LLM_SERVICE_TIER`** are already live secrets. Nobody
   has A/B'd them against call quality; higher effort costs first-token latency, which is the
   budget we are already over. Measure before adopting.
3. **Output shaping.** The transcript shows correct-but-flat sentences of even length. Real
   speech varies: fragments, one-word answers, occasional long explanation. That is specifiable.
4. **Few-shot exemplars** of the target register beat adjectives — the P1-2 register fix already
   proved examples change behaviour where instructions did not.

**Sequencing:** the identity bug (P0-1) makes her feel like a machine far more than register does.
Character work on top of a broken memory is polish on a cracked surface. Fix P0s first, then treat
character as its own change with Koren judging by ear.

⚠️ **`system-prompt.he.ts` is the highest-risk file in the repo.** Every change needs a test and a
deliberate golden-fixture regeneration, and prompt regressions are invisible to tests — they only
show on a live call.

---

## Still blocked, unchanged

- **P0-1 of the previous worklist: migration 0017 is unapplied.** The handoff records nothing.
- **P0-2: `tenants.settings.handoff` is null.** The owner alert reaches nobody.

Both need Koren. Neither is voice's to fix.
