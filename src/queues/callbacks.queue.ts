import type { Queue } from 'bullmq';

/**
 * Callbacks — BullMQ DELAYED jobs, the same "snooze alarm in Redis" the meeting reminders use, and
 * for the same reason: the ladder spans days, so the thing that fires has to survive a deploy.
 *
 * Design: `docs/phase-8-callback-and-followup-model.md` §5. This file is deliberately a close copy
 * of `meeting-reminders.queue.ts` rather than a second pattern — that file is the house shape and
 * it is correct.
 *
 * ── THE JOB CARRIES NO TIME ──────────────────────────────────────────────────────────────────
 *
 * `MeetingReminderJob` carries a snapshot of the booking (the lead's name, the meeting instant,
 * the meet link) and its worker re-reads the row to check the snapshot is still true. This job
 * carries LESS than that on purpose: an id, and two counters that exist only to NAME the job.
 *
 * There is no `dueAt` in here, and there is nothing to reconcile against, because the row's
 * `due_at` is the authority at fire time — full stop. A callback that was superseded, rescheduled
 * or cancelled while its job sat in Redis is re-read, not trusted, and a job that fires late
 * against a row that has moved does what the ROW says.
 *
 * ── DETERMINISTIC IDS ARE THE IDEMPOTENCY ────────────────────────────────────────────────────
 *
 * `callback-<callbackId>-a<attempt>` and, for a window deferral, `callback-<callbackId>-a<attempt>-d<n>`.
 * BullMQ refuses to add a job whose id already exists, so enqueueing the same rung twice is a
 * no-op rather than two phone calls — and there is deliberately NO application-level dedupe on
 * top, because a second mechanism that can disagree with the first is worse than one that cannot.
 * The `-d<n>` suffix exists because BullMQ will not reuse a COMPLETED job's id, so a deferred copy
 * of a job that has already run needs a fresh one.
 *
 * Determinism is also the entire reason cancellation is possible: the row stores the live id in
 * `callbacks.job_id` and `cancelCallbacks` removes it by name.
 */

export interface CallbackJob {
  tenantId: string;
  callbackId: string;
  /**
   * The row's `attempt` at enqueue time. NOT THE AUTHORITY — it names the job and nothing else.
   * Every decision the worker makes reads `callbacks.attempt` back from the database.
   */
  attempt: number;
  /** How many times a window check has already pushed this job out. Names the job; see above. */
  deferrals: number;
}

export function callbackJobId(callbackId: string, attempt: number, deferrals = 0): string {
  return `callback-${callbackId}-a${attempt}${deferrals > 0 ? `-d${deferrals}` : ''}`;
}

export function enqueueCallback(queue: Queue, job: CallbackJob, delayMs: number) {
  return queue.add('callback', job, {
    jobId: callbackJobId(job.callbackId, job.attempt, job.deferrals),
    delay: Math.max(0, Math.round(delayMs)),
    // Three BullMQ-level retries for an infrastructure blip (Redis, a dropped DB connection). They
    // are NOT the ladder: the ladder is rungs in the database, days apart, and it is what decides
    // whether a lead is rung again. Nothing in the worker throws for a reason the ladder owns.
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
  });
}

/**
 * Best-effort removal of pending callback jobs — a booking, an opt-out, a handoff, or a newer
 * callback superseding this one.
 *
 * A job that has already run or does not exist is NOT an error. The worker's own fire-time check
 * (the row must still be `pending`) is the authoritative backstop for everything this misses,
 * which is exactly why this can afford to be best-effort.
 */
export async function cancelCallbacks(queue: Queue, jobIds: string[]): Promise<number> {
  let removed = 0;
  for (const id of jobIds) {
    try {
      if ((await queue.remove(id)) === 1) removed += 1;
    } catch {
      // Already active/completed, or a Redis hiccup — the fire-time state check covers it.
    }
  }
  return removed;
}
