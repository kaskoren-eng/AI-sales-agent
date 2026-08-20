import { describe, it, expect } from 'vitest';
import { splitPrompt, PlaybookDeliverer, formatPlaybookMessage, PLAYBOOK_MARKER } from './playbook-packs.js';
import { buildSystemPrompt } from './prompts/system-prompt.he.js';

const slim = buildSystemPrompt({ toolsEnabled: true, ragEnabled: true, slimKnowledge: true });
const { core, packs } = splitPrompt(slim);

describe('splitPrompt — what leaves the resident prompt', () => {
  it('moves Steps 2, 3 and 4 out', () => {
    expect(packs.map((p) => p.heading.slice(0, 7))).toEqual(['Step 2:', 'Step 3:', 'Step 4:']);
    expect(core).not.toContain('## Step 2:');
    expect(core).not.toContain('## Step 3:');
    expect(core).not.toContain('## Step 4:');
  });

  /**
   * THE SAFETY BOUNDARY. Security rules are resident for the whole call and are never packed.
   * A defence delivered on a trigger is a defence an attacker can decline to trigger, and the phase
   * gate would leave `opening` — where injection attempts actually arrive — completely unprotected.
   */
  it('keeps the security rules resident, always', () => {
    expect(core).toContain('CRITICAL SECURITY RULES');
    for (const pack of packs) {
      expect(pack.content).not.toContain('CRITICAL SECURITY RULES');
    }
  });

  it('keeps her identity, the call flow and the opening resident', () => {
    expect(core).toContain('## Role');
    expect(core).toContain('## Call Flow Overview');
    expect(core).toContain('## Step 1');
  });

  it('keeps the opt-out and handoff handlers resident — they are triggered by the caller, not by a stage', () => {
    expect(core).toContain('## Hostile Or Opt-Out Request');
    expect(core).toContain('## Human Handoff Request');
    expect(core).toContain('## Unknown Question Handling');
  });

  it('keeps the grounding rules resident, since knowledge can arrive at any time', () => {
    expect(core).toContain('## KNOWLEDGE');
  });

  /** Nothing may be silently dropped: every word of the original ends up in core or in a pack. */
  it('loses no content — core plus packs still carry every section', () => {
    const recombined = core + packs.map((p) => p.content).join('');
    for (const heading of [
      'Role',
      'CRITICAL SECURITY RULES',
      'Call Flow Overview',
      'Step 1: Open The Call',
      'Step 2: Discovery Questions',
      'Step 3: Qualification',
      'Step 4: Offer And Book The Demo',
      'Hold Handling',
    ]) {
      expect(recombined, heading).toContain(heading);
    }
  });

  it('carries the booking mechanics intact inside the Step 4 pack', () => {
    const step4 = packs.find((p) => p.heading.startsWith('Step 4:'))!;
    expect(step4.content).toContain('YOU MUST COLLECT HIS DETAILS BEFORE BOOKING');
    expect(step4.content).toMatch(/NEVER claim a meeting is booked/i);
    expect(step4.content).toContain('book_meeting');
  });

  it('is a real reduction, not a rounding error', () => {
    const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
    expect(words(core)).toBeLessThan(words(slim) * 0.55);
  });
});

describe('PlaybookDeliverer', () => {
  it('delivers nothing during the greeting', () => {
    expect(new PlaybookDeliverer(packs).due('opening')).toEqual([]);
  });

  it('delivers the discovery pack on arrival at discovery', () => {
    const d = new PlaybookDeliverer(packs);
    expect(d.due('discovery').map((p) => p.heading.slice(0, 7))).toEqual(['Step 2:']);
  });

  /**
   * Step 4 arrives at QUALIFYING, one stage early and deliberately: `scheduling` is entered BY
   * check_calendar_availability succeeding, so a pack delivered there would arrive after she had
   * already started booking — too late for "collect his details BEFORE booking" to mean anything.
   */
  it('delivers the booking rules at qualifying, before any booking tool can fire', () => {
    const d = new PlaybookDeliverer(packs);
    d.due('discovery');
    expect(d.due('qualifying').map((p) => p.heading.slice(0, 7))).toEqual(['Step 3:', 'Step 4:']);
  });

  it('never delivers the same pack twice', () => {
    const d = new PlaybookDeliverer(packs);
    d.due('qualifying');
    expect(d.due('qualifying')).toEqual([]);
    expect(d.due('scheduling')).toEqual([]);
    expect(d.deliveredCount).toBe(3);
  });

  it('catches up when a stage is skipped — a caller who jumps straight to booking still gets everything', () => {
    const d = new PlaybookDeliverer(packs);
    expect(d.due('scheduling')).toHaveLength(3);
  });
});

describe('formatPlaybookMessage', () => {
  it('labels procedure distinctly from retrieved facts', () => {
    const msg = formatPlaybookMessage(packs.slice(0, 1));
    expect(msg.startsWith(PLAYBOOK_MARKER)).toBe(true);
    expect(msg).not.toContain('[KNOWLEDGE]');
  });
});
