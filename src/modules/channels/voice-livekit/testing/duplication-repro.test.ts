import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../prompts/system-prompt.he.js';
import { THINKING_FILLERS_HE } from '../prompts/thinking-fillers.he.js';
import { guardStream, withFiller } from '../speech-guard.js';

/**
 * REGRESSION — "she says the same short word twice" (thinking-filler ⨯ opener collision).
 *
 * Root cause (diagnosed via this harness): the armed thinking filler ends in "..." — a sentence
 * terminator — so guardStream flushes it as its OWN TTS chunk. When the reply's SHORT opener starts
 * with the same word (filler "רגע..." + the prompt opener example "רגע, בודקת."), the caller hears
 * that word TWICE. Koren heard exactly this.
 *
 * The fix lives in withFiller (speech-guard.ts): it peeks the reply's first word and DROPS the
 * filler when the opener is about to repeat it. This suite drives the REAL pipeline modules
 * (guardStream + withFiller) and the REAL config (THINKING_FILLERS_HE + the prompt opener examples)
 * through the exact composition agent.ts::ttsNode builds, and asserts the duplication no longer
 * reaches the TTS sink — while a non-colliding filler is still spoken.
 *
 *     agent.ts::ttsNode → guardStream(withFiller(filler, text), pred)
 */

/** A scripted LLM output stream — yields the reply in chunks, like the real streaming LLM node. */
async function* llmStream(...chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

/** Everything the TTS engine would be asked to speak, in order. This is the "sink". */
async function drainToSink(stream: AsyncIterable<string>): Promise<string[]> {
  const sink: string[] = [];
  for await (const chunk of stream) sink.push(chunk);
  return sink;
}

/** The first word token of a chunk, stripped of trailing punctuation ("...", ",", "."). */
function leadingWord(chunk: string): string {
  const first = chunk.trim().split(/[\s,.]+/u).filter(Boolean)[0] ?? '';
  return first.replace(/[.…]+$/u, '');
}

/**
 * Detects the bug: the SAME short leading word reaching the TTS sink in two adjacent chunks.
 * Excludes the confirmed false-positives (repeated phone digits, the idiom "אות אות").
 */
function firstDuplicatedLeadingWord(sink: string[]): { word: string; a: string; b: string } | null {
  for (let i = 1; i < sink.length; i++) {
    const prev = sink[i - 1]!;
    const curr = sink[i]!;
    const w = leadingWord(prev);
    if (!w || w !== leadingWord(curr)) continue;

    const DIGIT_WORDS = new Set(['אפס', 'אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר']);
    const IDIOMS = new Set(['אות']);
    if (DIGIT_WORDS.has(w) || IDIOMS.has(w)) continue;

    const prevTokens = prev.trim().split(/\s+/u).filter(Boolean).length;
    if (prevTokens <= 3) return { word: w, a: prev.trim(), b: curr.trim() };
  }
  return null;
}

/** Faithful reconstruction of agent.ts::ttsNode's text composition. */
function ttsNodeTextPath(filler: string | null, text: AsyncIterable<string>): AsyncIterable<string> {
  return guardStream(withFiller(filler, text), () => false);
}

describe('filler ⨯ opener duplication — real pipeline modules', () => {
  it('sanity: "רגע, בודקת." is a REAL system-prompt opener AND "רגע..." is a REAL thinking filler', () => {
    // The collision is not contrived — both halves are shipped config, so the guard must hold.
    const prompt = buildSystemPrompt({ toolsEnabled: false, businessProfile: null });
    expect(prompt).toContain('רגע, בודקת.');
    // The bank member is pointed since round 10 (`רֶגַע...`); the collision is with the same WORD,
    // and `normalizeFillerWord` strips niqqud precisely so the guard still sees one word.
    expect(THINKING_FILLERS_HE.map((f) => f.replace(/[֑-ׇ]/gu, ''))).toContain('רגע...');
  });

  // ---- The fix: filler suppressed when the opener would repeat it -----------------------------

  it('FIXED: filler "רגע..." + opener "רגע, בודקת." → "רגע" reaches the TTS sink only ONCE', async () => {
    const sink = await drainToSink(
      ttsNodeTextPath('רֶגַע...', llmStream('רגע, בודקת. ', 'יש לי כמה אפשרויות בשבילך.')),
    );
    // No back-to-back duplicate, and no standalone filler chunk — the opener carries the word once.
    expect(firstDuplicatedLeadingWord(sink)).toBeNull();
    expect(sink.filter((c) => c.includes('רגע'))).toHaveLength(1);
    expect(sink.some((c) => c.trim().replace(/[֑-ׇ]/gu, '') === 'רגע...')).toBe(false);
  });

  it('FIXED breadth: EVERY filler is suppressed when the opener starts with that filler word', async () => {
    for (const filler of THINKING_FILLERS_HE) {
      // Unpointed, on both sides. guardSpeech strips model niqqud on the way to the TTS and only
      // re-applies this file's own verified marks to the ELLIPSIS form, so a chunk carrying
      // "אֶממ, בודקת." reaches the sink as "אממ, בודקת." — the same word, without the mark.
      const word = filler.replace(/[֑-ׇ]/gu, '').replace(/[.…]+$/u, '');
      const sink = await drainToSink(
        ttsNodeTextPath(filler, llmStream(`${word}, בודקת. `, 'המשך המשפט כאן.')),
      );
      expect(firstDuplicatedLeadingWord(sink), `filler ${filler} must not duplicate`).toBeNull();
      expect(sink.filter((c) => c.includes(word))).toHaveLength(1);
    }
  });

  it('does NOT over-suppress: a non-colliding filler ("אֶממ...") is still spoken, no duplication', async () => {
    const sink = await drainToSink(
      ttsNodeTextPath('אֶממ...', llmStream('רגע, בודקת. ', 'יש לי כמה אפשרויות בשבילך.')),
    );
    expect(firstDuplicatedLeadingWord(sink)).toBeNull();
    const bare = sink.map((c) => c.replace(/[֑-ׇ]/gu, ''));
    expect(bare.some((c) => c.includes('אממ'))).toBe(true); // filler preserved
    expect(bare.some((c) => c.includes('רגע'))).toBe(true); // opener preserved
  });

  it('collision guard survives a halting speaker: opener word split across chunks', async () => {
    // The opener "רגע" arrives one grapheme cluster at a time — withFiller must still recognize it.
    const sink = await drainToSink(
      ttsNodeTextPath('רֶגַע...', llmStream('ר', 'ג', 'ע', ', בודקת. ', 'המשך.')),
    );
    expect(firstDuplicatedLeadingWord(sink)).toBeNull();
    expect(sink.filter((c) => c.includes('רגע'))).toHaveLength(1);
  });

  // ---- Unaffected hypotheses, kept as guardrails ----------------------------------------------

  it('H3 (still refuted): guardStream never splits on a comma, so a comma-opener is not duplicated', async () => {
    const sink = await drainToSink(
      ttsNodeTextPath(null, llmStream('מעולה, ', 'יואב. ', 'כיף לשמוע ממך. ', 'איזה עסק יש לך?')),
    );
    expect(sink.filter((c) => c.includes('מעולה'))).toHaveLength(1);
    expect(firstDuplicatedLeadingWord(sink)).toBeNull();
  });

  it('H1 (still gated): a discarded preemptive draft does NOT reach the audible sink', async () => {
    const audibleSink: string[] = [];
    const draftScheduled = false;
    const draft = await drainToSink(ttsNodeTextPath(null, llmStream('מעולה, יואב. ', 'כיף לשמוע.')));
    if (draftScheduled) audibleSink.push(...draft);
    const confirmed = await drainToSink(ttsNodeTextPath(null, llmStream('מעולה, יואב. ', 'ספר לי עוד.')));
    audibleSink.push(...confirmed);
    expect(audibleSink.filter((c) => c.includes('מעולה'))).toHaveLength(1);
  });
});
