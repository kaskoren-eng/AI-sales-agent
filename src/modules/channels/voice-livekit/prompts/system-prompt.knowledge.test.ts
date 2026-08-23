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
 * ── ANSWER LENGTH IS NOT A DEFECT. DO NOT "FIX" IT. ────────────────────────────────────────────
 *
 * On 2026-08-22 the `## KNOWLEDGE` block gained 185 words capping answers at one or two sentences
 * (~40 words). It cost 216 tokens on every inference of every call, measurably changed nothing, and
 * was reverted the next day.
 *
 * The reason it is not being retried is NOT that the wording was wrong. Koren, who judges these calls
 * by ear and is the only one who can, ruled on 2026-08-23:
 *
 *     "the long answers are not necessarily wrong or bad — in some cases the reply of the agent must
 *      be longer than usual. until now I didn't feel like it's too long."
 *
 * A word count is not the measure here. Some answers should be long, and the caller decides which. A
 * previous version of this file called long answers "the top open item" on the strength of counting
 * words in a transcript; that was a metric being mistaken for a judgement.
 *
 * So there is no brevity spec, and no `todo` implying one is owed. If this is ever reopened it will be
 * because Koren asks for it, about specific answers he heard — not because a number looked high.
 */
describe('## KNOWLEDGE — pricing has one source of truth', () => {
  /**
   * Unrelated to length, and the reason anything survives here at all: the reverted block's example
   * wrote ClickScales' real figures into a prompt every tenant receives, which is exactly the second
   * source of truth for pricing that `slimKnowledge` exists to delete. Whatever is added here later
   * must not do it again.
   */
  it('the RAG block quotes no actual figure', () => {
    const knowledge = withRag.slice(withRag.indexOf('## KNOWLEDGE'));
    expect(knowledge).not.toMatch(/\d[\d,.]*\s*(?:שקל|ש"ח|₪)/u);
    expect(knowledge).not.toMatch(/1,490|3,500/u);
  });
});
