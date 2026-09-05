/**
 * The lead pipeline status graph — the single source of truth for "is this status change allowed".
 *
 * Extracted from message-processor.worker.ts so the voice CRM-sync path can honor the SAME guard
 * instead of writing statuses blindly. The transition set here is a strict SUPERSET of the original
 * stepwise chat map: every edge the chat qualifier ever attempts
 * (new→contacted→qualifying→qualified/disqualified) is still allowed, so that path is unchanged.
 *
 * Two deliberate additions for the voice path:
 *  - a call can reach a terminal outcome in ONE call — a cold lead who books is new→qualified, and a
 *    lead who says "not interested" while still 'new' is new→disqualified — so every earlier state
 *    may jump straight to qualified/disqualified.
 *  - opt-out is a SAFETY boundary, reachable from any non-terminal state (and from qualified /
 *    disqualified too): if someone asks to be left alone we must always be able to honor it.
 */
export const LEAD_STATUSES = [
  'new',
  'contacted',
  'qualifying',
  'qualified',
  'disqualified',
  /**
   * The follow-up ladder ran out and he never picked up (Koren, 2026-09-04: *"פעם אחרונה לפני
   * שהוא מסמן את הליד כלא זמין"*). Written only by `callbacks.worker.ts` at `exhausted`.
   *
   * NOT the same as `disqualified`, and the distinction is the point of adding a status rather
   * than reusing one: `disqualified` is a lead we spoke to and ruled out, `unreachable` is a lead
   * we never reached. Collapsing them makes "how many leads did we fail to reach this month" —
   * the number that says whether the dialling hours are wrong — permanently unanswerable.
   *
   * NOT terminal. He can still ring back or answer a message, and the moment he does he is a live
   * lead again: `unreachable → contacted` is the edge below that says so.
   */
  'unreachable',
  'opted_out',
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Forward-only transitions. A status not listed as a key has no outgoing edges (terminal). */
export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  new: ['contacted', 'qualifying', 'qualified', 'disqualified', 'unreachable', 'opted_out'],
  contacted: ['qualifying', 'qualified', 'disqualified', 'unreachable', 'opted_out'],
  qualifying: ['qualified', 'disqualified', 'unreachable', 'opted_out'],
  qualified: ['opted_out'],
  disqualified: ['opted_out'],
  // The one status with an edge BACKWARDS, and it is not an exception to "forward-only" so much as
  // a statement that never answering is not an outcome. A lead who calls back, replies to a
  // message, or is dialled again re-enters the pipeline where he left it.
  unreachable: ['contacted', 'qualifying', 'qualified', 'disqualified', 'opted_out'],
  opted_out: [],
};

/**
 * May a lead move `from` → `to`? A no-op (from === to) is NOT a transition — callers that want
 * "already there, nothing to do" should check equality themselves before deciding to push.
 */
export function canTransition(from: string, to: string): boolean {
  if (from === to) return false;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
