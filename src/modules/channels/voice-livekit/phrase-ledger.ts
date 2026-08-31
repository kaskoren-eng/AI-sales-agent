/**
 * The phrase ledger — the ENFORCEMENT half of the anti-repetition work, shipped 2026-08-27.
 *
 * Koren, live calls: she answers similar questions with the SAME sentences, and it is what makes
 * her sound like a robot. The humanization plan (§4, 2026-08-02) measured up to 62 repeated
 * 4-grams in a single call and prescribed two halves: "natural variation" wrappers in the prompt
 * (shipped) and a code ledger that TRACKS what was already said and reminds the model per turn
 * (never shipped — until now). The MAX_FILLERS precedent is why the code half exists at all:
 * prompt instructions alone degrade under context load; the ledger is the enforcement, the
 * prompt is the guidance.
 *
 * WHAT IT DOES. Every committed agent utterance is folded into a 4-gram tally. When a 4-gram
 * crosses its second use, the ledger can produce a short reminder note listing the exact
 * phrasings to stop reusing. agent.ts injects that note at a TURN BOUNDARY only (the same safe
 * point as trimHistory — after her reply commits, when no preemptive draft is in flight), as a
 * tail-appended system item, so neither the prompt-cache prefix nor an in-flight draft is ever
 * invalidated. The note never rewrites her speech: repetition is an AUTHORING problem, fixed at
 * generation time — a regex paraphrase of Hebrew at TTS time would produce broken grammar.
 *
 * Tracked WORDS (the slang bank from SPOKEN_REGISTER) ride the same mechanism: the same slang
 * word every reply is the new "עם מי אני מדברת", so a tracked word crossing its second use joins
 * the note alongside the 4-grams.
 */

const NIQQUD = /[֑-ׇ]/gu;
const PUNCT = /[.,!?…׃:;()"'«»״׳-]+/gu;

/** Tokens for n-gram purposes: niqqud and punctuation are not part of a phrasing. */
export function ledgerTokens(text: string): string[] {
  return text
    .replace(NIQQUD, '')
    .replace(PUNCT, ' ')
    .split(/\s+/u)
    .filter(Boolean);
}

function fourGrams(tokens: string[]): string[] {
  const grams: string[] = [];
  for (let i = 0; i + 4 <= tokens.length; i++) grams.push(tokens.slice(i, i + 4).join(' '));
  return grams;
}

/**
 * The call-level metric: distinct 4-grams spoken 2+ times across the agent's lines. This is the
 * number the humanization plan's baseline (up to 62/call) was measured in, so CallReport reports
 * it in the same currency — call-report.ts and the backfill script both use THIS function.
 */
export function countRepeatedFourGrams(agentLines: string[]): number {
  const counts = new Map<string, number>();
  for (const line of agentLines) {
    for (const gram of fourGrams(ledgerTokens(line))) {
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
  }
  let repeated = 0;
  for (const n of counts.values()) if (n >= 2) repeated++;
  return repeated;
}

/**
 * THE OPENERS — the half of the repetition the 4-gram counter could never see.
 *
 * 2026-08-29: `repeatedPhraseCount: 0`, while six of her eight turns opened with `אהה.`, `בסדר.` or
 * `אוקיי.` — two uses each. Both numbers were correct. A 4-gram starting at a one-word opener
 * continues into the sentence that follows it, and that sentence is different every time, so a
 * repeated opener never produces a repeated 4-gram. The metric stayed green through exactly the
 * defect it exists to catch, which is worse than having no metric.
 *
 * An OPENER here is the first token of a line when it is punctuated off from the rest — "אהה. קודם
 * כל…", "אוקיי, אז…". That is the shape of both our injected acknowledgements and her own short
 * openers, and it is precisely what a caller hears as "she keeps saying the same thing". A line
 * that simply begins with a word and runs on has no opener.
 *
 * Returns DISTINCT openers used twice or more — the same currency as countRepeatedFourGrams, so
 * the two can be added. On that call it would have returned 3.
 */
export function countRepeatedOpeners(agentLines: string[]): number {
  const counts = new Map<string, number>();
  for (const line of agentLines) {
    const opener = leadingOpener(line);
    if (opener) counts.set(opener, (counts.get(opener) ?? 0) + 1);
  }
  let repeated = 0;
  for (const n of counts.values()) if (n >= 2) repeated++;
  return repeated;
}

/**
 * THE NUMBER THAT CAN ACTUALLY MOVE — how many times she opened a reply with the same word she
 * opened the previous one with.
 *
 * Koren, 2026-08-31: *"צריך לוודא שהסוכן לא חוזר על אותה מילה כל פעם בתחילת המשפט ('אוקיי')."*
 * `countRepeatedOpeners` above cannot see that complaint, and it is worth being exact about why:
 * it counts DISTINCT openers used twice or more across a whole call, so a three-word bank over
 * thirty-seven turns must score 3 and a five-word bank must score 5 — whatever the ORDER. Flawless
 * rotation and the same word every single turn are the same number to it. It read 4 on the call he
 * is describing and it would have read 4 if the rotation had been perfect.
 *
 * This counts ADJACENT PAIRS, which is the shape of the complaint: with the no-repeat rule on
 * (VOICE_OPENER_NO_REPEAT_ENABLED, see spoken-openers.ts) it should be 0, and any non-zero reading
 * is either a genuine escape or a mechanism nobody wired into SpokenOpenerTracker. Both are worth
 * knowing, which is what makes it a useful metric and the other one a constant.
 *
 * Measured on the transcript rather than on the ledger on purpose: the ledger is one of four
 * things that can put a word at the head of a reply, and the transcript is all of them.
 */
export function countConsecutiveOpenerRepeats(agentLines: string[]): number {
  let repeats = 0;
  let previous: string | null = null;
  for (const line of agentLines) {
    const opener = leadingOpener(line);
    if (opener !== null && opener === previous) repeats++;
    previous = opener;
  }
  return repeats;
}

/** The first token of a line, when a punctuation mark separates it from what follows. */
export function leadingOpener(line: string): string | null {
  const match = /^\s*([^\s.,!?…׃]+)\s*[.,!?…׃]/u.exec(line.replace(NIQQUD, ''));
  if (!match) return null;
  const word = match[1] ?? '';
  // A whole short sentence is not an "opener" — "מעולה!" alone is a turn, and a number or a name
  // that happens to be followed by a comma is not a reaction word either.
  return word.length > 0 && !/^\d+$/u.test(word) ? word : null;
}

/** How many phrases the reminder lists at most — enough to steer, small enough to stay cheap. */
const MAX_NOTE_PHRASES = 8;

export class PhraseLedger {
  #gramCounts = new Map<string, number>();
  /** Repeated phrases, MERGED into maximal runs, most recent last. Insertion-ordered set. */
  #repeats = new Set<string>();
  /** Words to watch as unigrams (the slang bank) — same rules, same note. */
  #trackedWords: Set<string>;
  #wordCounts = new Map<string, number>();
  /** Recently observed utterances, for the draft-echo dedupe below. */
  #seen: Array<{ text: string; at: number }> = [];

  constructor(trackedWords: readonly string[] = []) {
    this.#trackedWords = new Set(trackedWords.map((w) => ledgerTokens(w).join(' ')));
  }

  /**
   * One committed agent utterance. Overlapping repeated 4-grams from one sentence are merged into
   * a single maximal phrase ("איזה עסק יש לך ומה אתה מוכר" — not five staggered fragments of it),
   * so the note reads as phrases a person recognises, not a token soup.
   *
   * `at` is injectable for tests; production always uses the real clock.
   */
  observe(text: string, at: number = Date.now()): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    // ConversationItemAdded fires TWICE per reply under preemptive generation — draft then
    // confirmed, same text. Without this dedupe every reply counts itself as its own repetition
    // and the note fires on turn one. Same rule as CallReport.recordTranscript: an identical
    // utterance within 20s is the echo, not a repeat. (A caller genuinely making her repeat a
    // sentence inside 20s is missed — the same trade recordTranscript already accepted.)
    if (this.#seen.some((s) => s.text === trimmed && at - s.at < 20_000)) return;
    this.#seen.push({ text: trimmed, at });

    const tokens = ledgerTokens(trimmed);

    const grams = fourGrams(tokens);
    const nowRepeated: boolean[] = grams.map((g) => {
      const n = (this.#gramCounts.get(g) ?? 0) + 1;
      this.#gramCounts.set(g, n);
      return n >= 2;
    });

    for (let i = 0; i < nowRepeated.length; i++) {
      if (!nowRepeated[i]) continue;
      let end = i;
      while (end + 1 < nowRepeated.length && nowRepeated[end + 1]) end++;
      // Tokens i .. end+3 inclusive: the merged run of overlapping repeated 4-grams.
      const merged = tokens.slice(i, end + 4).join(' ');
      this.#repeats.delete(merged); // re-inserting moves it to "most recent"
      this.#repeats.add(merged);
      i = end;
    }

    for (const token of tokens) {
      if (!this.#trackedWords.has(token)) continue;
      const n = (this.#wordCounts.get(token) ?? 0) + 1;
      this.#wordCounts.set(token, n);
      if (n >= 2) {
        this.#repeats.delete(token);
        this.#repeats.add(token);
      }
    }
  }

  /** Distinct 4-grams at 2+ uses so far — the live counterpart of countRepeatedFourGrams. */
  get repeatedGramCount(): number {
    let n = 0;
    for (const c of this.#gramCounts.values()) if (c >= 2) n++;
    return n;
  }

  /**
   * The per-turn reminder, or null when there is nothing to say. Null is the common case and the
   * point: a call with no repetition never pays a token for this mechanism.
   */
  note(): string | null {
    if (this.#repeats.size === 0) return null;
    const phrases = [...this.#repeats].slice(-MAX_NOTE_PHRASES).reverse();
    return (
      '[Phrasing variety — automatic reminder] You have already used these exact phrasings on ' +
      'this call. Do not say them again word-for-word — express the same intent in fresh words: ' +
      phrases.map((p) => `«${p}»`).join(', ')
    );
  }
}
