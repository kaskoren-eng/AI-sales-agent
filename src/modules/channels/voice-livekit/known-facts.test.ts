import { describe, it, expect } from 'vitest';
import { CallStateMachine, formatKnownFacts } from './call-state.js';

/**
 * ── SHE ASKED THE SAME QUESTION TWICE, WITH THE ANSWER IN MEMORY ───────────────────────────────
 *
 * From the 2026-08-23 call, verbatim from the report:
 *
 *     41.1s  she asks   "איזה עסק אתה מנהל, ובמה אתם עוסקים?"
 *     49-51s he answers  website agency / digital store
 *     53.0s  capture_lead_info -> business_type: "חנות דיגיטלית"     <- captured, correctly
 *     69.2s  she asks   "איזה עסק יש לכה ומה אתה מוכר בדיוק?"        <- again
 *
 * The tool wrote into working memory and nothing read it back — the state machine is advisory, so it
 * watched the call and told the model nothing. Her only record of what had been asked was the
 * transcript, and Soniox had rendered his answer as near-nonsense ("יש כאן עותק של בניית אתרים").
 *
 * Same root cause as the phone asked four times and the email three on 2026-08-22 — except those two
 * were worse: `KnownFacts` had no phone or email field at all, so the tool captured them and working
 * memory never even saw them.
 */

describe('formatKnownFacts', () => {
  it('says nothing when nothing is known', () => {
    // A call that has captured nothing must cost zero tokens — this is why the instruction rides with
    // the data instead of living in the system prompt.
    expect(formatKnownFacts({})).toBeNull();
    expect(formatKnownFacts({ name: '   ' })).toBeNull();
  });

  it('carries its own instruction, so the prompt needs no new section', () => {
    const line = formatKnownFacts({ businessType: 'חנות דיגיטלית' })!;
    expect(line).toMatch(/do NOT ask for any of these again/u);
    expect(line).toContain('business=חנות דיגיטלית');
  });

  it('includes phone and email — the two most-repeated questions', () => {
    const line = formatKnownFacts({ phone: '0509788845', email: 'koren@example.com' })!;
    expect(line).toContain('phone=0509788845');
    expect(line).toContain('email=koren@example.com');
  });

  it('lists only what is actually known', () => {
    const line = formatKnownFacts({ name: 'דני לוי', businessType: 'מוסך' })!;
    expect(line).toContain('name=דני לוי');
    expect(line).toContain('business=מוסך');
    expect(line).not.toMatch(/phone|email|budget|timing/u);
  });

  /**
   * Qualification is a label she assigns to the caller, not a fact he gave her. Reading "qualification
   * is warm" back to the model invites her to talk about it, and a lead who hears himself graded is a
   * lead who hangs up.
   */
  it('never surfaces the internal qualification label', () => {
    const line = formatKnownFacts({ businessType: 'מוסך', qualification: 'hot' })!;
    expect(line).not.toMatch(/hot|qualification/u);
  });
});

describe('the state machine end to end — the 2026-08-23 sequence', () => {
  it('a captured business type is visible on the next turn', () => {
    const sm = new CallStateMachine();

    expect(formatKnownFacts(sm.facts)).toBeNull(); // 41.1s — she asks, nothing known yet

    sm.onToolCall('capture_lead_info', true, { businessType: 'חנות דיגיטלית' }); // 53.0s

    const line = formatKnownFacts(sm.facts)!; // 69.2s — what she now sees before speaking
    expect(line).toContain('חנות דיגיטלית');
  });

  it('accumulates across turns and never loses an earlier fact', () => {
    const sm = new CallStateMachine();
    sm.onToolCall('capture_lead_info', true, { businessType: 'מוסך' });
    sm.onToolCall('capture_lead_info', true, { name: 'דני לוי' });
    sm.onToolCall('capture_lead_info', true, { phone: '0509788845' });

    const line = formatKnownFacts(sm.facts)!;
    expect(line).toContain('business=מוסך');
    expect(line).toContain('name=דני לוי');
    expect(line).toContain('phone=0509788845');
  });

  /**
   * `mergeFacts` already coalesces — a blank never erases. Pinned from this side too, because the
   * failure it prevents is the one that matters: a later tool call with a null phone must not make
   * her start asking for the phone again.
   */
  it('a later empty value does not erase what was captured', () => {
    const sm = new CallStateMachine();
    sm.onToolCall('capture_lead_info', true, { phone: '0509788845' });
    sm.onToolCall('capture_lead_info', true, { phone: undefined, name: 'דני' });

    expect(formatKnownFacts(sm.facts)!).toContain('phone=0509788845');
  });
});
