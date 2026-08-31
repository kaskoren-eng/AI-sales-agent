# VOICE — 2026-08-31 — round-10 verdicts applied, and round 11 for the one he could not settle

Branch `feature/voice-round10-verdicts`. Everything below was judged **by exit code**, never by
reading a summary line.

| gate | result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run test:ci` | **exit 0** — 117 files, 1568 tests |
| `npm run build` | exit 0 |
| `bash scripts/ci/territory-check.sh feature/voice-round10-verdicts` | see §6 |

**Not deployed. Nothing here has been on a phone call.**

---

## 1. The verdicts, and every place each one landed

Koren listened to round 10 and returned ten verdicts. Eight differ from what was in the banks.

| card | was | now | where it is defined |
|---|---|---|---|
| f1 | `אהה.` | **`אמ.`** | `prompts/acknowledgements.he.ts` → `ACKNOWLEDGEMENTS_HE` |
| a1 | `אוקיי.` | **`אוקי.`** | same constant |
| a2 | `בסדר.` | **kept** | same constant, now pinned by a test |
| a3 | `הבנתי אותך.` | **kept** | `ACK_COMPREHENSION_HE`, pinned |
| a4 | `טוב, הבנתי.` | **kept** | `ACK_COMPREHENSION_HE`, pinned |
| f2 | `אה...` | **`אֶה...`** | `prompts/thinking-fillers.he.ts` → `THINKING_FILLERS_HE` |
| f3 | `אממ...` | **`אֶממ...`** | same constant |
| f4 | `רגע...` | **`רֶגַע...`** | same constant |
| f5 | `שנייה...` | **`שניה...`** | same constant |
| n1 | `אה אה.` | **unchanged — no verdict** | `dictation.ts` → `DICTATION_NOD` |

**There is no fourth place these strings live.** I looked for duplicates the way the brief asked —
four mechanisms write to the head of a reply (the ack deck, the dictation nod, the thinking filler,
and the model itself) and only the first three are ours. Every other occurrence of `אהה` / `אוקיי` /
`אממ` in `src/` is a **comment quoting a past call** or a **test fixture of a past transcript**;
none of them is spoken. I left the historical quotes alone deliberately — they are the record of
which call produced which decision, and rewriting them would erase it.

### The one change that is NOT a string edit — and without it the verdict silently reverts

`guardSpeech` **strips every Hebrew niqqud mark** before text reaches Cartesia, because
model-emitted pointing is unreliable (known-issues §13). The thinking filler is injected by
`llmNode` / `withFiller` **inside** `guardStream`, so it meets that strip like any other text.

So writing `אֶממ...` into the bank is not enough: Cartesia would have received `אממ...`, Koren's
verdict would have been reverted in the pipeline, and **nothing anywhere would have failed**.

The fix uses the mechanism that already exists for exactly this — `PRONUNCIATION_FIXES` in
`speech-guard.ts`, which re-applies this file's own verified marks *after* the strip. Three new
rows, scoped to the ellipsis:

```ts
[/(?<![֐-׿])אממ(?=\.{3}|…)/gu, 'אֶממ'],
[/(?<![֐-׿])רגע(?=\.{3}|…)/gu, 'רֶגַע'],
[/(?<![֐-׿])אה(?=\.{3}|…)/gu,  'אֶה'],
```

The ellipsis scope is load-bearing in two directions and both are pinned by tests:

- `"רגע, בודקת."` is a system-prompt opener the model writes constantly and is **not** this filler.
  Koren judged the hesitation, not the word everywhere it appears.
- `DICTATION_NOD` is `"אה אה."` and **has no verdict**. A bare `אה` → `אֶה` rule would have
  repointed the nod on his behalf — the exact class of silent drift this round exists to stop.

New tests in `speech-guard.test.ts` assert the end-to-end result: every bank member survives
`guardSpeech` byte-for-byte, survives `guardStream` (the path production uses), `רגע, בודקת.` is
untouched, and the nod is untouched.

### No prompt change, and the fixtures are byte-identical

`prompts/system-prompt.he.ts` is **not modified**, and `__fixtures__/` was **not regenerated**.

- The live bank is interpolated into the prompt by `buildSpeechRhythmAckInjected(bank)`, so the
  Speech Rhythm section now quotes `"אוקי.", "אמ.", "בסדר."` automatically and correctly.
- The fixtures are built with `instantAck: false` (the default), which uses the other section, so
  the bank change cannot touch them. Verified: `test:ci` green with the fixtures untouched.
- The prompt's one surviving `אהה` is the round-7 rule line — *"אהה. רגע..." is fine* — which is
  **Koren's own verbatim quote** about which two ACTS may share a breath, pinned by
  `system-prompt.test.ts`. I left it exactly as it is. It is an illustration of a category rule, not
  a claim about the current bank, and re-wording a verdict he gave in his own words to chase
  spelling consistency is not worth a prompt regression.
- **The screened-vocabulary claim in the prompt is still true.** That sentence
  (*"each one was tested through a real phone line and heard back correctly"*) is about
  `REGISTER_VOCABULARY` — the nine words `סבבה · אחלה · מעולה · בקטנה · על הדרך · סגור · וואלה ·
  אוף · איזה כיף`. Round 10 touched none of them, so nothing there needed weakening. The
  ack/filler banks are not claimed as screened anywhere in the prompt text.

---

## 2. What changed about the pairing classification — the thing that would have broken quietly

`mayPairInOneBreath` derives its categories from the two banks through `leadToken`, and
`DICTATION_NOD` was classified as a *hesitation* only because its lead token `אה` was a member of
`THINKING_FILLERS_HE`.

**With `אה...` becoming `אֶה...`, that membership disappears.** `leadToken` did not strip niqqud, so
`אה` would no longer have matched anything, and the nod would have dropped to `unscreened`.

Nothing would have failed. `mayPairInOneBreath` refuses `unscreened` and `hesitation` alike, so
every pairing test would still have passed while the nod quietly left the screened vocabulary.

Two changes, both pinned:

1. **`leadToken` now strips niqqud**, like `openerKey` next to it always has. A mark is a
   pronunciation instruction to Cartesia, not a different sound — `guardSpeech` removes them all
   before the voice sees the text, so a classifier that treated `אֶה` and `אה` as two words would
   have been the only thing in the module doing so. Re-derived categories:

   | | lead tokens (niqqud stripped) |
   |---|---|
   | acknowledgement | `אוקי` · `אמ` · `בסדר` · `הבנתי` · `טוב` |
   | hesitation | `אממ` · `רגע` · `שניה` · `אה` |
   | `DICTATION_NOD` | `אה` → **hesitation**, as before |

   The two sets are still disjoint (the existing disjointness test still passes), and
   `openingSoundCategory(DICTATION_NOD) === 'hesitation'` is now asserted with a comment naming
   this exact trap.

2. **A pair is now also refused when one lead token is a prefix of the other.** This is new
   behaviour and it is a **prediction of mine, not a verdict of his** — see §4.

   The receipt is `אמ.` and the hesitation is `אֶממ...`. Different categories, so the round-7 rule
   says they may share one breath, and the caller would hear **"אמ. אֶממ..."** — the same closed-lip
   hum twice, which is the stutter Koren ruled out in round 7 wearing a new face. The category
   lookup cannot see it, because the two words really are in different banks.

   It only ever REMOVES a sound, which this module already treats as always acceptable (an unspoken
   filler is not charged and survives for a later turn), and `VOICE_FILLER_PAIRING_ENABLED=false`
   is strictly more restrictive, so it remains an exact rollback of pairing as a whole. There is a
   test asserting that narrowing property directly. **No new env key was added** — this branch adds
   none, and `.env.example` / `src/config/env.ts` are untouched.

   `אמ.` retired `אהה.` from the ack bank, so `openingSoundCategory('אהה.')` is now `unscreened`
   and fails closed. That is correct and is asserted: a retired string must not keep its old
   privileges by living on in some caller's constant.

---

## 3. Round 11 — the nod, and the pair I blocked without asking

**The page: `tests/hebrew-tts-niqqud-ab/index-round11.html`.** 15 clips, 2 cards, sonic-3.5 at
production speed/volume (0.9 / 1.4).

Build/read scripts: `tests/hebrew-tts-niqqud-ab/round11.py` and
`tests/hebrew-tts-niqqud-ab/roundtrip11.ts`.

### Card `n1` — the nod, 12 candidates, every one spoken alone

Round 10 offered four spellings of `אה אה` and he rejected all four, so round 11 does not offer a
fifth. It offers **different sounds**:

- the two he PICKED in round 10 — `אמ` and `אֶה` — in this position, which he has never heard them
  in (A, B), plus `אֶמ` (C) and the doubled forms `אמ אמ` / `אֶה אֶה` (D, E);
- the everyday Israeli back-channels that were in **no** previous round: `אהם` (F), `אֲהֶם` (G),
  `אהא` (H), `אֲהָא` (I), `הממ` (J), `אמהם` (K);
- one bare open vowel, `אָה` (L).

The card says plainly that **"none of these" is a real answer with a real consequence**: if no sound
works, the honest conclusion is that there is no good nod and she should say *nothing* mid-dictation
— which is a change in `chooseTurnOpener` (which today falls back to a RECEIPT when no nod is
supplied, the very interruption the nod exists to prevent), not a fifth guess at a spelling.

### Card `p1` — the pair my guard refuses

Three clips: `אמ. אֶממ... בוא נבדוק…` (the blocked pair), `אמ. רֶגַע... בוא נבדוק…` (a pair the
code allows), and `אמ. בוא נבדוק…` (what the code produces today). **If A sounds fine, I remove the
guard.** It is one line and the comment says so.

### The instrument correction is on the page, in Hebrew, at the top

The 8kHz round trip measures whether Soniox can transcribe our own Cartesia output. For a CONTENT
word that is a real proxy and it earned its keep (`נוח` → `נח`, `רק לוודא` → `רק לוועדה`). **For a
filler it is close to meaningless** — nobody needs to transcribe a hesitation.

Round 10 demonstrated the limit and **I passed the result to Koren as fact when it was not one**:
`אמ` was reported as "never came back from the line" on card `f3`, and the identical string came
back cleanly as `אממ` on card `f1`. He then chose it on `f1`, by ear, and he was right.

So on round 11: every transcript is printed, every transcript is labelled **weak evidence**, nothing
is coloured red, and no candidate is withdrawn on a machine's opinion. `roundtrip11.ts` scores
nothing, exits 0 whatever it reads, and never uses the words *fail*, *vanished* or *unusable* —
round 10's harness ended its run by printing *"those spellings are unusable whatever they sound
like"*, which was not true and was not mine to say.

**Round 11's own run reproduced the same limit twice, live:**

| clip | sent | Soniox wrote |
|---|---|---|
| `p1_C` | `אמ. בוא נבדוק…` | `בוא נבדוק…` — the `אמ` is absent |
| `p1_B` | `אמ. רֶגַע... בוא נבדוק…` | `אממ, רגע, בוא נבדוק…` — the same `אמ` came back |

Same string, same voice, same model, two carriers, opposite results. Both are on the page as the
demonstration.

`p1_A` came back as a single `אממ.` — Soniox did not distinguish the two sounds. That is *weak*
evidence in the direction of my guard and the page labels it as such. **His ear decides.**

### Verification of the page itself

- all 15 clips pass `wavcheck.assert_playable` (headers repaired and re-read from disk);
- all 15 `<audio src=>` resolve to files that exist;
- **all 15 decode in a real Chrome via Playwright** through `AudioContext.decodeAudioData`, at
  48kHz, durations matching their headers. Three needed a retry — that is the throwaway
  single-threaded Python static server, not the files; each succeeded on retry and each also decodes
  offline through Python's `wave` module.

**What that does not prove: how any of them sounds.** That is the whole point and it is his alone.

---

## 4. One hard measurement worth reading before the round — `אמ.` alone is SILENT

Measured off the audio, not off a transcript:

```
r11_n1_A.wav   אמ.  alone     0.16s   peak 49 / 32767      <- effectively silence
r11_n1_C.wav   אֶמ. alone     1.04s   peak 31823           <- fine
r11_n1_D.wav   אמ אמ. alone   1.76s   peak 32495           <- fine
round-10 f1_E  אמ. + sentence 2.64s   audible, and he CHOSE it
```

**Cartesia produced no audible sound for the bare string `אמ.` synthesized on its own.** Pointing it
or doubling it rescues it, and inside a sentence it was fine — which is how it won card `f1`.

Why this matters beyond the nod card: `אמ.` is now the receipt, and the receipt is the mechanism
that puts first audio under a second. If it renders as near-silence the feature stops working with
no metric moving — the text is still in the CallReport, the latency instrumentation counts frames
and not loudness.

**I could not settle whether production is exposed, and I am not going to guess.** What I did
establish, by reading the plugin source (`node_modules/@livekit/agents-plugin-cartesia/dist/tts.js`):
it re-tokenizes the incoming text with its own `SentenceTokenizer` at `minSentenceLength = 8` words,
and sends every segment under **one `context_id` with `continue: true`**. So the receipt is not sent
to Cartesia as an isolated request the way my clip was; it is appended to a continuing context with
the reply behind it. That argues the exposure is small. It does not prove it is zero, and only a
call can.

**This is the first thing to listen for on the next real call.**

---

## 5. What is UNPROVEN — read this part

1. **Nothing here has been on a phone call.** Every gate above is a type-checker, a unit test or a
   file on disk. The verdicts were chosen by his ear on round-10 clips; whether the new bank sounds
   right *in a live conversation*, at a real turn boundary, is untested.
2. **`אמ.` alone renders silent in isolation** (§4). Whether that reaches a caller depends on
   plugin buffering I read but did not run. Unresolved.
3. **The `אמ.` + `אֶממ...` guard is my prediction, not his verdict.** He has never heard the pair;
   round-11 card `p1` exists to settle it. Until he answers, a filler is being dropped on a
   fraction of turns on my judgement alone.
4. **The dictation nod is still the unscreened 2026-08-30 string** and is still spoken on
   production calls. Round 10 rejected every alternative; round 11 is unheard.
5. **Round 11 is unheard, all of it.** I can report that 15 clips decode and that one of them is
   silent. I cannot report how any of the other fourteen sounds.
6. **A prompt change is invisible to every test** — and this branch makes none, which is the
   strongest statement available. But the same warning applies to what I did NOT change: the
   round-7 line still quotes `אהה. רגע...` while the bank contains neither string. I judged the
   inconsistency harmless because that line teaches a category rule in his own words. If she starts
   opening replies with `אהה` on a call, that line is the first suspect.
7. **The cross-TURN case of the stem collision is not guarded.** `chooseTurnOpener`'s no-repeat rule
   uses `openerKey`, for which `אמ` and `אממ` are different keys, so a receipt `אמ.` on one turn may
   be followed by a hesitation `אֶממ...` on the next. Across two turns that is far less audible than
   within one breath, so I left it — but it is a choice, not an oversight.
8. **`שניה...` (f5) is a spelling change with no pronunciation table behind it.** It reaches
   Cartesia exactly as written, which is what he heard, so nothing more is needed — but note it is
   the one verdict with no code mechanism protecting it, so a "fix the typo" pass would silently
   undo it. The literal is pinned by a test for that reason.

---

## Questions for the architect

- **Does the nod deserve a silence branch?** If Koren rejects card `n1` outright, the honest
  implementation is "say nothing mid-dictation" — but today `chooseTurnOpener` falls back to a
  RECEIPT when no nod is supplied, which is the original bug. That is a small, deliberate change and
  I did not make it speculatively.
- **`אמ.` is now both the receipt and (almost) the hesitation.** Two of the agent's three
  every-turn receipts are now closed-lip hums that differ from a hesitation by one letter. His ear
  chose it and his ear wins, but it narrows how much room the pairing rule has left. Worth a look
  when the next listening round is planned.

## Not deployed

`npm run agent:deploy` is Koren's call through the supervisor session. Nothing on this branch has
been deployed.
