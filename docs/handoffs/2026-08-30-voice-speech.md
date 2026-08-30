# 2026-08-30 — VOICE session: how she SOUNDS (seven notes from two production calls)

Branch: `feature/voice-hebrew-speech`, worktree `C:/agent-voice`, branched from `main` @ `7cfa526`.
Not merged, not deployed. Source: Koren's seven notes after listening to the two calls in
`call-reports/calls-2026-08-30.md` (04:56, 349s and 05:03, 426s — both on `PccRxPM5jzFd` = `7cfa526`).

**Gate: green.** `npm run typecheck` exit 0 · `npm run test:ci` **exit 0**, 107 files, 1328 passed,
no summary "Errors" line · `npm run build` exit 0. Baseline was 106 files / 1292 passed; the one new
file is `dictation.test.ts`.

## 👉 THE PAGE FOR KOREN TO OPEN

```
C:\agent-voice\tests\hebrew-tts-niqqud-ab\index-round6.html
```

59 clips, seven sections, all synthesized on **sonic-3.5 at the production speed and volume**
(0.9 / 1.4) — every earlier round used 1.0 / 1.0, and for a round about pacing that difference is
the subject. Listen, mark, press **"צור סיכום"**, paste the summary back. Four of the seven notes
end there and nowhere else.

Three commits:

| | commit | what |
|---|---|---|
| evidence | `b920dba` | round 6 — the listening test, the pause probe, the round-trip |
| code | `a9fe9c7` | the mid-dictation nod, and introducing herself once |
| prompt | `616cee3` | joy in proportion, a pausing rule with numbers, one confirmation phrasing |

---

## Where each of the seven notes stands

| # | note | status |
|---|---|---|
| 1 | "רוצה" gender + sweep | **his ear only** — page sections `g` and `sw`. Nothing shipped. |
| 2 | acks in the wrong place, need a vocal nod | **fixed in code**, nod SPELLING is his pick (`nd`) |
| 3 | fillers mispronounced | **his ear only** — page section `fl`. Machine agrees it is broken. |
| 4 | "נוח" mispronounced | **his ear only** — page section `nx` |
| 5 | "לוודא" not always right | **machine-proven broken**, two candidate fixes, his ear picks (`vd`) |
| 6 | flow and pausing | **investigated and measured**; prompt rule shipped; greeting is his call (`ps`) |
| 7 | "נעים מאוד" mid-call | **fixed in code + prompt** |

---

## 2 — she answered half a phone number with a whole sentence (FIXED)

```
169.5s  lead   050-
172.5s  KEREN  טוב, הבנתי.
172.6s  lead   9788845.
175.0s  KEREN  הבנתי אותךָ.
```

Both offending phrases were added *yesterday* and flagged then as unheard on a phone line. He has
now heard them, and the defect is not the words — it is the ACT. A receipt is a complete
conversational move: it closes the caller's turn and takes the floor. Mid-number that is an
interruption. A nod ("אה אה") says *still listening* and hands the floor back.

`dictation.ts` + a third branch in `chooseTurnOpener`. **A classifier over the caller's utterance,
not a state machine** — arm-on-ask/disarm-on-readback is the design that gets STUCK when the
read-back never happens, and a call spent nodding at everything would be a worse bug than the one
being fixed. Signals: four digits running, two digit groups with a breath between, a three-digit
group left hanging ("050-"), the spoken furniture of an email (שטרודל / ג'ימייל / נקודה קום), or
letters being spelled. Never a question, however many digits it carries.

Deliberately not `\d{3,}`: this same caller said "בערך 500 שקל" and "פעיל 24/7". A missed nod costs
one ordinary receipt; a nod at a man discussing his budget costs the appearance of listening.

The nod does not draw from the acknowledgement deck and does not spend the filler budget — it is a
third act, not a cheaper version of either.

⚠️ **The nod's spelling is provisional and needs his pick.** `DICTATION_NOD = 'אה אה.'` is Koren's
own spelling, unscreened. The round-trip already proves the choice matters: `אהה.` spoken alone came
back from Soniox as **"יאללה."**. Page card `nd1` has five spellings. One constant to change.

Switch: `VOICE_DICTATION_NOD_ENABLED` (default true). Off = the receipt mid-number, exactly.

## 7 — she introduced herself twice (FIXED)

```
153.7s  KEREN  רק לוודֵא — קורן, נכון? ומה שם המשפחה שלךָ?
156.5s  lead   שטרית.
163.8s  KEREN  אהה. נעים מאוד. רק לוודֵא — קורן שטרית, נכון?
```

It fires on a captured NAME FACT rather than on an introduction happening — the same class of defect
as asking his name three times, and it lives in the same state. `FactMemory` already knows what has
happened on this call; it now also knows whether she has greeted him, and `speech-guard.ts` removes a
second greeting from her speech.

Narrow by construction: only a greeting that STANDS as one is removed (followed by end of sentence, a
comma or a dash), so "נעים מאוד לשמוע" is untouched. The lead's established name goes with it, because
"נעים מאוד, קורן." must not become "קורן."; anything else after the comma is his real words and stays.
A sentence left with only the greeting becomes silence, not an empty utterance.

`guardStream` hands its per-reply flag to the CALLER rather than applying it itself, so the
kill-switch owns the whole behaviour — with it off, nothing is ever removed, repeats included.

Switch: `VOICE_INTRO_ONCE_ENABLED` (default true).

**The two adjacent smells he flagged.** `רק לוודֵא` twice in eleven seconds is the prompt's own
script — both read-back examples opened the same way — so the second one now opens differently and
the section says to vary it. `איזה כיף!` was firing per its own rule (he had just agreed to a demo),
so the rule is what changed: the big joy is now reserved for a booking that actually LANDED, and
agreement in principle gets a beat that matches its size.

## 6 — flow and pausing: MEASURED, and the tempting conclusion is wrong

His note: *"השימוש בפסיקים ונקודות כדי לעצור באמצע משפט לא עובד כמו שצריך, הזרימה של הדיבור לא מספיק
טובה במיוחד בתחילת השיחה."*

sonic-3.5 does **not** ignore Hebrew punctuation. It realises a **comma** so weakly that the
streaming path can lose it altogether. `pause_probe.py` on the real greeting (10ms RMS frames,
silence at 4% of the clip's own peak, gaps ≥90ms):

| greeting variant | one-shot `/tts/bytes` | the agent's own websocket stream |
|---|---|---|
| `שלום,` — today | 180ms | 180ms |
| `שלום —` | 270ms | **470ms** |
| `שלום.` split | 210ms | **260ms** |
| `שלום...` | 330ms | **560ms** |
| `שלום <break time="0.35s"/>` | 650ms | **780ms** |

And on the long comma-chained value line the streaming path **dropped three of its five pauses**
(the 90ms and 140ms ones vanished), while the same sentence split into real sentences kept five of
seven. That is his complaint, measured.

**What controls pacing, read out of the shipped plugin rather than guessed:**
`max_buffer_delay_ms: 0` is hardcoded in `@livekit/agents-plugin-cartesia` (`dist/tts.js:567`), and
the plugin re-splits our text with LiveKit's `basic.SentenceTokenizer` (minimum 8 **characters**,
terminators `.!?` only — `…` is not one). Neither is reachable from our side without forking. So the
lever is the TEXT, and the prompt now states the numbers so the model stops leaning on the mark that
does nothing.

**A find worth his attention: `<break time="0.35s"/>` appears to be honoured and is NOT read aloud.**
The Soniox round-trip of that clip comes back as clean Hebrew with no stray token, in both paths,
while producing the longest pause measured. Undocumented by Cartesia. **Recorded, not shipped** —
a tag that is silently ignored would be READ OUT to a caller, which is the worst failure mode
available, and no ear has heard it yet. Page card `ps1_E`, known-issues §16.

**The greeting itself is not changed.** It is persona data — his own tuned Hebrew, pinned
byte-for-byte — and its pacing is his call, the same precedent as the FAQ line in yesterday's
handoff. The four candidates are on the page with their measured pauses.

## 1, 3, 4, 5 — pronunciation: what the machine could settle, and what it could not

Every clip went through the phone band and back with Soniox (`roundtrip6.ts`, 41 pass / 2 fail /
16 unscored).

**5 · לוודא — machine-proven broken, and the shipped fix does not save it.**

```
sent  רק לוודא — קורן שטרית, נכון?      heard  רק לוועדה, קורן שטרית, נכון?   FAIL
sent  רק לוודֵא — קורן שטרית, נכון?     heard  רק לוועדה, קורן שטרית, נכון?   FAIL   <- what ships today
sent  רק לְוַודֵא — קורן שטרית, נכון?    heard  רק לוודא: קורן שטרית, נכון?    PASS
sent  רק לוודה — קורן שטרית, נכון?      heard  רק לוודא: קורן שטרית, נכון?    PASS
```

"לוועדה" is a different word (*to the committee*). The round-3 winner holds in the other carrier
("אני רוצה לוודא ש…", all three pass) and fails in this one — which is exactly the "לא תמיד נכון" he
reported, now localized. Two candidates fix it; **his ear picks which**, card `vd1`.

**3 · the fillers — machine agrees they are broken.** `אהה.` in her real carrier came back as
**"1."**; alone it came back as **"יאללה."**. `אה-הא` came back as "היי היי". The kamatz spelling
`אָהָה` came back correctly as "אהה", and `אֶה...` as "אה...". Suggestive, not decisive — Soniox owes
us nothing on a non-lexical sound, so these are printed and not scored. Cards `fl1`–`fl5`, `nd1`.

**4 · נוח — one suggestive signal.** In the second carrier the plain form came back as **"נח"** while
the pointed `נוֹחַ` came back as **"נוח"** — consistent with the furtive patach being dropped, which is
the suspected defect. Card `nx`.

**1 · רוצה — the round-trip is structurally blind and says so.** Masculine and feminine are the same
letters and Soniox writes back unpointed Hebrew, so both genders return "רוצה" and a PASS proves only
that the mark did not corrupt the word. The page therefore asks a **forced gender choice** for these
cards rather than ok/bad.

⚠️ **The masculine mark that ships today was never screened.** `רוצֶה` was added on 2026-08-26 *by
analogy* with `שלךָ` — no listening page, no verdict. Card `g1` is its first test, against plain,
holam+segol and tsere.

**The sweep he asked for** is section `sw`: the defect class is **ל"ה present-tense verbs**, where
masculine `־ֶה` and feminine `־ָה` sit on identical consonants — מחכה, רואה, עושה, עונה, מנסה, מקווה,
נראה. All seven are in her actual vocabulary and three of them appear in these two transcripts. Plain
text, exactly what she sends today, so the page says which ones are ALREADY wrong. **Nothing was
added to `speech-guard.ts` for any of them** — the round-3 method is that a word gets a mark when an
ear says it needs one, never on theory.

---

## Kill-switches added

| Switch | Default | Off = |
|---|---|---|
| `VOICE_DICTATION_NOD_ENABLED` | `true` | a full receipt in the middle of a phone number, exactly as on 2026-08-30 |
| `VOICE_INTRO_ONCE_ENABLED` | `true` | the second "נעים מאוד" survives, repeats within one reply included |

Both in `.env.example`. No new `tenants.settings` key, no schema change, no migration.

## Golden fixtures — regenerated deliberately, once, with the reason

`prompts/__fixtures__/prompt-default-{notools,tools,tools-noobjection}.txt` via
`scripts/regen-prompt-fixtures.mts`. The provenance note in `system-prompt.persona.test.ts` records
all four changes and answers "which live call did I just change": the 2026-08-30 04:56 and 05:03
production calls. `greeting-default.txt` is **byte-identical**; every persona-owned section was
verified unchanged; each new byte is independently pinned by a new test in `system-prompt.test.ts`.

## What ONLY his ear can settle

1. **The whole of round 6** — the four pronunciation/prosody notes, in one page. This is the
   blocking item; nothing for 1, 3, 4 or 5 ships until the summary comes back.
2. **The nod's spelling** (`nd1`) — it is live in code today with an unscreened word.
3. **Whether `<break time="…"/>` sounds like a pause or like a dropout** (`ps1_E`). If it sounds
   right it is the largest pacing lever available, and it is undocumented, so it needs a live call
   before it goes anywhere near production.
4. **The greeting's punctuation** (`ps1`) — persona data, his decision, four measured candidates.
5. **On the next live call:** does she still greet him twice; does she nod instead of interrupting a
   dictated number; grep the log for `turn_opener` (`kind: "nod"`) and for
   `speech_guard … removed a repeat greeting`. Plus latency as usual — nothing here adds a stage to
   the speech path: the nod rides the existing instant-ack injection and the greeting removal runs
   inside the guard that already runs per sentence.

## What I decided against, and why

- **Shipping a fix for לוודא, נוח or רוצה on the round-trip alone.** The round-trip is a necessary
  gate, never a sufficient one — that rule is what kept the שלכה respelling honest through three
  rounds, and the case where the machine is blind (רוצה) is exactly the case where it would be most
  tempting to skip the ear.
- **Adding the ל"ה sweep words to `speech-guard.ts` pre-emptively.** They are the right class by
  construction, which is not the same as being wrong today. Round 3's `ps` sweep exists precisely so
  a mark is only added to a word an ear has failed.
- **Changing the greeting's punctuation.** Persona data, and its pacing is a product decision. The
  measurement is provided instead.
- **Turning on `<break>`.** See above — the failure mode of an ignored tag is that a caller hears it
  read out.
- **An arm/disarm state machine for the dictation nod.** It gets stuck, silently, in exactly the
  cases where a call has already gone wrong.
- **Suppressing the acknowledgement entirely mid-dictation.** Silence there reads as a dropped line;
  he asked for a sound, not for nothing.

## Questions for the architect

- The two candidate fixes for `לוודא` (`לְוַודֵא`, `לוודה`) are both three-mark or respelled forms,
  which is a step beyond the "one mark on one letter" rule known-issues §13 records as the winner.
  If Koren picks one, is that a per-word exception (as `אלַיִךְ` already is) or does the rule need
  restating?
- `<break time="…"/>` — if it survives his ear and a live call, it changes how the pausing rule
  should be written. Worth scheduling as its own round?

## Still blocked, unchanged — neither is voice's to fix

- **Migration 0017 is unapplied.**
- **`tenants.settings.handoff` is null** for ClickScales, so the owner alert reaches nobody.
