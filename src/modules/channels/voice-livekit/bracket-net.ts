/**
 * THE SQUARE-BRACKET NET — round 24 made it a pre-flip requirement, not a nicety.
 *
 * A square-bracketed ASCII token in her speech has no legitimate meaning on ANY engine, and both
 * engines were measured (2026-09-02, probe21/probe24 + Soniox round-trips) doing something a
 * caller must never hear when one slips through:
 *
 *   Cartesia sonic-3.5/3.6:  `[laughter]` RENDERS a real laugh ("חח") — the one non-verbal the
 *                            model trained, and the one Koren banned in round 4b. Every other
 *                            bracket token is silently swallowed (lucky, not safe).
 *   DeepDub dd-etts-3.2:     `[breath]` is READ ALOUD as "ברף", `[breathes]` as "ברית" — the
 *                            engine SPEAKS markup it does not understand, and it understands none.
 *
 * So the failure is not hypothetical on either side of the flip: a stray bracket token from the
 * LLM either laughs at a lead or spells gibberish at him. `voice-mode.ts`'s `ANY_TAG` net covers
 * only ANGLE brackets (deliberately — `<break>` needed validating, and Hebrew text carries `<`
 * comparisons); until this file, a square token had NO net at all.
 *
 * THREE CONDITIONS this net was built under (agreed with the other voice sessions, 2026-09-02):
 *   1. It must not break the engine actually running: it touches ONLY `[...]` tokens, so
 *      Cartesia's working `<break time="…"/>` feature (voice-mode.ts, rounds 16-18) never meets
 *      this code. There is no provider gate because none is needed — a square token is
 *      unsanctioned on every provider.
 *   2. It is counted (`bracketTagsDropped` in the call report, beside `pauseTagsDropped`), and
 *      the number MUST read zero — non-zero means the model started emitting brackets and only
 *      the last net stopped them.
 *   3. It never touches PRONUNCIATION_FIXES or the pointed interjections — those carry niqqud,
 *      not brackets, and this pattern cannot see them.
 *
 * ASCII-LETTER START, like ANY_TAG and for the same reason: it is what stops the net eating
 * Hebrew — a genuine bracketed aside in Hebrew (`[שם העסק]` in a template that leaked, or a
 * price range) keeps its brackets and its sentence. Wrong-channel Hebrew has its own guards.
 * Bounded length and no newline for the same reason as ANY_TAG's bounds: a runaway match must
 * not swallow a sentence.
 */

/**
 * Any square-bracketed ASCII-lettered token: `[breath]`, `[laughter]`, `[clears throat]`.
 *
 * THE CLOSING `]` IS OPTIONAL — the same lesson ANY_TAG's test caught for the angle net: a
 * truncated `[breath` cut off by a stream boundary has no closing bracket, and a pattern that
 * demanded one would leave the single most dangerous variant on the wire. What an engine cannot
 * parse, it speaks.
 */
const SQUARE_TAG = /\[[A-Za-z][^\[\]\n]{0,30}\]?/gu;

/**
 * Delete every square-bracket token from one sentence.
 *
 * Unconditional by design, exactly like `normalisePauses`' net half: there is no mode in which
 * the model is ASKED to write `[anything]`, so a match is always the model doing something nobody
 * sanctioned. No engine renders these usefully (measured, both), and one of them speaks them.
 */
export function normaliseBrackets(text: string): { text: string; dropped: number } {
  if (!text.includes('[')) return { text, dropped: 0 };

  let dropped = 0;
  const out = text.replace(SQUARE_TAG, () => {
    dropped += 1;
    return '';
  });
  if (dropped === 0) return { text, dropped: 0 };
  return { text: out.replace(/[ \t]{2,}/gu, ' ').trim(), dropped };
}
