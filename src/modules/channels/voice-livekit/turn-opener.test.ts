import { describe, expect, it } from 'vitest';
import {
  ACKNOWLEDGEMENTS_HE,
  ACKNOWLEDGEMENTS_HE_WIDE,
  pickAcknowledgement,
} from './prompts/acknowledgements.he.js';
import { THINKING_FILLERS_HE } from './prompts/thinking-fillers.he.js';
import {
  ACK_COMPREHENSION_HE,
  AcknowledgementLedger,
} from './prompts/acknowledgements.he.js';
import {
  allowsArmedFiller,
  chooseTurnOpener,
  chunkCallsTool,
  mayPairInOneBreath,
  openingSoundCategory,
} from './turn-opener.js';
import { DICTATION_NOD } from './dictation.js';

/**
 * The regression net for the 2026-08-29 call — "אהה." alone, 5.4 seconds of nothing, then
 * "אוקיי. כמה פניות נכנסות אליךָ ביום…". Two of OUR words around a tool call, which Koren heard
 * as a script. See turn-opener.ts for the full mechanism.
 */
describe('chooseTurnOpener — a tool call changes what she says next', () => {
  const anyFiller = () => THINKING_FILLERS_HE[0]!;

  it('opens a fresh turn with an acknowledgement — the <1s mechanism is untouched', () => {
    const opener = chooseTurnOpener({
      afterToolCall: false,
      fillersEnabled: true,
      nextAck: () => pickAcknowledgement(null),
      offerFiller: anyFiller,
    });
    expect(opener.kind).toBe('ack');
    expect(ACKNOWLEDGEMENTS_HE).toContain((opener as { word: string }).word);
  });

  it('never acknowledges the caller TWICE on one turn — a post-tool step hesitates instead', () => {
    // This is the bug. The caller was already told "I heard you" on the step that called the tool;
    // a second receipt after the tool returns is the duplicate word around the hole.
    const opener = chooseTurnOpener({
      afterToolCall: true,
      fillersEnabled: true,
      nextAck: () => pickAcknowledgement('אוקיי.'),
      offerFiller: anyFiller,
    });
    expect(opener.kind).toBe('hesitation');
    expect(THINKING_FILLERS_HE).toContain((opener as { word: string }).word);
  });

  it('says NOTHING when the call has spent its hesitations — silence beats a stray word', () => {
    const opener = chooseTurnOpener({
      afterToolCall: true,
      fillersEnabled: true,
      nextAck: () => pickAcknowledgement('אוקיי.'),
      offerFiller: () => null,
    });
    expect(opener.kind).toBe('silent');
  });

  it('respects the thinking-filler kill-switch (VOICE_THINKING_FILLER_MS=0) — silent, not a receipt', () => {
    const opener = chooseTurnOpener({
      afterToolCall: true,
      fillersEnabled: false,
      nextAck: () => pickAcknowledgement('אוקיי.'),
      offerFiller: () => {
        throw new Error('must not be consulted when fillers are off');
      },
    });
    expect(opener.kind).toBe('silent');
  });

  it('asks the SUPPLIER for the word — the deck, or the random pick, is the agent choice', () => {
    // chooseTurnOpener decides WHETHER a receipt is the right sound here. WHICH receipt is a
    // per-call decision (AcknowledgementLedger when VOICE_ACK_LEDGER_ENABLED, pickAcknowledgement
    // when not), so this function must not reach for a bank of its own.
    const opener = chooseTurnOpener({
      afterToolCall: false,
      fillersEnabled: true,
      nextAck: () => 'בדיוק כמו שביקשת.',
      offerFiller: anyFiller,
    });
    expect(opener).toEqual({ kind: 'ack', word: 'בדיוק כמו שביקשת.' });
  });

  it('never consults the supplier on a post-tool step — that step must not acknowledge again', () => {
    const opener = chooseTurnOpener({
      afterToolCall: true,
      fillersEnabled: true,
      nextAck: () => {
        throw new Error('must not be consulted after a tool call');
      },
      offerFiller: anyFiller,
    });
    expect(opener.kind).toBe('hesitation');
  });

  it('never repeats the previous acknowledgement back-to-back', () => {
    for (const previous of ACKNOWLEDGEMENTS_HE) {
      for (let i = 0; i < 20; i++) {
        const opener = chooseTurnOpener({
          afterToolCall: false,
          fillersEnabled: true,
          nextAck: () => pickAcknowledgement(previous),
          offerFiller: anyFiller,
        });
        expect((opener as { word: string }).word).not.toBe(previous);
      }
    }
  });
});

/**
 * The 2026-08-30 half: he was still reading out his phone number and she answered the first half
 * with a complete sentence. See dictation.ts.
 */
describe('chooseTurnOpener — the caller is still reading out a number', () => {
  const anyFiller = () => THINKING_FILLERS_HE[0]!;
  const nodded = (over: Partial<Parameters<typeof chooseTurnOpener>[0]> = {}) =>
    chooseTurnOpener({
      afterToolCall: false,
      fillersEnabled: true,
      midDictation: true,
      nod: DICTATION_NOD,
      nextAck: () => pickAcknowledgement(null),
      offerFiller: anyFiller,
      ...over,
    });

  it('nods instead of acknowledging — "טוב, הבנתי." mid-number was the bug', () => {
    const opener = nodded();
    expect(opener.kind).toBe('nod');
    expect((opener as { word: string }).word).toBe(DICTATION_NOD);
  });

  it('does not spend an acknowledgement from the deck — the nod is a different act', () => {
    let drawn = 0;
    nodded({ nextAck: () => { drawn++; return 'אוקיי.'; } });
    expect(drawn).toBe(0);
  });

  it('does not spend a thinking filler either — it is not a hesitation', () => {
    let offered = 0;
    nodded({ offerFiller: () => { offered++; return THINKING_FILLERS_HE[0]!; } });
    expect(offered).toBe(0);
  });

  it('a post-tool step still hesitates — that step is not answering a caller turn at all', () => {
    // The tool branch is checked FIRST on purpose: nothing was said to her between the two steps,
    // so "was he dictating?" is not the question being asked there.
    const opener = nodded({ afterToolCall: true });
    expect(opener.kind).toBe('hesitation');
  });

  it('VOICE_DICTATION_NOD_ENABLED=false restores the receipt exactly', () => {
    // The agent passes midDictation:false when the switch is off — the ONLY difference.
    const opener = nodded({ midDictation: false });
    expect(opener.kind).toBe('ack');
  });

  it('falls back to a receipt when no nod word is supplied', () => {
    expect(nodded({ nod: undefined }).kind).toBe('ack');
  });
});

/**
 * NOTE 6, 2026-08-31 — WHICH receipt, not whether. See ACK_COMPREHENSION_HE.
 */
describe('chooseTurnOpener — a comprehension claim needs the caller to have said something', () => {
  const openWith = (callerShared: boolean, ledger: AcknowledgementLedger): string => {
    const opener = chooseTurnOpener({
      afterToolCall: false,
      fillersEnabled: true,
      callerShared,
      nextAck: (opts) => ledger.next(opts),
      offerFiller: () => THINKING_FILLERS_HE[0]!,
    });
    return (opener as { word: string }).word;
  };

  it('hands the permission through to the supplier, and withholds it by default', () => {
    const ledger = new AcknowledgementLedger();
    expect(ACK_COMPREHENSION_HE as readonly string[]).toContain(openWith(true, ledger));
    const plain = new AcknowledgementLedger();
    expect(ACK_COMPREHENSION_HE as readonly string[]).not.toContain(openWith(false, plain));
  });

  it('omitting callerShared entirely is the same as "he did not" — no signal, no claim', () => {
    const ledger = new AcknowledgementLedger();
    const opener = chooseTurnOpener({
      afterToolCall: false,
      fillersEnabled: true,
      nextAck: (opts) => ledger.next(opts),
      offerFiller: () => THINKING_FILLERS_HE[0]!,
    });
    expect(ACK_COMPREHENSION_HE as readonly string[]).not.toContain(
      (opener as { word: string }).word,
    );
  });
});

/**
 * ROUND-7 CARD `n4a`, 2026-08-31 — and the reason this block was rewritten rather than extended.
 *
 * Note 4 said *"מילת מילוי צריכה להגיע באופן חד פעמי בכל משפט"* and we shipped a hard cap: only a
 * `silent` opener could carry an armed hesitation. Koren then LISTENED to the three versions of
 * that moment and chose **A, the doubled filler we had just deleted** — `"אהה. רגע... בוא נבדוק…"` —
 * and said what the rule really is:
 *
 *     "אהה ורגע יכולים להתאים ביחד, אבל רגע ושניה או רגע וחכה זה מילים שלא יכולות ללכת ביחד"
 *
 * Compatibility between the two positions, not a count. His ear on the concrete audio supersedes
 * his own earlier note, which is the whole point of the listening rounds.
 */
describe('allowsArmedFiller — which two sounds may share one breath', () => {
  it("KOREN'S PICK: a receipt may be followed by a hesitation — card n4a variant A", () => {
    // His words, on the round-7 audio, are about the two ACTS: a receipt, then a hesitation. Both
    // halves changed spelling in round 10 (`אהה.` → `אמ.`, `רגע...` → `רֶגַע...`) and the RULE did
    // not — which is the point of reading categories out of the banks. The literal round-7 pair is
    // deliberately not asserted here: `אהה.` is in no bank now, so it is `unscreened` and fails
    // closed, exactly as any other retired string should.
    expect(allowsArmedFiller({ kind: 'ack', word: 'בסדר.' }, 'רֶגַע...')).toBe(true);
    expect(allowsArmedFiller({ kind: 'ack', word: 'אוקי.' }, 'שניה...')).toBe(true);
  });

  it('every receipt in the bank pairs with every hesitation in the bank — EXCEPT אמ / אֶממ', () => {
    for (const ack of ACKNOWLEDGEMENTS_HE_WIDE) {
      for (const filler of THINKING_FILLERS_HE) {
        // The one exception is the round-10 collision: `אמ.` (a receipt) and `אֶממ...` (a
        // hesitation) are the same closed-lip hum, and the categories cannot see it. See
        // mayPairInOneBreath. Every other pair still passes, so the rule stayed a rule.
        const collide = ack.startsWith('אמ') && filler.replace(/[֑-ׇ]/gu, '').startsWith('אממ');
        expect(
          allowsArmedFiller({ kind: 'ack', word: ack }, filler),
          `${ack} + ${filler}`,
        ).toBe(!collide);
      }
    }
  });

  it('THE ROUND-10 COLLISION: אמ. and אֶממ... are one sound twice, whatever their categories say', () => {
    expect(allowsArmedFiller({ kind: 'ack', word: 'אמ.' }, 'אֶממ...')).toBe(false);
    // ...and it is symmetric, so nothing depends on which position each lands in.
    expect(mayPairInOneBreath('אֶממ...', 'אמ.')).toBe(false);
    // The guard is about the STEM, not about the mark: it must hold with the niqqud stripped too,
    // which is the form the TTS eventually receives.
    expect(mayPairInOneBreath('אמ.', 'אממ...')).toBe(false);
  });

  it('THE ONE HE RULED OUT: רגע and שנייה can never both be spoken', () => {
    expect(allowsArmedFiller({ kind: 'hesitation', word: 'רֶגַע...' }, 'שניה...')).toBe(false);
    expect(allowsArmedFiller({ kind: 'hesitation', word: 'שניה...' }, 'רֶגַע...')).toBe(false);
    // The pre-round-10 spellings are still refused — the rule is about the act, not the string.
    expect(allowsArmedFiller({ kind: 'hesitation', word: 'רגע...' }, 'שנייה...')).toBe(false);
  });

  it('and no other same-bank pair either — two hesitations are the same act twice', () => {
    for (const first of THINKING_FILLERS_HE) {
      for (const second of THINKING_FILLERS_HE) {
        expect(allowsArmedFiller({ kind: 'hesitation', word: first }, second)).toBe(false);
      }
    }
  });

  it('the mid-dictation nod counts as a hesitation, so nothing stacks on it', () => {
    // "אה אה." leads on `אה`, which IS a member of THINKING_FILLERS_HE — the classification comes
    // out of the bank, not out of a second list that could drift from it.
    //
    // ⚠️ ROUND 10 NEARLY BROKE THIS SILENTLY. The bank member is now `אֶה...`, and a classifier that
    // did not strip niqqud would stop matching `אה`, drop the nod to `unscreened`, and change
    // NOTHING observable — `mayPairInOneBreath` refuses `unscreened` and `hesitation` alike, so the
    // pairing tests would all still pass while the nod quietly left the screened vocabulary. This
    // assertion is the one that fails.
    expect(openingSoundCategory(DICTATION_NOD)).toBe('hesitation');
    expect(allowsArmedFiller({ kind: 'nod', word: DICTATION_NOD }, 'רֶגַע...')).toBe(false);
    // The nod has NO verdict of its own (round-10 card n1: all four spellings rejected), so it must
    // still be the pre-round-10 constant. Round 11 is where it changes.
    expect(DICTATION_NOD).toBe('אה אה.');
  });

  it('silence leaves the position free', () => {
    expect(allowsArmedFiller({ kind: 'silent' }, 'רגע...')).toBe(true);
  });

  it('nothing to pair with is not a pairing', () => {
    expect(allowsArmedFiller({ kind: 'silent' }, null)).toBe(false);
    expect(allowsArmedFiller({ kind: 'ack', word: 'אהה.' }, null)).toBe(false);
  });

  it('an unscreened sound never pairs — silent failure is the module rule', () => {
    // חכה is one of the two words Koren named as incompatible with רגע and it is in no bank, so it
    // is refused for being unscreened rather than by an invented parallel list.
    expect(allowsArmedFiller({ kind: 'ack', word: 'חכה' }, 'רגע...')).toBe(false);
    expect(allowsArmedFiller({ kind: 'ack', word: 'אהה.' }, 'חכה')).toBe(false);
  });

  it('VOICE_FILLER_PAIRING_ENABLED=false restores the hard one-sound cap exactly', () => {
    expect(allowsArmedFiller({ kind: 'ack', word: 'בסדר.' }, 'רֶגַע...', { pairing: false })).toBe(
      false,
    );
    expect(allowsArmedFiller({ kind: 'silent' }, 'רֶגַע...', { pairing: false })).toBe(true);
  });

  it('the stem rule never blocks a pair the coarse kill-switch would have allowed', () => {
    // The one thing that must stay true of an added restriction: it is strictly narrower than the
    // switch that turns pairing off entirely, so `pairing:false` is still an exact rollback.
    for (const ack of ACKNOWLEDGEMENTS_HE_WIDE) {
      for (const filler of THINKING_FILLERS_HE) {
        if (allowsArmedFiller({ kind: 'ack', word: ack }, filler, { pairing: false })) {
          expect(allowsArmedFiller({ kind: 'ack', word: ack }, filler)).toBe(true);
        }
      }
    }
  });
});

describe('openingSoundCategory — read out of the banks, not out of a copy of them', () => {
  it('the two banks are disjoint on their leading token', () => {
    // If this fails, a word was added to one bank that already leads a member of the other, and
    // the pairing rule would silently start refusing a pair it used to allow.
    const acks = new Set(ACKNOWLEDGEMENTS_HE_WIDE.map((w) => openingSoundCategory(w)));
    const fillers = new Set(THINKING_FILLERS_HE.map((w) => openingSoundCategory(w)));
    expect([...acks]).toEqual(['acknowledgement']);
    expect([...fillers]).toEqual(['hesitation']);
  });

  it('the round-10 banks classify, and the words they replaced no longer do', () => {
    // `אהה.` was a receipt until 2026-08-31 and is now in no bank at all, so it is `unscreened` —
    // which is correct and is what fail-closed means: an old string surviving in some caller's
    // constant must not silently keep its old privileges.
    expect(openingSoundCategory('אמ.')).toBe('acknowledgement');
    expect(openingSoundCategory('אוקי.')).toBe('acknowledgement');
    expect(openingSoundCategory('אֶה...')).toBe('hesitation');
    expect(openingSoundCategory('אֶממ...')).toBe('hesitation');
    expect(openingSoundCategory('אהה.')).toBe('unscreened');
  });

  it('a niqqud mark is a pronunciation instruction, not a different sound', () => {
    // guardSpeech strips every mark before Cartesia sees the text, and openerKey has always ignored
    // them. If this classifier did not, `אֶה...` and `אה...` would be two words to the pairing rule
    // and one word to everything else.
    expect(openingSoundCategory('אה...')).toBe('hesitation');
    expect(openingSoundCategory('רגע...')).toBe('hesitation');
    expect(openingSoundCategory('רֶגַע...')).toBe('hesitation');
  });

  it('a compound receipt is classified by its first word', () => {
    expect(openingSoundCategory('טוב, הבנתי.')).toBe('acknowledgement');
  });
});

describe('chunkCallsTool — the signal that a step is not a reply', () => {
  it('sees a tool call in the delta the SDK itself reads', () => {
    expect(chunkCallsTool({ delta: { toolCalls: [{ type: 'function_call', name: 'capture_lead_info' }] } })).toBe(true);
  });

  it('is false for our own injected strings, for text deltas and for junk', () => {
    expect(chunkCallsTool('אוקיי. ')).toBe(false);
    expect(chunkCallsTool({ delta: { content: 'כמה פניות' } })).toBe(false);
    expect(chunkCallsTool({ delta: { toolCalls: [] } })).toBe(false);
    expect(chunkCallsTool({})).toBe(false);
    expect(chunkCallsTool(null)).toBe(false);
    expect(chunkCallsTool(undefined)).toBe(false);
  });
});
