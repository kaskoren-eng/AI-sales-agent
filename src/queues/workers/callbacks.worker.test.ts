import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Database } from '../../db/client.js';
import { callbacks, leads, scheduledCalls, tenants } from '../../db/schema/index.js';
import { AppError } from '../../shared/errors.js';
import { CircuitOpenError } from '../../shared/circuit-breaker.js';
import type { CallbackJob } from '../callbacks.queue.js';
import {
  classifyDialFailure,
  processCallback,
  MAX_DEFERRALS,
  type CallbacksWorkerDeps,
} from './callbacks.worker.js';

/**
 * Every instant is pinned, and Israel is UTC+3 (IDT) in September 2026.
 *
 *   2026-09-07T09:00:00Z  =  Monday 12:00 in Tel Aviv   — inside the proactive window
 *   2026-09-07T19:00:00Z  =  Monday 22:00               — honored only
 *   2026-09-07T20:30:00Z  =  Monday 23:30               — inside NOTHING (the hard floor)
 *   2026-09-05            =  Saturday
 *
 * The proactive window is Sun–Thu 09:00–20:00, the honored window is the hard floor 07:00–23:00,
 * and which of the two applies is decided by `requested_by_lead` AND the ordinal of the dial.
 */

const MON_NOON = new Date('2026-09-07T09:00:00.000Z');
const MON_2200 = new Date('2026-09-07T19:00:00.000Z');
const MON_2330 = new Date('2026-09-07T20:30:00.000Z');
/** Tuesday 09:00 Israel — where the proactive window pushes anything after Monday 20:00. */
const TUE_0900 = new Date('2026-09-08T06:00:00.000Z');

interface CallbackRowState {
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

interface LeadRowState {
  id: string;
  status: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

const CB = (over: Partial<CallbackRowState> = {}): CallbackRowState => ({
  id: 'cb-1',
  leadId: 'lead-1',
  dueAt: MON_NOON,
  state: 'pending',
  kind: 'explicit',
  requestedByLead: true,
  attempt: 0,
  maxAttempts: 3,
  reason: 'lead said: call me at noon',
  ...over,
});

const LEAD = (over: Partial<LeadRowState> = {}): LeadRowState => ({
  id: 'lead-1',
  status: 'contacted',
  name: 'דנה',
  phone: '+972501234567',
  email: null,
  ...over,
});

interface DbState {
  callback?: CallbackRowState | null;
  lead?: LeadRowState | null;
  booked?: boolean;
  settings?: unknown;
}

type Written = { table: 'callbacks' | 'leads' | 'other'; set: Record<string, unknown> };

function fakeDb(state: DbState) {
  const writes: Written[] = [];
  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === callbacks) return state.callback ? [state.callback] : [];
            if (table === leads) return state.lead ? [state.lead] : [];
            if (table === scheduledCalls) return state.booked ? [{ id: 'sc-1' }] : [];
            if (table === tenants) return [{ settings: state.settings ?? {} }];
            return [];
          },
        }),
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          writes.push({
            table: table === callbacks ? 'callbacks' : table === leads ? 'leads' : 'other',
            set: vals,
          });
        },
      }),
    })),
  } as unknown as Database;
  return { db, writes };
}

function makeDeps(state: DbState, now: Date, opts: { trunk?: boolean; dial?: () => Promise<{ callId: string }> } = {}) {
  const { db, writes } = fakeDb(state);
  const added: Array<{ data: CallbackJob; opts: Record<string, unknown> }> = [];
  const callbacksQueue = {
    add: vi.fn(async (_n: string, data: CallbackJob, jobOpts: Record<string, unknown>) => {
      added.push({ data, opts: jobOpts });
    }),
  } as unknown as Queue;
  const dial = vi.fn(opts.dial ?? (async () => ({ callId: 'call-out-abc' })));
  const deps = {
    db,
    redis: {} as Redis,
    deadLetterQueue: {} as Queue,
    callbacksQueue,
    voiceLivekit: { initiateOutboundCall: dial },
    env: { LIVEKIT_SIP_OUTBOUND_TRUNK_ID: opts.trunk === false ? undefined : 'ST_trunk' },
    now: () => now,
  } as unknown as CallbacksWorkerDeps;
  return { deps, writes, added, dial };
}

const job = (over: Partial<CallbackJob> = {}): CallbackJob => ({
  tenantId: 'tenant-1',
  callbackId: 'cb-1',
  attempt: 0,
  deferrals: 0,
  ...over,
});

const cbWrites = (writes: Written[]) => writes.filter((w) => w.table === 'callbacks');
const leadWrites = (writes: Written[]) => writes.filter((w) => w.table === 'leads');
const lastCbState = (writes: Written[]) => {
  const states = cbWrites(writes)
    .map((w) => w.set.state)
    .filter((s) => s !== undefined);
  return states[states.length - 1];
};

// ─────────────────────────────────────────────────────────────────────────────
// Fire-time authority — the row and the lead outrank the job every time
// ─────────────────────────────────────────────────────────────────────────────

describe('processCallback — fire-time authority', () => {
  it('row gone entirely → skipped, nothing dialled', async () => {
    const { deps, dial } = makeDeps({ callback: null }, MON_NOON);
    expect(await processCallback(deps, job())).toEqual({ outcome: 'skipped', detail: 'row_gone' });
    expect(dial).not.toHaveBeenCalled();
  });

  it('superseded row → skipped and NOT a failure — a newer callback won', async () => {
    const { deps, dial, writes } = makeDeps({ callback: CB({ state: 'superseded' }), lead: LEAD() }, MON_NOON);
    const out = await processCallback(deps, job());
    expect(out).toEqual({ outcome: 'skipped', detail: 'not_pending:superseded' });
    expect(dial).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('cancelled row → skipped', async () => {
    const { deps, dial } = makeDeps({ callback: CB({ state: 'cancelled' }), lead: LEAD() }, MON_NOON);
    expect((await processCallback(deps, job())).detail).toBe('not_pending:cancelled');
    expect(dial).not.toHaveBeenCalled();
  });

  it('OPTED-OUT LEAD IS NEVER DIALLED — the row is cancelled and the pointer cleared', async () => {
    const { deps, dial, writes } = makeDeps(
      { callback: CB(), lead: LEAD({ status: 'opted_out' }) },
      MON_NOON,
    );
    const out = await processCallback(deps, job());
    expect(out).toEqual({ outcome: 'skipped', detail: 'opted_out' });
    expect(dial).not.toHaveBeenCalled();
    expect(lastCbState(writes)).toBe('cancelled');
    expect(leadWrites(writes)[0]?.set.nextCallbackAt).toBeNull();
  });

  it('opt-out is checked BEFORE the window — an opted-out lead is cancelled, not deferred', async () => {
    // due_at at 23:30 would otherwise defer. Order matters: a deferral leaves the row pending and
    // keeps the promise alive, which is exactly what an opt-out must not do.
    const { deps, added, writes } = makeDeps(
      { callback: CB({ dueAt: MON_2330, requestedByLead: false }), lead: LEAD({ status: 'opted_out' }) },
      MON_2330,
    );
    expect((await processCallback(deps, job())).detail).toBe('opted_out');
    expect(added).toHaveLength(0);
    expect(lastCbState(writes)).toBe('cancelled');
  });

  it('lead row gone → cancelled, never dialled', async () => {
    const { deps, dial, writes } = makeDeps({ callback: CB(), lead: null }, MON_NOON);
    expect((await processCallback(deps, job())).detail).toBe('lead_gone');
    expect(dial).not.toHaveBeenCalled();
    expect(lastCbState(writes)).toBe('cancelled');
  });

  it('a lead who has since booked a meeting is not chased', async () => {
    const { deps, dial, writes } = makeDeps({ callback: CB(), lead: LEAD(), booked: true }, MON_NOON);
    expect((await processCallback(deps, job())).detail).toBe('meeting_booked');
    expect(dial).not.toHaveBeenCalled();
    expect(lastCbState(writes)).toBe('cancelled');
    expect(cbWrites(writes)[0]?.set.reason).toContain('meeting_booked');
  });

  it('tenant turned callbacks off → skipped, and the row is left PENDING for when they turn it back on', async () => {
    const { deps, dial, writes } = makeDeps(
      { callback: CB(), lead: LEAD(), settings: { callbacks: { enabled: false } } },
      MON_NOON,
    );
    expect((await processCallback(deps, job())).detail).toBe('disabled');
    expect(dial).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The window — deferred, never dropped, and NEVER dialled outside it
// ─────────────────────────────────────────────────────────────────────────────

describe('processCallback — calling window', () => {
  it('23:30 with nobody having asked for it → deferred to 09:00 the next morning, no dial', async () => {
    const { deps, dial, added, writes } = makeDeps(
      { callback: CB({ dueAt: MON_2330, requestedByLead: false, kind: 'soft_defer' }), lead: LEAD() },
      MON_2330,
    );
    const out = await processCallback(deps, job());
    expect(out.outcome).toBe('deferred');
    expect(dial).not.toHaveBeenCalled();
    expect(added).toHaveLength(1);
    expect(added[0]!.opts.jobId).toBe('callback-cb-1-a0-d1');
    expect(added[0]!.data).toEqual({ tenantId: 'tenant-1', callbackId: 'cb-1', attempt: 0, deferrals: 1 });
    expect((cbWrites(writes)[0]!.set.dueAt as Date).toISOString()).toBe(TUE_0900.toISOString());
    // `attempt` is untouched: a deferral costs no rung.
    expect(cbWrites(writes)[0]!.set.attempt).toBeUndefined();
  });

  it('Saturday is never dialled — the hard floor, whoever asked', async () => {
    const SAT = new Date('2026-09-05T09:00:00.000Z'); // Saturday 12:00 Israel
    const { deps, dial, added } = makeDeps(
      { callback: CB({ dueAt: SAT, requestedByLead: true }), lead: LEAD() },
      SAT,
    );
    expect((await processCallback(deps, job())).outcome).toBe('deferred');
    expect(dial).not.toHaveBeenCalled();
    // Sunday 09:00 Israel.
    expect((added[0]!.data as CallbackJob).deferrals).toBe(1);
  });

  it('22:00 HE asked for, on the first dial → honored, and it rings', async () => {
    const { deps, dial } = makeDeps(
      { callback: CB({ dueAt: MON_2200, requestedByLead: true, attempt: 0 }), lead: LEAD() },
      MON_2200,
    );
    expect((await processCallback(deps, job())).outcome).toBe('dialed');
    expect(dial).toHaveBeenCalledTimes(1);
  });

  it('22:00 on the SECOND dial → proactive, deferred to the morning. He asked for 22:00 once.', async () => {
    // The regression this exists for: reading `attempt` straight into the window context makes
    // `windowFor` return 'honored' on rung 2 (it treats 0 and 1 alike) and rings a lead at 22:00
    // on a night he never mentioned.
    const { deps, dial, added, writes } = makeDeps(
      { callback: CB({ dueAt: MON_2200, requestedByLead: true, attempt: 1 }), lead: LEAD() },
      MON_2200,
    );
    const out = await processCallback(deps, job({ attempt: 1 }));
    expect(out.outcome).toBe('deferred');
    expect(dial).not.toHaveBeenCalled();
    expect((cbWrites(writes)[0]!.set.dueAt as Date).toISOString()).toBe(TUE_0900.toISOString());
    expect(added[0]!.opts.jobId).toBe('callback-cb-1-a1-d1');
  });

  it('a job that fires late but still inside the window rings immediately, and reports how late', async () => {
    const late = new Date(MON_NOON.getTime() + 20 * 60_000); // 12:20, due at 12:00
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { deps, dial } = makeDeps({ callback: CB({ dueAt: MON_NOON }), lead: LEAD() }, late);
    (deps as { logger?: unknown }).logger = logger;
    expect((await processCallback(deps, job())).outcome).toBe('dialed');
    expect(dial).toHaveBeenCalledTimes(1);
    const dialed = logger.info.mock.calls.find((c) => c[0]?.event === 'callback_dialed');
    expect(dialed?.[0].lateBySeconds).toBe(1200);
  });

  it('after MAX_DEFERRALS the row FAILS instead of re-enqueueing itself forever', async () => {
    const { deps, added, writes } = makeDeps(
      { callback: CB({ dueAt: MON_2330, requestedByLead: false }), lead: LEAD() },
      MON_2330,
    );
    const out = await processCallback(deps, job({ deferrals: MAX_DEFERRALS }));
    expect(out).toEqual({ outcome: 'failed', detail: 'deferral_cap' });
    expect(added).toHaveLength(0);
    expect(lastCbState(writes)).toBe('failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The dial, the attempt counter, and the ladder
// ─────────────────────────────────────────────────────────────────────────────

describe('processCallback — dialling', () => {
  it('answered → attempt 0 becomes 1, state done, the lead pointer is cleared', async () => {
    const { deps, dial, writes } = makeDeps({ callback: CB(), lead: LEAD() }, MON_NOON);
    const out = await processCallback(deps, job());
    expect(out.outcome).toBe('dialed');
    expect(out.callId).toBe('call-out-abc');
    expect(dial).toHaveBeenCalledWith('+972501234567', 'tenant-1', { leadId: 'lead-1', name: 'דנה' });
    // `dialing` is written before the await, then the result.
    expect(cbWrites(writes).map((w) => w.set.state)).toEqual(['dialing', 'done']);
    const done = cbWrites(writes)[1]!.set;
    expect(done.attempt).toBe(1);
    expect(done.lastOutcome).toBe('answered');
    expect(leadWrites(writes)[0]?.set.nextCallbackAt).toBeNull();
  });

  it('THE NEVER-ANSWERED RING: a ring-out is recorded as no_answer and counts one dial', async () => {
    const { deps, writes, added } = makeDeps({ callback: CB(), lead: LEAD() }, MON_NOON, {
      dial: async () => {
        throw new Error('sip: participant did not answer');
      },
    });
    const out = await processCallback(deps, job());
    expect(out).toEqual({ outcome: 'retry_scheduled', detail: 'rung:2' });
    const written = cbWrites(writes)[1]!.set;
    expect(written.lastOutcome).toBe('no_answer');
    expect(written.attempt).toBe(1);
    expect(written.state).toBe('pending');
    // Rung 2 of the explicit ladder is +45 minutes, and it lands inside the proactive window.
    expect((written.dueAt as Date).toISOString()).toBe('2026-09-07T09:45:00.000Z');
    expect(written.jobId).toBe('callback-cb-1-a1');
    expect(added[0]!.data).toEqual({ tenantId: 'tenant-1', callbackId: 'cb-1', attempt: 1, deferrals: 0 });
    // The lead's own words survive; the outcome is appended, never overwritten.
    expect(written.reason).toContain('lead said: call me at noon');
    expect(written.reason).toContain('no_answer:');
  });

  it('a busy signal is told apart from a ring-out', async () => {
    const { deps, writes } = makeDeps({ callback: CB(), lead: LEAD() }, MON_NOON, {
      dial: async () => {
        throw new Error('sip status 486 Busy Here');
      },
    });
    await processCallback(deps, job());
    expect(cbWrites(writes)[1]!.set.lastOutcome).toBe('busy');
  });

  it('STOPPING IS A FEATURE: the third unanswered dial exhausts the row and queues nothing', async () => {
    const { deps, writes, added } = makeDeps(
      { callback: CB({ attempt: 2 }), lead: LEAD() },
      MON_NOON,
      { dial: async () => { throw new Error('no answer'); } },
    );
    const out = await processCallback(deps, job({ attempt: 2 }));
    expect(out.outcome).toBe('exhausted');
    expect(added).toHaveLength(0);
    expect(cbWrites(writes)[1]!.set.attempt).toBe(3);
    expect(lastCbState(writes)).toBe('exhausted');
    expect(leadWrites(writes)[0]?.set.nextCallbackAt).toBeNull();
  });

  it('a tenant may SHORTEN the ladder — maxAttempts 1 stops after one dial', async () => {
    const { deps, added, writes } = makeDeps(
      { callback: CB(), lead: LEAD(), settings: { callbacks: { maxAttempts: 1 } } },
      MON_NOON,
      { dial: async () => { throw new Error('no answer'); } },
    );
    expect((await processCallback(deps, job())).outcome).toBe('exhausted');
    expect(added).toHaveLength(0);
    expect(lastCbState(writes)).toBe('exhausted');
  });

  it('a tenant CANNOT lengthen it — maxAttempts 9 still stops at 3', async () => {
    const { deps, added, writes } = makeDeps(
      { callback: CB({ attempt: 2 }), lead: LEAD(), settings: { callbacks: { maxAttempts: 9 } } },
      MON_NOON,
      { dial: async () => { throw new Error('no answer'); } },
    );
    expect((await processCallback(deps, job({ attempt: 2 }))).outcome).toBe('exhausted');
    expect(added).toHaveLength(0);
    expect(lastCbState(writes)).toBe('exhausted');
  });

  it('a soft defer climbs its own ladder — rung 2 is +1 business day at the same hour', async () => {
    const { deps, writes } = makeDeps(
      { callback: CB({ kind: 'soft_defer', requestedByLead: false }), lead: LEAD() },
      MON_NOON,
      { dial: async () => { throw new Error('no answer'); } },
    );
    await processCallback(deps, job());
    // Monday noon + 1 business day = Tuesday noon Israel.
    expect((cbWrites(writes)[1]!.set.dueAt as Date).toISOString()).toBe('2026-09-08T09:00:00.000Z');
  });
});

describe('processCallback — configuration gaps are written to the row, not swallowed', () => {
  it('no outbound trunk → state failed, last_outcome no_trunk, nothing dialled, nothing thrown', async () => {
    const { deps, dial, writes } = makeDeps({ callback: CB(), lead: LEAD() }, MON_NOON, { trunk: false });
    const out = await processCallback(deps, job());
    expect(out).toEqual({ outcome: 'failed', detail: 'no_trunk' });
    expect(dial).not.toHaveBeenCalled();
    expect(lastCbState(writes)).toBe('failed');
    expect(cbWrites(writes)[0]!.set.lastOutcome).toBe('no_trunk');
    // And crucially NOT left pending with no job — the state that is invisible until someone runs
    // the reconcile script.
    expect(lastCbState(writes)).not.toBe('pending');
  });

  it('the dialer itself reporting no trunk is the same outcome', async () => {
    const { deps, writes } = makeDeps({ callback: CB(), lead: LEAD() }, MON_NOON, {
      dial: async () => {
        throw new AppError('Outbound calling is not configured', 503, 'SIP_TRUNK_NOT_CONFIGURED');
      },
    });
    expect((await processCallback(deps, job())).detail).toBe('no_trunk');
    expect(lastCbState(writes)).toBe('failed');
  });

  it('a lead with no phone number fails the row rather than retrying forever', async () => {
    const { deps, dial, writes } = makeDeps({ callback: CB(), lead: LEAD({ phone: null }) }, MON_NOON);
    expect((await processCallback(deps, job())).detail).toBe('no_phone');
    expect(dial).not.toHaveBeenCalled();
    expect(lastCbState(writes)).toBe('failed');
  });
});

describe('processCallback — an outage must not burn a rung', () => {
  it('spend limit → deferred, attempt unchanged, state back to pending', async () => {
    const { deps, writes, added } = makeDeps({ callback: CB(), lead: LEAD() }, MON_NOON, {
      dial: async () => {
        throw new AppError('Daily outbound spend limit reached', 429, 'SPEND_LIMIT_EXCEEDED');
      },
    });
    const out = await processCallback(deps, job());
    expect(out).toEqual({ outcome: 'deferred', detail: 'spend_limit' });
    expect(cbWrites(writes).map((w) => w.set.state)).toEqual(['dialing', 'pending', undefined]);
    expect(added[0]!.data.attempt).toBe(0);
    expect(added[0]!.opts.jobId).toBe('callback-cb-1-a0-d1');
    // +30 minutes, still inside the window.
    expect(added[0]!.opts.delay).toBe(30 * 60_000);
  });

  it('an open circuit breaker → deferred, attempt unchanged', async () => {
    const { deps, added } = makeDeps({ callback: CB(), lead: LEAD() }, MON_NOON, {
      dial: async () => {
        throw new CircuitOpenError('livekit-sip');
      },
    });
    const out = await processCallback(deps, job());
    expect(out).toEqual({ outcome: 'deferred', detail: 'circuit_open' });
    expect(added[0]!.data.attempt).toBe(0);
    expect(added[0]!.opts.delay).toBe(5 * 60_000);
  });
});

describe('classifyDialFailure', () => {
  it('defaults an unrecognised rejection to no_answer — the fact that lives nowhere else', () => {
    expect(classifyDialFailure(new Error('twirp error: rpc failed'))).toBe('no_answer');
    expect(classifyDialFailure('480 Temporarily Unavailable')).toBe('no_answer');
  });

  it('recognises busy and voicemail', () => {
    expect(classifyDialFailure(new Error('sip status 486'))).toBe('busy');
    expect(classifyDialFailure(new Error('Busy Everywhere'))).toBe('busy');
    expect(classifyDialFailure(new Error('answering machine detected'))).toBe('voicemail');
  });
});
