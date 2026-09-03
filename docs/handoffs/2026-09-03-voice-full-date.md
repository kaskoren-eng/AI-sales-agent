# VOICE — B10: she says the full DATE when offering slots

Branch `feature/voice-full-date`, off `origin/main` @ `48b7f9c`. Not merged, not deployed.

Koren's ask: *"כשהיא מציעה שעות או קובעת — שתגיד את התאריך המלא, לא רק את היום בשבוע."*

## The defect, as found

The brief's diagnosis was right and I verified every claim in it:

- `formatDayHe` (`tools/israel-time.ts:148`) already produces `"מחר, יום חמישי, 30 ביולי"`.
- `groupAvailability` already puts that in each day's `dayLabel`.
- `check-calendar-availability.tool.ts` already heads each day with it.
- The booking **confirmation** already speaks it, via `formatSlotHe`, and so does the
  slot-taken fallback in `book-meeting.tool.ts:153`.

So no data was missing. What was wrong is that the two places that model the OFFER out loud
both modelled a sentence containing an hour range and nothing else. The model imitates the
example, so the date the tool handed it died between the tool result and her mouth.

## What changed — two files, one sentence each

**1. `prompts/system-prompt.he.ts` — Step 4 booking mechanics, rule 3.** The rule now says to
open with the day exactly as the tool labelled it, and its worked example is
`"מחר, יום חמישי, 30 ביולי, יש לי פנוי מעשר עד שלוש, איזו שעה מתאימה לכה?"`. Everything else
about the rule is intact: range not list, both windows named when the day is split, a
fully-booked day sends her to ask for another day.

**2. `tools/check-calendar-availability.tool.ts` — the tool result's guidance. THIS IS NOT IN
THE BRIEF, and it is the more important half.** The result string carried its own worked
example with the same defect, and it is the copy closest to the model at the moment it
speaks — the system prompt is thousands of tokens back, this arrives in the turn. Fixing only
the prompt would have left the short example winning on recency. Same correction, same words.

**No new Hebrew was written.** The added text is `formatDayHe`'s exact output, which is the
string she already speaks in the booking confirmation, reaching one more place. That is what
makes this safe to ship without a listening round — and the tests pin it to the function's
output rather than to a hand-typed literal, so the two cannot drift apart.

Fixtures regenerated with `npx tsx scripts/regen-prompt-fixtures.mts` (the repo's mechanism —
not hand-edited). `diff`: line 459 of `prompt-default-tools.txt` and
`prompt-default-tools-noobjection.txt`, nothing else. `prompt-default-notools.txt` and
`greeting-default.txt` are byte-identical — the no-tools variant has no calendar and models no
offer. The provenance note at the top of `system-prompt.persona.test.ts` was updated in the
same commit, per the house rule.

## What the tests prove — and what they do NOT

Two new assertions, plus the four golden fixtures.

**They prove:** the instruction and the corrected example are present in the assembled tools
prompt and in the live tool-result string; the example day label is byte-identical to
`formatDayHe`'s own output for a pinned instant (so a change to the formatter fails this test
rather than silently desynchronising the prompt from the tool); the label sits immediately in
front of the range rather than merely somewhere in the file; and no other byte of the default
prompt moved.

**They do NOT prove that gpt-5.4 will say the date on turn thirty of a real call.** A prompt
assertion is a string-presence check. It is exactly the class of instrument the supervisor
warned about — it tells you the text exists and nothing about imitation. **The only gate that
can close this is a live PSTN call where she offers slots.** Two things to listen for:

1. Does she say the label at all, or does she compress it back to "מחר" / "יום חמישי"?
2. **How does the TTS voice the day-of-month digit?** See below.

**Mutation check, as instructed:** I stashed the two source edits and the fixtures, kept the
tests, and re-ran. Both new assertions failed (`toContain(label)` and
`/opening with the DAY HEADING below exactly as written/`). The fixture tests passed under the
mutation, correctly — I had stashed source and fixtures as a consistent pair. They fail if
either moves alone, which is their actual job.

## Where I think the brief is wrong — the `speech-numbers` gender question

The brief says to leave `speech-numbers.he.ts` alone. **Agreed, and I did not touch it.** But
the stated reason is factually wrong, and Koren should have the correct version:

> *"it has no date logic and defaults a bare integer to the feminine, so `3 בספטמבר` may be
> spoken שלוש where שלושה is correct"*

It **does** have date logic, and it is explicit. `speech-numbers.he.ts` line 97:

```ts
/** Month names — "ב-3 באוקטובר" is a DATE (masculine ordinal territory), not a count. Skip it. */
const MONTHS = /^ב?(?:ינואר|פברואר|...|דצמבר)$/u;
...
if (MONTHS.test(bare)) return m; // "ב-3 באוקטובר" is a date — untouched beats wrong.
```

I ran the normalizer over real strings to confirm rather than reading it off:

```
'היום, יום ראשון, 3 בספטמבר'  ->  'היום, יום ראשון, 3 בספטמבר'     (unchanged)
'1/2/3/10 בספטמבר'            ->  unchanged
'21 ביולי' / '30 ביולי'        ->  unchanged
'הפגישה נקבעה למחר, יום שלישי, 21 ביולי, בשעה 11:00'
                              ->  '... 21 ביולי, בשעה אחת עשרה'     (only the TIME converts)
```

So `normalizeSpokenNumbers` never converts a day-of-month to a Hebrew word — not to the
feminine, not to anything. There is no wrong-gender word being produced.

**The real residual risk is a different one, and it is worth Koren's ear:** the digit reaches
the TTS raw, and DeepDub decides how to voice `"30 ביולי"`. That is unscreened. It is
**already true today** in the confirmation path — this change does not create it, it exposes it
to one more moment in the call. Also note days 20–31 fall outside `SMALL_INT_RE`'s 1–19 range
entirely, so they could never have been converted regardless.

**Recommendation:** keep it as a separate board item, and settle it by ear on a listening page
(`formatDayHe` output through DeepDub for a 1–9 day, a 10–19 day and a 20–31 day) rather than
by changing number gender, which would move spoken output in places nobody has screened.

## Also considered and deliberately NOT changed

`system-prompt.he.ts:345`, the slang-placement rule, models `"יש לי אחת עשרה פנויה. מתאים לך?"`
— a slot named out loud with no date. I left it. Its entire job is to contrast two sentence
shapes for interjection placement, and padding the example with a date weakens the contrast it
exists to draw. The booking mechanics section is authoritative for how an offer is phrased.
Flagging it so the decision is visible rather than missed.

The no-tools booking step (`buildStep4NoTools`) models no time-offer sentence at all — there is
no calendar connected in that variant — so there was nothing to fix there.

## Gates

`npm run typecheck` · `npm run test:ci` · `npm run build` ·
`bash scripts/ci/territory-check.sh feature/voice-full-date origin/main` — all exit 0, judged by
exit code.

## Next steps

- **ME (implementation):** done; branch pushed.
- **VOICE:** one live PSTN call through the booking flow, listening for the two things above.
- **KOREN:** (1) the ear call above; (2) decide whether the day-of-month digit through DeepDub
  needs its own listening round — it is a pre-existing condition, not new here.
