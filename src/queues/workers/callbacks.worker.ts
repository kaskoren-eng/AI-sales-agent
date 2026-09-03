import { Worker } from 'bullmq';
import type { Queue } from 'bullmq';
import { and, eq, gte } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../db/client.js';
import { callbacks, leads, scheduledCalls, tenants } from '../../db/schema/index.js';
import { AppError } from '../../shared/errors.js';
import { CircuitOpenError } from '../../shared/circuit-breaker.js';
import {
  clampToWindow,
  dialOrdinal,
  nextRung,
  type CallbackKind,
} from '../../modules/channels/voice-livekit/tools/callback-time.js';
import {
  resolveCallbackSettings,
  type CallbackSettings,
} from '../../modules/channels/voice-livekit/tools/callback-settings.js';
import { callbackJobId, enqueueCallback, type CallbackJob } from '../callbacks.queue.js';
import { handleDeadLetter } from '../dead-letter.js';

/**
 * THE THING THAT ACTUALLY RINGS HIM BACK.
 *
 * Design: `docs/phase-8-callback-and-followup-model.md` §5 (mechanism), §4 (windows), §7 (ladder).
 * Until this worker existed, `callbacks` rows were written by `voice-livekit/disconnect.ts` and
 * read by nobody: a durable promise with nothing behind it.
 *
 * -- FIRE-TIME AUTHORITY ----------------------------------------------------------------------
 *
 * The job carries an id and two counters. Everything else is re-read, in this order, each check
 * authoritative over whatever was true when the job was created:
 *
 *   1. the row exists and is still `pending` — the cancellation and supersession backstop. A
 *      superseded callback is a NORMAL outcome here, not a failure: one live callback per lead
 *      means the older row is expected to lose;
 *   2. `lead.status === 'opted_out'` → NEVER dial. Unconditional. No tenant setting reaches this;
 *   3. the lead has since booked a meeting → cancelled, and the reason recorded;
 *   4. the tenant turned callbacks off since the row was written → skip, leave it pending;
 *   5. the window (§4) → DEFER, never drop and never dial outside it;
 *   6. the dial. `evaluateSpend` runs inside `initiateOutboundCall`, so a spend limit arrives here
 *      as a 429 and is treated as a deferral rather than a failed attempt.
 *
 * -- `attempt` COUNTS DIALS MADE --------------------------------------------------------------
 *
 * A fresh row is 0; after the first dial it is 1. Two things depend on it and neither is obvious:
 *
 *   · `clampToWindow`'s honored-window branch treats 0 and 1 alike (both mean "rung 1"), so the
 *     ordinal of the dial being scheduled is `attempt + 1` — `dialOrdinal()`. Passing the raw
 *     `attempt` when scheduling rung 2 puts it back in the HONORED window and rings a lead at
 *     22:00 on a night he never asked about;
 *   · the increment happens only when a dial was ACTUALLY placed. A spend limit, a missing trunk
 *     and an open circuit breaker all fail before the phone could ring, and none of them burns a
 *     rung — an outage must not exhaust a lead's ladder.
 *
 * -- THE NEVER-ANSWERED RING ------------------------------------------------------------------
 *
 * A lead who simply does not pick up is recorded NOWHERE else in this system. `no_answer` and
 * `voicemail` in `call-reflexes.ts` are set when a call CONNECTS and then goes silent; a phone
 * that rings out surfaces only as a rejection from `createSipParticipant({waitUntilAnswered:true})`,
 * and before this worker nothing wrote that down. `callbacks.last_outcome` is now the one place
 * that fact lives, which is why `classifyDialFailure` defaults to `no_answer` rather than to
 * `failed` — see its own note for what that costs.
 *
 * -- STOPPING IS A FEATURE --------------------------------------------------------------------
 *
 * `nextRung` returns null after the last rung and this worker writes `exhausted`. A lead who did
 * not answer three times is left alone. The one final WhatsApp §7 describes belongs to the
 * confirmation-message task (F1.5) and is deliberately not written here — no new spoken or
 * written Hebrew ships on this branch.
 *
 * -- IT DOES NOT THROW FOR ANYTHING THE LADDER OWNS -------------------------------------------
 *
 * A throw here means a BullMQ retry and eventually the dead-letter queue, and a row left `pending`
 * with no live job — invisible until someone runs the reconcile script. So every outcome this
 * worker understands is written to the row and returned. Only a genuinely unknown failure (the DB
 * itself) is allowed to propagate, and that is what the DLQ is for.
 */

/** Just enough of `LiveKitVoiceService` to dial — so the tests need no LiveKit. */
export interface CallbackDialer {
  initiateOutboundCall(
    to: string,
    tenantId: string,
    leadContext?: { leadId?: string; name?: string; email?: string },
  ): Promise<{ callId: string }>;
}

export interface CallbacksWorkerDeps {
  db: Database;
  redis: Redis;
  deadLetterQueue: Queue;
  /** The same 'callbacks' queue — needed to re-enqueue deferrals and the next rung. */
  callbacksQueue: Queue;
  /** Undefined when LiveKit is not configured at all (server.ts stays up without it). */
  voiceLivekit?: CallbackDialer;
  /** Only `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` is read: without it nothing can ring. */
  env: { LIVEKIT_SIP_OUTBOUND_TRUNK_ID?: string };
  logger?: FastifyBaseLogger;
  /** Test seam — fire-time "now". */
  now?: () => Date;
}

export type CallbackOutcomeKind =
  /** The lead picked up. The call is the agent's business from here. */
  | 'dialed'
  /** Nothing was done and nothing needed to be: superseded, cancelled, opted out, booked. */
  | 'skipped'
  /** Not now — the window, a spend cap or an outage. `attempt` unchanged, a new job queued. */
  | 'deferred'
  /** A dial was made and not answered; the next rung is queued. */
  | 'retry_scheduled'
  /** The ladder is finished. The lead is left alone. */
  | 'exhausted'
  /** Something is wrong with the configuration, and the row says so instead of retrying forever. */
  | 'failed';

export interface CallbackResult {
  outcome: CallbackOutcomeKind;
  detail?: string;
  callId?: string;
}

/**
 * How many times one rung may be pushed out of the calling window before we stop moving it.
 *
 * `clampToWindow` always returns an instant INSIDE the window, so a second deferral means the job
 * fired late by hours — a stopped worker, a Redis restore. Five is far past that and makes the
 * loop provably finite: the alternative is a job that re-enqueues itself forever, which is the one
 * failure mode a "never drop it" rule can quietly create.
 */
export const MAX_DEFERRALS = 5;

/** A spend cap is a day-shaped problem — retry late enough that the cap may have reset. */
const SPEND_RETRY_MINUTES = 30;
/** An open circuit breaker is a minutes-shaped problem (30s cooldown, plus room to recover). */
const OUTAGE_RETRY_MINUTES = 5;

const MINUTE_MS = 60_000;

/** `callbacks.last_outcome`. `no_trunk` extends the column's documented set — see the schema. */
export type CallbackDialOutcome =
  | 'answered'
  | 'no_answer'
  | 'busy'
  | 'voicemail'
  | 'failed'
  | 'no_trunk';

/**
 * What a rejected dial means, from the only evidence we have: the error.
 *
 * THE DEFAULT IS A JUDGEMENT CALL, AND IT IS NOT FREE. With `waitUntilAnswered: true` the
 * overwhelmingly common rejection is a phone that rang out, and `no_answer` is the fact this row
 * exists to record. So an unrecognised error is read as `no_answer` rather than `failed` — which
 * means a genuine LiveKit fault, if it ever reaches here, is filed as a lead who did not pick up.
 *
 * The mitigation is that the raw provider message is appended to `callbacks.reason`, so the row
 * still says what actually happened. Doing better needs the SIP status code, which LiveKit does
 * not reliably surface in the SDK error today. Flagged in the handoff.
 *
 * Errors raised BEFORE the phone could ring — spend cap, missing trunk, open breaker — never reach
 * this function; they are classified by their AppError code in `processCallback`.
 */
export function classifyDialFailure(err: unknown): CallbackDialOutcome {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/\b(486|600)\b/.test(message) || message.includes('busy')) return 'busy';
  if (message.includes('voicemail') || message.includes('answering machine')) return 'voicemail';
  return 'no_answer';
}

/** Row shape the worker reads. Narrow on purpose — everything selected is used. */
interface CallbackRow {
  id: string;
  leadId: string;
  dueAt: Date;
  state: string;
  kind: string;
  requestedByLead: boolean;
  attempt: number;
  maxAttempts: number;
  reason: string | null;
}

interface LeadRow {
  id: string;
  status: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

/** Free-text cap on `callbacks.reason`, so a chatty provider error cannot grow the row unbounded. */
const MAX_REASON_CHARS = 500;

/**
 * Append a note to `reason` instead of overwriting it. The original reason
 * ("caller_hung_up:discovery", the lead's own words) is why this callback exists and must survive
 * whatever happens to it.
 */
function appendReason(existing: string | null, note: string): string {
  return [existing, note].filter(Boolean).join(' | ').slice(0, MAX_REASON_CHARS);
}

/**
 * `callbackPunctuality` in one number: how late, in seconds, this dial is against the instant the
 * row promised. §10 — "a callback that fires 40 minutes late is a worse experience than no
 * callback, and every other counter here stays green through it."
 */
function lateBy(dueAt: Date, now: Date): number {
  return Math.round((now.getTime() - dueAt.getTime()) / 1000);
}

/** The processor, exported bare so tests drive it without a live BullMQ worker. */
export async function processCallback(
  deps: CallbacksWorkerDeps,
  data: CallbackJob,
): Promise<CallbackResult> {
  const { db, logger } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const base = { tenantId: data.tenantId, callbackId: data.callbackId };

  const setRow = async (values: Record<string, unknown>): Promise<void> => {
    await db
      .update(callbacks)
      .set({ ...values, updatedAt: now })
      .where(and(eq(callbacks.tenantId, data.tenantId), eq(callbacks.id, data.callbackId)));
  };

  /** The lead's denormalized pointer. Its own statement, never bundled into a row update. */
  const setLeadPointer = async (leadId: string, at: Date | null): Promise<void> => {
    await db
      .update(leads)
      .set({ nextCallbackAt: at, updatedAt: now })
      .where(and(eq(leads.id, leadId), eq(leads.tenantId, data.tenantId)));
  };

  // -- 1. The row is the truth about whether this callback still stands ------------------------
  const rows = (await db
    .select({
      id: callbacks.id,
      leadId: callbacks.leadId,
      dueAt: callbacks.dueAt,
      state: callbacks.state,
      kind: callbacks.kind,
      requestedByLead: callbacks.requestedByLead,
      attempt: callbacks.attempt,
      maxAttempts: callbacks.maxAttempts,
      reason: callbacks.reason,
    })
    .from(callbacks)
    .where(and(eq(callbacks.tenantId, data.tenantId), eq(callbacks.id, data.callbackId)))
    .limit(1)) as CallbackRow[];

  const row = rows[0];
  if (!row) {
    logger?.info({ event: 'callback_row_gone', ...base }, 'Callback skipped — row no longer exists');
    return { outcome: 'skipped', detail: 'row_gone' };
  }
  if (row.state !== 'pending') {
    // Superseded, cancelled, already done. A normal outcome, logged at info, never a failure.
    logger?.info(
      { event: 'callback_not_pending', ...base, state: row.state },
      'Callback skipped — no longer pending',
    );
    return { outcome: 'skipped', detail: `not_pending:${row.state}` };
  }

  // -- 2. Opt-out is absolute, and it is checked before anything that could dial ---------------
  const leadRows = (await db
    .select({
      id: leads.id,
      status: leads.status,
      name: leads.name,
      phone: leads.phone,
      email: leads.email,
    })
    .from(leads)
    .where(and(eq(leads.id, row.leadId), eq(leads.tenantId, data.tenantId)))
    .limit(1)) as LeadRow[];

  const lead = leadRows[0];
  if (!lead) {
    await setRow({ state: 'cancelled', reason: appendReason(row.reason, 'lead_gone') });
    logger?.warn({ event: 'callback_lead_gone', ...base }, 'Callback cancelled — lead row is gone');
    return { outcome: 'skipped', detail: 'lead_gone' };
  }
  if (lead.status === 'opted_out') {
    await setRow({ state: 'cancelled', reason: appendReason(row.reason, 'opted_out') });
    await setLeadPointer(lead.id, null);
    logger?.info(
      { event: 'callback_cancelled_opted_out', ...base },
      'Callback cancelled — lead opted out. Never dialled.',
    );
    return { outcome: 'skipped', detail: 'opted_out' };
  }

  // -- 3. A lead who has since booked is not chased --------------------------------------------
  const booked = await db
    .select({ id: scheduledCalls.id })
    .from(scheduledCalls)
    .where(
      and(
        eq(scheduledCalls.tenantId, data.tenantId),
        eq(scheduledCalls.leadId, lead.id),
        eq(scheduledCalls.status, 'scheduled'),
        gte(scheduledCalls.scheduledAt, now),
      ),
    )
    .limit(1);
  if (booked.length > 0) {
    await setRow({ state: 'cancelled', reason: appendReason(row.reason, 'meeting_booked') });
    await setLeadPointer(lead.id, null);
    logger?.info(
      { event: 'callback_cancelled_booked', ...base },
      'Callback cancelled — the lead has a meeting booked',
    );
    return { outcome: 'skipped', detail: 'meeting_booked' };
  }

  // -- 4. The tenant may have turned callbacks off since this row was written ------------------
  const tenantRows = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, data.tenantId))
    .limit(1);
  const cfg: CallbackSettings = resolveCallbackSettings(tenantRows[0]?.settings);
  if (!cfg.enabled) {
    // Left `pending` deliberately: the tenant may switch it back on, and the reconcile script will
    // find the row again. Cancelling here would destroy a promise on a config flip.
    logger?.info(
      { event: 'callback_disabled', ...base },
      'Callback skipped — disabled for this tenant',
    );
    return { outcome: 'skipped', detail: 'disabled' };
  }

  // The ladder's own ceiling, and the tenant's, whichever is shorter.
  const maxAttempts = Math.min(row.maxAttempts, cfg.maxAttempts);
  if (row.attempt >= maxAttempts) {
    // Backstop. Reaching here means a job outlived its ladder — the row is already finished.
    await setRow({ state: 'exhausted' });
    await setLeadPointer(lead.id, null);
    return { outcome: 'exhausted', detail: 'already_at_max' };
  }

  /** Push this rung out without spending it: same `attempt`, a fresh `-d<n>` job id. */
  const defer = async (rawAt: Date, why: string): Promise<CallbackResult> => {
    if (data.deferrals >= MAX_DEFERRALS) {
      await setRow({
        state: 'failed',
        lastOutcome: 'failed',
        reason: appendReason(row.reason, `deferral_cap:${why}`),
      });
      logger?.error(
        { event: 'callback_deferral_cap', ...base, why },
        'Callback deferred too many times — stopping rather than looping',
      );
      return { outcome: 'failed', detail: 'deferral_cap' };
    }
    // Clamp again: a spend/outage retry gap can land in the night just as easily as a rung can.
    const at = clampToWindow(
      rawAt,
      { requestedByLead: row.requestedByLead, attempt: dialOrdinal(row.attempt) },
      now,
      cfg,
    ).dueAt;
    const deferrals = data.deferrals + 1;
    const jobId = callbackJobId(data.callbackId, row.attempt, deferrals);
    await setRow({ dueAt: at, jobId });
    await setLeadPointer(row.leadId, at);
    await enqueueCallback(
      deps.callbacksQueue,
      { tenantId: data.tenantId, callbackId: data.callbackId, attempt: row.attempt, deferrals },
      at.getTime() - now.getTime(),
    );
    logger?.info(
      { event: 'callback_deferred', ...base, why, dueAt: at.toISOString(), deferrals },
      'Callback deferred — outside the calling window or blocked upstream',
    );
    return { outcome: 'deferred', detail: why };
  };

  // -- 5. The window. Never dial outside it, under any circumstance ----------------------------
  const ordinal = dialOrdinal(row.attempt);
  const clamped = clampToWindow(
    row.dueAt,
    { requestedByLead: row.requestedByLead, attempt: ordinal },
    now,
    cfg,
  );
  if (clamped.dueAt.getTime() > now.getTime()) {
    return defer(clamped.dueAt, `window:${clamped.reasons.join(',') || 'moved'}`);
  }

  // -- 6. The dial ------------------------------------------------------------------------------
  if (!lead.phone) {
    await setRow({
      state: 'failed',
      lastOutcome: 'failed',
      reason: appendReason(row.reason, 'no_phone'),
    });
    await setLeadPointer(lead.id, null);
    logger?.error(
      { event: 'callback_no_phone', ...base },
      'Callback failed — the lead has no phone number',
    );
    return { outcome: 'failed', detail: 'no_phone' };
  }

  if (!deps.voiceLivekit || !deps.env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID) {
    // The config gap that once made production report placing calls for weeks while dialling
    // nothing. It is written to the ROW, not just logged, so it is visible from the database.
    const detail = deps.voiceLivekit ? 'no_trunk' : 'livekit_unconfigured';
    await setRow({
      state: 'failed',
      lastOutcome: 'no_trunk',
      reason: appendReason(row.reason, detail),
    });
    await setLeadPointer(lead.id, null);
    logger?.error(
      { event: 'callback_dial_unconfigured', ...base, detail },
      'CALLBACK NOT DIALLED — LIVEKIT_SIP_OUTBOUND_TRUNK_ID is unset (or LiveKit is unconfigured). Every callback will fail until this is set.',
    );
    return { outcome: 'failed', detail };
  }

  // `dialing` is written BEFORE the await so a crash mid-dial is visible as exactly that. The
  // reconcile script rescues rows stuck here; a row left `pending` through a dial would be
  // indistinguishable from one that never started.
  await setRow({ state: 'dialing' });

  try {
    const { callId } = await deps.voiceLivekit.initiateOutboundCall(lead.phone, data.tenantId, {
      leadId: lead.id,
      ...(lead.name ? { name: lead.name } : {}),
      ...(lead.email ? { email: lead.email } : {}),
    });
    await setRow({ state: 'done', attempt: ordinal, lastOutcome: 'answered' });
    await setLeadPointer(lead.id, null);
    logger?.info(
      {
        event: 'callback_dialed',
        ...base,
        attempt: ordinal,
        callId,
        lateBySeconds: lateBy(row.dueAt, now),
      },
      'Callback answered',
    );
    return { outcome: 'dialed', detail: `attempt:${ordinal}`, callId };
  } catch (err) {
    const code = err instanceof AppError ? err.code : undefined;

    // Neither of these got as far as ringing a phone, so neither costs a rung.
    if (code === 'SPEND_LIMIT_EXCEEDED') {
      await setRow({ state: 'pending' });
      return defer(new Date(now.getTime() + SPEND_RETRY_MINUTES * MINUTE_MS), 'spend_limit');
    }
    if (err instanceof CircuitOpenError) {
      await setRow({ state: 'pending' });
      return defer(new Date(now.getTime() + OUTAGE_RETRY_MINUTES * MINUTE_MS), 'circuit_open');
    }
    if (code === 'SIP_TRUNK_NOT_CONFIGURED') {
      await setRow({
        state: 'failed',
        lastOutcome: 'no_trunk',
        reason: appendReason(row.reason, 'no_trunk'),
      });
      await setLeadPointer(lead.id, null);
      logger?.error(
        { event: 'callback_dial_unconfigured', ...base, detail: 'no_trunk' },
        'CALLBACK NOT DIALLED — the dialer reports no outbound trunk.',
      );
      return { outcome: 'failed', detail: 'no_trunk' };
    }

    // A dial WAS made and the lead did not come on the line. This is the rung.
    const outcome = classifyDialFailure(err);
    const message = err instanceof Error ? err.message : String(err);
    const reason = appendReason(row.reason, `${outcome}:${message}`);
    const attemptsMade = ordinal;

    logger?.info(
      { event: 'callback_not_reached', ...base, attempt: attemptsMade, outcome },
      'Callback dialled and not answered',
    );

    if (attemptsMade >= maxAttempts) {
      await setRow({ state: 'exhausted', attempt: attemptsMade, lastOutcome: outcome, reason });
      await setLeadPointer(lead.id, null);
      logger?.info(
        { event: 'callback_exhausted', ...base, attempts: attemptsMade },
        'Callback ladder finished — the lead is left alone',
      );
      return { outcome: 'exhausted', detail: `${outcome}:${attemptsMade}` };
    }

    const plan = nextRung(row.kind as CallbackKind, attemptsMade, now);
    if (!plan) {
      // The ladder is shorter than maxAttempts. The ladder wins: stopping is the feature.
      await setRow({ state: 'exhausted', attempt: attemptsMade, lastOutcome: outcome, reason });
      await setLeadPointer(lead.id, null);
      return { outcome: 'exhausted', detail: `${outcome}:ladder_end` };
    }

    // Every rung after the first is proactive — `dialOrdinal(attemptsMade)` is 2 or more, which is
    // what takes `windowFor` out of the honored branch.
    const nextAt = clampToWindow(
      plan.dueAt,
      { requestedByLead: row.requestedByLead, attempt: dialOrdinal(attemptsMade) },
      now,
      cfg,
    ).dueAt;
    const jobId = callbackJobId(data.callbackId, attemptsMade, 0);
    await setRow({
      state: 'pending',
      attempt: attemptsMade,
      lastOutcome: outcome,
      reason,
      dueAt: nextAt,
      jobId,
    });
    await setLeadPointer(lead.id, nextAt);
    await enqueueCallback(
      deps.callbacksQueue,
      {
        tenantId: data.tenantId,
        callbackId: data.callbackId,
        attempt: attemptsMade,
        deferrals: 0,
      },
      nextAt.getTime() - now.getTime(),
    );
    logger?.info(
      { event: 'callback_rung_scheduled', ...base, rung: plan.rung.rung, dueAt: nextAt.toISOString() },
      'Next callback rung scheduled',
    );
    return { outcome: 'retry_scheduled', detail: `rung:${plan.rung.rung}` };
  }
}

/**
 * Start the callbacks worker — or don't.
 *
 * THE FLAG GATE LIVES HERE, NOT IN server.ts, so that OFF is provable by RUNNING it: with
 * `enabled: false` no Worker is constructed, no Redis connection is duplicated, and the return
 * value says so. The alternative — an `if` in server.ts — can only be tested by asserting that a
 * file contains some text, which proves the text exists and nothing about whether it gates
 * anything. This repo has shipped a flag that silently did nothing before.
 */
export function startCallbacksWorker(
  deps: CallbacksWorkerDeps & { enabled: boolean },
): Worker<CallbackJob> | null {
  if (!deps.enabled) return null;

  const worker = new Worker<CallbackJob>(
    'callbacks',
    async (job) => processCallback(deps, job.data),
    {
      connection: deps.redis.duplicate(),
      // Deliberately low. Every job here places a PHONE CALL; two at once is two simultaneous
      // outbound dials on one tenant's trunk, and the spend guard is a cap, not a rate limit.
      concurrency: 2,
    },
  );

  worker.on('failed', (job, err) => {
    deps.logger?.error({ jobId: job?.id, err }, 'Callback job failed');
    handleDeadLetter(deps.deadLetterQueue, job, err);
  });

  return worker;
}
