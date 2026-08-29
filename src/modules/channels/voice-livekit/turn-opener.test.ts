import { describe, expect, it } from 'vitest';
import { ACKNOWLEDGEMENTS_HE } from './prompts/acknowledgements.he.js';
import { THINKING_FILLERS_HE } from './prompts/thinking-fillers.he.js';
import { chooseTurnOpener, chunkCallsTool } from './turn-opener.js';

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
      lastAck: null,
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
      lastAck: 'אוקיי.',
      offerFiller: anyFiller,
    });
    expect(opener.kind).toBe('hesitation');
    expect(THINKING_FILLERS_HE).toContain((opener as { word: string }).word);
  });

  it('says NOTHING when the call has spent its hesitations — silence beats a stray word', () => {
    const opener = chooseTurnOpener({
      afterToolCall: true,
      fillersEnabled: true,
      lastAck: 'אוקיי.',
      offerFiller: () => null,
    });
    expect(opener.kind).toBe('silent');
  });

  it('respects the thinking-filler kill-switch (VOICE_THINKING_FILLER_MS=0) — silent, not a receipt', () => {
    const opener = chooseTurnOpener({
      afterToolCall: true,
      fillersEnabled: false,
      lastAck: 'אוקיי.',
      offerFiller: () => {
        throw new Error('must not be consulted when fillers are off');
      },
    });
    expect(opener.kind).toBe('silent');
  });

  it('never repeats the previous acknowledgement back-to-back', () => {
    for (const previous of ACKNOWLEDGEMENTS_HE) {
      for (let i = 0; i < 20; i++) {
        const opener = chooseTurnOpener({
          afterToolCall: false,
          fillersEnabled: true,
          lastAck: previous,
          offerFiller: anyFiller,
        });
        expect((opener as { word: string }).word).not.toBe(previous);
      }
    }
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
