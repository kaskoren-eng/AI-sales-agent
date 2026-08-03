import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { Redis } from 'ioredis';
import type { Env } from '../../config/env.js';
import { callLearnings } from '../../db/schema/index.js';
import type { SalesCallAnalysis } from '../../db/schema/call-learnings.js';
import { CallsService, mapLearnings, mapLearningsTranscript } from './calls.service.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const CONV_ID = '22222222-2222-2222-2222-222222222222';
const ROOM_NAME = 'call-out-abc123';

function makeConvRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONV_ID,
    channelRef: ROOM_NAME,
    status: 'ended',
    summary: null,
    createdAt: new Date('2026-07-20T10:00:00Z'),
    updatedAt: new Date('2026-07-20T10:05:00Z'),
    channel: 'voice',
    lead: {
      id: 'lead-1',
      name: 'דנה כהן',
      email: null,
      phone: '+972501234567',
      status: 'qualified',
      score: 80,
    },
    ...overrides,
  };
}

// The agent-written half of the analysis JSONB — present from call teardown
const agentOnlyAnalysis: SalesCallAnalysis = {
  tool_calls: [
    { atMs: 42_000, name: 'check_calendar_availability', durationMs: 320, ok: true },
    { atMs: 75_000, name: 'book_meeting', durationMs: 480, ok: false, error: 'slot taken' },
    { atMs: 123_000, name: 'end_call', durationMs: 12, ok: true },
  ],
  end_reason: 'meeting_booked',
  recording_notice_played: true,
  recording_notice_at: '2026-07-20T10:00:03Z',
  ai_disclosure: 'during_call',
};

// The full JSONB after the call-analysis worker has run
const fullAnalysis: SalesCallAnalysis = {
  ...agentOnlyAnalysis,
  overall_effectiveness_score: 8,
  opening_technique: 'פתיחה חמה עם שם פרטי',
  closing_technique: 'סגירה ישירה',
  rapport_building: 'שיקוף והקשבה',
  pain_points_uncovered: ['אין זמן לטפל בלידים'],
  objections: [{ objection: 'יקר לי', response: 'החזר השקעה תוך חודשיים', handled_well: true }],
  key_questions_asked: ['מה הכי מעכב אתכם היום?'],
  what_worked: ['שאלות פתוחות'],
  what_didnt_work: [],
  recommendations: ['להציע דמו קצר יותר'],
};

function makeLearningsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cl-1',
    tenantId: TENANT_ID,
    conferenceName: ROOM_NAME,
    conferenceSid: null,
    recordingSid: null,
    recordingUrl: null,
    transcript: [
      { speaker: 'agent', text: 'שלום, מדברת קרן', start: 0.5, end: 2.0 },
      { speaker: 'user', text: 'היי, מי זאת?', start: 2.4, end: 3.8 },
    ],
    shadowSttTranscript: null,
    analysis: fullAnalysis,
    outcome: 'won',
    durationSecs: 130,
    label: 'livekit',
    status: 'analyzed',
    createdAt: new Date('2026-07-20T10:05:10Z'),
    ...overrides,
  };
}

// ── Mocks ─────────────────────────────────────────────────────────────────

// getCall issues up to three selects in a fixed order:
//   1. conversation ⋈ lead   (.from().innerJoin().where().limit())
//   2. messages              (.from().where().orderBy())
//   3. call_learnings        (.from().where().limit())  — only when channelRef is set
function makeDb(opts: {
  convRow?: Record<string, unknown> | null;
  msgs?: Array<Record<string, unknown>>;
  learningsRows?: Array<Record<string, unknown>>;
  learningsFail?: boolean;
}) {
  const convChain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(opts.convRow ? [opts.convRow] : []),
  };
  const msgsChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue(opts.msgs ?? []),
  };
  const learningsChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: opts.learningsFail
      ? vi.fn().mockRejectedValue(new Error('db down'))
      : vi.fn().mockResolvedValue(opts.learningsRows ?? []),
  };
  const select = vi
    .fn()
    .mockReturnValueOnce(convChain)
    .mockReturnValueOnce(msgsChain)
    .mockReturnValueOnce(learningsChain);

  return { db: { select } as unknown as Database, select, learningsChain };
}

function fakeRedis() {
  return { get: vi.fn(async () => null), set: vi.fn(async () => 'OK') } as unknown as Redis;
}

// No RETELL_API_KEY → the live-fetch branch is skipped entirely
function makeService(db: Database) {
  return new CallsService({ db, redis: fakeRedis(), env: { RETELL_API_KEY: undefined } as unknown as Env });
}

// ── getCall + learnings ───────────────────────────────────────────────────

describe('getCall — call_learnings join', () => {
  it('returns learnings: null when no call_learnings row matches', async () => {
    const { db } = makeDb({ convRow: makeConvRow(), learningsRows: [] });
    const call = await makeService(db).getCall(TENANT_ID, CONV_ID);

    expect(call).not.toBeNull();
    expect(call!.learnings).toBeNull();
  });

  it('does not query call_learnings when channelRef is null', async () => {
    const { db, select } = makeDb({ convRow: makeConvRow({ channelRef: null }) });
    const call = await makeService(db).getCall(TENANT_ID, CONV_ID);

    expect(call!.learnings).toBeNull();
    expect(select).toHaveBeenCalledTimes(2); // conversation + messages only
  });

  it('maps a full row: verdict, tool calls, compliance, sales analysis, merged transcript', async () => {
    const { db } = makeDb({ convRow: makeConvRow(), msgs: [], learningsRows: [makeLearningsRow()] });
    const call = await makeService(db).getCall(TENANT_ID, CONV_ID);

    const l = call!.learnings!;
    expect(l.status).toBe('analyzed');
    expect(l.outcome).toBe('won');
    expect(call!.duration_secs).toBe(130); // no terminal-message metadata → learnings row provides it
    expect(l.end_reason).toBe('meeting_booked');
    expect(l.tool_calls).toHaveLength(3);
    expect(l.tool_calls[1]).toEqual({ atMs: 75_000, name: 'book_meeting', durationMs: 480, ok: false, error: 'slot taken' });
    expect(l.compliance).toEqual({
      recording_notice_played: true,
      recording_notice_at: '2026-07-20T10:00:03Z',
      ai_disclosure: 'during_call',
    });
    expect(l.sales_analysis).not.toBeNull();
    expect(l.sales_analysis!.overall_effectiveness_score).toBe(8);
    expect(l.sales_analysis!.objections).toEqual([
      { objection: 'יקר לי', response: 'החזר השקעה תוך חודשיים', handled_well: true },
    ]);

    // No messages transcript → the learnings transcript takes over, remapped
    expect(call!.transcript).toEqual([
      { role: 'agent', message: 'שלום, מדברת קרן', time_in_call_secs: 0.5 },
      { role: 'user', message: 'היי, מי זאת?', time_in_call_secs: 2.4 },
    ]);
  });

  it('scopes the learnings lookup to the tenant (tenant isolation)', async () => {
    const { db, learningsChain } = makeDb({ convRow: makeConvRow(), learningsRows: [makeLearningsRow()] });
    await makeService(db).getCall(TENANT_ID, CONV_ID);

    expect(learningsChain.where).toHaveBeenCalledWith(
      and(eq(callLearnings.tenantId, TENANT_ID), eq(callLearnings.conferenceName, ROOM_NAME)),
    );
  });

  it('sales_analysis is null when the JSONB holds only agent-written keys', async () => {
    const row = makeLearningsRow({ analysis: agentOnlyAnalysis, status: 'pending', outcome: null });
    const { db } = makeDb({ convRow: makeConvRow(), learningsRows: [row] });
    const call = await makeService(db).getCall(TENANT_ID, CONV_ID);

    const l = call!.learnings!;
    expect(l.sales_analysis).toBeNull();
    expect(l.status).toBe('pending');
    expect(l.outcome).toBeNull();
    expect(l.tool_calls).toHaveLength(3); // agent-written data still surfaces
    expect(l.compliance.recording_notice_played).toBe(true);
  });

  it('never overrides a non-empty messages transcript with the learnings one', async () => {
    const msgs = [
      {
        role: 'agent',
        content: 'Hello from Retell',
        contentType: 'transcript',
        metadata: { time_in_call_secs: 1 },
        createdAt: new Date('2026-07-20T10:00:01Z'),
      },
    ];
    const { db } = makeDb({ convRow: makeConvRow(), msgs, learningsRows: [makeLearningsRow()] });
    const call = await makeService(db).getCall(TENANT_ID, CONV_ID);

    expect(call!.transcript).toEqual([{ role: 'agent', message: 'Hello from Retell', time_in_call_secs: 1 }]);
  });

  it('a learnings lookup failure degrades to learnings: null, never a throw', async () => {
    const { db } = makeDb({ convRow: makeConvRow(), learningsFail: true });
    const call = await makeService(db).getCall(TENANT_ID, CONV_ID);

    expect(call).not.toBeNull();
    expect(call!.learnings).toBeNull();
  });
});

// ── mapLearnings (pure) ───────────────────────────────────────────────────

describe('mapLearnings', () => {
  it('empty analysis JSONB → safe defaults everywhere', () => {
    const l = mapLearnings({ status: 'pending', outcome: null, analysis: {} as SalesCallAnalysis });

    expect(l).toEqual({
      status: 'pending',
      outcome: null,
      end_reason: null,
      tool_calls: [],
      compliance: { recording_notice_played: null, recording_notice_at: null, ai_disclosure: null },
      sales_analysis: null,
    });
  });

  it('null analysis (jsonb column nullable) → same safe defaults', () => {
    const l = mapLearnings({ status: 'failed', outcome: 'lost', analysis: null });

    expect(l.sales_analysis).toBeNull();
    expect(l.tool_calls).toEqual([]);
    expect(l.outcome).toBe('lost');
  });

  it('a single GPT-written key is enough to build sales_analysis, missing fields defaulted', () => {
    const l = mapLearnings({
      status: 'analyzed',
      outcome: null,
      analysis: { overall_effectiveness_score: 3 } as SalesCallAnalysis,
    });

    expect(l.sales_analysis).toEqual({
      overall_effectiveness_score: 3,
      opening_technique: null,
      closing_technique: null,
      rapport_building: null,
      pain_points_uncovered: [],
      objections: [],
      key_questions_asked: [],
      what_worked: [],
      what_didnt_work: [],
      recommendations: [],
    });
  });
});

// ── mapLearningsTranscript (pure) ─────────────────────────────────────────

describe('mapLearningsTranscript', () => {
  it('maps speaker → role: agent/assistant → agent, anything else → user', () => {
    const turns = mapLearningsTranscript([
      { speaker: 'agent', text: 'a' },
      { speaker: 'assistant', text: 'b' },
      { speaker: 'user', text: 'c' },
      { speaker: 'customer', text: 'd' },
    ]);

    expect(turns.map((t) => t.role)).toEqual(['agent', 'agent', 'user', 'user']);
  });

  it('start → time_in_call_secs, absent start → null', () => {
    const turns = mapLearningsTranscript([
      { speaker: 'agent', text: 'a', start: 12.5 },
      { speaker: 'user', text: 'b' },
    ]);

    expect(turns).toEqual([
      { role: 'agent', message: 'a', time_in_call_secs: 12.5 },
      { role: 'user', message: 'b', time_in_call_secs: null },
    ]);
  });
});
