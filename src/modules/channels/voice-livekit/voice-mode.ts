/**
 * SHE SOUNDS THE SAME AT MINUTE SIX AS SHE DID AT SECOND FOUR.
 *
 * Koren, 2026-09-02: *"אם הסוכן הוא קצת יותר בטוח במה שהוא אומר אז המקצב שלו יהיה יותר אחיד ויותר
 * קצבי, לעומת זאת אם הוא מהסס או חושב על משהו שהוא נשאל והוא צריך לבדוק, אז התשובה שלו תהיה קצת
 * יותר מהוססת."*
 *
 * ── THE RATE LEVER IS DEAD, AND IT WAS MY IDEA ────────────────────────────────────────────────
 *
 * The first version of this file shipped a speed multiplier: the hesitant register slowed Cartesia
 * from 0.90 to 0.78, a figure taken from a duration table (`phase-4-known-issues.md` §9) showing
 * +13.7%. Round 16 put it in front of Koren:
 *
 *   sp: -   *"נשמעים אותו דבר למעט אופציה D שאיטית מדי"* — 0.90 / 0.84 / 0.78 are
 *           indistinguishable to him. Only 0.72 was audible, and it was wrong.
 *   tr: A   Asked directly whether a rate change BETWEEN turns sounds like a person slowing down,
 *           he chose the clip with no rate change at all.
 *
 * The table was correct and it measured the wrong thing. There is no speed handling in this file
 * any more, and `VOICE_HESITANT_SPEED_FACTOR` is gone rather than set to 1: a knob that does
 * nothing is worse than an absent one, because the next person will tune it.
 *
 * ── WHAT WON: THE PAUSE, AND THREE DIFFERENT LENGTHS OF IT ────────────────────────────────────
 *
 * `<break time="…"/>` is honoured on Hebrew sonic-3.5, is NOT read aloud (round-16 and round-17
 * round-trips: the tag variants come back word for word identical to the punctuation ones), and
 * its duration scales with the request. It had been sitting unshipped in known-issues §16 for a
 * month for want of an ear.
 *
 * His verdicts, and each one is a different card:
 *
 *   bk: B   0.25s — before the answer, on a turn where she is genuinely checking something.
 *           *"רגע <break time="0.25s"/> אני בודקת את היומן."*
 *   ah: E   0.15s — after a filler, MID-sentence, on a question that deserves thought.
 *           *"אז, אֶה <break time="0.15s"/> זה תלוי בכמה שיחות…"*
 *   eb: B   0.35s — after the acknowledgement, before the thing that costs him.
 *           *"אני מבינה <break time="0.35s"/> זה באמת מתסכל."*
 *
 * Three lengths, three positions, each won its own card against the alternatives. The right pause
 * is not one number — it depends on where it sits. Nothing else is permitted, because nothing else
 * has been heard.
 *
 * ── NO MARKERS ANY MORE ───────────────────────────────────────────────────────────────────────
 *
 * The first version had the model declare its register with `[[H]]` / `[[E]]`, stripped before
 * synthesis. That existed to carry a mode across to the rate, and the rate is gone. Now the model
 * declares by WRITING THE PAUSE, which is the same act as producing it — so the marker, the
 * two-stage stripper and the whole `modeMarkerLeaks` risk class disappear with it. The thing that
 * could have been read out to a lead no longer exists.
 *
 * What is left to guard is the tag itself: a MALFORMED tag is the one that gets spoken, so this
 * file validates against a whitelist and deletes anything else.
 */

/**
 * THE PAUSE IS CARTESIA'S SSML, AND ONLY CARTESIA'S.
 *
 * `<break time="…"/>` was verified on Hebrew `sonic-3.5` and nowhere else. The whole doctrine of
 * this file is that a tag the engine does not parse is a tag the engine SPEAKS — that is why an
 * unapproved DURATION is deleted rather than passed on. An engine that does not recognise the tag
 * at all is the same failure with a wider mouth: the caller hears "break time zero point two five
 * s" in the middle of a Hebrew sentence.
 *
 * DeepDub is a fully built alternative behind `VOICE_TTS_PROVIDER` and, as of 2026-09-02, won all
 * five cards of a listening round against Cartesia at production knobs — so a provider flip is a
 * live prospect rather than a hypothetical, and this feature must fail closed when it happens
 * instead of being remembered. Nothing here has been heard on DeepDub. If it ever is, this
 * function is where the verdict lands.
 */
export function pausesSupported(ttsProvider: string): boolean {
  return ttsProvider === 'cartesia';
}

/** The three pause lengths Koren's ear chose, and nothing else. Seconds, as Cartesia writes them. */
export const PAUSE_SECONDS = ['0.15', '0.25', '0.35'] as const;
export type PauseSeconds = (typeof PAUSE_SECONDS)[number];

/** The canonical tag for one of the approved lengths. */
export function pauseTag(seconds: PauseSeconds): string {
  return `<break time="${seconds}s"/>`;
}

/**
 * A well-formed tag carrying an APPROVED duration.
 *
 * Deliberately strict about the duration and deliberately loose about the whitespace: the model
 * writes `<break time="0.25s" />` as readily as `<break time="0.25s"/>`, and both are the same
 * instruction to Cartesia. A duration we have never heard is not a smaller mistake than a typo —
 * `phase-4-known-issues.md` §16 recorded the tag as unverified for a month precisely because a
 * silently-ignored tag would be READ ALOUD, and the only lengths anyone has listened to are these
 * three.
 */
const APPROVED_SECONDS = /^<break\s+time="(0\.15|0\.25|0\.35)s"\s*\/?>$/iu;

/**
 * ANY angle-bracketed token at all — the net.
 *
 * Wider than the tag it protects, on the same principle the old marker net used: a bracketed token
 * in her speech has no legitimate meaning, and a bracketed token at a caller does. `<break
 * time="1.5s"/>`, `<pause>`, `<emotion value="calm"/>` and a half-written `<break time=` all go.
 *
 * THE CLOSING `>` IS OPTIONAL, and that is the case that matters most. A truncated `<break time=`
 * has no closing bracket, so a pattern that demanded one would leave the single most dangerous
 * variant on the wire: Cartesia cannot honour what it cannot parse, and what it cannot parse it
 * speaks. The first version of this pattern required the `>` and a test caught it.
 *
 * It must START with an ASCII letter, and that is what stops it eating Hebrew — `פחות מ<אלף שקלים`
 * keeps its bracket and its sentence. Bounded length and no newline for the same reason.
 */
const ANY_TAG = /<[A-Za-z][^<>\n]{0,40}>?/gu;

/**
 * Normalise the pauses in one sentence.
 *
 * Returns the text Cartesia should receive, how many approved pauses it carries, and whether
 * anything had to be deleted. `dropped` must read zero on a call: it does not mean a caller heard
 * a tag — the net runs inside the guard, upstream of synthesis — but it means the model wrote
 * something we have never listened to, which is one guard away from audible.
 *
 * `enabled: false` deletes every tag, including the approved ones. That is what makes the kill
 * switch total: with the feature off she is not asked for pauses, so a tag is the model doing
 * something nobody sanctioned and it does not reach the voice.
 */
export function normalisePauses(
  text: string,
  opts: { enabled: boolean } = { enabled: true },
): { text: string; pauses: number; dropped: number } {
  if (!text.includes('<')) return { text, pauses: 0, dropped: 0 };

  let pauses = 0;
  let dropped = 0;

  // ONE PASS over every angle-bracketed token, deciding each one on the spot. The earlier version
  // ran the approved pattern first and the net second, which meant an approved tag had to survive
  // being taken apart and put back together — three regexes where one decision will do.
  const out = text.replace(ANY_TAG, (token) => {
    const approved = opts.enabled ? APPROVED_SECONDS.exec(token) : null;
    APPROVED_SECONDS.lastIndex = 0;
    if (approved) {
      pauses += 1;
      // Canonical spelling, not the model's: its spacing varies, and one shape in the audio path
      // is one shape to reason about.
      return pauseTag(approved[1] as PauseSeconds);
    }
    dropped += 1;
    return '';
  });

  return {
    text: out.replace(/[ \t]{2,}/gu, ' ').trim(),
    pauses,
    dropped,
  };
}

/**
 * Does this sentence carry a pause we approved?
 *
 * Read by the call report so `pauseTurns` can be compared against the transcript: the pause is
 * supposed to land on a turn where thinking is plausible, and the only way to know whether it did
 * is to see which turns had one.
 */
export function hasPause(text: string): boolean {
  return PAUSE_SECONDS.some((s) => text.includes(pauseTag(s)));
}
