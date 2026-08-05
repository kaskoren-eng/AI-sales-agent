import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { Database } from '../../db/client.js';
import { startOfIsraelDay, israelDayKey } from '../channels/voice-livekit/tools/israel-time.js';
import {
  TOLL_FRAUD_DEFAULTS,
  _resetSpendGuardFailureState,
  evaluateSpend,
  countDialAttempt,
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

/**
 * `count` is the number of dials ALREADY made today — what GET returns. It is no longer the value
 * INCR returns, because evaluateSpend() reads the counter and countDialAttempt() advances it.
 */
function fakeRedis(opts: { count?: number; fail?: boolean; failIncrOnly?: boolean } = {}) {
  let value = opts.count ?? 0;
  return {
    get: vi.fn(async () => {
      if (opts.fail) throw new Error('redis down');
      return String(value);
    }),
    incr: vi.fn(async () => {
      if (opts.fail || opts.failIncrOnly) throw new Error('redis down');
      return ++value;
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

describe('evaluateSpend — dual caps, read-only', () => {
  const NOW = new Date('2026-07-21T10:00:00Z');

  it('under both caps → allowed, spend computed from minutes × rate', async () => {
    const d = await evaluateSpend(
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
    const d = await evaluateSpend(
      { db: fakeDb({ totalSecs: 0, nullCount: 3 }), redis: fakeRedis() },
      't1',
      {},
      NOW,
    );
    expect(d.spentUsd).toBeCloseTo(0.6); // 3 × 2min × $0.10
  });

  it('dollar cap exceeded → blocked with daily_spend_limit_exceeded', async () => {
    const d = await evaluateSpend(
      { db: fakeDb({ totalSecs: 50 * 600 + 60 }), redis: fakeRedis() }, // > $50 at $0.10/min
      't1',
      {},
      NOW,
    );
    expect(d).toMatchObject({ allowed: false, reason: 'daily_spend_limit_exceeded' });
  });

  it('DOES NOT COUNT — reading the caps has no side effect', async () => {
    /**
     * THE BUG (#4). This function used to INCR the dial counter as part of checking, and it was
     * called twice per outbound call: once by the flow executor as a policy check, once by the
     * dial service as defence in depth. Every real call therefore counted as two, and a
     * `dailyCallLimit` of 100 actually blocked at about 50 — the configured number meant nothing.
     */
    const redis = fakeRedis({ count: 7 });
    await evaluateSpend({ db: fakeDb(), redis }, 't1', {}, NOW);
    await evaluateSpend({ db: fakeDb(), redis }, 't1', {}, NOW);
    await evaluateSpend({ db: fakeDb(), redis }, 't1', {}, NOW);
    expect(redis.incr).not.toHaveBeenCalled();
    expect(redis.get).toHaveBeenCalledWith(`spend:calls:t1:${israelDayKey(NOW)}`);
  });

  it('fail-open: everything down → allowed, but loudly (this is a brake, not billing)', async () => {
    const d = await evaluateSpend(
      { db: fakeDb({ fail: true }), redis: fakeRedis({ fail: true }) },
      't1',
      {},
      NOW,
    );
    expect(d.allowed).toBe(true);
  });
});

describe('countDialAttempt — the only writer', () => {
  const NOW = new Date('2026-07-21T10:00:00Z');

  it('INCRs the Israel-day key and sets a TTL', async () => {
    const redis = fakeRedis({ count: 6 });
    const n = await countDialAttempt({ db: fakeDb(), redis }, 't1', NOW);
    expect(redis.incr).toHaveBeenCalledWith(`spend:calls:t1:${israelDayKey(NOW)}`);
    expect(redis.expire).toHaveBeenCalled();
    expect(n).toBe(7);
  });

  it('swallows a Redis failure — a blip must not stop a working sales channel', async () => {
    const redis = fakeRedis({ failIncrOnly: true });
    await expect(countDialAttempt({ db: fakeDb(), redis }, 't1', NOW)).resolves.toBeNull();
  });
});

describe('the call cap fires at exactly the configured number', () => {
  /**
   * The off-by-one that the read/count split could easily have introduced. The old comparison ran
   * AFTER the increment (`callsToday > limit`); the new one runs BEFORE (`callsToday >= limit`).
   * Get it wrong and the cap is off by one in the only number standing between an attacker and an
   * unbounded phone bill.
   */
  const NOW = new Date('2026-07-21T10:00:00Z');

  it('allows exactly 100 dials with dailyCallLimit: 100, then blocks', async () => {
    const redis = fakeRedis({ count: 0 });
    const deps = { db: fakeDb(), redis };
    let allowed = 0;

    for (let i = 0; i < 150; i++) {
      const d = await evaluateSpend(deps, 't1', {}, NOW);
      if (!d.allowed) {
        expect(d.reason).toBe('daily_call_limit_exceeded');
        break;
      }
      allowed++;
      await countDialAttempt(deps, 't1', NOW); // only the dialer counts
    }

    expect(allowed).toBe(100);
  });

  it('honours a raised tenant limit', async () => {
    const redis = fakeRedis({ count: 0 });
    const deps = { db: fakeDb(), redis };
    const settings = { toll_fraud: { dailyCallLimit: 3 } };
    let allowed = 0;

    for (let i = 0; i < 10; i++) {
      const d = await evaluateSpend(deps, 't1', settings, NOW);
      if (!d.allowed) break;
      allowed++;
      await countDialAttempt(deps, 't1', NOW);
    }

    expect(allowed).toBe(3);
  });
});

describe('the 3-strike operator alert — per cap', () => {
  const NOW = new Date('2026-07-21T10:00:00Z');

  it('2 consecutive failures → no email; the 3rd → exactly one email', async () => {
    const sendAlert = vi.fn(async (_subject: string, _body: string) => undefined);
    const deps = () => ({ db: fakeDb({ fail: true }), redis: fakeRedis({ fail: true }), sendAlert });

    await evaluateSpend(deps(), 't1', {}, NOW);
    await evaluateSpend(deps(), 't1', {}, NOW);
    expect(sendAlert).not.toHaveBeenCalled();

    // Third consecutive failure trips BOTH caps' counters — two dead brakes, two alerts, each
    // naming which one died. Under the old shared counter this was one undifferentiated email.
    await evaluateSpend(deps(), 't1', {}, NOW);
    expect(sendAlert).toHaveBeenCalledTimes(2);

    await evaluateSpend(deps(), 't1', {}, NOW);
    expect(sendAlert).toHaveBeenCalledTimes(2); // once per outage, not per failure
  });

  it('A LIVE REDIS NO LONGER MASKS A DEAD DATABASE', async () => {
    /**
     * THE BUG (#6). The old code kept one failure counter and reset it with
     * `if (dbOk || redisOk) recordSuccess()`. With Postgres down and Redis up, the DOLLAR cap was
     * completely dead — no spend was being measured — but a healthy Redis reset the counter on
     * every check, so the 3-strike alert could never fire. The half of the brake that had failed
     * was exactly the half nobody would be told about.
     */
    const sendAlert = vi.fn(async (_subject: string, _body: string) => undefined);
    const deps = () => ({ db: fakeDb({ fail: true }), redis: fakeRedis({ count: 1 }), sendAlert });

    await evaluateSpend(deps(), 't1', {}, NOW);
    await evaluateSpend(deps(), 't1', {}, NOW);
    await evaluateSpend(deps(), 't1', {}, NOW);

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0][0]).toContain('דולרים'); // the SPEND cap, named
  });

  it('a recovered cap resets its own streak and re-arms its alert', async () => {
    const sendAlert = vi.fn(async (_subject: string, _body: string) => undefined);
    const failing = () => ({ db: fakeDb({ fail: true }), redis: fakeRedis({ fail: true }), sendAlert });

    await evaluateSpend(failing(), 't1', {}, NOW);
    await evaluateSpend(failing(), 't1', {}, NOW);
    await evaluateSpend({ db: fakeDb(), redis: fakeRedis(), sendAlert }, 't1', {}, NOW); // both recover
    await evaluateSpend(failing(), 't1', {}, NOW);
    await evaluateSpend(failing(), 't1', {}, NOW);

    expect(sendAlert).not.toHaveBeenCalled();
  });
});
