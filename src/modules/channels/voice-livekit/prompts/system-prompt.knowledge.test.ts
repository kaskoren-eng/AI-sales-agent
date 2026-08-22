import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from './system-prompt.he.js';
import { KNOWLEDGE_MARKER } from '../knowledge-injector.js';

/**
 * The `## KNOWLEDGE` grounding block — the only part of the prompt that RAG adds.
 *
 * It had no tests at all until 2026-08-22, which is how it shipped telling her WHAT she may say
 * without ever telling her HOW MUCH. Both real calls show the result: 77-, 54- and 52-word answers
 * that recite the retrieved chunk end to end, where the hand-tuned FAQ bank the KB replaced had
 * one-sentence answers.
 *
 * These pin the two halves separately, because they fail differently. Lose the grounding rules and
 * she invents a price; lose the brevity rules and she keeps every fact but becomes unlistenable.
 */

const withRag = buildSystemPrompt({ toolsEnabled: true, ragEnabled: true });
const withoutRag = buildSystemPrompt({ toolsEnabled: true, ragEnabled: false });

describe('## KNOWLEDGE — the flag is a true rollback', () => {
  it('appears only when ragEnabled', () => {
    expect(withRag).toContain('## KNOWLEDGE');
    expect(withoutRag).not.toContain('## KNOWLEDGE');
    expect(withoutRag).not.toContain(KNOWLEDGE_MARKER);
  });

  it('names the exact marker the injector emits', () => {
    // If these two ever drift the model is told to look for a label that never arrives, and every
    // grounded answer silently becomes an un-grounded one.
    expect(withRag).toContain(KNOWLEDGE_MARKER);
  });
});

describe('## KNOWLEDGE — grounding', () => {
  it('forbids inventing facts and says what to do instead', () => {
    expect(withRag).toMatch(/NEVER guess a price, a number, a spec or a policy/u);
    expect(withRag).toMatch(/team will follow up/u);
  });

  it('forbids revealing that anything was looked up', () => {
    expect(withRag).toMatch(/Never mention documents, sources/u);
  });

  it('makes retrieved knowledge win over her own earlier claim', () => {
    expect(withRag).toMatch(/the knowledge wins/u);
  });
});

/**
 * THE 2026-08-22 VERBOSITY REGRESSION.
 *
 * Measured on both calls: she answers a one-fact question by reading the whole chunk — price, then
 * inclusions, then per-lead overage, then languages, then CRM sync. The block is reference material
 * and she was treating it as a script.
 *
 * Asserted on the PROMPT rather than on her words, because what she actually says is a model
 * behaviour that only a real call can judge. What this file can guarantee is that the instruction is
 * present and unambiguous — the necessary half, not the sufficient one.
 */
describe('## KNOWLEDGE — brevity', () => {
  it('caps the length of a factual answer', () => {
    expect(withRag).toMatch(/ONE OR TWO sentences/u);
    expect(withRag).toMatch(/40 spoken words/u);
  });

  it('says to answer the question asked and leave the rest unsaid', () => {
    expect(withRag).toMatch(/Everything else in the block stays unsaid/u);
  });

  it('forbids reciting lists the lead never asked for', () => {
    expect(withRag).toMatch(/Never read out a list of features/u);
  });

  it('carries a worked example of the failure, not just the rule', () => {
    // An abstract "be brief" is the instruction that was already implied and already ignored. The
    // example names the specific thing she did: the price PLUS four things nobody asked about.
    expect(withRag).toMatch(/כמה זה עולה/u);
    expect(withRag).toMatch(/NOT the price, plus what the package includes/u);
  });

  /**
   * The example must DESCRIBE quoting a price without CONTAINING one.
   *
   * The first draft of it wrote ClickScales' real figures into the prompt — in a multi-tenant prompt,
   * for every tenant, and reintroducing the second source of truth for pricing that `slimKnowledge`
   * exists to delete. `knowledge-settings.test.ts` caught it. Pinned here too, next to the example,
   * because that is where the mistake will be made again.
   */
  it('the example quotes no actual figure', () => {
    const example = withRag.slice(withRag.indexOf('Asked "כמה זה עולה'));
    expect(example).not.toMatch(/\d[\d,.]*\s*(?:שקל|ש"ח|₪)/u);
    expect(example).not.toMatch(/1,490|3,500/u);
  });

  it('keeps the brevity rules inside the RAG block, so rollback takes them too', () => {
    // They describe how to use a `[KNOWLEDGE]` block. Without RAG there is no block, and a stray
    // 40-word cap would silently shorten her scripted FAQ answers instead.
    expect(withoutRag).not.toMatch(/40 spoken words/u);
  });
});
