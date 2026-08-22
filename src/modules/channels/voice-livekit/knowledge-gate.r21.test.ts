import { describe, it, expect } from 'vitest';
import { decideRetrieval, isContactData } from './knowledge-gate.js';

/**
 * R2.1 GATE TIGHTENING — every utterance in this file is VERBATIM from the 2026-08-22 real call
 * (`call-reports/2026-08-22T11-42-13-377Z.json`), not invented.
 *
 * That call measured 28 of 40 retrievals (70%) returning nothing usable, for 7,645ms of embedding and
 * DB work: 22 in `qualifying`, 14 in `scheduling`, 4 in `discovery`. Reading the transcript against
 * the log shows one cause behind nearly all of them — the caller was ANSWERING her, not asking
 * anything. There is no fact in a knowledge base that answers "050".
 *
 * The two rules are deliberately narrow. A false positive means a real question silently goes
 * un-grounded, which is the expensive failure; a false negative costs one embedding, which is the
 * cheap one. When in doubt these rules let the turn through.
 */

const on = (transcript: string, lastAgentTurn: string | null = null) =>
  decideRetrieval({ enabled: true, ragActive: true, transcript, lastAgentTurn });

describe('isContactData — shapes that cannot be a question', () => {
  it('catches a phone number arriving in pieces, as Soniox delivers it', () => {
    // Real fragments from the call: she asked four times because they arrived like this.
    for (const t of ['050.', '9788.  8.  45.', '052-3.  48.', '678.']) {
      expect(isContactData(t), t).toBe(true);
    }
  });

  it('catches an email being spelled out', () => {
    for (const t of ['K-A-S קורן, שטרודל gmail נקודה com.', 'danilevi@gmail.  Com.']) {
      expect(isContactData(t), t).toBe(true);
    }
  });

  /** The expensive direction. These MUST still retrieve. */
  it('does not catch questions that merely mention email or numbers', () => {
    for (const t of [
      'מה כתובת המייל שלכם ואיך שולחים אליכם חומרים?',
      'כמה זה עולה בחודש?',
      'אני מקבל בערך שישים פניות בחודש',
      'תוך כמה זמן זה נכנס לפעולה?',
    ]) {
      expect(isContactData(t), t).toBe(false);
    }
  });
});

describe('decideRetrieval — answering_agent', () => {
  it('skips a short answer to her contact question', () => {
    // Verbatim: she asked "רק לוודא — מה השם המלא?" and he replied with his name.
    expect(on('קורן שטרית.', 'מצוין. רק לוודא — מה השם המלא?').reason).toBe('answering_agent');
    expect(on('דני לוי.', 'נעים מאוד. מה השם המלא?').retrieve).toBe(false);
  });

  it('skips a name given after she asked who she is speaking to', () => {
    expect(on('שלי הוא קורן.', 'הבנתי. לפני הכל — עם מי אני מדברת?').reason).toBe('answering_agent');
  });

  /**
   * THE GUARD THAT MAKES THE RULE SAFE. A turn can be an answer AND a question, and the question is
   * the half that matters — she must still be able to answer it.
   */
  it('still retrieves when the answer carries a question with it', () => {
    expect(on('קורן. ותוך כמה זמן זה נכנס לפעולה?', 'מה השם המלא?').reason).toBe('ok');
    expect(on('דני לוי, ואגב כמה זה עולה בחודש בדיוק?', 'מה השם המלא?').reason).toBe('ok');
  });

  it('does nothing when her last turn was not a contact question', () => {
    expect(on('קורן שטרית.', 'נשמע שיש פה מקום טוב לשיפור.').reason).toBe('ok');
  });

  it('does nothing when her last turn is unknown', () => {
    expect(on('קורן שטרית.', null).reason).toBe('ok');
  });
});

describe('decideRetrieval — the R2.1 rules do not weaken the R2 ones', () => {
  it('still retrieves for an objection phrased as a statement', () => {
    // The reason the gate skips acknowledgements rather than non-questions. Unchanged by R2.1.
    expect(on('זה יקר לי.').reason).toBe('ok');
    expect(on('אני לא חושב שAI יכול לעשות את זה.').reason).toBe('ok');
  });

  it('still skips bare acknowledgements', () => {
    expect(on('אוקיי').reason).toBe('acknowledgement');
    expect(on('כן').reason).toBe('acknowledgement');
  });

  it('still closes on the phase gate', () => {
    expect(decideRetrieval({ enabled: true, ragActive: false, transcript: 'כמה זה עולה' }).reason).toBe('phase_gate');
  });

  /** Order matters for readability of a call log: an acknowledgement must not report as contact data. */
  it('reports the most specific reason', () => {
    expect(on('כן').reason).toBe('acknowledgement');
    expect(on('050.').reason).toBe('contact_data');
  });
});
