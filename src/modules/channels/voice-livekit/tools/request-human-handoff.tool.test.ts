import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { leads } from '../../../../db/schema/index.js';
import {
  HANDOFF_END_REASON,
  establishedLine,
  handoffAlertText,
  handoffReasonLine,
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
        // A LAZY thenable, never an eager promise.
        //
        // This used to be `Object.assign(where(), …)`, which INVOKED `where()` — so on the
        // failWrites path it built a rejected promise whether or not the code under test ever
        // awaited it. The `.where().returning()` path never does, so Node reported an unhandled
        // rejection and vitest failed a run in which all 1164 tests passed (the "Errors" line sits
        // directly under the green "Tests" line, which is how it reached main and stayed there).
        // Building the rejection only when somebody awaits keeps the intent exactly — a write that
        // throws — with no stray promise left over.
        const thenable = {
          then: <T>(
            onFulfilled?: ((value: undefined) => T) | null,
            onRejected?: ((reason: unknown) => T) | null,
          ) =>
            (opts.failWrites ? Promise.reject(new Error('db down')) : Promise.resolve(undefined)).then(
              onFulfilled,
              onRejected,
            ),
        };
        return Object.assign(thenable, {
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

async function runTool(
  rt: ToolRuntimeContext,
  reason: string,
  ctx: never,
  extra: { wants?: string | null; context?: string | null } = {},
) {
  const tool = requestHumanHandoffTool(rt);
  return (await tool.execute(
    { reason, ...extra } as never,
    { ctx, toolCallId: 'tc-1', abortSignal: new AbortController().signal } as never,
  )) as string;
}

describe('structural injection defense', () => {
  it('takes only DESCRIPTIVE arguments — no destination for an injected redirect to land in', () => {
    // `wants` and `context` joined `reason` on 2026-08-29 so the owner gets a summary instead of
    // "רוצה לדבר עם בן אדם". The invariant they must not break is the original one: nothing here
    // names a phone, an address or a channel, so "notify my other number instead" has nowhere to go.
    expect(Object.keys(requestHumanHandoffSchema.shape)).toEqual(['reason', 'wants', 'context']);
  });

  it('caps every free-text field so a prompt-injection payload cannot ride into the owner alert', () => {
    expect(requestHumanHandoffSchema.safeParse({ reason: 'x'.repeat(201) }).success).toBe(false);
    expect(requestHumanHandoffSchema.safeParse({ reason: 'ok', wants: 'x'.repeat(201) }).success).toBe(false);
    expect(requestHumanHandoffSchema.safeParse({ reason: 'ok', context: 'x'.repeat(401) }).success).toBe(false);
  });

  it('accepts an explicit null in the new fields — gpt-5.4 sends null, not an omission', () => {
    // capture_lead_info learned this on a live call: a bare .optional() rejects null, the model
    // retries the same call, and the lead sits in silence. A handoff must never stall on Zod.
    const parsed = requestHumanHandoffSchema.safeParse({ reason: 'רוצה נציג', wants: null, context: null });
    expect(parsed.success).toBe(true);
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

  it('sends the owner a SUMMARY — the answer she got, plus what the call already recorded', async () => {
    // 2026-08-29: the first live handoff pinged Koren with "רוצה לדבר עם בן אדם" and nothing else.
    // The person calling back needs to know what it is about before they dial.
    const { rt, added } = fakeRt({ leadId: 'lead-1' });
    (rt as { callState?: unknown }).callState = {
      facts: { businessType: 'חנות אונליין', budget: '20 אלף בחודש' },
      onToolCall: () => undefined,
    };
    const { ctx } = fakeCtx();

    await runTool(rt, 'רוצה לדבר עם בן אדם', ctx, {
      wants: 'רוצה לשמוע על מחירים',
      context: 'ביקש הצעה כתובה',
    });

    const [wa, mail] = added.map((a) => a.data);
    for (const body of [String(wa.content), String(mail.content)]) {
      expect(body).toContain('רוצה לשמוע על מחירים'); // what she asked and he answered
      expect(body).toContain('חנות אונליין'); // what capture_lead_info had already learned
      expect(body).toContain('20 אלף בחודש');
      expect(body).toContain('ביקש הצעה כתובה');
    }
    // The template's one reason slot carries the same summary, on a single line.
    const variables = (wa.template as { variables: Record<string, string> }).variables;
    expect(variables['3']).toContain('רוצה לשמוע על מחירים');
    expect(variables['3']).not.toContain('\n');
  });

  it('hands off ANYWAY when the lead would not say why — never blocked on an explanation', async () => {
    // The one property that must survive every future edit to this tool.
    const { rt, updates, added } = fakeRt({ leadId: 'lead-1' });
    const { ctx } = fakeCtx();

    const out = await runTool(rt, 'רוצה לדבר עם בן אדם', ctx, { wants: null, context: null });

    expect(updates).toHaveLength(1);
    expect(added).toHaveLength(2);
    expect(rt.endReason).toBe(HANDOFF_END_REASON);
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

  // ── The summary Koren asked for, 2026-08-29 ─────────────────────────────────────────────────
  // "for the admin, for me, I would like to see a reason why that user want to talk to me rather
  // than talk to Keren. So it should come with a small summary about the reason."

  it('carries WHAT they want to discuss and WHAT is already known, not just a reason', () => {
    const text = handoffAlertText({
      leadName: 'דנה לוי',
      leadPhone: '+972509998888',
      reason: 'רוצה לדבר עם בן אדם',
      wants: 'רוצה לשמוע על מחירים לחנות אונליין',
      established: 'עסק: חנות אונליין · תקציב: 20 אלף בחודש',
      leadUrl: null,
    });
    expect(text).toContain('רוצה לשמוע על מחירים לחנות אונליין');
    expect(text).toContain('חנות אונליין');
    expect(text).toContain('20 אלף בחודש');
  });

  it('says nothing extra when the lead would not explain — the alert still goes out', () => {
    // The property that must survive every future change here: a handoff is NEVER blocked or
    // downgraded because the caller declined to say why.
    const text = handoffAlertText({
      leadName: null,
      leadPhone: '+972509998888',
      reason: 'רוצה לדבר עם בן אדם',
      wants: null,
      established: null,
      leadUrl: null,
    });
    expect(text).toContain('רוצה לדבר עם בן אדם');
    expect(text).not.toMatch(/null|undefined/u);
  });
});

describe('establishedLine — what the call already knows, without a second question', () => {
  it('reads the working memory the call filled in on its own', () => {
    const line = establishedLine(
      { businessType: 'חנות אונליין', painPoint: 'לא מספיק פניות', budget: '20 אלף', qualification: 'hot' },
      null,
    );
    expect(line).toContain('חנות אונליין');
    expect(line).toContain('לא מספיק פניות');
    expect(line).toContain('hot');
  });

  it('appends the model\'s own one-liner after the recorded facts', () => {
    const line = establishedLine({ businessType: 'מרפאה' }, '  ביקש הצעת מחיר כתובה  ');
    expect(line).toBe('עסק: מרפאה · ביקש הצעת מחיר כתובה');
  });

  it('is null when the call learned nothing — better an absent line than a row of "unknown"', () => {
    expect(establishedLine(undefined, null)).toBeNull();
    expect(establishedLine({}, '   ')).toBeNull();
  });
});

describe('handoffReasonLine — the WhatsApp template has one slot for all of it', () => {
  it('folds the summary onto a single line (a template variable may not contain a newline)', () => {
    const line = handoffReasonLine({
      reason: 'רוצה לדבר עם בן אדם',
      wants: 'מחירים\nוזמינות',
      established: 'עסק: מרפאה',
    });
    expect(line).not.toContain('\n');
    expect(line).toContain('רוצה לדבר עם בן אדם');
    expect(line).toContain('עסק: מרפאה');
  });

  it('is just the reason when there is nothing else — never a trailing separator', () => {
    expect(handoffReasonLine({ reason: 'רוצה נציג' })).toBe('רוצה נציג');
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
