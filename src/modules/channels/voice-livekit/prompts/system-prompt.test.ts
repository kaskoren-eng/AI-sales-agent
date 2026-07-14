import { describe, expect, it } from 'vitest';
import { GREETING_HE, SYSTEM_PROMPT_HE } from './system-prompt.he.js';

/**
 * Prompt regression tests for the Keren v2 prompt (ported from docs/system-prompt-keren-v2.md).
 *
 * Required by `docs/voice-agent-development-methodology.md` principle #1: never edit the system
 * prompt without a test proving the fix works and old behaviour still holds.
 *
 * READ THE `it.todo` BLOCK AT THE BOTTOM. The v2 prompt DROPS eight guards that the previous prompt
 * carried, and every one of them was added because of a failure on a real call — not because
 * somebody thought it might be nice. They are recorded as todos rather than deleted, so the suite
 * stays green while the losses stay loud.
 */

describe('Keren v2 — identity and gender', () => {
  it('names her קרן', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/קרן \(Keren\)/u);
  });

  it('states she is female', () => {
    // Hebrew inflects by gender and there is no neutral option, so a female voice using masculine
    // verbs is instantly, glaringly wrong to an Israeli ear. v1 of the original prompt did exactly
    // that and greeted every caller with a man's verb.
    expect(SYSTEM_PROMPT_HE).toMatch(/You are female/u);
  });

  it('gives feminine first-person examples she can actually copy', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/אני יכולה/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/מצטערת/u);
  });

  it('tells her the COMPANY is masculine plural, not feminine', () => {
    // The bug this exists for: "speak about yourself in the feminine" leaked into the first-person
    // PLURAL, and she said "אנחנו מספקות" about ClickScales. A company is not a woman, and the
    // feminine plural sounds flatly wrong. Three persons, three genders.
    expect(SYSTEM_PROMPT_HE).toMatch(/masculine plural/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/אנחנו בונים|אנחנו מציעים/u);
  });

  it('greets in the feminine (the Cartesia voice is female)', () => {
    expect(GREETING_HE).toMatch(/יכולה/u);
    expect(GREETING_HE).not.toMatch(/אני יכול(?!ה)/u);
  });

  it('introduces herself by name, anchored to the company', () => {
    // "קרן" and "קורן" are one letter apart and the phone line eats that letter. The company name
    // is the only thing in the sentence that tells a caller which one he is talking to.
    expect(GREETING_HE).toMatch(/קרן/u);
    expect(GREETING_HE).toMatch(/ClickScales|קליקסקיילס/u);
  });
});

describe('Keren v2 — what the business is', () => {
  it('states the business rather than leaving the model to infer it', () => {
    // NOTE: v2 CHANGES THE BUSINESS. The previous prompt said ClickScales is a digital marketing
    // agency ("סוכנות שיווק דיגיטלי"). This one says it builds AI voice and WhatsApp sales agents.
    // That is not a rewording — it is what she will now tell every caller.
    expect(SYSTEM_PROMPT_HE).toMatch(/builds AI voice and WhatsApp sales agents/u);
  });

  it('refuses to answer what it was not told, rather than inventing', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/אין לי כרגע את המידע הזה/u);
  });

  it('does not guess missing lead details — it asks', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/do not guess/u);
  });

  it('admits to being an AI when the caller asks for a human', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/אני סוכנת AI/u);
  });
});

describe('Keren v2 — the call flow', () => {
  it('opens without re-greeting (session.say already spoke the opening line)', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/do not repeat or re-say a greeting/u);
  });

  it('asks discovery questions one at a time', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/one question at a time/u);
  });

  it('treats general uncertainty as an objection to handle, NOT a disqualifier', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/General uncertainty is not a disqualifier/u);
  });

  it('stops immediately on a hostile or opt-out request', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/לא נתקשר אליך יותר/u);
  });

  it('stays silent when the caller asks her to hold', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/NO_RESPONSE_NEEDED/u);
  });
});

/**
 * ============================================================================================
 * BLOCKERS — the v2 prompt cannot go live until these are wired. It was written for RETELL.
 * ============================================================================================
 */
describe('Keren v2 — DEPLOY BLOCKERS', () => {
  it('KNOWN: instructs her to call three tools that DO NOT EXIST in this agent', () => {
    // Our LiveKit agent wires NO tools at all — that is Phase 4. An LLM told to call a tool it has
    // not been given does not fail cleanly: it improvises. It will narrate the call aloud, or claim
    // to have booked a meeting that was never booked. The second is far worse than a crash — the
    // lead hangs up believing he has a demo on Tuesday, and nobody ever rings him.
    expect(SYSTEM_PROMPT_HE).toMatch(/end_call/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/check_availability_cal/u);
    expect(SYSTEM_PROMPT_HE).toMatch(/book_appointment_cal/u);
  });

  it('KNOWN: contains template variables that NOTHING substitutes', () => {
    // Retell interpolates these. LiveKit does not. As shipped, the model literally reads
    // "Lead name: {{lead_name}}" and will reason about it as though that were his name.
    for (const v of ['{{lead_name}}', '{{company_name}}', '{{industry}}', '{{opening_line}}', '{{call_direction}}']) {
      expect(SYSTEM_PROMPT_HE).toContain(v);
    }
  });
});

/**
 * ============================================================================================
 * GUARDS DROPPED BY v2 — each was added because of a REAL failure on a REAL call.
 *
 * Recorded as todos rather than deleted, so the suite stays green while the losses stay visible.
 * If any of these behaviours reappears in production, this is the list to work through.
 * ============================================================================================
 */
describe('Keren v2 — guards the previous prompt had and this one does not', () => {
  // She is קרן. The founder is קורן. One vav apart, and she books meetings WITH him — so both names
  // occur in the same sentence, down an 8kHz line that strips exactly the sound separating them.
  // v2 never mentions the founder at all, so "אני רוצה לדבר עם קורן" now meets a model with no rule.
  it.todo('should disambiguate קרן (her) from קורן (the founder)');

  // The model once reasoned "ClickScales" -> "scales" -> מאזניים and told real callers we sell
  // weighing equipment. An LLM given no facts invents plausible ones; v1 had to forbid the
  // inference BY NAME. v2 states the business but never blocks the inference.
  it.todo('should explicitly deny the "scales/מאזניים" inference from the company name');

  // On a phone a long reply is worse than a slow one — the caller cannot skim, and cannot tell when
  // she is finished. v2 has no length limit anywhere, and its FAQ answers are long.
  it.todo('should cap replies at two sentences');

  // Added TODAY, because on a real call Koren said to her: "סיימת? אני פשוט לא מדבר, אני מחכה
  // שתסיימי." He could not tell when she had stopped talking, so he sat in silence. v2 has no rule
  // about ending a turn, and its FAQ answers end on flat statements that invite nobody to speak.
  it.todo('should end every turn clearly, preferring a question, and never on a list');

  // Hebrew addresses the listener by HIS gender, not the speaker's. v1 had her applying her own
  // gender to callers. v2 says nothing about the caller's gender at all.
  it.todo("should not apply her own gender to the caller");
});
