import { describe, expect, it } from 'vitest';
import { canTransition, ALLOWED_TRANSITIONS } from './lead-status.js';

/**
 * The shared status guard. It was extracted from message-processor.worker.ts as a strict SUPERSET,
 * so the four stepwise edges the chat qualifier attempts MUST still hold — those are pinned here as
 * a regression fence — while the voice path gains the direct-to-terminal and opt-out edges.
 */
describe('canTransition', () => {
  it('still allows every edge the chat qualifier attempts (no regression)', () => {
    expect(canTransition('new', 'contacted')).toBe(true);
    expect(canTransition('contacted', 'qualifying')).toBe(true);
    expect(canTransition('qualifying', 'qualified')).toBe(true);
    expect(canTransition('qualifying', 'disqualified')).toBe(true);
  });

  it('allows a voice call to reach a terminal outcome in one step', () => {
    expect(canTransition('new', 'qualified')).toBe(true); // cold lead who books
    expect(canTransition('new', 'disqualified')).toBe(true); // "not interested" while still new
    expect(canTransition('contacted', 'qualified')).toBe(true);
  });

  it('makes opt-out reachable from any state (safety boundary)', () => {
    expect(canTransition('new', 'opted_out')).toBe(true);
    expect(canTransition('qualifying', 'opted_out')).toBe(true);
    expect(canTransition('qualified', 'opted_out')).toBe(true);
    expect(canTransition('disqualified', 'opted_out')).toBe(true);
  });

  it('treats opted_out as terminal and rejects reversals', () => {
    expect(canTransition('opted_out', 'qualified')).toBe(false);
    expect(canTransition('opted_out', 'new')).toBe(false);
    expect(canTransition('qualified', 'new')).toBe(false);
    expect(canTransition('disqualified', 'qualified')).toBe(false);
  });

  it('is not a transition when from === to', () => {
    expect(canTransition('qualified', 'qualified')).toBe(false);
    expect(canTransition('new', 'new')).toBe(false);
  });

  it('rejects unknown statuses rather than throwing', () => {
    expect(canTransition('banana', 'qualified')).toBe(false);
    expect(ALLOWED_TRANSITIONS.opted_out).toEqual([]);
  });
});
