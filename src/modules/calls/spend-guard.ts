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

// 3 consecutive failures anywhere in the process → one alert; success resets. Module-level on
// purpose: the operator cares that the BRAKE is dead, not which call noticed first.
let consecutiveFailures = 0;
let alertedForThisOutage = false;

/** Visible for tests. */
export function _resetSpendGuardFailureState(): void {
  consecutiveFailures = 0;
  alertedForThisOutage = false;
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

async function recordFailure(deps: SpendGuardDeps, err: unknown): Promise<void> {
  consecutiveFailures++;
  console.error(
    'spend_guard_check_failed',
    JSON.stringify({ consecutiveFailures, error: err instanceof Error ? err.message : String(err) }),
  );
  if (consecutiveFailures >= 3 && !alertedForThisOutage) {
    alertedForThisOutage = true;
    const send = deps.sendAlert ?? defaultSendAlert;
    await send(
      '🚨 בלם ה-toll fraud לא מתפקד — 3 בדיקות רצופות נכשלו',
      'בדיקת תקרת ההוצאה היומית נכשלה 3 פעמים ברצף. שיחות יוצאות ממשיכות ללא בלם (fail-open). יש לבדוק את חיבור ה-DB/Redis של השרת.',
    ).catch((alertErr) =>
      console.error('spend_guard_alert_failed', alertErr instanceof Error ? alertErr.message : String(alertErr)),
    );
  }
}

function recordSuccess(): void {
  consecutiveFailures = 0;
  alertedForThisOutage = false;
}

/**
 * The check — call it immediately before dialing. Also COUNTS the attempt (Redis INCR), so
 * blocked attempts are visible in the counter too.
 */
export async function checkDailySpendLimit(
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
  } catch (err) {
    await recordFailure(deps, err);
  }

  if (deps.redis) {
    try {
      const key = `spend:calls:${tenantId}:${israelDayKey(now)}`;
      callsToday = await deps.redis.incr(key);
      await deps.redis.expire(key, 48 * 60 * 60);
      redisOk = true;
    } catch (err) {
      await recordFailure(deps, err);
    }
  }

  if (dbOk || redisOk) recordSuccess();

  if (dbOk && spentUsd >= limits.dailySpendLimitUsd) {
    return { allowed: false, spentUsd, callsToday, limits, reason: 'daily_spend_limit_exceeded' };
  }
  if (redisOk && callsToday > limits.dailyCallLimit) {
    return { allowed: false, spentUsd, callsToday, limits, reason: 'daily_call_limit_exceeded' };
  }
  return { allowed: true, spentUsd, callsToday, limits, reason: null };
}
