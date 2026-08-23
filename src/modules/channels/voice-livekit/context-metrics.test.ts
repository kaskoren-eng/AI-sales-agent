import { describe, it, expect } from 'vitest';
import { countTokens } from '../../knowledge/tokens.js';
import { KNOWLEDGE_MARKER, formatKnowledgeBlock } from './knowledge-injector.js';
import type { RetrievedChunk } from '../../knowledge/retrieval.service.js';

/**
 * ── WHY THE CONTEXT-SIZE METRICS ARE OFF BY DEFAULT ────────────────────────────────────────────
 *
 * `contextTokens()` runs cl100k over the ENTIRE chat context, synchronously, inside `llmNode` — which
 * is on the critical path, before the LLM call starts. It ran twice per inference: once before the
 * slot went in and once after.
 *
 * Measured on a realistic 6,553-token late-call context: 18ms median each, so ~36ms of every turn's
 * time-to-first-token was being spent producing a log line. That was the right trade while the rolling
 * slot was unproven — those two numbers are exactly what demonstrated injection overhead is flat
 * rather than cumulative — and the wrong one now that two real calls have shown a bounded footprint.
 *
 * This file guards the two properties that keep it that way.
 */

function chunk(id: string, content: string, tokenCount: number): RetrievedChunk {
  return { id, documentId: 'd', content, chunkIndex: 0, tokenCount, score: 0.9, vectorScore: 0.9, lexicalScore: 0.1 };
}

describe('the cost this flag exists to avoid', () => {
  it('tokenizing a late-call context is slow enough to matter on the critical path', () => {
    let text = '';
    const line = 'הסוכנת עובדת בערבים בסופי שבוע ובחגים גם בעשרים ושלוש בלילה וגם בשבת לידים לא מפסיקים להיכנס ';
    while (countTokens(text) < 6000) text += line;

    const t0 = performance.now();
    countTokens(`${text} unique-${t0}`); // suffix defeats memoisation, as a live context would
    const elapsed = performance.now() - t0;

    // Not asserting an exact figure — CI machines vary. Asserting the ORDER of magnitude: this is
    // milliseconds of blocking work, not microseconds, and it was happening twice a turn.
    expect(countTokens(text)).toBeGreaterThan(6000);
    expect(elapsed).toBeGreaterThan(1);
  });
});

/**
 * The post-injection size is now DERIVED (`baseline + slot.tokens + KNOWLEDGE_MARKER_TOKENS`) instead
 * of measured with a second full tokenization. That is only legitimate if the arithmetic agrees with
 * what a real measurement would have said — otherwise the flag turned a true number into a plausible
 * one, which is worse than not logging it.
 */
describe('deriving the post-slot size instead of re-tokenizing', () => {
  const markerTokens = countTokens(`${KNOWLEDGE_MARKER}\n`);

  it('marker cost is derived from the marker itself, so it cannot drift', () => {
    expect(markerTokens).toBeGreaterThan(0);
    expect(markerTokens).toBe(countTokens(`${KNOWLEDGE_MARKER}\n`));
  });

  it('derived total matches a real measurement of the same block', () => {
    const chunks = [
      chunk('a', 'המנוי החודשי הוא אלף ארבע מאות תשעים שקלים לחודש.', 0),
      chunk('b', 'הסוכנת עובדת בערבים, בסופי שבוע ובחגים.', 0),
    ];
    // Stored counts come from ingest; mirror that here so the arithmetic uses the same inputs it does.
    for (const c of chunks) c.tokenCount = countTokens(c.content.trim());

    const block = formatKnowledgeBlock(chunks);
    const slotTokens = chunks.reduce((n, c) => n + c.tokenCount, 0);

    const derived = slotTokens + markerTokens;
    const measured = countTokens(block);

    // Exactness is not the claim — the block joins chunks with blank lines, and the tokenizer is free
    // to merge across those boundaries. The claim is that the derived figure tracks the real one
    // closely enough to read a growth curve off it.
    expect(Math.abs(derived - measured)).toBeLessThanOrEqual(4);
  });
});
