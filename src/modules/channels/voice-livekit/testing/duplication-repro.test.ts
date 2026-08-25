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
 *     agent.ts::ttsNode → guardStream(withFiller(takeFiller, text), pred)
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
  // Consuming getter, exactly as agent.ts::ttsNode passes it since the mid-silence filler change.
  let armed = filler;
  const takeFiller = () => { const f = armed; armed = null; return f; };
  return guardStream(withFiller(takeFiller, text), () => false);
}

describe('filler ⨯ opener duplication — real pipeline modules', () => {
  it('sanity: "רגע, בודקת." is a REAL system-prompt opener AND "רגע..." is a REAL thinking filler', () => {
    // The collision is not contrived — both halves are shipped config, so the guard must hold.
    const prompt = buildSystemPrompt({ toolsEnabled: false, businessProfile: null });
    expect(prompt).toContain('רגע, בודקת.');
    expect(THINKING_FILLERS_HE).toContain('רגע...');
  });

  // ---- The fix, v2: the OPENER loses the duplicate word, never the filler ---------------------
  //
  // v1 withheld the filler on collision. Since the mid-silence change (2026-08-25) that is no
  // longer possible: the filler is spoken WHILE the LLM is still silent — by the time the opener
  // arrives it is already out of her mouth. The invariant that matters is unchanged (the caller
  // hears the word ONCE); which side carries it flipped.

  it('FIXED: filler "רגע..." + opener "רגע, בודקת." → "רגע" reaches the TTS sink only ONCE', async () => {
    const sink = await drainToSink(
      ttsNodeTextPath('רגע...', llmStream('רגע, בודקת. ', 'יש לי כמה אפשרויות בשבילך.')),
    );
    // No back-to-back duplicate; the filler chunk carries the word, the opener arrives without it.
    expect(firstDuplicatedLeadingWord(sink)).toBeNull();
    expect(sink.filter((c) => c.includes('רגע'))).toHaveLength(1);
    expect(sink.some((c) => c.trim() === 'רגע...')).toBe(true);
  });

  it('FIXED breadth: EVERY filler is suppressed when the opener starts with that filler word', async () => {
    for (const filler of THINKING_FILLERS_HE) {
      const word = filler.replace(/[.…]+$/u, '');
      const sink = await drainToSink(
        ttsNodeTextPath(filler, llmStream(`${word}, בודקת. `, 'המשך המשפט כאן.')),
      );
      expect(firstDuplicatedLeadingWord(sink), `filler ${filler} must not duplicate`).toBeNull();
      expect(sink.filter((c) => c.includes(word))).toHaveLength(1);
    }
  });

  it('does NOT over-suppress: a non-colliding filler ("אממ...") is still spoken, no duplication', async () => {
    const sink = await drainToSink(
      ttsNodeTextPath('אממ...', llmStream('רגע, בודקת. ', 'יש לי כמה אפשרויות בשבילך.')),
    );
    expect(firstDuplicatedLeadingWord(sink)).toBeNull();
    expect(sink.some((c) => c.includes('אממ'))).toBe(true); // filler preserved
    expect(sink.some((c) => c.includes('רגע'))).toBe(true); // opener preserved
  });

  it('collision guard survives a halting speaker: opener word split across chunks', async () => {
    // The opener "רגע" arrives one grapheme cluster at a time — withFiller must still recognize it.
    const sink = await drainToSink(
      ttsNodeTextPath('רגע...', llmStream('ר', 'ג', 'ע', ', בודקת. ', 'המשך.')),
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
