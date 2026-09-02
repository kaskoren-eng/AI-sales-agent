/**
 * WRITTEN LAUGHTER IS NEVER A LAUGH. IT IS THE LETTERS, READ OUT.
 *
 * Koren asked on 2026-09-02 whether DeepDub can laugh. Four routes were probed (`probe26`):
 * `[laughter]` inert, emoji inert and — usefully — not spoken, and orthographic laughter the only
 * one that renders anything at all: `חחח` added +692ms of audio and `הא הא` +1195ms against a
 * 98ms baseline spread. So the instrument said "something happened", and only his ear could say
 * what. **His verdict was `letters`: she is reading them out, not laughing.**
 *
 * WHY THIS IS A GUARD AND NOT A PROMPT LINE. The prompt has forbidden it in as many words since
 * before this probe — *"You CANNOT laugh: written laughter (חח, חחח, חהחה) comes out as spelled
 * letters, never a laugh — do not write it, ever"* — with the reason attached. **She wrote it
 * anyway**, in production, on the 07:33 call of 2026-09-02: `חחח, אז הגעת למקום אחר.` One
 * occurrence in 676 agent turns, which is rare enough to have gone unnoticed and far too common
 * to leave to guidance. That is this repo's own rule about prompt and code, applied to a case
 * where the prompt half was already there and the code half was missing.
 *
 * ── THE PATTERN, AND THE HEBREW TRAP IT HAS TO AVOID ─────────────────────────────────────────
 *
 * `\b` never matches Hebrew — Hebrew letters are not `\w` — which has already produced one silent
 * defect in this module's history. So the boundaries here are LOOKAROUNDS on the Hebrew block,
 * and they are load-bearing rather than tidy: `פחח` (a tinsmith) contains `חח`, and a naive
 * pattern would leave a caller hearing "פ". Only a run of `ח` standing alone between non-Hebrew
 * neighbours is laughter.
 *
 * Deleted rather than rewritten. There is no spelling of a laugh that works — that is the whole
 * finding — so replacing it with another one would be inventing a fix nobody has heard. The
 * prompt already tells her what to do instead: say it in words ("זה ממש מצחיק!").
 */

/** A run of ח standing alone: `חח`, `חחח`, `חחחח`. Lookarounds keep `פחח` and friends intact. */
const HET_RUN = /(?<![֐-׿])חח+(?![֐-׿])/gu;

/** The spelled-out alternations: `חה חה`, `חהחה`, `הא הא`. Doubling is required — `הא` alone is a word. */
const SPELLED = /(?<![֐-׿])(?:חה\s*חה(?:\s*חה)*|הא\s+הא(?:\s+הא)*)(?![֐-׿])/gu;

/**
 * Strip written laughter from one sentence.
 *
 * Returns the text and how many runs were removed. `dropped` is expected to be zero on a call:
 * non-zero does not mean a caller heard letters — this runs upstream of synthesis — but it means
 * the model ignored an explicit prompt rule, which is worth seeing in a report.
 */
export function stripWrittenLaughter(text: string): { text: string; dropped: number } {
  if (!text.includes('ח') && !text.includes('הא')) return { text, dropped: 0 };

  let dropped = 0;
  const count = (): string => {
    dropped += 1;
    return '';
  };
  let out = text.replace(HET_RUN, count).replace(SPELLED, count);
  if (dropped === 0) return { text, dropped: 0 };

  // `חחח, אז הגעת למקום אחר.` leaves `, אז הגעת…` — a sentence opening on a comma is a worse
  // artefact than the one just removed, and the same is true of a doubled space mid-sentence.
  out = out
    .replace(/^[\s,.!?—-]+/u, '')
    .replace(/\s*,\s*,/gu, ',')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();

  return { text: out, dropped };
}
