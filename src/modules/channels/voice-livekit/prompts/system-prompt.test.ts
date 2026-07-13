import { describe, expect, it } from 'vitest';
import { GREETING_HE, SYSTEM_PROMPT_HE } from './system-prompt.he.js';

/**
 * Prompt regression tests.
 *
 * Required by `docs/voice-agent-development-methodology.md` principle #1: never edit the system
 * prompt without a test proving the fix works and old behaviour still holds.
 *
 * The bug these exist for: the Cartesia voice is FEMALE, but v1 of the prompt was written in the
 * masculine and the agent greeted every caller with "שלום, איך אני יכול לעזור?" — a woman's voice
 * using a man's verb. Hebrew inflects by gender, so this is not a nuance an English-speaking
 * developer would notice, and it is glaring to the caller.
 *
 * Note on the regexes: "יכולה" (fem.) CONTAINS "יכול" (masc.), so a naive substring check passes
 * on the broken text. Every pattern below therefore asserts the masculine form is NOT followed by
 * a ה.
 */

/** Masculine self-reference: "אני יכול" but not "אני יכולה". */
const MASC_SELF = /אני יכול(?!ה)/u;
/** Masculine address to self: "אתה עוזר" (v1's opening line). */
const MASC_IDENTITY = /\bאתה עוזר\b/u;
/**
 * FEMININE PLURAL for the company — the v2 bug. Telling the agent "always speak about yourself in
 * the feminine" leaked into the first-person PLURAL, so she said "אנחנו מספקות" / "אנחנו עושות"
 * about ClickScales. The company is not a woman; Hebrew uses the masculine plural for a company or
 * a mixed group, and the feminine plural sounds flatly wrong to a native ear.
 * Three different persons, three different genders — see the prompt.
 */
const FEM_PLURAL_COMPANY = /אנחנו\s+\S*(ות)\b/u;

describe('Hebrew system prompt — gender', () => {
  it('greets in the feminine (the voice is female)', () => {
    expect(GREETING_HE).toMatch(/יכולה/u);
    expect(GREETING_HE).not.toMatch(MASC_SELF);
  });

  it('addresses the agent as female, not male', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/את עוזרת/u);
    expect(SYSTEM_PROMPT_HE).not.toMatch(MASC_IDENTITY);
  });

  it('never uses a masculine verb for the agent itself', () => {
    // Strict on purpose: the masculine form must not appear ANYWHERE, not even quoted as a
    // "don't say this" example. This test caught exactly that in v2 — the prompt listed
    // "אני יכול" as a counter-example, which risks priming the model to produce it. Describe the
    // rule, never spell out the wrong form.
    expect(SYSTEM_PROMPT_HE).not.toMatch(MASC_SELF);
  });

  it('instructs the agent to speak about itself in the feminine', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/לשון נקבה/u);
  });

  it('tells the agent the COMPANY is masculine plural, not feminine', () => {
    // The v2 bug: "אנחנו מספקות" — she applied her own gender to the company.
    expect(SYSTEM_PROMPT_HE).toMatch(/לשון זכר רבים/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/אנחנו עושים|אנחנו מספקים/u);
  });

  it('tells the agent NOT to apply her own gender to the caller', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/אל תנחשי/u);
  });
});

describe('Hebrew system prompt — the business is stated, not guessed', () => {
  /**
   * The bug: the prompt said "עוזרת קולית של ClickScales" and nothing else, so the model inferred
   * the business FROM THE NAME — "ClickScales" -> "scales" -> מאזניים. It told real callers we
   * sell weighing equipment. An LLM with no facts will always invent plausible ones; the fix is to
   * give it the facts and forbid the inference explicitly.
   */
  it('states what ClickScales actually does', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/סוכנות שיווק דיגיטלי/u);
  });

  it('explicitly denies the scales/weighing inference from the name', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/לא חברת שקילה|לא מוכרת מאזניים/u);
  });

  it('forbids inventing anything not stated', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/אל תמציאי/u);
  });
});

describe('Hebrew system prompt — voice rules that must not regress', () => {
  it('caps replies at two sentences (long replies are worse than slow ones on a phone)', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/שני משפטים/u);
  });

  it('forbids inventing prices, dates and calendar availability', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/אל תמציאי/u);
  });

  it('requires asking again rather than guessing — Hebrew STT mishears names', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/אל תנחשי/u);
  });

  it('admits to being an automated assistant when asked', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/עוזרת אוטומטית/u);
  });
});
