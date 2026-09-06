/**
 * THE WRITES THE CALLER SHOULD NOT BE WAITING FOR.
 *
 * `capture_lead_info` ran two sequential database round-trips before it returned, and the model
 * cannot write the next sentence until a tool returns — so every one of those milliseconds was
 * silence on the phone. Measured on production calls: 880 / 927 / 978 / 1021 / 1055 / 1072 / 1081 /
 * 1099ms, and once 3927ms. The per-turn table (latency-anatomy.ts) put a tool turn at 2877ms of
 * dead air against 1479ms for an ordinary one.
 *
 * The facts themselves are not urgent. Nothing in the conversation reads them back out of the
 * database — the model already has them in its context, the state machine and the identity memory
 * hold their own copies in memory, and the row is needed at the END of the call (the booking, the
 * hang-up, the handoff alert). So the write can happen while she talks.
 *
 * WHAT MAKES IT SAFE, in order of how badly each would have bitten:
 *
 *  1. ORDERED. Two capture calls a second apart upsert the same lead; run concurrently, both find
 *     no existing row and both insert one. The chain serialises them, so the second sees the
 *     first's `rt.leadId`.
 *  2. AWAITED WHERE THE ROW MATTERS. book_meeting, end_call, the handoff and the confirmations
 *     call `settleLeadWrites` first. Without that, book_meeting's own upsert races the chain's
 *     insert — the same duplicate, one layer along.
 *  3. NEVER THROWS. A rejected background promise with no handler takes the worker down in Node,
 *     which would turn a slow write into a dropped call. Failures are counted and logged.
 *  4. THE MODEL'S ANSWER IS UNCHANGED. Every word `capture_lead_info` returns is decided by the
 *     identity guard, which stays synchronous and runs before anything is queued.
 */

/** What the chain needs from the runtime context — structural, so tests need no full fixture. */
export interface LeadWriteHost {
  pendingLeadWrites?: Promise<void> | undefined;
  leadWriteFailures?: number | undefined;
  /** The call report, when there is one. A lost write has to reach the record, not only stderr. */
  report?: { recordMetric: (stage: string, m: Record<string, unknown>) => void } | undefined;
}

/**
 * Queues one write behind the call's existing ones.
 *
 * The returned promise is the CHAIN, not the write: it is already handled, so awaiting it is
 * optional and never produces an unhandled rejection.
 */
export function queueLeadWrite(
  rt: LeadWriteHost,
  label: string,
  write: () => Promise<void>,
): void {
  const previous = rt.pendingLeadWrites ?? Promise.resolve();
  rt.pendingLeadWrites = previous
    .then(write)
    .catch((err: unknown) => {
      // COUNTED AND LOGGED, never rethrown. The call is still in progress and the caller is
      // talking to her; a lost fact is recoverable from the transcript and the usage ledger
      // (`npm run usage:reconcile`), a crashed worker is not.
      rt.leadWriteFailures = (rt.leadWriteFailures ?? 0) + 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error('lead_write_failed', JSON.stringify({ label, error: message }));
      // Into the report as well as the log, because a call whose facts were silently lost must be
      // identifiable afterwards from the record alone. Wrapped: a reporting failure must not
      // become a second failure inside a catch handler.
      try {
        rt.report?.recordMetric('lead_write_failed', { kind: label, reason: message.slice(0, 200) });
      } catch {
        /* the report is best-effort here; the console line above is the durable one */
      }
    });
}

/**
 * Waits for every queued write to finish. Call this before reading `rt.leadId` for anything that
 * writes a row of its own.
 *
 * Resolves rather than rejects on a failed write — the chain has already swallowed it — so a
 * caller can `await` this unconditionally without a try/catch that would only ever catch nothing.
 */
export async function settleLeadWrites(rt: LeadWriteHost): Promise<void> {
  await rt.pendingLeadWrites;
}
