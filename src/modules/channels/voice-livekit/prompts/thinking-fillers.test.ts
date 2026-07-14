import { describe, expect, it } from 'vitest';
import { THINKING_FILLERS_HE, pickThinkingFiller } from './thinking-fillers.he.js';

describe('thinking fillers', () => {
  it('never repeats the same filler twice in a row', () => {
    // "אממ... אממ..." is not thinking, it is a stuck record — and it is the fastest way to make her
    // sound like a machine again, which is the exact thing this feature exists to prevent.
    for (const previous of THINKING_FILLERS_HE) {
      for (let i = 0; i < 30; i++) {
        expect(pickThinkingFiller(previous)).not.toBe(previous);
      }
    }
  });

  it('always returns something (never undefined) on the first turn', () => {
    expect(THINKING_FILLERS_HE).toContain(pickThinkingFiller(null));
  });

  it('is a NOISE, not a sentence — no promises she might not keep', () => {
    // Koren asked for "not the full sentence, just the noise that people do when they think".
    // A filler that says "I'll check that for you" is a REPLY, and it commits her to something.
    for (const f of THINKING_FILLERS_HE) {
      const words = f.replace(/\.{2,}/gu, '').trim().split(/\s+/u);
      expect(words.length).toBeLessThanOrEqual(4);
      expect(f).not.toMatch(/\?/u); // a question is a turn hand-back, not a hesitation
    }
  });

  it('is short — the real answer queues BEHIND the filler, so a long one lengthens the wait', () => {
    for (const f of THINKING_FILLERS_HE) {
      expect(f.length).toBeLessThanOrEqual(22);
    }
  });

  it('is Hebrew that Israelis actually say, not translated English', () => {
    // "ובכן" would be correct Hebrew and would sound like a newsreader. These are speech.
    expect(THINKING_FILLERS_HE).toContain('אממ...');
    expect(THINKING_FILLERS_HE).toContain('רגע...');
    for (const f of THINKING_FILLERS_HE) {
      expect(f).toMatch(/[֐-׿]/u);
    }
  });
});
