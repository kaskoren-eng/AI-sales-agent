import { and, gte, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Database } from '../../db/client.js';
import { callLearnings } from '../../db/schema/index.js';
import { israelDayKey, startOfIsraelDay } from '../channels/voice-livekit/tools/israel-time.js';

/**
 * Toll-fraud brake — DUAL daily caps per tenant, checked before EVERY outbound dial.
 *
 * Why two caps (Koren's decision, 2026-07-21):
 *  - DOLLAR CAP: minutes × rate over today's call_learnings. Tracks real cost, but rows are
 *    written at call TEARDOWN — N long calls in flight contribute $0 until they end.
 *  - CALL-COUNT CAP: a per-tenant Redis counter incremented AT DIAL TIME — real-time, closes the
 *    teardown blindspot. An attacker triggering a dial burst hits this one first.
 *
 * There is ALWAYS a limit: the tenant can tune the numbers via settings.toll_fraud, but 0/null/
 * garbage all resolve to the defaults — no tenant can switch the brake off (build principle 4).
 *
 * FAIL-OPEN, LOUDLY: a broken guard must not silence a working sales channel (this is an abuse
 * brake, not a billing invariant) — but a silently-dead brake is worse, so 3 CONSECUTIVE check
 * failures fire an email alert to the operator (restored per Koren's approval).
 */

export interface TollFraudSettings {
  dailySpendLimitUsd: number;
  perMinuteRateUsd: number;
  dailyCallLimit: number;
}

export const TOLL_FRAUD_DEFAULTS: TollFraudSettings = {
  dailySpendLimitUsd: 50,
  perMinuteRateUsd: 0.1,
  dailyCallLimit: 100,
};

/** Minutes charged for a call that never wrote a duration (crashed mid-call — still cost money). */
const ASSUMED_MINUTES_PER_UNFINISHED_CALL = 2;

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

/** Tenant overrides with hard floors — invalid/absent/zero all mean "the default", never "off". */
export function resolveTollFraudSettings(settings: unknown): TollFraudSettings {
  const raw =
    settings && typeof settings === 'object'
      ? ((settings as Record<string, unknown>)['toll_fraud'] as Record<string, unknown> | undefined)
      : undefined;
  return {
    dailySpendLimitUsd: num(raw?.dailySpendLimitUsd) ?? TOLL_FRAUD_DEFAULTS.dailySpendLimitUsd,
    perMinuteRateUsd: num(raw?.perMinuteRateUsd) ?? TOLL_FRAUD_DEFAULTS.perMinuteRateUsd,
    dailyCallLimit: num(raw?.dailyCallLimit) ?? TOLL_FRAUD_DEFAULTS.dailyCallLimit,
  };
}

export interface SpendDecision {
  allowed: boolean;
  spentUsd: number;
  callsToday: number;
  limits: TollFraudSettings;
  reason: 'daily_spend_limit_exceeded' | 'daily_call_limit_exceeded' | null;
}

export interface SpendGuardDeps {
  db: Database;
  redis?: Redis | null;
  /** Test seam for the 3-strike alert. Defaults to the Resend email below. */
  sendAlert?: (subject: string, body: string) => Promise<void>;
}

/**
 * Failure tracking, PER CAP.
 *
 * These used to share one counter, reset by `if (dbOk || redisOk) recordSuccess()`. That line
 * disarmed the very alert it was meant to arm: with Postgres down and Redis up, the dollar cap was
 * dead — no spend was being measured at all — and a healthy Redis reset the counter on every
 * check, so the 3-strike alert could never fire. The half of the brake that had failed was
 * precisely the half nobody would be told about.
 *
 * Two caps, two counters, two alerts. Module-level on purpose: the operator cares that a brake is
 * dead, not which call noticed first.
 */
interface CapHealth {
  consecutiveFailures: number;
  alerted: boolean;
}

const health: Record<'spend' | 'calls', CapHealth> = {
  spend: { consecutiveFailures: 0, alerted: false },
  calls: { consecutiveFailures: 0, alerted: false },
};

/** Visible for tests. */
export function _resetSpendGuardFailureState(): void {
  health.spend = { consecutiveFailures: 0, alerted: false };
  health.calls = { consecutiveFailures: 0, alerted: false };
}

async function defaultSendAlert(subject: string, body: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('spend_guard_alert_no_resend_key — cannot email operator');
    return;
  }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Keren Voice Agent <koren@clickscales.com>',
      to: ['kaskoren@gmail.com'],
      subject,
      html: `<div dir="rtl">${body}</div>`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
}

const CAP_LABEL: Record<'spend' | 'calls', string> = {
  spend: 'תקרת ההוצאה היומית (דולרים)',
  calls: 'תקרת מספר השיחות היומי',
};

async function recordFailure(
  deps: SpendGuardDeps,
  cap: 'spend' | 'calls',
  err: unknown,
): Promise<void> {
  const state = health[cap];
  state.consecutiveFailures++;
  console.error(
    'spend_guard_check_failed',
    JSON.stringify({
      cap,
      consecutiveFailures: state.consecutiveFailures,
      error: err instanceof Error ? err.message : String(err),
    }),
  );

  if (state.consecutiveFailures >= 3 && !state.alerted) {
    state.alerted = true;
    const send = deps.sendAlert ?? defaultSendAlert;
    await send(
      `🚨 בלם ה-toll fraud לא מתפקד — ${CAP_LABEL[cap]}`,
      `${CAP_LABEL[cap]} נכשלה 3 פעמים ברצף. שיחות יוצאות ממשיכות ללא הבלם הזה (fail-open). ` +
        'יש לבדוק את חיבור ה-DB/Redis של השרת.',
    ).catch((alertErr) =>
      console.error('spend_guard_alert_failed', alertErr instanceof Error ? alertErr.message : String(alertErr)),
    );
  }
}

/** Reset ONE cap's health. Never reset a cap because the other one is fine. */
function recordSuccess(cap: 'spend' | 'calls'): void {
  health[cap] = { consecutiveFailures: 0, alerted: false };
}

const dayKey = (tenantId: string, now: Date) => `spend:calls:${tenantId}:${israelDayKey(now)}`;

/** Two days, so a call placed just before midnight still sees its counter after the rollover. */
const COUNTER_TTL_SECONDS = 48 * 60 * 60;

/**
 * READ the caps. No side effects — safe to call as many times as you like, from as many places as
 * you like.
 *
 * This used to be one function that both read the caps AND incremented the dial counter, and it
 * was called twice per outbound call: once by the flow executor (policy check) and again by the
 * dial service (defence in depth). Each call incremented. So every real dial counted as two, and
 * `dailyCallLimit: 100` actually blocked at about 50 — the brake was twice as tight as configured,
 * and the number in the settings meant nothing.
 *
 * Splitting the read from the count is what makes defence-in-depth safe: checking in more places
 * is now free, and only the code that actually dials calls `countDialAttempt`.
 */
export async function evaluateSpend(
  deps: SpendGuardDeps,
  tenantId: string,
  settings: unknown,
  now: Date = new Date(),
): Promise<SpendDecision> {
  const limits = resolveTollFraudSettings(settings);
  let spentUsd = 0;
  let callsToday = 0;
  let dbOk = false;
  let redisOk = false;

  try {
    const rows = await deps.db
      .select({
        totalSecs: sql<number>`coalesce(sum(${callLearnings.durationSecs}), 0)`,
        nullCount: sql<number>`count(*) FILTER (WHERE ${callLearnings.durationSecs} IS NULL)`,
      })
      .from(callLearnings)
      .where(and(eq(callLearnings.tenantId, tenantId), gte(callLearnings.createdAt, startOfIsraelDay(now))));
    const totalSecs = Number(rows[0]?.totalSecs ?? 0);
    const nullCount = Number(rows[0]?.nullCount ?? 0);
    spentUsd = (totalSecs / 60 + nullCount * ASSUMED_MINUTES_PER_UNFINISHED_CALL) * limits.perMinuteRateUsd;
    dbOk = true;
    recordSuccess('spend');
  } catch (err) {
    await recordFailure(deps, 'spend', err);
  }

  if (deps.redis) {
    try {
      // GET, not INCR. The counter is advanced by countDialAttempt() and nowhere else.
      const raw = await deps.redis.get(dayKey(tenantId, now));
      callsToday = raw ? Number(raw) : 0;
      if (!Number.isFinite(callsToday)) callsToday = 0;
      redisOk = true;
      recordSuccess('calls');
    } catch (err) {
      await recordFailure(deps, 'calls', err);
    }
  }

  if (dbOk && spentUsd >= limits.dailySpendLimitUsd) {
    return { allowed: false, spentUsd, callsToday, limits, reason: 'daily_spend_limit_exceeded' };
  }
  /**
   * `>=`, not `>`.
   *
   * The old comparison ran AFTER the increment, so the value included the attempt being judged.
   * This one runs BEFORE, so it is the number of attempts already made. With a limit of 100:
   * attempt 101 sees 100 already made and is refused, which allows exactly 100 — the same
   * behaviour the old `>` gave post-increment. Getting this backwards is an off-by-one in the
   * only number standing between an attacker and an unbounded phone bill.
   */
  if (redisOk && callsToday >= limits.dailyCallLimit) {
    return { allowed: false, spentUsd, callsToday, limits, reason: 'daily_call_limit_exceeded' };
  }
  return { allowed: true, spentUsd, callsToday, limits, reason: null };
}

/**
 * COUNT one dial attempt. Call this EXACTLY ONCE per real attempt, from the code that dials.
 *
 * Deliberately counts attempts and not successes: the abuse this brake exists to stop is a burst
 * of dials, and a dial that fails at the carrier still costs money and still indicates the burst.
 *
 * Failure is swallowed — this is a brake, not a billing invariant, and a Redis blip must not stop
 * a working sales channel. It is recorded against the calls cap's health, so three in a row alerts.
 */
export async function countDialAttempt(
  deps: SpendGuardDeps,
  tenantId: string,
  now: Date = new Date(),
): Promise<number | null> {
  if (!deps.redis) return null;
  try {
    const key = dayKey(tenantId, now);
    const count = await deps.redis.incr(key);
    await deps.redis.expire(key, COUNTER_TTL_SECONDS);
    recordSuccess('calls');
    return count;
  } catch (err) {
    await recordFailure(deps, 'calls', err);
    return null;
  }
}
