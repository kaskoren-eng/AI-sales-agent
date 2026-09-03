import { llm } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { callbacks, leads } from '../../../../db/schema/index.js';
import { buildAgentTools, TOOL_NAMES } from './index.js';
import {
  CALLBACK_TOOL_NAME,
  callbackKindFor,
  executeScheduleCallback,
  scheduleCallbackSchema,
  type ScheduleCallbackArgs,
} from './schedule-callback.tool.js';
import type { ToolRuntimeContext } from './tool-context.js';

/**
 * schedule_callback — "תתקשר אליי עוד שעה", written down.
 *
 * Three classes of defect are pinned here, and the third is the one that would actually reach a
 * person's ear:
 *
 *   1. A SILENT FLAG. VOICE_CALLBACK_TOOL off must mean the tool is NOT REGISTERED. Proved by
 *      running buildAgentTools() and reading the array, never by reading index.ts.
 *   2. THE WRONG WINDOW. `requestedByLead` decides whether the honored window (07:00–23:00) or the
 *      proactive one (Sun–Thu 09:00–20:00) applies. Getting it wrong in one direction rings a
 *      stranger at 22:30 on a time nobody chose; in the other it refuses the 22:00 the lead
 *      explicitly asked for. Both directions are pinned.
 *   3. A TIME SHE READS BACK AND WILL NOT HONOUR. When the clamp moves the instant, the tool
 *      result is the only thing standing between "אחזור אליך בשלוש לפנות בוקר" and the truth.
 */

// ── Instants, pinned. Israel is on IDT (UTC+3) in September. ─────────────────────────────────
/** Wednesday 2026-09-02, 12:00 Israel local. Mid-window; no Shabbat, no holiday. */
const MIDDAY = new Date('2026-09-02T09:00:00.000Z');
/** The same Wednesday at 19:30 Israel local — still inside the proactive window, only just. */
const EVENING = new Date('2026-09-02T16:30:00.000Z');

interface FakeDbOpts {
  /** Rows `closePendingCallbacks` will find for this lead. */
  pending?: Array<{ id: string; jobId: string | null; reason: string | null }>;
  leadRow?: { id: string; name: string | null; phone: string | null } | null;
  failCallbackInsert?: boolean;
  failLeadLookup?: boolean;
}

function fakeDb(opts: FakeDbOpts = {}) {
  const callbackInserts: Record<string, unknown>[] = [];
  const callbackUpdates: Record<string, unknown>[] = [];
  const leadInserts: Record<string, unknown>[] = [];
  const leadUpdates: Record<string, unknown>[] = [];

  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => {
          const rows: Array<Record<string, unknown>> =
            table === callbacks ? (opts.pending ?? []) : opts.leadRow ? [opts.leadRow] : [];
          // A LAZY-SAFE thenable that is ALSO chainable with .limit(): `closePendingCallbacks`
          // awaits `.where(...)` directly, `resolveDisconnectLead` calls `.limit(1)` on it. Both
          // shapes are real drizzle, and a fake that supports only one silently no-ops the other.
          const settle = (): Promise<Array<Record<string, unknown>>> =>
            opts.failLeadLookup && table === leads
              ? Promise.reject(new Error('db down'))
              : Promise.resolve(rows);
          const p = settle();
          p.catch(() => undefined);
          return {
            then: p.then.bind(p),
            catch: p.catch.bind(p),
            limit: () => settle(),
          };
        },
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        if (table === callbacks) callbackInserts.push(vals);
        if (table === leads) leadInserts.push(vals);
        return {
          returning: async () => {
            if (table === callbacks) {
              if (opts.failCallbackInsert) throw new Error('callbacks insert failed');
              return [{ id: 'cb-new' }];
            }
            return [{ id: 'lead-new' }];
          },
        };
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (vals: Record<string, unknown>) => {
        if (table === callbacks) callbackUpdates.push(vals);
        if (table === leads) leadUpdates.push(vals);
        return { where: async () => undefined };
      },
    })),
  };
  return { db, callbackInserts, callbackUpdates, leadInserts, leadUpdates };
}

function fakeRt(
  opts: FakeDbOpts & {
    leadId?: string | null;
    callerPhone?: string | null;
    conversationId?: string | null;
    settings?: unknown;
    queue?: boolean;
  } = {},
) {
  const { db, callbackInserts, callbackUpdates, leadInserts, leadUpdates } = fakeDb(opts);
  const added: Array<{ name: string; data: Record<string, unknown>; opts: Record<string, unknown> }> =
    [];
  const removed: string[] = [];
  const callbacksQueue =
    opts.queue === false
      ? null
      : ({
          add: vi.fn(
            async (name: string, data: Record<string, unknown>, o: Record<string, unknown>) => {
              added.push({ name, data, opts: o });
            },
          ),
          remove: vi.fn(async (id: string) => {
            removed.push(id);
            return 1;
          }),
        } as never);

  const recordCallbackScheduled = vi.fn();
  const rt = {
    tenantId: 'tenant-1',
    leadId: opts.leadId === undefined ? 'lead-1' : opts.leadId,
    conversationId: opts.conversationId ?? null,
    callId: 'room-1',
    callerPhone: opts.callerPhone ?? null,
    db,
    report: { recordToolCall: vi.fn(), recordCallbackScheduled },
    env: {},
    settings: 'settings' in opts ? opts.settings : {},
    callbacksQueue,
    outboundQueue: null,
  } as unknown as ToolRuntimeContext;

  return { rt, callbackInserts, callbackUpdates, leadInserts, leadUpdates, added, removed, recordCallbackScheduled };
}

const args = (over: Partial<ScheduleCallbackArgs> = {}): ScheduleCallbackArgs => ({
  when_kind: 'in_minutes',
  in_minutes: 60,
  day: null,
  time_hhmm: null,
  quote: 'תתקשר אליי עוד שעה',
  reason: null,
  ...over,
});

/** The one field every assertion below reads, hoisted so a shape change fails in one place. */
const dueOf = (inserts: Record<string, unknown>[]): Date => inserts[0]!.dueAt as Date;

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE SCHEMA — §3, and the two rules that cost live calls to learn
// ─────────────────────────────────────────────────────────────────────────────

describe('scheduleCallbackSchema', () => {
  it('has exactly the six fields §3 specifies, in order', () => {
    expect(Object.keys(scheduleCallbackSchema.shape)).toEqual([
      'when_kind',
      'in_minutes',
      'day',
      'time_hhmm',
      'quote',
      'reason',
    ]);
  });

  it('takes NO absolute timestamp — the model is never allowed to do the date arithmetic', () => {
    // book_meeting echoes a slot_datetime verbatim from the availability list. A callback has no
    // list, so the equivalent safety is that there is nowhere for a hallucinated instant to land.
    for (const field of ['when_iso', 'due_at', 'datetime', 'callback_at', 'timestamp']) {
      expect(scheduleCallbackSchema.shape).not.toHaveProperty(field);
    }
  });

  it('accepts an explicit null in EVERY optional field — gpt-5.4 sends null, not an omission', () => {
    // capture_lead_info learned this on a live call: a bare .optional() rejects null, Zod fails,
    // the model retries the same call, and the lead sits in silence.
    const parsed = scheduleCallbackSchema.safeParse({
      when_kind: 'unspecified',
      in_minutes: null,
      day: null,
      time_hhmm: null,
      quote: 'לא עכשיו',
      reason: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('is a plain ZodObject — LiveKit rejects the ZodEffects a .refine() would produce', () => {
    expect(scheduleCallbackSchema).toBeInstanceOf(z.ZodObject);
  });

  it('caps the free text so an injection payload cannot ride into the dashboard', () => {
    expect(scheduleCallbackSchema.safeParse({ when_kind: 'unspecified', quote: 'x'.repeat(201) }).success).toBe(false);
    expect(
      scheduleCallbackSchema.safeParse({ when_kind: 'unspecified', quote: 'ok', reason: 'x'.repeat(201) }).success,
    ).toBe(false);
  });

  it('bounds in_minutes to the resolver’s own range (5 minutes … 14 days)', () => {
    const base = { when_kind: 'in_minutes' as const, quote: 'ok' };
    expect(scheduleCallbackSchema.safeParse({ ...base, in_minutes: 4 }).success).toBe(false);
    expect(scheduleCallbackSchema.safeParse({ ...base, in_minutes: 20161 }).success).toBe(false);
    expect(scheduleCallbackSchema.safeParse({ ...base, in_minutes: 60 }).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE FLAG — proved by RUNNING buildAgentTools, never by reading index.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('VOICE_CALLBACK_TOOL', () => {
  const rtWith = (on: boolean) =>
    ({ env: { VOICE_CALLBACK_TOOL: on }, report: {}, db: {} } as unknown as ToolRuntimeContext);

  it('OFF: the tool is NOT REGISTERED — the model cannot see a name it cannot call', () => {
    const names = buildAgentTools(rtWith(false)).map((t) => (t as { name?: string }).name);
    expect(names).not.toContain(CALLBACK_TOOL_NAME);
    expect(buildAgentTools(rtWith(false))).toHaveLength(TOOL_NAMES.length);
  });

  it('ON: it joins the seven, and only it', () => {
    const before = buildAgentTools(rtWith(false)).length;
    const after = buildAgentTools(rtWith(true));
    expect(after).toHaveLength(before + 1);
    expect(after.map((t) => (t as { name?: string }).name)).toContain(CALLBACK_TOOL_NAME);
  });

  it('stays OUT of TOOL_NAMES while it ships dark — the prompt lockstep test reads that list', () => {
    // system-prompt.test.ts asserts every TOOL_NAMES entry appears in TOOLS_PROMPT. This tool is
    // deliberately unmentioned in the prompt (F1.7), so listing it there would fail a test whose
    // only fix is prompt text this branch must not write.
    expect(TOOL_NAMES as readonly string[]).not.toContain(CALLBACK_TOOL_NAME);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE WINDOW — the derivation the whole feature's decency rests on
// ─────────────────────────────────────────────────────────────────────────────

describe('callbackKindFor', () => {
  it('a time the lead NAMED is explicit and honored', () => {
    expect(callbackKindFor('in_minutes')).toEqual({ kind: 'explicit', requestedByLead: true });
    expect(callbackKindFor('clock_time')).toEqual({ kind: 'explicit', requestedByLead: true });
    expect(callbackKindFor('day_and_time')).toEqual({ kind: 'explicit', requestedByLead: true });
  });

  it('a time NOBODY named is a soft defer, and never honored', () => {
    expect(callbackKindFor('ladder_default')).toEqual({ kind: 'soft_defer', requestedByLead: false });
  });
});

describe('the calling window, both directions', () => {
  it('HONORS 22:00 when he asked for 22:00 — the whole point of the wide window', async () => {
    // Koren, 2026-09-01: "אם הוא מבקש שיחה בשעה 22:00 אז יקבל". 22:00 is outside the proactive
    // window (ends 20:00) and inside the hard floor (ends 23:00), so this passes ONLY if the
    // explicit branch reached clampToWindow with requestedByLead=true.
    const { rt, callbackInserts } = fakeRt();
    const out = await executeScheduleCallback(
      rt,
      args({ when_kind: 'at_time', in_minutes: null, day: 'today', time_hhmm: '22:00' }),
      MIDDAY,
    );

    expect(dueOf(callbackInserts).toISOString()).toBe('2026-09-02T19:00:00.000Z'); // Wed 22:00 IDT
    expect(callbackInserts[0]).toMatchObject({ kind: 'explicit', requestedByLead: true });
    expect(out).not.toContain('NOT THE TIME HE ASKED FOR');
  });

  it('REFUSES 22:30 for a soft defer — nobody chose that hour, so the proactive window applies', async () => {
    // THE TEST THAT PINS THE DERIVATION. At 19:30 a soft defer resolves to rung 1 of the ladder
    // (+3h = 22:30). Hard-coding requestedByLead=true — the obvious reading, and the one the brief
    // asked for — leaves it at 22:30 and rings a stranger at half past ten at night on a time he
    // never named. Deriving it from the resolver's basis pushes it to the next morning instead.
    const { rt, callbackInserts } = fakeRt();
    const out = await executeScheduleCallback(
      rt,
      args({ when_kind: 'unspecified', in_minutes: null, quote: 'לא עכשיו, אני נוהג' }),
      EVENING,
    );

    // Thursday 2026-09-03, 09:00 Israel = 06:00Z — the start of the next proactive window.
    expect(dueOf(callbackInserts).toISOString()).toBe('2026-09-03T06:00:00.000Z');
    expect(callbackInserts[0]).toMatchObject({ kind: 'soft_defer', requestedByLead: false });
    expect(out).toContain('NOT THE TIME HE ASKED FOR');
  });

  it('an at_time intent with NEITHER a day nor an hour is a soft defer, whatever it claimed', async () => {
    // The resolver falls back to the ladder (basis 'ladder_default'), and an instant nobody named
    // is not an instant anybody asked for — so the window must follow the RESOLUTION, not the
    // model's own label for it. Deriving from `when_kind` would call this explicit.
    const { rt, callbackInserts } = fakeRt();
    await executeScheduleCallback(
      rt,
      args({ when_kind: 'at_time', in_minutes: null, day: null, time_hhmm: null }),
      MIDDAY,
    );
    expect(callbackInserts[0]).toMatchObject({ kind: 'soft_defer', requestedByLead: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE HAPPY PATH — row, pointer, job, report
// ─────────────────────────────────────────────────────────────────────────────

describe('executeScheduleCallback — the durable half', () => {
  it('writes the row, points the lead at it, queues the dial, and tells the model the time', async () => {
    const { rt, callbackInserts, leadUpdates, added, recordCallbackScheduled } = fakeRt({
      conversationId: 'conv-1',
    });
    const out = await executeScheduleCallback(rt, args(), MIDDAY);

    // 1. The row. 13:00 Israel = 10:00Z, inside every window, so nothing moved.
    expect(callbackInserts).toHaveLength(1);
    expect(callbackInserts[0]).toMatchObject({
      tenantId: 'tenant-1',
      leadId: 'lead-1',
      conversationId: 'conv-1',
      state: 'pending',
      kind: 'explicit',
      requestedByLead: true,
      attempt: 0,
      maxAttempts: 3,
      leadQuote: 'תתקשר אליי עוד שעה',
    });
    expect(dueOf(callbackInserts).toISOString()).toBe('2026-09-02T10:00:00.000Z');

    // 2. The lead's pointer — what the dashboard reads.
    expect(leadUpdates.some((u) => (u.nextCallbackAt as Date)?.toISOString() === '2026-09-02T10:00:00.000Z')).toBe(true);

    // 3. The job: attempt 0 (nothing has rung yet), deterministic id, delay = the gap.
    expect(added).toHaveLength(1);
    expect(added[0]!.data).toEqual({
      tenantId: 'tenant-1',
      callbackId: 'cb-new',
      attempt: 0,
      deferrals: 0,
    });
    expect(added[0]!.opts).toMatchObject({ jobId: 'callback-cb-new-a0', delay: 60 * 60_000 });

    // 4. The id is written back to the row, or nothing can ever cancel it.
    expect(rt.callbackScheduled).toBe(true);
    expect(recordCallbackScheduled).toHaveBeenCalledWith({
      resolvedIso: '2026-09-02T10:00:00.000Z',
      moved: false,
    });

    // 5. And the model is told what to say — including what NOT to promise.
    expect(out).toContain('Callback recorded');
    expect(out).toMatch(/NO message .*is sent about a callback/u);
  });

  it('stores the job id on the row so the cancellation hooks have something to remove', async () => {
    const { rt, callbackUpdates } = fakeRt();
    await executeScheduleCallback(rt, args(), MIDDAY);
    expect(callbackUpdates.some((u) => u.jobId === 'callback-cb-new-a0')).toBe(true);
  });

  it('creates a minimal lead for an unknown caller, exactly as the disconnect path does', async () => {
    const { rt, leadInserts, callbackInserts } = fakeRt({ leadId: null, callerPhone: '+972501234567' });
    await executeScheduleCallback(rt, args(), MIDDAY);
    expect(leadInserts[0]).toMatchObject({ tenantId: 'tenant-1', phone: '+972501234567', source: 'voice-livekit' });
    expect(callbackInserts[0]).toMatchObject({ leadId: 'lead-new' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ONE LIVE CALLBACK PER LEAD
// ─────────────────────────────────────────────────────────────────────────────

describe('supersession', () => {
  it('closes the previous pending callback and unqueues its dial before writing the new one', async () => {
    const { rt, callbackUpdates, callbackInserts, removed } = fakeRt({
      pending: [{ id: 'cb-old', jobId: 'callback-cb-old-a0', reason: 'caller_hung_up:discovery' }],
    });
    await executeScheduleCallback(rt, args({ quote: 'רגע, עדיף מחר' }), MIDDAY);

    const superseded = callbackUpdates.find((u) => u.state === 'superseded');
    expect(superseded).toBeDefined();
    // The original reason SURVIVES — it is why the callback existed at all.
    expect(String(superseded!.reason)).toContain('caller_hung_up:discovery');
    expect(String(superseded!.reason)).toContain('superseded_by_schedule_callback');
    expect(removed).toEqual(['callback-cb-old-a0']);
    // And the new row still landed — the supersede is a precondition, not a substitute.
    expect(callbackInserts).toHaveLength(1);
  });

  it('a second call on the same conversation RESCHEDULES rather than refusing', async () => {
    // A departure from bookingCompleted / handoffRequested, both of which refuse a repeat. A lead
    // correcting himself must not be left with a phone ringing at the time he just withdrew.
    const { rt, callbackInserts } = fakeRt();
    await executeScheduleCallback(rt, args(), MIDDAY);
    await executeScheduleCallback(rt, args({ in_minutes: 120 }), MIDDAY);
    expect(callbackInserts).toHaveLength(2);
    expect(dueOf(callbackInserts.slice(1)).toISOString()).toBe('2026-09-02T11:00:00.000Z');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. TRUTHFULNESS — the only thing between her and a promise she will not keep
// ─────────────────────────────────────────────────────────────────────────────

describe('what the model is told', () => {
  it('says the time MOVED, names both, and forbids reading back the one he asked for', async () => {
    // "בשלוש לפנות בוקר" → the night floor pushes it to 07:00. If the result did not say so she
    // reads back 03:00 and the phone rings four hours later.
    const { rt, callbackInserts, recordCallbackScheduled } = fakeRt();
    const out = await executeScheduleCallback(
      rt,
      args({ when_kind: 'at_time', in_minutes: null, day: null, time_hhmm: '03:00', quote: 'תתקשר בשלוש' }),
      MIDDAY,
    );

    expect(dueOf(callbackInserts).toISOString()).toBe('2026-09-03T04:00:00.000Z'); // Thu 07:00 IDT
    expect(out).toContain('NOT THE TIME HE ASKED FOR');
    expect(out).toContain('night floor');
    expect(out).toMatch(/never read back/u);
    expect(recordCallbackScheduled).toHaveBeenCalledWith(
      expect.objectContaining({ moved: true }),
    );
  });

  it('never lets her promise a confirmation message — there is no such message yet', async () => {
    const { rt } = fakeRt();
    const out = await executeScheduleCallback(rt, args(), MIDDAY);
    expect(out).toMatch(/do\s*NOT tell him a confirmation is on its way/iu);
  });

  it('with Redis down the row is still written, and the model is told the dial is not automatic', async () => {
    const { rt, callbackInserts } = fakeRt({ queue: false });
    const out = await executeScheduleCallback(rt, args(), MIDDAY);
    expect(callbackInserts).toHaveLength(1);
    expect(out).toContain('could not be queued');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. REFUSALS — every path where she must NOT promise anything
// ─────────────────────────────────────────────────────────────────────────────

describe('the refusals', () => {
  it('refuses when the tenant has switched callbacks off, and writes nothing', async () => {
    // The worker would skip a disabled tenant's row and leave it pending forever, which from the
    // lead's side is a call that simply never comes.
    const { rt, callbackInserts } = fakeRt({ settings: { callbacks: { enabled: false } } });
    await expect(executeScheduleCallback(rt, args(), MIDDAY)).rejects.toBeInstanceOf(llm.ToolError);
    expect(callbackInserts).toHaveLength(0);
  });

  it('refuses when there is nobody to ring — no lead id and no usable number', async () => {
    const { rt, callbackInserts } = fakeRt({ leadId: null, callerPhone: null });
    await expect(executeScheduleCallback(rt, args(), MIDDAY)).rejects.toThrow(/no phone number/iu);
    expect(callbackInserts).toHaveLength(0);
  });

  it('refuses when the row could not be written — a promise with nothing behind it is the defect', async () => {
    const { rt } = fakeRt({ failCallbackInsert: true });
    await expect(executeScheduleCallback(rt, args(), MIDDAY)).rejects.toThrow(/could NOT be saved/u);
  });

  it('refuses when the lead lookup itself fails', async () => {
    const { rt, callbackInserts } = fakeRt({ failLeadLookup: true });
    await expect(executeScheduleCallback(rt, args(), MIDDAY)).rejects.toBeInstanceOf(llm.ToolError);
    expect(callbackInserts).toHaveLength(0);
  });
});
