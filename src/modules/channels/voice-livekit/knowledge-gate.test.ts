import { describe, it, expect } from 'vitest';
import { isAcknowledgement, decideRetrieval } from './knowledge-gate.js';

describe('isAcknowledgement', () => {
  it('skips bare acknowledgements, with or without punctuation', () => {
    for (const utterance of ['כן', 'כן.', 'בסדר', 'אוקיי, ', 'תודה', 'ok', 'OK', 'הבנתי']) {
      expect(isAcknowledgement(utterance), utterance).toBe(true);
    }
  });

  it('treats an empty or whitespace utterance as nothing to look up', () => {
    expect(isAcknowledgement('')).toBe(true);
    expect(isAcknowledgement('   ')).toBe(true);
  });

  it('does NOT skip an acknowledgement that carries a real question behind it', () => {
    expect(isAcknowledgement('כן, אבל כמה זה עולה')).toBe(false);
    expect(isAcknowledgement('אוקיי אז מה השלב הבא בתהליך')).toBe(false);
  });
});

describe('decideRetrieval — the two-layer gate', () => {
  const base = { enabled: true, ragActive: true };

  it('retrieves for an ordinary question', () => {
    expect(decideRetrieval({ ...base, transcript: 'כמה זה עולה' })).toEqual({ retrieve: true, reason: 'ok' });
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR.
   *
   * The RAG plan proposed skipping "non-questions". Hebrew objections are statements, and objection
   * answers are exactly what moved into the knowledge base — so a question-gate would silently
   * suppress retrieval on the turns that decide whether the call is won. Every utterance below is a
   * statement, and every one must retrieve.
   */
  it('retrieves for objections, which are STATEMENTS and not questions', () => {
    for (const objection of [
      'זה יקר לי',
      'אני לא חושב שAI יכול לעשות את זה',
      'אני מעדיף שאדם אמיתי יחזור אליהם',
      'הלקוחות שלי יזהו שזה רובוט',
      'אני רוצה לחשוב על זה',
    ]) {
      expect(decideRetrieval({ ...base, transcript: objection }), objection).toEqual({
        retrieve: true,
        reason: 'ok',
      });
    }
  });

  it('does not retrieve when the global flag is off', () => {
    expect(decideRetrieval({ enabled: false, ragActive: true, transcript: 'כמה זה עולה' })).toEqual({
      retrieve: false,
      reason: 'rag_disabled',
    });
  });

  it('does not retrieve when the phase gate is closed', () => {
    expect(decideRetrieval({ enabled: true, ragActive: false, transcript: 'כמה זה עולה' })).toEqual({
      retrieve: false,
      reason: 'phase_gate',
    });
  });

  it('does not retrieve on an acknowledgement', () => {
    expect(decideRetrieval({ ...base, transcript: 'כן' })).toEqual({
      retrieve: false,
      reason: 'acknowledgement',
    });
  });

  it('does not retrieve on a mid-word STT fragment', () => {
    expect(decideRetrieval({ ...base, transcript: 'מ' }).reason).toBe('too_short');
  });

  it('checks the flag before the phase, so the log names the outermost reason', () => {
    expect(decideRetrieval({ enabled: false, ragActive: false, transcript: 'כן' }).reason).toBe('rag_disabled');
  });
});
