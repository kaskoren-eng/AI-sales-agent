import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { leads } from '../../../../db/schema/index.js';
import {
  HANDOFF_END_REASON,
  handoffAlertText,
  handoffInstruction,
  requestHumanHandoffSchema,
  requestHumanHandoffTool,
} from './request-human-handoff.tool.js';
import type { ToolRuntimeContext } from './tool-context.js';

/**
 * The handoff is the one tool whose failure modes are all invisible to the lead: a dropped flag,
 * an un-notified owner, a double ping. Every test here pins one of those.
 */

const OWNER = {
  ownerName: 'קורן',
  ownerPhone: '+972501112222',
  ownerEmail: 'koren@clickscales.com',
  notify: ['whatsapp', 'email'],
};

function fakeDb(opts: { phoneMatch?: { id: string; name: string | null; phone: string } | null; failWrites?: boolean } = {}) {
  const updates: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => (opts.phoneMatch ? [opts.phoneMatch] : []),
        }),
      }),
    })),
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => {
        updates.push(vals);
        const where = async () => {
          if (opts.failWrites) throw new Error('db down');
        };
        return Object.assign(where(), {
          where: () =>
            Object.assign(Promise.resolve([{ id: 'lead-1', name: 'דנה לוי', phone: '+972509998888' }]), {
              returning: async () => {
                if (opts.failWrites) throw new Error('db down');
                return [{ id: 'lead-1', name: 'דנה לוי', phone: '+972509998888' }];
              },
            }),
        });
      },
    })),
    insert: vi.fn((table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        if (table === leads) inserts.push(vals);
        return {
          returning: async () => {
            if (opts.failWrites) throw new Error('db down');
            return [{ id: 'lead-new' }];
          },
        };
      },
    })),
  };
  return { db, updates, inserts };
}

function fakeRt(
  opts: {
    leadId?: string | null;
    callerPhone?: string | null;
    phoneMatch?: { id: string; name: string | null; phone: string } | null;
    failWrites?: boolean;
    queue?: boolean | 'hangs';
    settings?: unknown;
    agentLines?: string[];
    dashboardUrl?: string;
  } = {},
) {
  const { db, updates, inserts } = fakeDb(opts);
  const added: Array<{ name: string; data: Record<string, unknown> }> = [];
  const queue =
    opts.queue === false
      ? null
      : opts.queue === 'hangs'
        ? ({ add: vi.fn(() => new Promise(() => undefined)) } as never)
        : ({
            add: vi.fn(async (name: string, data: Record<string, unknown>) => {
              added.push({ name, data });
            }),
          } as never);
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
      recordToolCall: vi.fn(),
      recordCompliance,
      markEndDisclosureRequested,
      someAgentLine: (pred: (t: string) => boolean) => agentLines.some(pred),
    },
    env: { DASHBOARD_BASE_URL: opts.dashboardUrl },
    settings: 'settings' in opts ? opts.settings : { handoff: OWNER },
    outboundQueue: queue,
    lastCheckedDurationMinutes: null,
    bookingCompleted: false,
    handoffRequested: false,
    endReason: null,
  } as unknown as ToolRuntimeContext;
  return { rt, updates, inserts, added, recordCompliance, markEndDisclosureRequested };
}

function fakeCtx() {
  const session = new EventEmitter() as EventEmitter & { shutdown: ReturnType<typeof vi.fn> };
  session.shutdown = vi.fn();
  const doneCallbacks: Array<() => void> = [];
  const speechHandle = { addDoneCallback: vi.fn((cb: () => void) => doneCallbacks.push(cb)) };
  return { session, speechHandle, doneCallbacks, ctx: { session, speechHandle } as never };
}

async function runTool(rt: ToolRuntimeContext, reason: string, ctx: never) {
  const tool = requestHumanHandoffTool(rt);
  return (await tool.execute(
    { reason } as never,
    { ctx, toolCallId: 'tc-1', abortSignal: new AbortController().signal } as never,
  )) as string;
}

describe('structural injection defense', () => {
  it('takes ONE argument — a reason. No destination for an injected redirect to land in', () => {
    expect(Object.keys(requestHumanHandoffSchema.shape)).toEqual(['reason']);
  });

  it('caps the reason so a prompt-injection payload cannot ride into the owner alert', () => {
    const parsed = requestHumanHandoffSchema.safeParse({ reason: 'x'.repeat(201) });
    expect(parsed.success).toBe(false);
  });
});

describe('request_human_handoff — the happy path', () => {
  it('flags the lead, pings the owner on both channels, and hands the model the line', async () => {
    const { rt, updates, added } = fakeRt({ leadId: 'lead-1', dashboardUrl: 'https://app.example.com' });
    const { ctx, speechHandle } = fakeCtx();

    const out = await runTool(rt, 'רוצה לדבר עם מנהל על מחיר', ctx);

    // 1. The durable flag — a real timestamp, not a boolean.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.handoffRequestedAt).toBeInstanceOf(Date);

    // 2. Both owner notifications, addressed to the OWNER from settings — never to the lead.
    expect(added).toHaveLength(2);
    const [wa, mail] = added.map((a) => a.data);
    expect(wa).toMatchObject({ channel: 'whatsapp', to: OWNER.ownerPhone });
    expect(wa.template).toMatchObject({ key: 'handoff_alert' });
    expect((wa.metadata as Record<string, unknown>).notifyRole).toBe('owner');
    expect(mail).toMatchObject({ channel: 'email', to: OWNER.ownerEmail });
    // The reason the lead gave, and the deep link, reach the human who calls back.
    expect(String(wa.content)).toContain('רוצה לדבר עם מנהל על מחיר');
    expect(String(wa.content)).toContain('https://app.example.com/leads/lead-1');

    // 3. The call ends the end_call way, and the model is told to name the owner.
    expect(speechHandle.addDoneCallback).toHaveBeenCalled();
    expect(rt.endReason).toBe(HANDOFF_END_REASON);
    expect(out).toContain('קורן');
    expect(out).toMatch(/one warm sentence/iu);
  });

  it('omits the dashboard link entirely when DASHBOARD_BASE_URL is unset — never a broken URL', async () => {
    const { rt, added } = fakeRt({ leadId: 'lead-1' });
    const { ctx } = fakeCtx();
    await runTool(rt, 'רוצה בן אדם', ctx);
    expect(String(added[0]!.data.content)).not.toContain('/leads/');
  });
});

describe('request_human_handoff — idempotency', () => {
  it('a second call in the same session re-flags nothing and does NOT double-ping the owner', async () => {
    const { rt, updates, added } = fakeRt({ leadId: 'lead-1' });
    const { ctx } = fakeCtx();

    await runTool(rt, 'רוצה בן אדם', ctx);
    const second = await runTool(rt, 'שוב מבקש בן אדם', ctx);

    expect(updates).toHaveLength(1);
    expect(added).toHaveLength(2); // still just the first call's whatsapp+email
    expect(second).toMatch(/already recorded/iu);
  });
});

describe('request_human_handoff — the lead never pays for our plumbing', () => {
  it('no owner configured → still flags, still says the line, names no one', async () => {
    const { rt, updates, added } = fakeRt({ leadId: 'lead-1', settings: {} });
    const { ctx } = fakeCtx();

    const out = await runTool(rt, 'רוצה נציג', ctx);

    expect(updates).toHaveLength(1);
    expect(added).toHaveLength(0);
    expect(rt.endReason).toBe(HANDOFF_END_REASON);
    expect(out).toMatch(/do NOT invent a name/iu);
  });

  it('dead queue → the handoff still completes', async () => {
    const { rt, updates } = fakeRt({ leadId: 'lead-1', queue: false });
    const { ctx, speechHandle } = fakeCtx();

    const out = await runTool(rt, 'רוצה נציג', ctx);

    expect(updates).toHaveLength(1);
    expect(speechHandle.addDoneCallback).toHaveBeenCalled();
    expect(out).toContain('קורן');
  });

  it('a hung Redis is timeboxed — the lead does not wait on the queue', async () => {
    const { rt } = fakeRt({ leadId: 'lead-1', queue: 'hangs' });
    const { ctx, speechHandle } = fakeCtx();

    const started = Date.now();
    const out = await runTool(rt, 'רוצה נציג', ctx);

    expect(Date.now() - started).toBeLessThan(5_000); // two 1.5s timeboxes, not a hang
    expect(speechHandle.addDoneCallback).toHaveBeenCalled();
    expect(out).toContain('קורן');
  });

  it('the DB write failing does not swallow the handoff — she still says the line', async () => {
    const { rt } = fakeRt({ leadId: 'lead-1', failWrites: true });
    const { ctx, speechHandle } = fakeCtx();

    const out = await runTool(rt, 'רוצה נציג', ctx);

    expect(rt.endReason).toBe(HANDOFF_END_REASON);
    expect(speechHandle.addDoneCallback).toHaveBeenCalled();
    expect(out).toContain('קורן');
  });
});

describe('request_human_handoff — inbound callers with no lead row', () => {
  it('an unknown caller gets a lead CREATED so the request survives the call', async () => {
    const { rt, inserts, added } = fakeRt({ leadId: null, callerPhone: '+972521234567' });
    const { ctx } = fakeCtx();

    await runTool(rt, 'רוצה לדבר עם מישהו', ctx);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ tenantId: 'tenant-1', phone: '+972521234567', source: 'voice-livekit' });
    expect(inserts[0]!.handoffRequestedAt).toBeInstanceOf(Date);
    expect(added).toHaveLength(2); // the owner is notified even for an unknown caller
  });

  it('an existing lead matched by phone is updated, not duplicated', async () => {
    const { rt, updates, inserts } = fakeRt({
      leadId: null,
      callerPhone: '+972521234567',
      phoneMatch: { id: 'lead-9', name: 'יוסי', phone: '+972521234567' },
    });
    const { ctx } = fakeCtx();

    await runTool(rt, 'רוצה נציג', ctx);

    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.handoffRequestedAt).toBeInstanceOf(Date);
  });

  it('no lead id and no usable phone → logged, and the call still ends politely', async () => {
    const { rt, inserts, updates } = fakeRt({ leadId: null, callerPhone: null });
    const { ctx, speechHandle } = fakeCtx();

    const out = await runTool(rt, 'רוצה נציג', ctx);

    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(speechHandle.addDoneCallback).toHaveBeenCalled();
    expect(out).toContain('קורן');
  });
});

describe('AI disclosure carries into the handoff goodbye', () => {
  it('never disclosed during the call → the instruction demands the disclosure sentence', async () => {
    const { rt, markEndDisclosureRequested } = fakeRt({ leadId: 'lead-1', agentLines: ['שלום, מה שלומך?'] });
    const { ctx } = fakeCtx();

    const out = await runTool(rt, 'רוצה נציג', ctx);

    expect(markEndDisclosureRequested).toHaveBeenCalled();
    expect(out.length).toBeGreaterThan(handoffInstruction('קורן').length);
  });

  it('already disclosed → plain handoff line, disclosure logged as during_call', async () => {
    const { rt, recordCompliance } = fakeRt({ leadId: 'lead-1', agentLines: ['אני סוכנת AI של ClickScales'] });
    const { ctx } = fakeCtx();

    await runTool(rt, 'רוצה נציג', ctx);

    expect(recordCompliance).toHaveBeenCalledWith({ ai_disclosure: 'during_call' });
  });
});

describe('the owner alert text', () => {
  it('carries name, phone, reason and link — what a human needs to call back', () => {
    const text = handoffAlertText({
      leadName: 'דנה לוי',
      leadPhone: '+972509998888',
      reason: 'שאלה על מחיר',
      leadUrl: 'https://app.example.com/leads/lead-1',
    });
    expect(text).toContain('דנה לוי');
    expect(text).toContain('+972509998888');
    expect(text).toContain('שאלה על מחיר');
    expect(text).toContain('https://app.example.com/leads/lead-1');
  });

  it('degrades to "unknown" rather than printing "null" at a human', () => {
    const text = handoffAlertText({ leadName: null, leadPhone: null, reason: 'רוצה נציג', leadUrl: null });
    expect(text).not.toMatch(/null|undefined/u);
    expect(text).toContain('לא ידוע');
  });
});

describe('the spoken instruction', () => {
  it('never promises a live transfer — a human CALLS BACK', () => {
    for (const instruction of [handoffInstruction('קורן'), handoffInstruction(null)]) {
      expect(instruction).toMatch(/get back to them/iu);
      expect(instruction).not.toMatch(/transfer|connect(ing)? (you|them) now/iu);
      expect(instruction).toMatch(/do NOT promise an exact/iu);
    }
  });
});
