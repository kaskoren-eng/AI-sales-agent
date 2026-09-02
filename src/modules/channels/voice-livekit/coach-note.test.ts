import { describe, expect, it, vi } from 'vitest';
import { COACH_NOTE_ORDER, type CoachNoteProducerId, buildCoachNote } from './coach-note.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * A NOTE NOBODY RECEIVES IS WORTH NOTHING — and we have now built three of them.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `registerTracker.note()` (2026-08-30) was built on every turn, named in the injection gate
 * condition and printed in the `coach_note` log line, and left out of the array that gets joined.
 * It ran in production for three days advising nobody. `salesGate.observeAgentSpeech` and
 * `onGateAViolation` were the same shape of mistake in the same week.
 *
 * ── Why this test is structural and not a source grep ─────────────────────────────────────────
 *
 * The obvious test is `expect(read('./agent.ts')).toContain('registerTracker.note()')`. It would
 * have caught this one, and it is worth less than it looks: it breaks on a rename, and it passes
 * on a call that is present and unreachable — which is EXACTLY the bug, since the register note
 * was being called, just not joined.
 *
 * So the note is built through the real code path with every producer returning a sentinel, and
 * the assertion is that every sentinel comes out the other side. Add a producer to
 * `CoachNoteProducerId` and forget the order array and the file stops compiling; add it to the
 * order array and forget to wire it in agent.ts and the enumeration below stays honest about what
 * the model can actually receive.
 */
describe('coach note — every registered producer reaches the model', () => {
  const sentinel = (id: CoachNoteProducerId) => `<<${id}>>`;

  it('joins every id in COACH_NOTE_ORDER, in that order', () => {
    const sources = Object.fromEntries(
      COACH_NOTE_ORDER.map((id) => [id, () => sentinel(id)]),
    );
    const note = buildCoachNote(sources);

    // Reachability: nothing is silently dropped on the way out.
    for (const id of COACH_NOTE_ORDER) {
      expect(note, `producer "${id}" is registered but its note never reaches the model`).toContain(
        sentinel(id),
      );
    }
    // Order: the memory notes precede the gate, and `booking` is last — it reads the tool runtime
    // rather than the transcript and it decides whether the call may end.
    expect(note.split('\n')).toEqual(COACH_NOTE_ORDER.map(sentinel));
    expect(COACH_NOTE_ORDER[COACH_NOTE_ORDER.length - 1]).toBe('booking');
  });

  it('the registry has no duplicates — one line per producer per turn', () => {
    expect(new Set(COACH_NOTE_ORDER).size).toBe(COACH_NOTE_ORDER.length);
  });

  /**
   * THE REGRESSION ITSELF. Named explicitly rather than left implicit in the loop above, because
   * this is the one that shipped: the spoken-register nudge.
   */
  it('the spoken-register nudge is one of them — it was not, for three days', () => {
    expect(COACH_NOTE_ORDER).toContain('register');
    expect(buildCoachNote({ register: () => 'USE AN EVERYDAY WORD' })).toBe('USE AN EVERYDAY WORD');
  });

  it('a producer that is switched off costs nothing and shifts nobody', () => {
    expect(buildCoachNote({ fact: () => 'F', booking: () => 'B' })).toBe('F\nB');
    expect(buildCoachNote({ fact: () => null })).toBe('');
    expect(buildCoachNote({})).toBe('');
  });

  /**
   * Advisory means advisory: a tracker that throws loses its own line, not the call. The injection
   * site has had a try/catch since 2026-08-31 for the same reason; this one is per producer, so
   * one broken tracker cannot cost the other eight their turn.
   */
  it('one producer throwing does not take the others with it', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const note = buildCoachNote({
        fact: () => {
          throw new Error('boom');
        },
        booking: () => 'BOOKING',
      });
      expect(note).toBe('BOOKING');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
