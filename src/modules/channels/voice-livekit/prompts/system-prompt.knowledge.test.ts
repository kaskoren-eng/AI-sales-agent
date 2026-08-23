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
 * ── ANSWER LENGTH: TRIED IN THE PROMPT, MEASURED, REVERTED ─────────────────────────────────────
 *
 * She answers a one-fact question by reading the whole retrieved chunk — price, then inclusions,
 * then per-lead overage, then languages, then CRM sync. Measured across three calls.
 *
 * On 2026-08-22 the `## KNOWLEDGE` block gained 185 words telling her to answer in one or two
 * sentences (~40 words), to use only the fact that was asked for, never to recite lists, plus a
 * worked example of this exact failure. The 2026-08-23 call is the result:
 *
 *     answers: 45 / 61 / 49 / 34 / 27 words
 *     baseline inference: 2,754 -> 2,970 promptTokens  (+216, EVERY inference of EVERY call)
 *
 * No shorter than before, and the longest answer of the call was 61 words. The instruction cost
 * tokens on every turn for the length of the call and changed nothing, so it was reverted in full.
 *
 * WHAT THIS RULES OUT, which is the part worth keeping: the problem is not that she was never told.
 * She was told explicitly, with an example, and did it anyway. The next attempt should not be more
 * prompt words — the chunks themselves are ~250 tokens of prose, and she recites what she is handed.
 * Shorten the source material and there is less to recite.
 *
 * These stay as `todo` rather than being deleted: they are the specification for whatever fixes this,
 * and re-deriving them means re-running three calls.
 */
describe('## KNOWLEDGE — brevity', () => {
  it.todo('caps the length of a factual answer');
  it.todo('says to answer the question asked and leave the rest unsaid');
  it.todo('forbids reciting lists the lead never asked for');
  it.todo('carries a worked example of the failure, not just the rule');

  /**
   * KEPT LIVE, because it is about pricing having one source of truth rather than about brevity.
   * The reverted block's example originally wrote ClickScales' real figures into a multi-tenant
   * prompt. Whatever replaces it must not do that again.
   */
  it('the RAG block quotes no actual figure', () => {
    const knowledge = withRag.slice(withRag.indexOf('## KNOWLEDGE'));
    expect(knowledge).not.toMatch(/\d[\d,.]*\s*(?:שקל|ש"ח|₪)/u);
    expect(knowledge).not.toMatch(/1,490|3,500/u);
  });
});
