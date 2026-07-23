import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { Database } from '../../db/client.js';
import { startOfIsraelDay, israelDayKey } from '../channels/voice-livekit/tools/israel-time.js';
import {
  TOLL_FRAUD_DEFAULTS,
  _resetSpendGuardFailureState,
  checkDailySpendLimit,
  resolveTollFraudSettings,
} from './spend-guard.js';

function fakeDb(opts: { totalSecs?: number; nullCount?: number; fail?: boolean } = {}) {
  return {
    select: vi.fn(() => ({
      from: () => ({
        where: async () => {
          if (opts.fail) throw new Error('db down');
          return [{ totalSecs: opts.totalSecs ?? 0, nullCount: opts.nullCount ?? 0 }];
        },
      }),
    })),
  } as unknown as Database;
}

function fakeRedis(opts: { count?: number; fail?: boolean } = {}) {
  return {
    incr: vi.fn(async () => {
      if (opts.fail) throw new Error('redis down');
      return opts.count ?? 1;
    }),
    expire: vi.fn(async () => 1),
  } as unknown as Redis;
}

beforeEach(() => _resetSpendGuardFailureState());

describe('resolveTollFraudSettings — there is ALWAYS a limit', () => {
  it('defaults: $50/day, $0.10/min, 100 calls/day', () => {
    expect(resolveTollFraudSettings(null)).toEqual(TOLL_FRAUD_DEFAULTS);
    expect(resolveTollFraudSettings({})).toEqual(TOLL_FRAUD_DEFAULTS);
  });

  it('tenant may TUNE the numbers', () => {
    const r = resolveTollFraudSettings({ toll_fraud: { dailySpendLimitUsd: 200, dailyCallLimit: 500 } });
    expect(r.dailySpendLimitUsd).toBe(200);
    expect(r.dailyCallLimit).toBe(500);
  });

  it('tenant can NEVER turn the brake off — 0/negative/garbage resolve to defaults', () => {
    for (const bad of [0, -5, 'off', null, Infinity, NaN]) {
      const r = resolveTollFraudSettings({ toll_fraud: { dailySpendLimitUsd: bad, dailyCallLimit: bad } });
      expect(r.dailySpendLimitUsd).toBe(50);
      expect(r.dailyCallLimit).toBe(100);
    }
  });
});

describe('startOfIsraelDay / israelDayKey — DST-safe day boundary', () => {
  it('summer (IDT, UTC+3): 23:59 vs 00:01 Israel land on different days', () => {
    // 2026-07-21 23:59 Israel = 20:59Z; 2026-07-22 00:01 Israel = 21:01Z on the 21st UTC!
    expect(israelDayKey(new Date('2026-07-21T20:59:00Z'))).toBe('2026-07-21');
    expect(israelDayKey(new Date('2026-07-21T21:01:00Z'))).toBe('2026-07-22');
    // Start of the Israel day 2026-07-21 is 20:00Z the day BEFORE (00:00 IDT = 21:00Z? no: +3 → 21:00Z on the 20th)
    expect(startOfIsraelDay(new Date('2026-07-21T10:00:00Z')).toISOString()).toBe('2026-07-20T21:00:00.000Z');
  });

  it('winter (IST, UTC+2): boundary shifts with the clock change', () => {
    expect(israelDayKey(new Date('2026-01-13T21:59:00Z'))).toBe('2026-01-13');
    expect(israelDayKey(new Date('2026-01-13T22:01:00Z'))).toBe('2026-01-14');
    expect(startOfIsraelDay(new Date('2026-01-13T10:00:00Z')).toISOString()).toBe('2026-01-12T22:00:00.000Z');
  });
});

describe('checkDailySpendLimit — dual caps', () => {
  const NOW = new Date('2026-07-21T10:00:00Z');

  it('under both caps → allowed, spend computed from minutes × rate', async () => {
    const d = await checkDailySpendLimit(
      { db: fakeDb({ totalSecs: 3600 }), redis: fakeRedis({ count: 5 }) },
      't1',
      {},
      NOW,
    );
    expect(d.allowed).toBe(true);
    expect(d.spentUsd).toBeCloseTo(6.0); // 60 min × $0.10
    expect(d.callsToday).toBe(5);
  });

  it('unfinished calls (null duration) are charged the assumed 2 minutes each', async () => {
    const d = await checkDailySpendLimit(
      { db: fakeDb({ totalSecs: 0, nullCount: 3 }), redis: fakeRedis() },
      't1',
      {},
      NOW,
    );
    expect(d.spentUsd).toBeCloseTo(0.6); // 3 × 2min × $0.10
  });

  it('dollar cap exceeded → blocked with daily_spend_limit_exceeded', async () => {
    const d = await checkDailySpendLimit(
      { db: fakeDb({ totalSecs: 50 * 600 + 60 }), redis: fakeRedis() }, // > $50 at $0.10/min
      't1',
      {},
      NOW,
    );
    expect(d).toMatchObject({ allowed: false, reason: 'daily_spend_limit_exceeded' });
  });

  it('call-count cap exceeded (real-time INCR) → blocked even at $0 spend', async () => {
    const d = await checkDailySpendLimit(
      { db: fakeDb({ totalSecs: 0 }), redis: fakeRedis({ count: 101 }) },
      't1',
      {},
      NOW,
    );
    expect(d).toMatchObject({ allowed: false, reason: 'daily_call_limit_exceeded' });
  });

  it('the attempt itself is counted — INCR with the Israel-day key + TTL', async () => {
    const redis = fakeRedis({ count: 7 });
    await checkDailySpendLimit({ db: fakeDb(), redis }, 't1', {}, NOW);
    expect(redis.incr).toHaveBeenCalledWith(`spend:calls:t1:${israelDayKey(NOW)}`);
    expect(redis.expire).toHaveBeenCalled();
  });

  it('fail-open: everything down → allowed, but loudly (this is a brake, not billing)', async () => {
    const d = await checkDailySpendLimit(
      { db: fakeDb({ fail: true }), redis: fakeRedis({ fail: true }) },
      't1',
      {},
      NOW,
    );
    expect(d.allowed).toBe(true);
  });
});

describe('the 3-strike operator alert', () => {
  const NOW = new Date('2026-07-21T10:00:00Z');
  const failingDeps = (sendAlert: (s: string, b: string) => Promise<void>) => ({
    db: fakeDb({ fail: true }),
    redis: fakeRedis({ fail: true }),
    sendAlert,
  });

  it('2 consecutive failures → no email; the 3rd → exactly one email', async () => {
    const sendAlert = vi.fn(async () => undefined);
    await checkDailySpendLimit(failingDeps(sendAlert), 't1', {}, NOW);
    expect(sendAlert).not.toHaveBeenCalled();
    await checkDailySpendLimit(failingDeps(sendAlert), 't1', {}, NOW);
    // Each check fails BOTH db and redis → 2 failures per check → threshold hits inside check #2.
    expect(sendAlert).toHaveBeenCalledTimes(1);
    await checkDailySpendLimit(failingDeps(sendAlert), 't1', {}, NOW);
    expect(sendAlert).toHaveBeenCalledTimes(1); // alert once per outage, not per failure
  });

  it('a successful check resets the streak and re-arms the alert', async () => {
    const sendAlert = vi.fn(async () => undefined);
    await checkDailySpendLimit(failingDeps(sendAlert), 't1', {}, NOW); // 2 strikes
    await checkDailySpendLimit({ db: fakeDb(), redis: fakeRedis(), sendAlert }, 't1', {}, NOW); // reset
    await checkDailySpendLimit(failingDeps(sendAlert), 't1', {}, NOW); // 2 strikes again — no alert yet
    expect(sendAlert).not.toHaveBeenCalled();
  });
});
