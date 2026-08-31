import { describe, expect, it } from 'vitest';
import { DICTATION_NODS } from './dictation.js';
import { countConsecutiveOpenerRepeats, countRepeatedOpeners } from './phrase-ledger.js';
import {
  ACKNOWLEDGEMENTS_HE,
  ACKNOWLEDGEMENTS_HE_WIDE,
  AcknowledgementLedger,
} from './prompts/acknowledgements.he.js';
import { THINKING_FILLERS_HE } from './prompts/thinking-fillers.he.js';
import { SpokenOpenerTracker, observeFirstOpener, openerKey, readLeadingOpener } from './spoken-openers.js';
import { chooseTurnOpener } from './turn-opener.js';

/**
 * ROUND-7 CARD `n6b`, 2026-08-31. Koren picked the earned acknowledgement ("אוקיי. זה באמת מתסכל…"
 * over "הבנתי אותךָ. זה באמת מתסכל…") and added a note:
 *
 *     "צריך לוודא שהסוכן לא חוזר על אותה מילה כל פעם בתחילת המשפט ('אוקיי')"
 *
 * The first job was to find out whether the rotation we already had could produce that, and the
 * answer is no — see the simulation below, which is the diagnosis this change rests on.
 */
describe('the acknowledgement deck was already clean — the diagnosis, as a test', () => {
  it('never hands out the same receipt twice running, in any of its four configurations', () => {
    // This is the probe that was run before anything was changed, at 1/200th the sample size so it
    // stays a fast unit test. At 20,000 x 40 it also returned zero in all four rows.
    const configs: Array<[string, () => AcknowledgementLedger, () => boolean]> = [
      ['3-word deck, never earned', () => new AcknowledgementLedger(), () => false],
      ['3-word deck, always earned', () => new AcknowledgementLedger(), () => true],
      ['3-word deck, sometimes earned', () => new AcknowledgementLedger(), () => Math.random() < 0.4],
      [
        'WIDE 5-word deck (VOICE_ACK_EARNED_ENABLED=false)',
        () => new AcknowledgementLedger(ACKNOWLEDGEMENTS_HE_WIDE),
        () => false,
      ],
    ];
    for (const [label, make, earned] of configs) {
      let consecutive = 0;
      for (let call = 0; call < 100; call++) {
        const ledger = make();
        let previous: string | null = null;
        for (let turn = 0; turn < 40; turn++) {
          const word = ledger.next({ earned: earned() });
          if (word === previous) consecutive++;
          previous = word;
        }
      }
      expect(`${label}: ${consecutive}`).toBe(`${label}: 0`);
    }
  });
});

describe('SpokenOpenerTracker — the memory that made the comparison expressible', () => {
  it('starts with nothing to avoid', () => {
    expect(new SpokenOpenerTracker().avoid).toBeNull();
  });

  it('compares on the first word, so our "אוקיי." and the model\'s "אוקיי, אז…" are one opener', () => {
    const tracker = new SpokenOpenerTracker();
    tracker.record('אוקיי.');
    expect(tracker.repeats('אוקיי, אז בוא נבדוק')).toBe(true);
    expect(tracker.repeats('בסדר.')).toBe(false);
  });

  it('a compound receipt is remembered by the word the caller heard first', () => {
    const tracker = new SpokenOpenerTracker();
    tracker.record('טוב, הבנתי.');
    expect(tracker.avoid).toBe('טוב');
    expect(tracker.repeats('טוב, הבנתי.')).toBe(true);
  });

  it('a reply that opened with no sound CLEARS the memory rather than keeping a stale one', () => {
    const tracker = new SpokenOpenerTracker();
    tracker.record('אוקיי.');
    tracker.record(null);
    expect(tracker.avoid).toBeNull();
    expect(tracker.repeats('אוקיי.')).toBe(false);
  });

  it('niqqud is not part of an opener — speech-guard adds it on the way to the TTS', () => {
    expect(openerKey('לוודֵא')).toBe(openerKey('לוודא'));
  });
});

describe('readLeadingOpener — only a word punctuated off from what follows', () => {
  it('reads the opener the caller hears', () => {
    expect(readLeadingOpener('מעולה. אז בוא נקבע')).toBe('מעולה');
    expect(readLeadingOpener('אוקיי, אז בוא נקבע')).toBe('אוקיי');
  });

  it('a sentence that simply runs on has no opener', () => {
    expect(readLeadingOpener('בוא נקבע שיחת דמו קצרה')).toBeNull();
  });

  it('a number is not a reaction word', () => {
    expect(readLeadingOpener('050. אחת עשרה')).toBeNull();
  });
});

describe('observeFirstOpener — observes, never buffers', () => {
  it('reports the model\'s first word and passes every chunk through untouched', async () => {
    const chunks = ['מעולה. ', 'אז בוא ', 'נקבע.'];
    const seen: Array<string | null> = [];
    const out: string[] = [];
    for await (const chunk of observeFirstOpener(
      (async function* () {
        yield* chunks;
      })(),
      (word) => seen.push(word),
    )) {
      out.push(chunk);
    }
    expect(out).toEqual(chunks);
    expect(seen).toEqual(['מעולה']);
  });

  it('reports null when the first chunk carries no opener — nothing is at the head', async () => {
    const seen: Array<string | null> = [];
    for await (const _ of observeFirstOpener(
      (async function* () {
        yield 'בוא נקבע ';
        yield 'שיחה.';
      })(),
      (word) => seen.push(word),
    )) {
      // drain
    }
    expect(seen).toEqual([null]);
  });
});

/**
 * The rule itself, at the one function that chooses every opening sound the agent produces.
 */
describe('chooseTurnOpener — the same word never opens two replies running', () => {
  const anyFiller = () => THINKING_FILLERS_HE[0]!;

  it('the receipt deck refuses the word the caller just heard, whoever said it', () => {
    // The previous head-word here came from the MODEL, not from the deck — exactly the case the
    // deck could not see. Repeated because the deck is shuffled.
    for (let i = 0; i < 200; i++) {
      const ledger = new AcknowledgementLedger();
      const opener = chooseTurnOpener({
        afterToolCall: false,
        fillersEnabled: true,
        avoidOpener: 'אוקיי',
        nextAck: (opts) => ledger.next(opts),
        offerFiller: anyFiller,
      });
      expect((opener as { word: string }).word).not.toBe('אוקיי.');
    }
  });

  it('an earned comprehension claim is refused too when it would repeat', () => {
    for (let i = 0; i < 200; i++) {
      const ledger = new AcknowledgementLedger();
      const opener = chooseTurnOpener({
        afterToolCall: false,
        fillersEnabled: true,
        callerShared: true,
        avoidOpener: 'טוב, הבנתי.',
        nextAck: (opts) => ledger.next(opts),
        offerFiller: anyFiller,
      });
      expect((opener as { word: string }).word).not.toBe('טוב, הבנתי.');
    }
  });

  it('THE ONE THAT COULD NOT ROTATE, AND NOW CAN: a second dictation nod picks another sound', () => {
    // This test used to assert SILENCE. The nod was one constant, so a phone number followed by an
    // email said the same sound twice by construction, and the only repair available was to say
    // nothing on the second turn. Koren's round-11 verdict is three sounds used at random, which
    // removes the cause — so the honest assertion now is that the second turn still NODS, with a
    // different sound, through the same `avoidOpener` window every other opening sound uses.
    for (const heard of DICTATION_NODS) {
      const opener = chooseTurnOpener({
        afterToolCall: false,
        fillersEnabled: true,
        midDictation: true,
        nods: DICTATION_NODS,
        avoidOpener: heard,
        nextAck: () => {
          throw new Error('must not fall back to a receipt in the middle of a dictation');
        },
        offerFiller: anyFiller,
      });
      expect(opener.kind, heard).toBe('nod');
      expect((opener as { word: string }).word, heard).not.toBe(heard);
    }
  });

  it('...and falls SILENT rather than acknowledge if the bank is ever cut back to one', () => {
    // The fail-safe branch, still reachable and still correct: a receipt mid-dictation is the very
    // interruption the nod exists to prevent (he said "050-", she said "טוב, הבנתי.").
    const opener = chooseTurnOpener({
      afterToolCall: false,
      fillersEnabled: true,
      midDictation: true,
      nods: [DICTATION_NODS[0]],
      avoidOpener: DICTATION_NODS[0],
      nextAck: () => {
        throw new Error('must not fall back to a receipt in the middle of a dictation');
      },
      offerFiller: anyFiller,
    });
    expect(opener.kind).toBe('silent');
  });

  it('A RECEIPT ON THE PREVIOUS TURN BLOCKS THE NOD THAT IS THE SAME SOUND', () => {
    // `אֶמ.` (a nod) and `אמ.` (a receipt) differ by one mark and are one sound to a listener.
    // `openerKey` strips niqqud, so they are one key here — which is exactly why the nod goes
    // through the SHARED no-repeat window instead of a parallel one of its own.
    for (let i = 0; i < 200; i++) {
      const opener = chooseTurnOpener({
        afterToolCall: false,
        fillersEnabled: true,
        midDictation: true,
        nods: DICTATION_NODS,
        avoidOpener: 'אמ.',
        nextAck: () => 'אוקי.',
        offerFiller: anyFiller,
      });
      expect((opener as { word: string }).word).not.toBe('אֶמ.');
    }
  });

  it('the first dictation turn still nods — the rule only fires on a repeat', () => {
    const opener = chooseTurnOpener({
      afterToolCall: false,
      fillersEnabled: true,
      midDictation: true,
      nods: DICTATION_NODS,
      avoidOpener: 'אוקיי',
      nextAck: () => 'אוקיי.',
      offerFiller: anyFiller,
    });
    expect(opener.kind).toBe('nod');
    expect([...DICTATION_NODS]).toContain((opener as { word: string }).word);
  });

  it('a hesitation that would repeat is withheld unspoken, so the budget survives', () => {
    let offered = 0;
    const opener = chooseTurnOpener({
      afterToolCall: true,
      fillersEnabled: true,
      avoidOpener: 'רגע...',
      nextAck: () => 'אוקיי.',
      offerFiller: () => {
        offered++;
        return 'רגע...';
      },
    });
    expect(opener.kind).toBe('silent');
    // offer() costs nothing; only commit() spends. See ThinkingFillerLedger.
    expect(offered).toBe(1);
  });

  it('VOICE_OPENER_NO_REPEAT_ENABLED=false (avoidOpener null) restores the old behaviour', () => {
    // With the rule off the agent passes null, and the nod fires even on a repeat.
    const opener = chooseTurnOpener({
      afterToolCall: false,
      fillersEnabled: true,
      midDictation: true,
      nods: DICTATION_NODS,
      avoidOpener: null,
      nextAck: () => 'אוקיי.',
      offerFiller: anyFiller,
    });
    expect(opener.kind).toBe('nod');
    expect([...DICTATION_NODS]).toContain((opener as { word: string }).word);
  });

  it('end to end: forty turns of every mechanism, and no two adjacent openers match', () => {
    const tracker = new SpokenOpenerTracker();
    const ledger = new AcknowledgementLedger();
    const spoken: string[] = [];
    for (let turn = 0; turn < 40; turn++) {
      const opener = chooseTurnOpener({
        afterToolCall: turn % 5 === 0,
        fillersEnabled: true,
        // Two dictation turns in a row on purpose — the phone number, then the email.
        midDictation: turn % 7 === 3 || turn % 7 === 4,
        nods: DICTATION_NODS,
        callerShared: turn % 3 === 0,
        avoidOpener: tracker.avoid,
        nextAck: (opts) => ledger.next(opts),
        offerFiller: () => THINKING_FILLERS_HE[turn % THINKING_FILLERS_HE.length]!,
      });
      if (opener.kind === 'silent') {
        tracker.record(null);
        continue;
      }
      tracker.record(opener.word);
      spoken.push(`${opener.word} משהו לומר.`);
    }
    // Measured with the report's own metric, on lines shaped like the transcript it reads.
    expect(countConsecutiveOpenerRepeats(spoken)).toBe(0);
  });
});

/**
 * WHY THE OLD METRIC COULD NOT MOVE — the reason a new one was needed rather than a harder look at
 * the old one.
 */
describe('countConsecutiveOpenerRepeats vs countRepeatedOpeners', () => {
  const say = (openers: string[]): string[] => openers.map((o) => `${o} ואז המשפט עצמו.`);

  it('the old metric scores perfect rotation and the same word every turn IDENTICALLY', () => {
    const rotated = say(['אוקיי.', 'אהה.', 'בסדר.', 'אוקיי.', 'אהה.', 'בסדר.']);
    const stuck = say(['אוקיי.', 'אוקיי.', 'אהה.', 'אהה.', 'בסדר.', 'בסדר.']);
    expect(countRepeatedOpeners(rotated)).toBe(3);
    expect(countRepeatedOpeners(stuck)).toBe(3);
    // ...and the new one tells them apart, which is the whole point.
    expect(countConsecutiveOpenerRepeats(rotated)).toBe(0);
    expect(countConsecutiveOpenerRepeats(stuck)).toBe(3);
  });

  it('a line with no opener breaks a run rather than joining it', () => {
    expect(
      countConsecutiveOpenerRepeats([
        'אוקיי. ואז המשפט.',
        'בוא נקבע שיחה קצרה',
        'אוקיי. ואז המשפט.',
      ]),
    ).toBe(0);
  });

  it('every word in the receipt bank is counted the same way', () => {
    for (const word of ACKNOWLEDGEMENTS_HE) {
      expect(countConsecutiveOpenerRepeats(say([word, word]))).toBe(1);
    }
  });
});
