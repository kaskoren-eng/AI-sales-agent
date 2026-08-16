import { describe, expect, it } from 'vitest';
import { ACKNOWLEDGEMENTS_HE, dropEchoedOpener, pickAcknowledgement } from './acknowledgements.he.js';

/**
 * The acknowledgement is the ONLY thing that puts first audio under a second — end-of-turn ~400ms
 * plus the LLM's ~974ms time-to-first-token means a real answer cannot beat ~1.6s. So the phrase
 * set and the echo guard are load-bearing, not decoration.
 */
describe('acknowledgements', () => {
  it('never collides with the openers she actually uses on real calls', () => {
    // Observed on 2026-08-16: "בשמחה.", "מעולה.", "בטח.", "הבנתי.", "נשמע טוב.", "שאלה טובה."
    // Hearing the same word twice back-to-back is the failure mode this set is chosen to avoid.
    const openers = ['בשמחה', 'מעולה', 'בטח', 'הבנתי', 'נשמע', 'שאלה'];
    for (const ack of ACKNOWLEDGEMENTS_HE) {
      expect(openers).not.toContain(ack.replace(/[.,!?…]/gu, ''));
    }
  });

  it('never repeats itself twice running', () => {
    // These fire on EVERY turn, so a repeat is far more audible than it was for thinking fillers.
    for (const previous of ACKNOWLEDGEMENTS_HE) {
      for (let i = 0; i < 20; i++) expect(pickAcknowledgement(previous)).not.toBe(previous);
    }
  });
});

describe('dropEchoedOpener', () => {
  it('removes the model echoing the word we already said', () => {
    expect(dropEchoedOpener('אוקיי.', 'אוקיי, בהחלט. אנחנו בונים סוכני AI.')).toBe(
      'בהחלט. אנחנו בונים סוכני AI.',
    );
  });

  it('ignores punctuation differences between the two', () => {
    expect(dropEchoedOpener('כן.', 'כן! בטח.')).toBe('בטח.');
  });

  it('leaves a different opener completely alone', () => {
    const reply = 'בשמחה. אנחנו בונים סוכני AI.';
    expect(dropEchoedOpener('אוקיי.', reply)).toBe(reply);
  });

  it('does not touch the word later in the sentence', () => {
    // Only the FIRST word can be the echo. Anywhere else it is the model's own sentence.
    const reply = 'בטח, זה בסדר גמור.';
    expect(dropEchoedOpener('בסדר.', reply)).toBe(reply);
  });
});
