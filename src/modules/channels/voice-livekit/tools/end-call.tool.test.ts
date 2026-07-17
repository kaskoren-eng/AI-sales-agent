import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { leads } from '../../../../db/schema/index.js';
import {
  END_CALL_REASONS,
  LEAD_STATUS_OPTED_OUT,
  endCallTool,
  goodbyeInstruction,
  markLeadOptedOut,
} from './end-call.tool.js';
import type { ToolRuntimeContext } from './tool-context.js';

function fakeDb(opts: { phoneMatch?: string | null; failWrites?: boolean } = {}) {
  const updates: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => (opts.phoneMatch ? [{ id: opts.phoneMatch }] : []),
        }),
      }),
    })),
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => {
        updates.push(vals);
        return {
          where: async () => {
            if (opts.failWrites) throw new Error('db down');
          },
        };
      },
    })),
    insert: vi.fn((table: unknown) => ({
      values: async (vals: Record<string, unknown>) => {
        if (opts.failWrites) throw new Error('db down');
        if (table === leads) inserts.push(vals);
      },
    })),
  };
  return { db, updates, inserts };
}

function fakeRt(opts: {
  leadId?: string | null;
  callerPhone?: string | null;
  phoneMatch?: string | null;
  failWrites?: boolean;
  /** Agent transcript lines already spoken — what the disclosure scan reads. */
  agentLines?: string[];
} = {}) {
  const { db, updates, inserts } = fakeDb(opts);
  const recordToolCall = vi.fn();
  const recordCompliance = vi.fn();
  const markEndDisclosureRequested = vi.fn();
  const agentLines = opts.agentLines ?? [];
  const rt = {
    tenantId: 'tenant-1',
    leadId: opts.leadId ?? null,
    conversationId: null,
    callId: 'call-1',
    callerPhone: opts.callerPhone ?? null,
    db,
    report: {
      recordToolCall,
      recordCompliance,
      markEndDisclosureRequested,
      someAgentLine: (pred: (t: string) => boolean) => agentLines.some(pred),
    },
    env: {},
    lastCheckedDurationMinutes: null,
    bookingCompleted: false,
    endReason: null,
  } as unknown as ToolRuntimeContext;
  return { rt, updates, inserts, recordToolCall, recordCompliance, markEndDisclosureRequested };
}

function fakeCtx() {
  const session = new EventEmitter() as EventEmitter & { shutdown: ReturnType<typeof vi.fn> };
  session.shutdown = vi.fn();
  const doneCallbacks: Array<() => void> = [];
  const speechHandle = { addDoneCallback: vi.fn((cb: () => void) => doneCallbacks.push(cb)) };
  return {
    session,
    speechHandle,
    doneCallbacks,
    ctx: { session, speechHandle } as never,
  };
}

async function runTool(rt: ToolRuntimeContext, reason: string, ctx: never) {
  const tool = endCallTool(rt);
  return tool.execute(
    { reason } as never,
    { ctx, toolCallId: 'tc-1', abortSignal: new AbortController().signal } as never,
  );
}

describe('goodbyeInstruction', () => {
  it('carries the reason and demands exactly one Hebrew goodbye sentence', () => {
    for (const reason of END_CALL_REASONS) {
      const out = goodbyeInstruction(reason);
      expect(out).toContain(reason);
      expect(out).toContain('Hebrew');
    }
  });
});

describe('endCallTool — teardown choreography', () => {
  it('records the reason, arms shutdown AFTER the goodbye finishes, returns the instruction', async () => {
    const { rt, recordToolCall } = fakeRt();
    const { ctx, session, speechHandle, doneCallbacks } = fakeCtx();

    const out = await runTool(rt, 'meeting_booked', ctx);

    expect(out).toContain('meeting_booked');
    expect(rt.endReason).toBe('meeting_booked');
    expect(recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'end_call', ok: true }),
    );

    // The session must NOT die before the goodbye has played.
    expect(speechHandle.addDoneCallback).toHaveBeenCalledOnce();
    expect(session.shutdown).not.toHaveBeenCalled();
    doneCallbacks.forEach((cb) => cb());
    expect(session.shutdown).toHaveBeenCalledOnce();
  });

  it('a failed DNC write does not stop the hang-up — the call still ends gracefully', async () => {
    const { rt } = fakeRt({ leadId: 'lead-1', failWrites: true });
    const { ctx } = fakeCtx();
    const out = await runTool(rt, 'opt_out', ctx);
    expect(out).toContain('opt_out');
    expect(rt.endReason).toBe('opt_out');
  });
});

describe('markLeadOptedOut — the DNC mark, tenant-scoped on every path', () => {
  it('outbound (known lead): flips the lead to opted_out', async () => {
    const { rt, updates } = fakeRt({ leadId: 'lead-known' });
    expect(await markLeadOptedOut(rt)).toBe('lead_updated');
    expect(updates[0]).toMatchObject({ status: LEAD_STATUS_OPTED_OUT });
  });

  it('inbound with a phone match: flips the matched lead', async () => {
    const { rt, updates, inserts } = fakeRt({ callerPhone: '+972501234567', phoneMatch: 'lead-x' });
    expect(await markLeadOptedOut(rt)).toBe('lead_updated');
    expect(updates[0]).toMatchObject({ status: LEAD_STATUS_OPTED_OUT });
    expect(inserts).toHaveLength(0);
  });

  it('inbound stranger: CREATES an opted_out lead so the request survives', async () => {
    const { rt, inserts } = fakeRt({ callerPhone: '+972501234567', phoneMatch: null });
    expect(await markLeadOptedOut(rt)).toBe('lead_created');
    expect(inserts[0]).toMatchObject({
      tenantId: 'tenant-1',
      phone: '+972501234567',
      status: LEAD_STATUS_OPTED_OUT,
      source: 'voice-livekit',
    });
  });

  it('no lead and no caller id: reports no_identity instead of guessing', async () => {
    const { rt, updates, inserts } = fakeRt({ callerPhone: null });
    expect(await markLeadOptedOut(rt)).toBe('no_identity');
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it('opt_out through the tool marks the lead before the goodbye', async () => {
    const { rt, updates } = fakeRt({ leadId: 'lead-1' });
    const { ctx } = fakeCtx();
    await runTool(rt, 'opt_out', ctx);
    expect(updates[0]).toMatchObject({ status: LEAD_STATUS_OPTED_OUT });
  });

  it('other reasons never touch the lead status', async () => {
    const { rt, updates, inserts } = fakeRt({ leadId: 'lead-1' });
    const { ctx } = fakeCtx();
    await runTool(rt, 'not_interested', ctx);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});

/**
 * AI disclosure at end of call — documented product decision for the Israeli market (see
 * compliance/ai-disclosure.ts, including the EU AI Act caveat). Decided from the TRANSCRIPT,
 * never from the model's memory of itself.
 */
describe('endCallTool — conditional AI disclosure in the goodbye', () => {
  it('caller was told during the call ("אני סוכנת AI") → normal goodbye, disclosure logged as during_call', async () => {
    const { rt, recordCompliance, markEndDisclosureRequested } = fakeRt({
      leadId: 'lead-1',
      agentLines: ['שלום, מה שלומך?', 'אני סוכנת AI, אבל אני יכולה להעביר הודעה לצוות.'],
    });
    const { ctx } = fakeCtx();
    const out = await runTool(rt, 'meeting_booked', ctx);
    expect(out).not.toContain('digital assistant');
    expect(recordCompliance).toHaveBeenCalledWith({ ai_disclosure: 'during_call' });
    expect(markEndDisclosureRequested).not.toHaveBeenCalled();
  });

  it('never disclosed → the goodbye instruction DEMANDS the disclosure sentence', async () => {
    const { rt, recordCompliance, markEndDisclosureRequested } = fakeRt({
      leadId: 'lead-1',
      agentLines: ['שלום, מה שלומך?', 'קבעתי לך פגישה ליום ראשון.'],
    });
    const { ctx } = fakeCtx();
    const out = await runTool(rt, 'meeting_booked', ctx);
    expect(out).toContain('העוזרת הדיגיטלית של קורן');
    expect(out).toContain('you have not yet told the caller you are an AI');
    // The verdict (at_end vs missed) is settled at shutdown by re-scanning the transcript —
    // here we only flag that the request was made.
    expect(markEndDisclosureRequested).toHaveBeenCalledOnce();
    expect(recordCompliance).not.toHaveBeenCalledWith(expect.objectContaining({ ai_disclosure: expect.anything() }));
  });
});
