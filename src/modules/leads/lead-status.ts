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
  'opted_out',
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Forward-only transitions. A status not listed as a key has no outgoing edges (terminal). */
export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  new: ['contacted', 'qualifying', 'qualified', 'disqualified', 'opted_out'],
  contacted: ['qualifying', 'qualified', 'disqualified', 'opted_out'],
  qualifying: ['qualified', 'disqualified', 'opted_out'],
  qualified: ['opted_out'],
  disqualified: ['opted_out'],
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
