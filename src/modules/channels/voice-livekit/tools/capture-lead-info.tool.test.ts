import { describe, expect, it, vi } from 'vitest';
import { CallStateMachine } from '../call-state.js';
import type { ToolRuntimeContext } from './tool-context.js';
import {
  captureLeadInfoSchema,
  executeCaptureLeadInfo,
  type CaptureLeadInfoArgs,
} from './capture-lead-info.tool.js';

function fakeRt(opts: { leadId?: string | null; phoneMatch?: string | null; insertFails?: boolean; callState?: CallStateMachine } = {}) {
  const updates: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: async () => (opts.phoneMatch ? [{ id: opts.phoneMatch }] : []) }),
      }),
    })),
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          updates.push(vals);
        },
      }),
    })),
    insert: vi.fn(() => ({
      values: (vals: Record<string, unknown>) => {
        inserts.push(vals);
        return { returning: async () => (opts.insertFails ? [] : [{ id: 'lead-new' }]) };
      },
    })),
  };
  const rt = {
    tenantId: 'tenant-1',
    leadId: opts.leadId ?? null,
    callerPhone: '+972501234567',
    callId: 'call-1',
    db,
    report: { recordToolCall: vi.fn() },
    lastCheckedDurationMinutes: null,
    bookingCompleted: false,
    endReason: null,
    callState: opts.callState,
  } as unknown as ToolRuntimeContext;
  return { rt, updates, inserts };
}

const args = (over: Partial<CaptureLeadInfoArgs>): CaptureLeadInfoArgs => over as CaptureLeadInfoArgs;

describe('captureLeadInfoSchema', () => {
  it('empty args pass the SCHEMA (plain z.object for LiveKit) but the HANDLER refuses', async () => {
    expect(captureLeadInfoSchema.safeParse({}).success).toBe(true); // ZodEffects would break llm.tool
    const { rt } = fakeRt({ leadId: 'lead-1' });
    await expect(executeCaptureLeadInfo(rt, args({}))).rejects.toThrow('Nothing to save');
  });

  it('accepts any single field', () => {
    expect(captureLeadInfoSchema.safeParse({ budget: 'בערך 20 אלף' }).success).toBe(true);
    expect(captureLeadInfoSchema.safeParse({ qualification: 'hot' }).success).toBe(true);
  });

  it('mirrors captured facts into the state machine working memory + advances on a qualification read', async () => {
    const cs = new CallStateMachine();
    cs.onUserTurn(); // opening → discovery
    const { rt } = fakeRt({ leadId: 'lead-1', callState: cs });
    await executeCaptureLeadInfo(
      rt,
      args({ business_type: 'מכון כושר', pain_point: 'לידים אבודים', qualification: 'hot' }),
    );
    expect(cs.stage).toBe('qualifying'); // qualification read advanced the stage
    expect(cs.facts).toEqual({ businessType: 'מכון כושר', painPoint: 'לידים אבודים', qualification: 'hot' });
  });

  it('a capture WITHOUT a qualification read does not advance the stage', async () => {
    const cs = new CallStateMachine();
    cs.onUserTurn(); // → discovery
    const { rt } = fakeRt({ leadId: 'lead-1', callState: cs });
    await executeCaptureLeadInfo(rt, args({ business_type: 'חנות אונליין' }));
    expect(cs.stage).toBe('discovery');
    expect(cs.facts.businessType).toBe('חנות אונליין');
  });

  it('rejects unknown qualification values', () => {
    expect(captureLeadInfoSchema.safeParse({ qualification: 'boiling' }).success).toBe(false);
  });

  it('ACCEPTS null in every field — gpt-5.4 fills unknowns with null, not by omitting (the vanish bug)', () => {
    // A bare .optional() rejected null → the model looped on a failing call and Keren went silent.
    const allNull = {
      name: null, email: null, phone: null, business_type: null,
      pain_point: null, budget: null, timeline: null, qualification: null, notes: null,
    };
    expect(captureLeadInfoSchema.safeParse(allNull).success).toBe(true);
    // A realistic mixed call (some real values, the rest null) must parse in ONE shot.
    expect(
      captureLeadInfoSchema.safeParse({ name: 'יוסי נאמן', business_type: 'הוצאת ספרים', qualification: 'warm', email: null, phone: null, budget: null }).success,
    ).toBe(true);
  });

  it('an all-null call is still "nothing to save" — null counts as absent in the handler', async () => {
    const { rt } = fakeRt({ leadId: 'lead-1' });
    await expect(
      executeCaptureLeadInfo(rt, args({ name: null, email: null, business_type: null, qualification: null })),
    ).rejects.toThrow('Nothing to save');
  });

  it('null contact fields do not blank the lead — a name with null email/phone still saves', async () => {
    const { rt } = fakeRt({ leadId: 'lead-1' });
    await expect(
      executeCaptureLeadInfo(rt, args({ name: 'יוסי נאמן', email: null, phone: null })),
    ).resolves.toContain('Saved');
  });
});

describe('executeCaptureLeadInfo', () => {
  it('caches the resolved lead id back onto the runtime for later tools', async () => {
    const { rt } = fakeRt({ phoneMatch: 'lead-existing' });
    await executeCaptureLeadInfo(rt, args({ business_type: 'חנות רהיטים' }));
    expect(rt.leadId).toBe('lead-existing');
  });

  it('qualification facts land in metadata merge with the call id stamped', async () => {
    const { rt, updates } = fakeRt({ leadId: 'lead-1' });
    await executeCaptureLeadInfo(rt, args({ pain_point: 'מפספס לידים', qualification: 'hot' }));
    // update #1 = contact backfill (upsert), update #2 = qualification metadata merge + score
    expect(updates).toHaveLength(2);
    expect(updates[1]).toHaveProperty('metadata');
    expect(updates[1]).toHaveProperty('score'); // hot → GREATEST(score, 90)
  });

  it('contact-only capture (name/email) performs no metadata merge', async () => {
    const { rt, updates } = fakeRt({ leadId: 'lead-1' });
    await executeCaptureLeadInfo(rt, args({ name: 'דנה לוי', email: 'Dana@Example.com' }));
    expect(updates).toHaveLength(1); // just the backfill
    expect(updates[0]).not.toHaveProperty('metadata');
  });

  it('never touches lead status — that belongs to book_meeting/end_call', async () => {
    const { rt, updates } = fakeRt({ leadId: 'lead-1' });
    await executeCaptureLeadInfo(rt, args({ qualification: 'cold', notes: 'לא בשל' }));
    for (const u of updates) expect(u).not.toHaveProperty('status');
  });

  it('tells the model to keep quiet about the save', async () => {
    const { rt } = fakeRt({ leadId: 'lead-1' });
    const out = await executeCaptureLeadInfo(rt, args({ budget: '20K' }));
    expect(out).toContain('do not mention');
  });
});
