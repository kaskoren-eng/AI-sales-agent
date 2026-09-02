/**
 * THE TURN-BOUNDARY COACH NOTE — one registry, which is also the join.
 *
 * ── Why this file exists ──────────────────────────────────────────────────────────────────────
 *
 * Every tracker in this module ends in a `note()`: the phrase ledger, fact memory, the sales gate,
 * slot memory, engagement, the two dictation stitchers, the spoken-register nudge. They are all
 * advisory, they are all appended as ONE system item at the tail of the context (never folded into
 * the prompt prefix — the cache prefix must not move), and they are all worth exactly nothing if
 * the model never receives them.
 *
 * `registerTracker.note()` was written on 2026-08-30, appears in the injection gate condition and
 * in the `coach_note` log line, and was NOT in the array that gets joined. It ran in production for
 * three days building a reminder nobody has ever read. It is the third instrument in one week to
 * be built and never wired — `salesGate.observeAgentSpeech` and `onGateAViolation` were the other
 * two — so the fix is not "add it to the array", it is to remove the array you can forget.
 *
 * ── The invariant ─────────────────────────────────────────────────────────────────────────────
 *
 * `COACH_NOTE_ORDER` is BOTH the list of producers and the order they are joined in. There is no
 * second list to fall out of sync with it, and `CoachNoteSources` is keyed by the same union, so a
 * producer that exists in the type and not in the order array is a COMPILE error (see the
 * exhaustiveness check below), not a silent no-op. `coach-note.test.ts` then proves at runtime that
 * every id in the order actually reaches the joined output.
 *
 * ── Why thunks and not the notes themselves ───────────────────────────────────────────────────
 *
 * `() => string | null`, not `string | null`, so a producer that is switched off (or whose tracker
 * is `undefined`) costs nothing, and so the caller cannot accidentally build a note it then forgets
 * to pass — an absent key is an absent producer, and the test enumerates the keys.
 */

/**
 * Every note that can reach the model, in the order it is read.
 *
 * Order is not cosmetic. The memory notes come first because they are statements about what is
 * KNOWN; `booking` is last because it is the one that must not be argued with — it reads the tool
 * runtime rather than the transcript, and it decides whether the call may end.
 */
export type CoachNoteProducerId =
  | 'phrase'
  | 'fact'
  | 'gate'
  | 'slot'
  | 'engagement'
  | 'email'
  | 'name'
  | 'register'
  | 'booking';

export const COACH_NOTE_ORDER = [
  // "You have already said these four-grams." — phrase-ledger.ts
  'phrase',
  // "You already know his name / you have asked three times." — fact-memory.ts
  'fact',
  // "You do not yet know his pain — do NOT describe the product." — sales-gate.ts. Read BEFORE the
  // engagement note so a terse caller is still gated: shortening the call is not permission to
  // pitch into a vacuum.
  'gate',
  // "He has already told you when." — slot-memory.ts. With the memory notes rather than with the
  // booking note, because it is about what the CALLER said, not about what the tool needs.
  'slot',
  // "He is giving you four-word answers — mandatory questions only." — engagement.ts. Fires on a
  // CHANGE of level, so a consistent caller costs one line for the whole call.
  'engagement',
  // What she just read back, so his next "לא נכון" has a value to attach to — email-dictation.ts
  // and name-dictation.ts.
  'email',
  'name',
  // "Your last N replies carried no everyday word." — register-tracker.ts. WIRED 2026-09-02; it had
  // been built and dropped on the floor since 2026-08-30.
  'register',
  // THE ONLY NOTE READ OFF THE TOOL RUNTIME RATHER THAN OFF THE TRANSCRIPT — what is actually
  // booked, and which of `book_meeting`'s required arguments still have no value. Last, and it
  // stays last. See booking-note.ts.
  'booking',
] as const satisfies readonly CoachNoteProducerId[];

/**
 * Compile-time exhaustiveness: add an id to `CoachNoteProducerId` and forget `COACH_NOTE_ORDER`,
 * and this line stops type-checking. That is the whole point of the file — the register nudge was
 * lost to exactly this omission and nothing caught it for three days.
 */
type MissingFromOrder = Exclude<CoachNoteProducerId, (typeof COACH_NOTE_ORDER)[number]>;
const _everyProducerIsOrdered: MissingFromOrder extends never ? true : never = true;
void _everyProducerIsOrdered;

/** A producer supplies its note lazily; an absent key is a producer that is switched off. */
export type CoachNoteSources = Partial<Record<CoachNoteProducerId, () => string | null>>;

/**
 * The note the model will actually receive this turn, or `''` when there is nothing to say.
 *
 * A producer that throws must not take the call down with it — this is style advice, and on the
 * 2026-08-31 call the injection was already wrapped in a try/catch for that reason. Here the catch
 * is PER PRODUCER, so one broken tracker costs its own line rather than everybody else's.
 */
export function buildCoachNote(sources: CoachNoteSources): string {
  const lines: string[] = [];
  for (const id of COACH_NOTE_ORDER) {
    const produce = sources[id];
    if (!produce) continue;
    let note: string | null = null;
    try {
      note = produce();
    } catch (err) {
      console.error('coach_note_producer_failed', id, err instanceof Error ? err.message : String(err));
      continue;
    }
    if (note) lines.push(note);
  }
  return lines.join('\n');
}
