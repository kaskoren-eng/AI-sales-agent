import { describe, expect, it, vi } from 'vitest';
import { CallStateMachine } from '../call-state.js';
import { FactMemory } from '../fact-memory.js';
import { settleLeadWrites } from './lead-writes.js';
import type { ToolRuntimeContext } from './tool-context.js';
import {
  captureLeadInfoSchema,
  executeCaptureLeadInfo,
  type CaptureLeadInfoArgs,
} from './capture-lead-info.tool.js';

/**
 * Every string reachable from a drizzle `.set()` payload.
 *
 * `JSON.stringify` cannot be used here: the qualification patch travels inside a `sql` template
 * whose chunks reference the PgTable, which references its columns, which reference the table —
 * a cycle. This walks it with a seen-set instead, so a test can assert what was actually sent
 * without reaching into drizzle's internals by name.
 */
function collectStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value as Record<string, unknown>).flatMap((v) => collectStrings(v, seen));
}

function fakeRt(opts: { leadId?: string | null; phoneMatch?: string | null; insertFails?: boolean; callState?: CallStateMachine; factMemory?: FactMemory; asyncWrites?: boolean; hold?: Promise<void> } = {}) {
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
          // `hold` lets a test keep the write open, which is the only way to observe that the
          // tool returned BEFORE the database did.
          if (opts.hold) await opts.hold;
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
    factMemory: opts.factMemory,
    // The default is the AWAITED path, which is what every case written before
    // VOICE_ASYNC_LEAD_WRITES existed is asserting about.
    env: { VOICE_ASYNC_LEAD_WRITES: opts.asyncWrites === true },
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

/**
 * THE 2026-08-29 RENAME, at the tool boundary.
 *
 * The DB never accepted the rename — `upsertLead` coalesces and cannot blank a name. The MODEL
 * did, because nothing told it otherwise, and it is the model that speaks. So the assertion that
 * matters here is not "the row is unchanged" (it always was) but "the tool result CORRECTS the
 * model", which is what reaches her before she says the wrong name out loud.
 */
describe('capture_lead_info — an established identity is harder to overwrite than to set', () => {
  it('refuses a rename from a noisy turn, keeps the DB clean, and says so in the tool result', async () => {
    const fm = new FactMemory();
    const { rt, updates } = fakeRt({ leadId: 'lead-1', factMemory: fm });
    await executeCaptureLeadInfo(rt, args({ name: 'קורן' }));
    const result = await executeCaptureLeadInfo(rt, args({ name: 'טל' }));

    expect(result).toContain('did NOT change');
    expect(result).toContain('קורן');
    expect(result).toContain('is_correction=true');
    expect(fm.get('name')).toBe('קורן');
    // The refused name never reached the write at all — not merely coalesced away by SQL.
    expect(updates.at(-1)).not.toHaveProperty('name');
  });

  it('an explicit correction goes through and returns the plain success message', async () => {
    const fm = new FactMemory();
    const { rt } = fakeRt({ leadId: 'lead-1', factMemory: fm });
    await executeCaptureLeadInfo(rt, args({ name: 'קורן' }));
    const result = await executeCaptureLeadInfo(rt, args({ name: 'טל', is_correction: true }));
    expect(result).toContain('Saved.');
    expect(result).not.toContain('did NOT change');
    expect(fm.get('name')).toBe('טל');
  });

  it('a refused name never reaches the working memory the handoff alert is built from', async () => {
    const fm = new FactMemory();
    const cs = new CallStateMachine();
    const { rt } = fakeRt({ leadId: 'lead-1', factMemory: fm, callState: cs });
    await executeCaptureLeadInfo(rt, args({ name: 'קורן' }));
    await executeCaptureLeadInfo(rt, args({ name: 'טל' }));
    expect(cs.facts.name).toBe('קורן');
  });

  it('qualification facts stay freely overwritable — a wrong budget is silent, a wrong name is not', async () => {
    const fm = new FactMemory();
    const cs = new CallStateMachine();
    const { rt } = fakeRt({ leadId: 'lead-1', factMemory: fm, callState: cs });
    await executeCaptureLeadInfo(rt, args({ budget: 'בערך 5000' }));
    const result = await executeCaptureLeadInfo(rt, args({ budget: 'בעצם 20 אלף' }));
    expect(result).not.toContain('did NOT change');
    expect(cs.facts.budget).toBe('בעצם 20 אלף');
  });

  it('WITHOUT the fact memory (switch off) the tool behaves exactly as before — the rename lands', async () => {
    const cs = new CallStateMachine();
    const { rt } = fakeRt({ leadId: 'lead-1', callState: cs });
    await executeCaptureLeadInfo(rt, args({ name: 'קורן' }));
    const result = await executeCaptureLeadInfo(rt, args({ name: 'טל' }));
    expect(result).toBe('Saved. Continue the conversation naturally — do not mention that you saved anything.');
    expect(cs.facts.name).toBe('טל');
  });

  it('is_correction alone is not a fact — an otherwise empty call is still refused', async () => {
    const { rt } = fakeRt({ leadId: 'lead-1', factMemory: new FactMemory() });
    await expect(executeCaptureLeadInfo(rt, args({ is_correction: true }))).rejects.toThrow('Nothing to save');
  });

  it('a captured business_type is established, so the reminder can stop her re-asking for it', async () => {
    const fm = new FactMemory();
    const { rt } = fakeRt({ leadId: 'lead-1', factMemory: fm });
    await executeCaptureLeadInfo(rt, args({ business_type: 'מכון כושר' }));
    expect(fm.get('business')).toBe('מכון כושר');
  });

  /**
   * ALL FIVE MANDATORY ANSWERS, not just the one that had a field.
   *
   * Koren set the five mandatory discovery questions on 2026-09-01. `FactField` gained `process`,
   * `frustration`, `closing` and `volume` — and nothing ever called `establish` for any of them,
   * while two of them had no tool field to be established FROM. So the memory counted her asks and
   * never learned she had been answered, which is a memory that can tell her to stop asking but
   * not why. She asked one of these four times on his 14:56 call.
   */
  it('establishes every mandatory answer, including the two that had no field until now', async () => {
    const fm = new FactMemory();
    const { rt } = fakeRt({ leadId: 'lead-1', factMemory: fm });
    await executeCaptureLeadInfo(
      rt,
      args({
        business_type: 'בניית אתרים',
        current_process: 'אני עונה בעצמי, תוך כמה שעות',
        pain_point: 'לא מספיק לחזור לכולם',
        sales_process: 'שיחת זום',
        daily_volume: 'בערך חמישה עשר',
      }),
    );
    expect(fm.get('business')).toBe('בניית אתרים');
    expect(fm.get('process')).toBe('אני עונה בעצמי, תוך כמה שעות');
    expect(fm.get('frustration')).toBe('לא מספיק לחזור לכולם');
    expect(fm.get('closing')).toBe('שיחת זום');
    expect(fm.get('volume')).toBe('בערך חמישה עשר');
  });

  it('persists the three facts that were gated on but never written down', async () => {
    // `current_process` opened Gate A from the day it was added and was saved nowhere, so the fact
    // deciding whether she may pitch was invisible to whoever picks the lead up afterwards. The
    // two new ones would have had the same problem.
    const { rt, updates } = fakeRt({ leadId: 'lead-1', factMemory: new FactMemory() });
    await executeCaptureLeadInfo(
      rt,
      args({
        current_process: 'המזכירה עונה עד ארבע',
        sales_process: 'פגישה פיזית',
        daily_volume: 'שבע-שמונה',
      }),
    );
    const patch = collectStrings(updates.at(-1) ?? {}).join(' ');
    expect(patch).toContain('המזכירה עונה עד ארבע');
    expect(patch).toContain('פגישה פיזית');
    expect(patch).toContain('שבע-שמונה');
  });

  it('stores the volume verbatim rather than as a number', async () => {
    // Rule 1 of the sales model is that a number she was given must be USED, and the number he
    // said is "בערך חמישה עשר" — not 15. Converting it here would lose the hedge, and the hedge is
    // what makes "אז בערך חמישה עשר ביום" sound like listening rather than like a database read.
    const fm = new FactMemory();
    const { rt } = fakeRt({ leadId: 'lead-1', factMemory: fm });
    await executeCaptureLeadInfo(rt, args({ daily_volume: 'בערך חמישה עשר' }));
    expect(fm.get('volume')).toBe('בערך חמישה עשר');
  });

  /**
   * 2026-08-31: she read `k o r e n at gmail dot com` back to a man whose address begins `kas`, he
   * said "לא נכון", and she proposed the identical string again. The tool had no reason not to
   * save it — nothing held the refusal. This is the enforcement half; email-dictation.ts is what
   * notices the rejection and calls `FactMemory.reject`.
   */
  it('never saves a value the lead ruled out, and tells the model why', async () => {
    const fm = new FactMemory();
    fm.reject('email', 'koren@gmail.com');
    const { rt, updates } = fakeRt({ leadId: 'lead-1', factMemory: fm });
    const result = await executeCaptureLeadInfo(rt, args({ email: 'koren@gmail.com' }));

    expect(result).toContain('NOT SAVED');
    expect(result).toContain('told you out loud that it is wrong');
    expect(updates.at(-1) ?? {}).not.toHaveProperty('email');
  });

  it('saves the address he actually meant, once it differs from the one he ruled out', async () => {
    const fm = new FactMemory();
    fm.reject('email', 'koren@gmail.com');
    const { rt } = fakeRt({ leadId: 'lead-1', factMemory: fm });
    const result = await executeCaptureLeadInfo(rt, args({ email: 'kaskoren@gmail.com' }));
    expect(result).toContain('Saved.');
    expect(result).not.toContain('NOT SAVED');
    expect(fm.get('email')).toBe('kaskoren@gmail.com');
  });
});

/**
 * VOICE_ASYNC_LEAD_WRITES — the caller stops waiting for Postgres.
 *
 * The tool ran two sequential round-trips before returning, and the model cannot write the next
 * sentence until a tool returns, so all of it was silence on the phone (880-1099ms on production
 * calls, once 3927ms). These cases pin the two things that make moving it off the hot path safe:
 * the model's answer does not change, and the row still gets written.
 */
describe("capture_lead_info — writes off the caller's clock", () => {
  const sameArgs = () => args({ name: 'עמית', business_type: 'סוכנות ביטוח', qualification: 'hot' });

  it('returns the SAME words as the awaited path — the model cannot tell the difference', async () => {
    const sync = fakeRt({ leadId: 'lead-1' });
    const async_ = fakeRt({ leadId: 'lead-1', asyncWrites: true });

    const syncSaid = await executeCaptureLeadInfo(sync.rt, sameArgs());
    const asyncSaid = await executeCaptureLeadInfo(async_.rt, sameArgs());

    expect(asyncSaid).toBe(syncSaid);
    expect(asyncSaid).toContain('Saved.');
  });

  it('returns while the database write is still open, then completes it', async () => {
    let release!: () => void;
    const hold = new Promise<void>((res) => {
      release = res;
    });
    const { rt, updates } = fakeRt({ leadId: 'lead-1', asyncWrites: true, hold });

    await executeCaptureLeadInfo(rt, sameArgs());
    // The tool has answered the model and the row has NOT been written yet. On the awaited path
    // this is where the caller sat listening to nothing.
    expect(updates).toHaveLength(0);

    release();
    await settleLeadWrites(rt);
    expect(updates.length).toBeGreaterThan(0);
  });

  it('still writes the contact fields and the qualification patch', async () => {
    const { rt, updates } = fakeRt({ leadId: 'lead-1', asyncWrites: true });
    await executeCaptureLeadInfo(rt, args({ name: 'עמית', business_type: 'סוכנות ביטוח' }));
    await settleLeadWrites(rt);

    // Two writes: the contact backfill, then the qualification patch — the same pair the awaited
    // path made, in the same order.
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(collectStrings(updates[0] ?? {})).toContain('עמית');
    expect(collectStrings(updates.at(-1) ?? {}).join(' ')).toContain('סוכנות ביטוח');
  });

  it('resolves the lead id for the tools that run later', async () => {
    const { rt } = fakeRt({ leadId: null, phoneMatch: null, asyncWrites: true });
    await executeCaptureLeadInfo(rt, sameArgs());
    expect(rt.leadId).toBeNull(); // not yet — the write is in flight
    await settleLeadWrites(rt);
    expect(rt.leadId).toBe('lead-new');
  });

  it('does NOT throw at the model when the write fails — it counts it instead', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { rt } = fakeRt({ leadId: null, phoneMatch: null, insertFails: true, asyncWrites: true });
      // The model is told "Saved" and keeps the conversation going. That is the stated price of
      // this flag: on a database failure the facts are lost where today the model is told so.
      await expect(executeCaptureLeadInfo(rt, sameArgs())).resolves.toContain('Saved.');
      await settleLeadWrites(rt);
      expect((rt as { leadWriteFailures?: number }).leadWriteFailures).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('with the flag OFF, a failed write still reaches the model exactly as it did', async () => {
    const { rt } = fakeRt({ leadId: null, phoneMatch: null, insertFails: true });
    await expect(executeCaptureLeadInfo(rt, sameArgs())).rejects.toThrow('Could not save right now');
  });

  it('with no env at all — the eight hand-built fixtures — takes the awaited path', async () => {
    const { rt, updates } = fakeRt({ leadId: 'lead-1' });
    (rt as { env?: unknown }).env = undefined;
    await executeCaptureLeadInfo(rt, sameArgs());
    // Written by the time the tool returned, i.e. the old behaviour, not the new one.
    expect(updates.length).toBeGreaterThan(0);
  });
});
