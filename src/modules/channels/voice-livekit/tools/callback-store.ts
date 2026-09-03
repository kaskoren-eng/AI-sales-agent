import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../../../db/client.js';
import { callbacks, leads } from '../../../../db/schema/index.js';
import { cancelCallbacks } from '../../../../queues/callbacks.queue.js';

/**
 * CLOSING A CALLBACK THAT HAS STOPPED MAKING SENSE.
 *
 * Design: `docs/phase-8-callback-and-followup-model.md` §2 ("one live callback per lead") and §5.
 *
 * Four events end a pending callback, and all four go through this one function:
 *
 *   book_meeting              a lead who just booked must not be rung back about booking
 *   end_call(opt_out)         absolute, and the one that is a legal obligation rather than a courtesy
 *   request_human_handoff     he belongs to the human now; two of us calling is worse than neither
 *   schedule_callback         the supersede — he named a NEW time, so the old row loses
 *
 * ── THESE HOOKS ARE DEFENCE IN DEPTH, NOT THE GUARD ──────────────────────────────────────────
 *
 * Read `callbacks.worker.ts` steps 1–3 before deciding any of this is load-bearing. At fire time
 * the worker re-reads the row and refuses to dial unless it is still `pending`; it refuses again
 * for an opted-out lead, and again for a lead with a future `scheduled_calls` row. Every one of
 * those checks would catch a callback these hooks missed.
 *
 * So what do the hooks actually buy? Two things, both worth having and neither critical:
 *   · the QUEUE stays clean — a removed job is one fewer wake-up on a worker that dials phones;
 *   · the ROW says WHY it stopped, at the moment it stopped, which the worker's own cancellation
 *     (recorded hours later, if the job fires at all) cannot.
 *
 * The practical consequence: **nothing here may fail its caller.** A booking must not fail because
 * Redis is down, and an opt-out — the one write in this system that is a legal obligation — must
 * not fail because a `callbacks` row would not update. So this function NEVER THROWS. It returns
 * what it managed to do and logs what it did not.
 *
 * ── NOT GATED ON VOICE_CALLBACK_TOOL ─────────────────────────────────────────────────────────
 *
 * `disconnect.ts` writes `callbacks` rows under VOICE_DISCONNECT_TRACKING, and the worker dials
 * them under VOICE_CALLBACK_WORKER. Neither knows anything about the tool's flag. A tenant that has
 * never seen `schedule_callback` can therefore have a live pending callback, and hooks hidden
 * behind the tool's flag would leave it queued against a lead who had just opted out. The hooks
 * cost one indexed SELECT on a call that is already ending; the flag buys nothing and hides a bug.
 */

/** What the row becomes. `superseded` = a newer callback replaced it; `cancelled` = it is moot. */
export type CallbackClosureState = 'superseded' | 'cancelled';

export interface CallbackStoreDeps {
  db: Database;
  /** Null when Redis is unreachable — the rows are still closed; only the job removal is skipped. */
  callbacksQueue: Queue | null;
}

export interface CloseCallbacksOptions {
  tenantId: string;
  leadId: string;
  state: CallbackClosureState;
  /** Appended to `reason`, never replacing it — the original is why the callback existed. */
  note: string;
  /** The row NOT to touch. Used by the supersede, which must not close the row it just wrote. */
  exceptId?: string | null;
  /**
   * Clear `leads.next_callback_at` as well.
   *
   * True for the three cancellations (nothing is coming, and the dashboard must not say one is).
   * FALSE for the supersede, where the tool writes the new instant into that column immediately
   * afterwards — clearing it first would leave a window in which the lead's pointer says "no
   * callback" while a pending row says otherwise.
   */
  clearLeadPointer: boolean;
}

export interface CloseCallbacksResult {
  /** Rows moved out of `pending`. 0 is the overwhelmingly common answer and is not a failure. */
  closed: number;
  /** BullMQ jobs actually removed. Always ≤ `closed` — a job may have run, or never existed. */
  jobsRemoved: number;
  /** Set when something went wrong. The caller logs it and carries on; it is never thrown. */
  error?: string;
}

/** Same cap and same joiner as the worker's `appendReason`, so a row reads the same either way. */
const MAX_REASON_CHARS = 500;

function appendReason(existing: string | null, note: string): string {
  return [existing, note].filter(Boolean).join(' | ').slice(0, MAX_REASON_CHARS);
}

/**
 * Move every `pending` callback for one lead out of `pending`, and unqueue its dial.
 *
 * NEVER THROWS — see the header. Every caller is an action that matters more than this one.
 *
 * The per-row UPDATE loop looks wasteful and is not: the whole point of the supersede is that a
 * lead has AT MOST ONE pending callback, so this loop runs zero or one times in practice. More
 * than one means an invariant broke somewhere else, and in that case closing each row with its own
 * preserved `reason` is exactly what the person debugging it will want.
 */
export async function closePendingCallbacks(
  deps: CallbackStoreDeps,
  opts: CloseCallbacksOptions,
): Promise<CloseCallbacksResult> {
  try {
    const rows = await deps.db
      .select({ id: callbacks.id, jobId: callbacks.jobId, reason: callbacks.reason })
      .from(callbacks)
      .where(
        and(
          eq(callbacks.tenantId, opts.tenantId),
          eq(callbacks.leadId, opts.leadId),
          eq(callbacks.state, 'pending'),
        ),
      );

    const targets = rows.filter((r) => r.id !== opts.exceptId);
    if (targets.length === 0) return { closed: 0, jobsRemoved: 0 };

    const now = new Date();
    for (const row of targets) {
      await deps.db
        .update(callbacks)
        .set({
          state: opts.state,
          reason: appendReason(row.reason, opts.note),
          updatedAt: now,
        })
        .where(and(eq(callbacks.tenantId, opts.tenantId), eq(callbacks.id, row.id)));
    }

    if (opts.clearLeadPointer) {
      await deps.db
        .update(leads)
        .set({ nextCallbackAt: null, updatedAt: now })
        .where(and(eq(leads.id, opts.leadId), eq(leads.tenantId, opts.tenantId)));
    }

    // Best-effort by contract — `cancelCallbacks` swallows a missing/active job on purpose, and
    // the worker's fire-time state check is what actually stops a dial we failed to unqueue.
    let jobsRemoved = 0;
    const jobIds = targets.map((r) => r.jobId).filter((id): id is string => Boolean(id));
    if (deps.callbacksQueue && jobIds.length > 0) {
      jobsRemoved = await cancelCallbacks(deps.callbacksQueue, jobIds);
    }

    console.log(
      'callbacks_closed',
      JSON.stringify({
        tenantId: opts.tenantId,
        leadId: opts.leadId,
        state: opts.state,
        note: opts.note,
        closed: targets.length,
        jobsRemoved,
        queued: Boolean(deps.callbacksQueue),
      }),
    );
    return { closed: targets.length, jobsRemoved };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(
      'callbacks_close_failed',
      JSON.stringify({ tenantId: opts.tenantId, leadId: opts.leadId, note: opts.note, error }),
    );
    return { closed: 0, jobsRemoved: 0, error };
  }
}

/**
 * The three cancellation hooks in one line each — booked, opted out, handed to a human.
 *
 * `leadId` is passed explicitly rather than read off the runtime: `book_meeting` learns the lead's
 * id from its own upsert, `end_call` from its opt-out ladder, and the handoff tool from its flag
 * write. Each of the three knows a truer id at that moment than `rt.leadId` does.
 */
export async function cancelCallbacksForLead(
  rt: { tenantId: string; db: Database; callbacksQueue: Queue | null },
  leadId: string | null | undefined,
  note: string,
): Promise<CloseCallbacksResult> {
  if (!leadId) return { closed: 0, jobsRemoved: 0 };
  return closePendingCallbacks(
    { db: rt.db, callbacksQueue: rt.callbacksQueue },
    { tenantId: rt.tenantId, leadId, state: 'cancelled', note, clearLeadPointer: true },
  );
}
