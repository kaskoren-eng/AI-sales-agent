import { describe, expect, it } from 'vitest';
import { guardSpeech } from './speech-guard.js';
import { stripWrittenLaughter } from './written-laughter.js';

/**
 * THE PROMPT SAID NEVER, AND SHE DID IT ANYWAY.
 *
 * Written laughter has been forbidden in the system prompt for weeks, with its reason attached.
 * The 07:33 production call of 2026-09-02 opens a turn with `חחח, אז הגעת למקום אחר.` — one
 * occurrence in 676 agent turns. Koren's probe-26 verdict was `letters`: DeepDub reads them out,
 * it does not laugh. So this is the code half of a rule that already had a prompt half.
 */
describe('stripWrittenLaughter', () => {
  it('removes the exact sentence she said in production, comma and all', () => {
    const r = stripWrittenLaughter('חחח, אז הגעת למקום אחר.');
    expect(r.dropped).toBe(1);
    // Not `, אז הגעת…` — a sentence opening on a comma is a worse artefact than the one removed.
    expect(r.text).toBe('אז הגעת למקום אחר.');
  });

  it('catches every spelling the prompt names', () => {
    for (const laugh of ['חח', 'חחח', 'חחחח', 'חהחה', 'חה חה', 'הא הא']) {
      const r = stripWrittenLaughter(`${laugh} זה מצחיק.`);
      expect(r.dropped, laugh).toBe(1);
      expect(r.text, laugh).toBe('זה מצחיק.');
    }
  });

  it('DOES NOT EAT A HEBREW WORD THAT MERELY CONTAINS חח', () => {
    // `\b` never matches Hebrew — Hebrew letters are not `\w` — and that has already produced one
    // silent defect in this module's history. `פחח` is a tinsmith; a naive pattern leaves "פ".
    for (const word of ['פחח', 'הפחח', 'שחח', 'מתחחח']) {
      const r = stripWrittenLaughter(`קראתי ל${word} אתמול.`);
      expect(r.dropped, word).toBe(0);
      expect(r.text, word).toContain(word);
    }
  });

  it('leaves the ordinary word הא alone — only the doubling is laughter', () => {
    const plain = 'הא ראיה שזה עובד.';
    expect(stripWrittenLaughter(plain)).toEqual({ text: plain, dropped: 0 });
  });

  it('costs nothing on the sentence that has none, which is almost all of them', () => {
    const plain = 'אנחנו דואגים שכל פנייה תקבל שיחה תוך דקה.';
    expect(stripWrittenLaughter(plain)).toEqual({ text: plain, dropped: 0 });
  });

  it('counts each run, so the report can say how often she ignored the rule', () => {
    const r = stripWrittenLaughter('חחח, כן, הא הא, בטח.');
    expect(r.dropped).toBe(2);
    expect(r.text).not.toMatch(/חח|הא הא/u);
  });
});

describe('the guard', () => {
  it('strips it unconditionally — there is no flag, because no engine performs it', () => {
    const r = guardSpeech('חחח, אז הגעת למקום אחר.', {});
    expect(r.text).toBe('אז הגעת למקום אחר.');
    expect(r.interventions.some((i) => i.includes('written laugh'))).toBe(true);
  });

  it('does not make her silent when the laugh was the whole reply', () => {
    // Nothing human survives `חחח.` — reported as silence rather than as an empty utterance, so
    // the reply-level path speaks the hold check-back instead of leaving dead air.
    const r = guardSpeech('חחח.', {});
    expect(r.text).toBe('');
    expect(r.silent).toBe(true);
  });

  it('still lets a real sentence about laughing through', () => {
    // The prompt's own instruction is to say it in WORDS. That must survive the net.
    const r = guardSpeech('זה ממש מצחיק!', {});
    expect(r.text).toContain('מצחיק');
  });
});
