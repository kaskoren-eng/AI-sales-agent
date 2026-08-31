import { describe, expect, it } from 'vitest';
import {
  ACKNOWLEDGEMENTS_HE,
  ACKNOWLEDGEMENTS_HE_WIDE,
  ACK_COMPREHENSION_HE,
  AcknowledgementLedger,
  dropEchoedOpener,
  pickAcknowledgement,
} from './acknowledgements.he.js';

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

  it('never contains a word that could be heard as an ANSWER', () => {
    // 2026-08-29, live: Koren asked "מה המצב, קרן?" and the call replied "כן." — the acknowledgement
    // landing on a QUESTION, where it stops being a receipt and becomes a wrong answer. A receipt
    // has to survive being read back after a question, not only after a statement.
    const answers = ['כן', 'לא', 'נכון', 'בטח', 'אולי'];
    for (const ack of ACKNOWLEDGEMENTS_HE) {
      expect(answers).not.toContain(ack.replace(/[.,!?…]/gu, ''));
    }
  });

  it('keeps enough variety for the no-repeat rule to be reachable', () => {
    expect(ACKNOWLEDGEMENTS_HE.length).toBeGreaterThanOrEqual(3);
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

/**
 * P1-1. `repeatedPhraseCount` read 0 on a call where six of eight turns opened with one of three
 * words. The counter is fixed in phrase-ledger.ts; this is the other half — making there be less
 * to count.
 */
describe('the widened bank', () => {
  it('holds every original word, so the switch-off path is a strict subset', () => {
    for (const ack of ACKNOWLEDGEMENTS_HE) expect(ACKNOWLEDGEMENTS_HE_WIDE).toContain(ack);
  });

  it('every new member obeys the two rules the original three were chosen by', () => {
    // Never a word she opens replies with herself (2026-08-16 observations)…
    const herOpeners = ['בשמחה', 'מעולה', 'בטח', 'הבנתי', 'נשמע', 'שאלה'];
    // …and never a word that could be heard as an ANSWER to a question ("כן." — 2026-08-29).
    const answers = ['כן', 'לא', 'נכון', 'בטח', 'אולי', 'טוב'];
    for (const ack of ACKNOWLEDGEMENTS_HE_WIDE) {
      const bare = ack.replace(/[.,!?…]/gu, '');
      expect(herOpeners).not.toContain(bare);
      expect(answers).not.toContain(bare);
    }
  });
});

describe('AcknowledgementLedger — a deck, not a dice roll', () => {
  it('spends every word once before repeating any', () => {
    const ledger = new AcknowledgementLedger(ACKNOWLEDGEMENTS_HE_WIDE);
    const round = ACKNOWLEDGEMENTS_HE_WIDE.map(() => ledger.next());
    expect(new Set(round).size).toBe(ACKNOWLEDGEMENTS_HE_WIDE.length);
    expect(ledger.repeatedCount).toBe(0);
  });

  it('never says the same word twice running, including across a refill', () => {
    // The refill boundary is the only place a deck CAN repeat, so it is the only place worth
    // testing hard. Every seed, not one lucky one.
    for (let seed = 0; seed < 50; seed++) {
      let n = seed;
      const ledger = new AcknowledgementLedger(ACKNOWLEDGEMENTS_HE_WIDE, () => {
        n = (n * 1103515245 + 12345) % 2147483648;
        return n / 2147483648;
      });
      let previous: string | null = null;
      for (let i = 0; i < 40; i++) {
        const word = ledger.next();
        expect(word).not.toBe(previous);
        previous = word;
      }
    }
  });

  it('THE 2026-08-29 SHAPE: eight turns, and no word is heard more than twice', () => {
    const ledger = new AcknowledgementLedger(ACKNOWLEDGEMENTS_HE_WIDE);
    const spoken = Array.from({ length: 8 }, () => ledger.next());
    const counts = new Map<string, number>();
    for (const w of spoken) counts.set(w, (counts.get(w) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    // Three words over eight turns cannot beat "each one twice"; five can, and does.
    expect(ledger.repeatedCount).toBeLessThanOrEqual(3);
  });

  it('counts its own repeats — the number the call report was missing', () => {
    const ledger = new AcknowledgementLedger(['א.', 'ב.']);
    ledger.next();
    ledger.next();
    expect(ledger.repeatedCount).toBe(0);
    ledger.next();
    ledger.next();
    expect(ledger.repeatedCount).toBe(2);
  });

  it('a one-word bank degrades rather than looping forever', () => {
    const ledger = new AcknowledgementLedger(['אוקיי.']);
    expect(ledger.next()).toBe('אוקיי.');
    expect(ledger.next()).toBe('אוקיי.');
  });
});

/**
 * NOTE 6, 2026-08-31. `repeatedPhraseCount: 34` on a ten-minute call, and Koren's ear agreed:
 * *"הסוכן אמר 'טוב, הבנתי' או 'הבנתי אותך' יותר מדי פעמים, וצריך באמת להגיע בהקשר כשהלקוח משתף
 * מידע שרלוונטי לשיחה. לא סתם להגיד 'טוב, הבנתי' על כל דבר."*
 */
describe('the comprehension claim has to be earned', () => {
  const isClaim = (word: string): boolean =>
    (ACK_COMPREHENSION_HE as readonly string[]).includes(word);

  it('is never spoken on an ordinary turn, however many turns go by', () => {
    const ledger = new AcknowledgementLedger();
    for (let i = 0; i < 40; i++) expect(isClaim(ledger.next())).toBe(false);
  });

  it('is available the moment the caller actually told her something', () => {
    const ledger = new AcknowledgementLedger();
    expect(isClaim(ledger.next({ earned: true }))).toBe(true);
  });

  it('never twice running, even when every single turn earns one', () => {
    const ledger = new AcknowledgementLedger();
    const spoken = Array.from({ length: 12 }, () => ledger.next({ earned: true }));
    for (let i = 1; i < spoken.length; i++) {
      expect(
        isClaim(spoken[i]!) && isClaim(spoken[i - 1]!),
        `${spoken[i - 1]} then ${spoken[i]}`,
      ).toBe(false);
    }
    // …so even the most generous caller hears one on at most half his turns.
    expect(spoken.filter(isClaim).length).toBeLessThanOrEqual(6);
  });

  it('the kill-switch path is the OLD behaviour exactly — a flat five-word deck', () => {
    // VOICE_ACK_EARNED_ENABLED=false constructs it this way (agent.ts). The comprehension words are
    // deck members again, and `earned` must not double-offer them from a second deck.
    const ledger = new AcknowledgementLedger(ACKNOWLEDGEMENTS_HE_WIDE);
    const round = ACKNOWLEDGEMENTS_HE_WIDE.map(() => ledger.next({ earned: true }));
    expect(new Set(round).size).toBe(ACKNOWLEDGEMENTS_HE_WIDE.length);
  });

  it('the two banks are disjoint, and together they are the wide bank', () => {
    for (const claim of ACK_COMPREHENSION_HE) {
      expect(ACKNOWLEDGEMENTS_HE as readonly string[]).not.toContain(claim);
      expect(ACKNOWLEDGEMENTS_HE_WIDE as readonly string[]).toContain(claim);
    }
    expect(ACKNOWLEDGEMENTS_HE_WIDE.length).toBe(
      ACKNOWLEDGEMENTS_HE.length + ACK_COMPREHENSION_HE.length,
    );
  });
});
