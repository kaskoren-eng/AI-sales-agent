# 2026-08-31 — VOICE: the email prompt, and the permission to stop asking for it

Branch: `feature/voice-email-prompt`, branched from `main` @ `9d380e5`. **Not merged, not deployed.**

Applies §5 of `docs/handoffs/2026-08-31-voice-stall-and-email.md` — five Hebrew wordings written by
the session that fixed the email-capture CODE path and was fenced out of `system-prompt.he.ts` while
`feature/voice-persona-notes` held it. That branch has since merged (`2dcb23d`), so each of the five
was re-judged against what it landed (`## No Preamble`, the earned acknowledgement, the
MANDATORY/OPTIONAL split, and the deletion of every `רק לוודא` preamble) before being applied.

**Gate.** `npm run typecheck` exit 0 · `npm run test:ci` **exit 0** (113 files, 1467 passed, 6 todo;
judged by exit code) · `npm run build` exit 0 ·
`bash scripts/ci/territory-check.sh feature/voice-email-prompt` OK.

## 👉 THE PAGE FOR KOREN

```
tests\hebrew-tts-niqqud-ab\index-round8.html
```

15 clips, six sections, sonic-3.5 at the production speed/volume (0.9 / 1.4). Every card is a moment
of the 31.8 call twice: **A is what you actually heard, B is what she says now.** New in this round:
under each clip is **what Soniox got back off that exact audio after an 8kHz round trip**, so you can
see where the machine and your ear disagree. Listen, mark, press "צור סיכום", paste it back.

Card **e2** is the one that matters and card **e6** is the one that argues against me — read both.

---

## Per point: applied, already covered, or changed and why

### §5.1 — ask for the part before the @ alone, as one word · APPLIED

Not covered by anything on `main`. Step 4 said only `3. Email — "ומה כתובת המייל?" Then read it
back.`, i.e. the whole address in one breath. Now a `### The email address` subsection asks for the
local part on its own — *"תגיד לי את החלק שלפני השטרודל, כמילה אחת."* — with the domain as a
separate question, asked only if he has not already said it.

Detail 3 in the outer list changed from "Then read it back." to "This one has its own method; it is
below." **That instruction was itself part of the defect**: "read it back" is exactly what she did,
in Latin letters.

### §5.2 — Hebrew word-first read-back · APPLIED, one word changed

Applied close to verbatim. §5 proposed *"אז לפני השטרודל זה קאסקורן…"*; the shipped line drops the
leading `אז` — `## No Preamble` says the detail itself is the sentence, and the local run in the
other session's handoff produced the `אז`-less form. The letter-by-letter fallback is Hebrew letter
names (קיי, איי, אס), and only after he says the word is wrong.

**Partly duplicated on purpose.** `EmailDictation.note()` already ends with a Hebrew-word-first
instruction, but only while it is collecting and only with `VOICE_EMAIL_DICTATION_ENABLED` on. That
handoff called it "an interim measure" and asked for the durable wording here. The prompt is the
half that is always present.

### §5.3 — letters across turns are ONE address · APPLIED (prompt half only)

The stitching itself is `email-dictation.ts` on `main` and I did not touch it. What the code cannot
do is stop her *saying* the pieces as alternatives, so the prompt now bans the competing-options
line by name — `"שמעתי גם ... וגם ..."`, verbatim from the call.

### §5.4 — a rejected value never comes back · APPLIED, trimmed to what only a prompt can do

Half of this is already enforced in code: `FactMemory.reject()` + `guardIdentity` make it
unsaveable, and `capture_lead_info` returns a distinct `NOT SAVED:`. **Neither stops her speaking
it.** So the prompt carries the speech half — never said again — plus the inference §5 makes that
the code cannot: *the correct address DIFFERS from it, so a reading that comes out the same is a
reading you have got wrong.*

### §5.5 — abandon the field, keep the meeting · APPLIED, and it needed a CODE change

**§5's wording alone would not have worked.** `book_meeting`'s schema required
`email: z.string().min(5)` and `normalizeEmail` had to parse it. Telling her to "take what you have
and close the booking" would have produced a `ToolError` — whose text was
*"Ask the lead to spell it again, read it back, then retry"*, i.e. the tool would have rebuilt the
exact retry loop that ended the call. So:

- `email` is now `.nullable().optional()`. A deliberate `null` books the meeting with **no
  attendee**, via the provider path that already existed for the service-account 403. The lead is
  saved against his phone; `inviteSent` is forced false; reminders already skipped the email channel
  when the address was null, so that needed nothing.
- **An email that is present but unparseable still fails** — a confident wrong guess is the original
  defect. But the error now names the exit: *"if you have ALREADY read an address back to him twice
  without getting it right … call book_meeting again with email set to null."*
- `send_email_confirmation` refuses on a null-email booking and tells her not to claim one.
- `provider.interface.ts` `attendee.email` relaxed to optional; Google and Trafft updated. Every
  existing caller passes one and is unaffected.
- **Kill-switch `VOICE_BOOK_WITHOUT_EMAIL`, default `true`.** It gates the tool AND rule 5 of the
  prompt together, so the two can never disagree. Off restores the old hard requirement exactly.

⚠️ **This is one of the few voice flags whose default is NOT "what we did yesterday"** — yesterday's
behaviour is the defect. Flagging it because the module convention is the opposite.

### §5.5, the WhatsApp promise · DELIBERATELY NOT APPLIED

§5 says: *"אמרי שתשלחי אישור בוואטסאפ לנייד"*. **The system cannot keep that promise today**, so it
is not in the text. Traced through `whatsapp-window.ts` and `outbound-sender.worker.ts`:

- A lead who has only ever PHONED us has no open 24h window — `lastInboundWhatsappAt` is stamped
  only by the WhatsApp inbound webhooks, never by anything on the voice path.
- Out of window, the send needs a Twilio-capable provider **and** an approved
  `meeting_confirmation` template. Without either: `resolveWhatsappSendMode` → `blocked`, the worker
  logs `whatsapp_send_blocked`, **drops the job, and returns success**.
- `PROJECT_STATUS.md:259`, `docs/phase-6-verification-checklist.md:67` and
  `docs/handoffs/2026-07-29-voice-livekit.md:37` all record the templates as still awaiting
  Twilio/Meta approval. I cannot read the live `tenants.settings` row, so this is docs-based, not
  code-proved — but nothing in the repo configures that slot for any tenant.
- Verbal consent is **not** the blocker: `grantWhatsappConsentVerbal` writes exactly the shape the
  worker reads, and `book_meeting` awaits it before returning.

Rule 5 therefore promises **the team** — *"הצוות יחזור אליך עם הפרטים"* — which is true, and
explicitly forbids naming a channel. A test asserts the word "וואטסאפ" does not appear in rule 5.

**Bonus fix, same root cause, wider blast radius:** `send_whatsapp_confirmation` returned *"You may
tell the lead a WhatsApp message is on its way"* on every booking, which has always been a false
promise for this tenant. It now pre-flights both preconditions (free — templates from the settings
already loaded at call start, provider from env) and, when they are not met, tells the model not to
promise the channel. **The job is still queued either way** — a lead whose window IS open still gets
the freeform message. Only the text the model reads changed.

### The rule 5 spoken line, checked against what the persona merge landed

`"יש לי את הנייד שלךָ וזה מספיק — הצוות יחזור אליך עם הפרטים"`. Two earlier drafts were thrown away
and a test pins all of it:

- My first draft opened `"סגור, ..."` — which contradicts the Spoken Register placement rule
  (`slangPlacement(instantAck)` forbids a first-word reaction under the production `VOICE_INSTANT_ACK`).
- My second used `"לא נורא"` — a bare unstressed `לא`, exactly the class "Say It So It Cannot Be
  Misheard" exists for, where losing the particle inverts the sentence.
- It also must not announce the booking (`"אני קובעת את הפגישה עכשיו"`) because `BOOKING_FILLER_HE`
  already says that when the tool runs — the note-4 doubling defect.

Nothing the persona merge landed was weakened. The empathy beat, the opening slang and the nine
register words are untouched; their own tests still pass.

## Fixture regeneration — the justification

`__fixtures__/prompt-default-{notools,tools,tools-noobjection}.txt` regenerated with
`npx tsx scripts/regen-prompt-fixtures.mts`. The full "which live call did I just change" is written
into the provenance note at the top of `system-prompt.persona.test.ts`, as the rule requires.

**Four deltas, all inside Step 4:** detail 3's "Then read it back." → a pointer to the new section;
the `### The email address` section (rules 1–4); rule 5; and the booking-mechanics step 5 sentence
naming the same exception. `greeting-default.txt` is **byte-identical** and was not regenerated;
every persona-owned section (Role, FAQ, gender rules) is untouched. 13 new tests in
`system-prompt.test.ts` pin every new byte independently, including that the section smuggles no
banned verification preamble back in.

## What I measured, and one result that argues against my own change

`python tests/hebrew-tts-niqqud-ab/round8.py` (15 clips) +
`npx tsx tests/hebrew-tts-niqqud-ab/roundtrip8.ts` (synth → 8kHz phone band → Soniox), run twice
with the same outcome:

| what | result |
|---|---|
| `שטרודל` — new vocabulary, on every email collection | **3/3 intact.** Safe. |
| `ג'ימייל נקודה קום` | **PASS**, returns `gmail.com` — the Hebrew spoken form is at no disadvantage to the English one |
| `קאסקורן` — the invented transliteration the method rests on | **0/3.** Alone → swallowed ("אז קורן"). End of sentence → "קס קורן", two words. After his real name → **vanished without trace.** |
| Hebrew letter names (the rule-2 fallback) | `קיי` came back as `הכי` and the first letter was lost. English letters kept every letter, with one invented `T`. |

**Read honestly:** Soniox is transcribing HER voice here, and in production nothing transcribes her
— it transcribes the lead. So this is evidence the words are acoustically weak through the band, not
proof a human cannot follow them, and a transcriber's language model penalises a nonsense word where
a man listening for his own name expects it. But it is the same silent-failure shape round 4b
documented ("אוו" swallowed whole), and I am not going to bury it: **on the machine's ear the Latin
letters survive better than the Hebrew word.** The case for the Hebrew word is that the letters never
failed at pronunciation — they failed at *verification*, twice, and cost two bookings. Card e2 is
where Koren's ear settles it, and the measurement is printed on the page next to the audio rather
than hidden in here.

## What is NOT verified

- **No PSTN call, and nothing is deployed.** I did not run `agent:deploy`; the secrets hazard stands.
- **A prompt change is invisible to every test in this repo.** The 13 new prompt tests prove the
  instruction is present and says what was asked. Whether gpt-5.4 obeys it on turn 30 — and in
  particular whether it will actually pass `email: null` and stop asking, rather than keep trying
  because trying feels more helpful — is not something any of them can see.
- **The null-email booking has never run end to end.** It is proven by unit tests against a fake
  provider only. No real Google Calendar event has been created without an attendee by this path,
  and I have not confirmed Google accepts the attendee-less insert on the ClickScales calendar
  (the code path exists for the 403 fallback, so it should — "should" is the operative word).
- **The Hebrew letter-name fallback is the most likely thing I got wrong** (measurement above). It is
  one string in `EMAIL_COLLECTION`, rule 2.
- **The WhatsApp template state is docs-based.** I could not read the live tenant settings. If the
  template HAS since been approved and configured, the pre-flight will detect it automatically and
  she will start offering WhatsApp again — no code change needed.
- **`send_whatsapp_confirmation`'s pre-flight cannot see the 24h window** (that needs a DB read
  mid-call, which is dead air). With no template configured it therefore tells her not to promise
  WhatsApp even to the rare lead whose window IS open. Conservative in the right direction.
- **I did not re-run the local synthetic call.** The other session's `email_spelling` scenario
  exercises the code half; this branch changes the prompt half and the tool schema, and a synthetic
  caller too fluent to hesitate is a weak instrument for "does she give up gracefully".

## Also changed, and why (small, but not silent)

- `tests/hebrew-tts-niqqud-ab/synth.py` and `roundtrip8.ts` now find the checkout's `.env` by
  walking UP from the repo root. **A git worktree has no `.env`** — it is gitignored, so it lives
  only in the main checkout — which made every round of this experiment unrunnable from a worktree,
  which is where voice sessions actually work. The alternative was copying secrets into the
  worktree; `.gitignore` covers `.env*`, but a copied secret is one `git add -f` from the history.
- `roundtrip8.ts` writes `round8-heard.json`; re-running `round8.py` folds the transcripts into the
  page with no resynth and no new spend.
- Scoring bug in the first cut of `round8.py`, recorded so nobody repeats it: `hear` applied to
  every variant of a card, so the A clips — the OLD lines, which are not supposed to contain the new
  word — were scored and "failed". Cards now carry an explicit `score` list of variant keys.

## Questions for architect / Koren

1. **Card e2 and card e6.** Is the Hebrew word read-back genuinely clearer to you than the spelled
   letters, given the machine says the opposite? If it is not, rules 1–2 should be rethought and the
   change is worth less than it looks — rule 5 stands on its own either way.
2. **Rule 2's fallback alphabet.** Hebrew letter names measured worse than English ones. Keep, or
   revert that clause to English letters?
3. **`VOICE_BOOK_WITHOUT_EMAIL` defaults to ON**, against the usual "default = yesterday's
   behaviour" convention, because yesterday's behaviour lost the booking. Confirm you want that.
4. **A booking with no email means no calendar invite and — today — no WhatsApp.** The only thing
   reaching that lead is a human at ClickScales looking at the booking. Is that acceptable as the
   fallback, or should the `meeting_confirmation` template approval move up the list?

## Next steps

- **KOREN:** open `tests\hebrew-tts-niqqud-ab\index-round8.html`, judge A vs B (e2 and e6 above all),
  press "צור סיכום", paste it back.
- **VOICE (next session):** a local `voice:dev` run against a scenario where the email genuinely
  cannot be transferred, to see whether she actually reaches for `email: null` or keeps asking. That
  is the one behaviour this branch claims and cannot yet demonstrate.
- **ME:** nothing blocking.
