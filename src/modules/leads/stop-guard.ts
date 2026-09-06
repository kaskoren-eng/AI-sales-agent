import { and, eq } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import type { Database } from '../../db/client.js';
import { leads } from '../../db/schema/index.js';
import { closePendingCallbacks } from '../channels/voice-livekit/tools/callback-store.js';
import { canTransition } from './lead-status.js';
import type { StopSignal } from './stop-signals.js';

/**
 * ACTING ON A STOP SIGNAL — the write half of `stop-signals.ts`, which only decides.
 *
 * One function, called from every inbound path (WhatsApp, email, and the voice agent's end-call
 * outcomes), so that "he told us to stop" means the same thing however he said it. Before this,
 * the WhatsApp path had no way to say it at all.
 *
 * NEVER THROWS. A lead who asked to be left alone must be left alone even if Redis is down and the
 * BullMQ job cannot be removed — the DB flags are what the workers actually read at fire time, and
 * `callbacks.worker.ts` re-checks every one of them before it dials. Removing the job is a
 * courtesy that saves a wake-up, not the guarantee.
 */

export const LEAD_STATUS_OPTED_OUT = 'opted_out';

export interface StopGuardDeps {
  db: Database;
  /** Null when Redis is unreachable. The rows still close; only job removal is skipped. */
  callbacksQueue: Queue | null;
  logger?: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
  now?: () => Date;
}

export interface ApplyStopSignalParams {
  tenantId: string;
  leadId: string;
  /** The lead's status as just read. Needed for `canTransition` — never written blindly. */
  currentStatus: string;
  /** Whether the lead currently carries a soft stop, so a `continue` can lift it. */
  followupStoppedAt?: Date | null;
  signal: StopSignal;
  /** Where the sentence came from, for the log line and the stored reason. */
  channel: string;
}

export type StopGuardAction =
  /** Hard stop: `opted_out` written (or already there), callbacks cancelled. */
  | 'opted_out'
  /** Soft stop: the ladder is off for this lead, status untouched. */
  | 'followup_stopped'
  /** He came back — a soft stop was lifted. */
  | 'reopened'
  /** Nothing to do. */
  | 'none';

export interface StopGuardResult {
  action: StopGuardAction;
  callbacksClosed: number;
}

/**
 * Apply one verdict to one lead.
 *
 *   hard_stop → `status = 'opted_out'` (transition-guarded) AND the soft-stop columns, because a
 *               do-not-call is also, trivially, a stop-following-up. Callbacks cancelled.
 *   soft_stop → the soft-stop columns only. Status is HIS pipeline position and a refusal of the
 *               offer does not move it; `disqualified` is a judgement WE make after qualifying him.
 *               Callbacks cancelled.
 *   continue  → if a soft stop is standing, HE JUST CAME BACK: lift it. This is the whole reason
 *               soft and hard are different tiers. An opted-out lead is NOT reopened here — that
 *               takes a human, deliberately.
 */
export async function applyStopSignal(
  deps: StopGuardDeps,
  params: ApplyStopSignalParams,
): Promise<StopGuardResult> {
  const now = (deps.now ?? (() => new Date()))();
  const { tenantId, leadId, signal } = params;

  try {
    if (signal.verdict === 'continue') {
      if (!params.followupStoppedAt) return { action: 'none', callbacksClosed: 0 };
      await deps.db
        .update(leads)
        .set({ followupStoppedAt: null, followupStopReason: null, updatedAt: now })
        .where(and(eq(leads.id, leadId), eq(leads.tenantId, tenantId)));
      deps.logger?.info(
        { event: 'followup_stop_lifted', tenantId, leadId, channel: params.channel },
        'Lead re-engaged — follow-up stop lifted',
      );
      return { action: 'reopened', callbacksClosed: 0 };
    }

    const reason = [signal.source, signal.evidence].filter(Boolean).join(':').slice(0, 500);
    const hard = signal.verdict === 'hard_stop';

    const update: Record<string, unknown> = {
      followupStoppedAt: now,
      followupStopReason: reason,
      updatedAt: now,
    };
    // An already-opted-out lead stays opted out; `canTransition` returns false for a no-op, which
    // is the right answer for both "already there" and "further along than this".
    if (hard && canTransition(params.currentStatus, LEAD_STATUS_OPTED_OUT)) {
      update.status = LEAD_STATUS_OPTED_OUT;
    }

    await deps.db
      .update(leads)
      .set(update)
      .where(and(eq(leads.id, leadId), eq(leads.tenantId, tenantId)));

    const closed = await closePendingCallbacks(
      { db: deps.db, callbacksQueue: deps.callbacksQueue },
      {
        tenantId,
        leadId,
        state: 'cancelled',
        note: hard ? 'cancelled:opted_out' : 'cancelled:followup_stopped',
        clearLeadPointer: true,
      },
    );

    deps.logger?.info(
      {
        event: hard ? 'lead_opted_out' : 'followup_stopped',
        tenantId,
        leadId,
        channel: params.channel,
        source: signal.source,
        callbacksClosed: closed.closed,
      },
      hard
        ? 'Lead asked not to be contacted — opted out, callbacks cancelled'
        : 'Lead is not interested — follow-up ladder stopped',
    );

    return {
      action: hard ? 'opted_out' : 'followup_stopped',
      callbacksClosed: closed.closed,
    };
  } catch (err) {
    // Swallowed on purpose — see the header. The caller is an inbound message handler and must not
    // fail because of this, but a stop we failed to record is worth shouting about.
    deps.logger?.error(
      {
        event: 'stop_signal_apply_failed',
        tenantId,
        leadId,
        verdict: signal.verdict,
        err: err instanceof Error ? err.message : String(err),
      },
      'Failed to record a stop signal',
    );
    return { action: 'none', callbacksClosed: 0 };
  }
}
