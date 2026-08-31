# 2026-08-31 — VOICE: nine things we shipped, and Koren's ear reversing them

Branch: `feature/voice-round7-verdicts`, branched from `main` @ `d7da334`. **Not merged, not
deployed.** Commits `e960d96` (the verdicts) and `c6e64bb` (round 9).

**Gate.** `npm run typecheck` exit 0 · `npm run test:ci` **exit 0** (116 files, 1519 passed, 6 todo;
judged by exit code — the two `Errors` strings in the log are `formErrors:`/`fieldErrors:` inside a
Zod fixture, not vitest's summary line) · `npm run build` exit 0 ·
`bash scripts/ci/territory-check.sh feature/voice-round7-verdicts` OK.

## 👉 THE PAGE FOR KOREN

```
tests\hebrew-tts-niqqud-ab\index-round9.html
```

Four cards, eleven clips. **It is short on purpose: it contains only wording you have not heard.**
Nothing on it asks you to decide something you already decided.

**And it should actually play this time** — see "the WAV header" below. If a clip still does not
play, say so immediately; that would be a different bug.

---

## The through-line

Rounds 7 and 8 asked "is B better than A?" on thirty moments of your 31.8 call. You answered, and
**nine of your answers reversed something we had already built and merged.** That is the system
working, not failing: a written note is a description of a feeling, and the audio is the feeling.
Twice now we have read a note correctly, implemented it faithfully, and produced something worse.

The rule this branch encodes, in a test file that says so out loud
(`prompts/system-prompt.verdicts.test.ts`): **on a question of how she sounds, your ear is the
acceptance test, and a test is the only way that survives the next refactor.**

---

## Round 7 — the four cards

### n4a — we over-corrected note 4, and you caught it

Your note said a filler should arrive once per sentence. We implemented a hard cap: one opening
sound per breath, full stop. You then heard the three versions and picked **A, the doubled filler
we had just deleted**, and told us what the rule actually is:

> "אהה ורגע יכולים להתאים ביחד, אבל רגע ושניה או רגע וחכה זה מילים שלא יכולות ללכת ביחד"

So it was never a cap — it is **compatibility between the two positions**. `allowsArmedFiller` now
asks `mayPairInOneBreath`, and the categories are read out of the two existing banks
(`ACKNOWLEDGEMENTS_HE_WIDE`, `THINKING_FILLERS_HE`) rather than a hand-written list. That choice
pays for itself immediately: the dictation nod `"אה אה."` leads on `אה`, which IS a member of the
hesitation bank, so it lands in the right family without anyone deciding it should.

- a receipt (`אהה`, `אוקיי`, `בסדר`, `טוב`) may be followed by a hesitation — **your pick**
- two hesitations never stack — `רגע` + `שנייה` is impossible, with a test that says so by name
- a nod is a hesitation, so nothing stacks on it either
- an **unscreened** sound never pairs at all (`חכה`, your other example, is in no bank)

Kill-switch `VOICE_FILLER_PAIRING_ENABLED=false` restores the cap exactly. The prompt line that
forbade `"אהה. רגע..."` now forbids two of the *same kind* instead.

### n7a — small talk has to be situational

You were given three openers and chose **C**, the one about the moment of the call. Note 7 itself
had offered the generic form ("איך היה היום שלך עד עכשיו?") as an acceptable fallback, and the
prompt said so in as many words. Your ear rejected it.

The prompt now says small talk must be about **this moment — that you have just rung a man who was
doing something else**, or about something he actually said. The rejected line is **named as the
shape to avoid** rather than quietly deleted; it is the obvious thing the model would otherwise
reach for, and a deleted example teaches it nothing.

> ⚠️ One thing changed on the way in that you should know about. The prompt's second example was
> `"אני לא תופסת אותךָ בזמן לא טוב?"` — **two bare unstressed `לא` in one sentence**, which is
> exactly the class the shipped "Say It So It Cannot Be Misheard" section exists to prevent (the
> `"ועוזרים לא לפספס לידים"` incident). A line that can invert its own meaning on an 8kHz line has
> no business being an example. It is now `"תפסתי אותךָ בזמן טוב?"`, and **that is round-9 card
> `n7b` B** — you have not heard it.

### sg1 — `סגור` is the one bank word with a position rule

You picked A (end of a sentence) and said C (standing alone) is also good. **B, mid-sentence, is
out.** That is a positional constraint, and the bank listed the word with no such note.

The interesting part: **the round-trip transcribed all three carriers perfectly.** The machine
screen we use to admit a word to the bank cannot see this at all. So the constraint is recorded
where the bank is defined, stated in the Spoken Register craft rules where the model can act on it,
and **scoped explicitly to that one word** — `סבבה` and `אחלה` are softeners and the section's own
example builds a clause around one of them.

### n6b — the same-opener repeat, and what was actually wrong

You confirmed the earned acknowledgement and added: *"צריך לוודא שהסוכן לא חוזר על אותה מילה כל
פעם בתחילת המשפט ('אוקיי')."*

**I measured before changing anything, and the obvious suspect is innocent.** Simulating
`AcknowledgementLedger` over 20,000 calls × 40 turns in each of its four configurations produced
**zero** consecutive identical receipts. Its window is not one turn and it is not absent: it is the
whole deck — every word spent before any repeats — plus a boundary swap. That probe is now a unit
test at 1/200th the sample size, so the diagnosis is in the repo rather than in this document.

The real hole: **the deck is one of four things that can occupy the head of a reply, and none of
them could see the others.**

| producer | rotation it had |
|---|---|
| the receipt deck | a full deck + boundary guard — fine |
| `DICTATION_NOD` | **none. It is a single constant**, so a phone number followed by an email says it twice by construction |
| a thinking filler | never repeats within a call, but never checked against anything else |
| the model's own word on a `silent` step | none, and nothing compared it to the previous turn |

`SpokenOpenerTracker` is the missing memory — the head-word of the previous reply, whichever
mechanism said it. The deck, the nod and the filler all consult it now. **A nod that would repeat
becomes silence, not a receipt** — a receipt mid-dictation is the exact interruption the nod exists
to prevent (you said "050-", she said "טוב, הבנתי."), and inventing a second nod is not available
because an unscreened interjection fails silently.

**And the metric could not have moved.** `repeatedOpenerCount` counts *distinct* openers used twice
or more, so over a 37-turn call a three-word bank must score 3 whatever the order — perfect rotation
and the same word every single turn are the same number to it. It read 4 on your call and would have
read 4 if the rotation had been flawless. `CallReport` now also carries **`consecutiveOpenerRepeats`**,
which is the complaint you actually made and which should read 0.

Kill-switch `VOICE_OPENER_NO_REPEAT_ENABLED`.

---

## Round 8 — the Hebrew method is largely reverted

You rejected the Hebrew-transliteration approach on every card, and your ear agrees with the
phone-band measurement the previous session had already recorded and flagged against itself.

| card | your pick | what changed |
|---|---|---|
| e1 | **A** | Ask for the whole address at once (`"ומה כתובת המייל?"`). The "part before the @, as one word" instruction is gone. |
| e2 | **A** | Read back in **English letters** — and with the `רק לוודֵא` preamble off, which is card `e2c` in round 9. |
| e2b | **B** | The domain in English (`gmail dot com`). |
| e4 | **A** | English letter names on a miss. Hebrew ones gone. |
| e6 | rejected | `קאסקורן` does not appear anywhere in the prompt any more. |
| e5 | **B + amendment** | Kept, and extended — below. |

`"ג'ימייל נקודה קום"` survives **once**, as the named counter-example inside its own prohibition,
for the same reason `רק לוודא` does: a rule that never names the wrong form is a rule the model
cannot recognise it is breaking. A test asserts it appears exactly once and only there.

**The input-parsing half is untouched**, deliberately: `email-dictation.ts` still resolves
`ג'ימייל נקודה קום` → `gmail.com` when the CALLER says it. None of your verdicts are about what he
says. Also untouched, as instructed: the letter-stitching, the `fact-memory` rejection ledger,
`book_meeting`'s nullable email behind `VOICE_BOOK_WITHOUT_EMAIL`, and the
`send_whatsapp_confirmation` pre-flight.

### e3 — no verdict, so a third form

You endorsed neither variant, which means both were wrong. What **neither** gave you is a way to
check the address without being asked to arbitrate between two readings. The new form reads the
joined address back in English letters and **says how many letters she counted**, so a fragment the
line ate is something you can hear is missing:

> `"זה שמונה אותיות: k. a. s. k. o. r. e. n. נכון?"`

**This is a proposal and it is UNHEARD.** Round-9 card `e3c`, with a no-count alternative beside it.

### e5 — your WhatsApp amendment, checked in the code rather than assumed

> *"עדיף שהיא תבקש ממנו לשלוח לה את הכתובת אימייל בוואטצאפ אם זה לא עובד אחרי פעמיים שלוש"*

**You are right and the direction is why.** The previous session's blocker was real, and it applies
only to messages WE send: a lead who has only ever phoned us has no open 24-hour window, so an
outbound needs the `meeting_confirmation` template, which is still pending.

Traced through the code: **a message HE sends opens the window by itself.** The inbound webhook
calls `touchWhatsappWindow` (`whatsapp.routes.ts:102` and `:159`), which stamps
`leads.last_inbound_whatsapp_at`; `resolveWhatsappSendMode` then returns `freeform` for 24 hours —
no template, no consent gate, nothing pending Meta. The lead row already exists, because the call
created it.

**What is NOT settled is how he knows where to write, and I have not papered over it.** The only
WhatsApp sender in the system is `TWILIO_WHATSAPP_NUMBER` — a platform-wide **optional** env var.
There is no per-tenant WhatsApp-number setting, and nothing on the voice path speaks a number to a
caller today. So the clause is **interpolated and empty by default**: with no number configured she
makes no offer at all and says only that the team will be in touch, which is true for every tenant.
She never names a channel that will not reach us — that was the whole point of cutting the outbound
promise, and it would have been trivial to undo it here by accident.

Kill-switch `VOICE_EMAIL_WHATSAPP_HANDBACK_ENABLED`. The wording is round-9 card `w1`, including
the question of whether she should read a phone number out loud mid-call.

### The contradictory comments, fixed

`provider.interface.ts`, `google-calendar.provider.ts` and `env.ts` all said a null-email booking is
"confirmed by WhatsApp" / `(NO EMAIL — confirmed by WhatsApp)`. **It is not**, and the same change
that wrote those comments had deliberately stopped her promising it. They now say what actually
happens: nothing reaches that lead automatically, and the only things that do are a human looking at
the booking or a WhatsApp he sends us.

---

## The WAV header — proven at the source, not inferred

Every clip in every listening round carried `0xFFFFFFFF` in both size fields, and you could not play
round 7 at all. The 297 files were repaired in `d7da334`; **the generator still emitted it.**

The working theory was ffmpeg. It is not — there is no ffmpeg anywhere in this path. **I generated
one clip and read the bytes**, and the placeholder comes straight off the wire:

```
RAW BYTES AS CARTESIA SENT THEM
  first 16 bytes: 52 49 46 46 ff ff ff ff 57 41 56 45 66 6d 74 20
  file_size = 63582
  riff_size = 0xffffffff
  chunks    = [('fmt ', 16, 12), ('LIST', 26, 36), ('data', 4294967295, 70)]

AFTER finalize()
  first 16 bytes: 52 49 46 46 56 f8 00 00 57 41 56 45 66 6d 74 20
  riff_size = 63574 ( = file_size - 8 -> True )
  data_size = 63504 ( = bytes after header -> True )
  audio bytes identical: True
```

`/tts/bytes` is a **stream**, so the writer cannot seek back to patch the length, and `synth.py`
wrote the response straight to disk. Every round since round 1 inherited it.

**Fixed at the moment of writing, not in a repair script.** `tests/hebrew-tts-niqqud-ab/wavcheck.py`
repairs and then *verifies*; `synth()` calls it on every clip and **raises** rather than warns — a
warning inside a run that synthesizes thirty clips is a warning nobody reads, which is how a whole
round was lost. Every round script (3 through 9) goes through that one function.

Verified end to end: a second clip through the fixed `synth()` came back `riff=91798 data=91728` of
91806 bytes, and all eleven round-9 clips read back valid with eleven distinct hashes.

`wav.ts` — the TypeScript side, which has **always** written correct headers and produced none of
the broken files — gains `readWavHeader` / `assertPlayableWav`, and `encodeWav` now validates what it
produced before returning it. Not because it was wrong, but because "we compute it correctly" is
precisely what everyone believed about the Python path. Seven tests, including one that refuses the
exact `0xFFFFFFFF` byte pattern.

`roundtrip*.ts` and the A/B page recorder were checked and write no WAVs of their own — the
round-trip scripts read existing files, and everything in `testing/` funnels through `encodeWav`.

---

## Fixture regeneration — the justification

`__fixtures__/prompt-default-{notools,tools,tools-noobjection}.txt` regenerated with
`npx tsx scripts/regen-prompt-fixtures.mts`. The full note is at the top of
`system-prompt.persona.test.ts`, as the rule requires.

This regeneration is different from every one above it in that note: **it is not driven by a call,
it is driven by you listening to the previous two changes and reversing five of them.** Six
deliberate deltas — the pairing rule, situational small talk, the `סגור` position rule, the email
method reverted to English letters, the new `e3` form, and the interpolated WhatsApp clause.

`greeting-default.txt` is **byte-identical** and was not regenerated. Every persona-owned section
(Role, FAQ, gender rules) was diffed and is unchanged.

**New file: `prompts/system-prompt.verdicts.test.ts`** — twelve tests pinning the eleven round-7
cards and the one round-8 card you CONFIRMED. It exists because several of them are the opposite of
what a reasonable session would do unprompted (remove a politeness, keep a filler, open with slang),
and a future session reading only the code will find good reasons to change them back.

---

## What is UNVERIFIED — read this before quoting anything above

- **No real PSTN call, and nothing is deployed.** I did not run `agent:deploy`.
- **No local synthetic call either.** I did not run `voice:dev` this session. The code changes are
  proven by unit tests against their own functions, not by a call.
- **A prompt change is invisible to every test in this repo.** The tests prove the instruction is
  present and says what you asked for. Whether gpt-5.4 obeys it on turn 30 of a real call is not
  something any of them can see — that is true of every prompt line on this branch, and it is
  especially true of the small-talk rule, which competes with a section two pages away.
- **The consecutive-opener rule has ONE hole and it is stated rather than hidden.** On a `silent`
  step (no receipt, no filler) the model's own first word is the head of the reply. It is
  **observed** — so the next opener we choose avoids it — but **not rewritten**, because rewriting
  it means buffering the first audio of a step that already has no sound covering it, and that step
  follows a tool round-trip the caller has just sat through. Two consecutive silent steps could in
  principle repeat. Under the production default (`VOICE_INSTANT_ACK` on) that needs two tool calls
  inside one reply.
- **`consecutiveOpenerRepeats` has never been read off a real call.** Its expected value is 0 and I
  have not seen it be 0 in production.
- **Round 9 tests PHRASING, not behaviour**, like every round before it. A win on `e3c` says the
  sentence sounds better; it does not say she will write it.
- **The `w1` phone number is a dummy** and I do not know whether `TWILIO_WHATSAPP_NUMBER` is
  actually set on the deployed agent. If it is unset, the WhatsApp clause is simply absent and
  nothing about her behaviour changes — that is the safe default, not a fix.
- **Nobody has ever sent that WhatsApp.** The window logic is read from the code and is correct; the
  end-to-end path (he messages us → the message lands against his lead → a human reads the address)
  has not been exercised once.
- **The `e3c` letter-count wording is my invention**, not yours and not measured. `שמונה אותיות` has
  not been through a round trip; it is ordinary Hebrew, but so was `אוו`.

---

## Questions for architect / Koren

1. **`w1` — should she read a phone number out loud mid-call at all?** Card B does, card C makes the
   offer without one. If C wins, we need another way for him to know the number, and I do not have
   one today.
2. **There is no per-tenant WhatsApp number setting.** Today the offer only ever works for the
   ClickScales tenant, via a platform env var. If this is meant to be a product behaviour rather
   than a ClickScales one, it needs a `tenants.settings` key — that is a cross-workstream contract
   and I have not claimed one.
3. **A booking with no email still reaches nobody automatically.** Fixing the contradictory comments
   made that plainer, not better. Does the `meeting_confirmation` template approval move up the list?
4. **`registerTracker.note()` is still dead** (found and deliberately not switched on by the previous
   session — it pushes for MORE register touches). Round 7 said nothing about it either way.

---

## Next steps

- **KOREN:** open `tests\hebrew-tts-niqqud-ab\index-round9.html`, judge, press "צור סיכום", paste it
  back. Card `e3c` is the one you did not answer last time; card `w1` is your own suggestion turned
  into sentences.
- **VOICE (next session):** a local `voice:dev` run against `terse_caller` and `email_spelling` to
  see (a) whether `consecutiveOpenerRepeats` really comes back 0 and (b) whether she actually reaches
  for `email: null` rather than continuing to ask, which is the one behaviour the email branch claims
  and has never demonstrated.
- **ME:** nothing blocking.
