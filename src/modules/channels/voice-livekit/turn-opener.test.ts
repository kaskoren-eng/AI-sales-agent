import { describe, expect, it } from 'vitest';
import { ACKNOWLEDGEMENTS_HE, pickAcknowledgement } from './prompts/acknowledgements.he.js';
import { THINKING_FILLERS_HE } from './prompts/thinking-fillers.he.js';
import { chooseTurnOpener, chunkCallsTool } from './turn-opener.js';
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
