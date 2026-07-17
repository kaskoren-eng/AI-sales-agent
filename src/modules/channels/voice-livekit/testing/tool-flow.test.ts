import { initializeLogger, voice } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { leads, scheduledCalls } from '../../../../db/schema/index.js';
import type { TimeSlot } from '../../../scheduling/providers/provider.interface.js';
import { buildSystemPrompt } from '../prompts/system-prompt.he.js';
import { buildAgentTools } from '../tools/index.js';
import { isBusinessHours } from '../tools/israel-time.js';
import type { ToolRuntimeContext } from '../tools/tool-context.js';

/**
 * THE SCRIPTED CONVERSATION TEST the phase-4 doc demands: hot lead → check_calendar_availability
 * → book_meeting → end_call, asserted IN ORDER, through the real AgentSession machinery —
 * real Agent, real tool dispatch, real session.run() — with a FakeLLM standing in for GPT so CI
 * is deterministic and free.
 *
 * What this proves that the unit tests cannot: the tools are actually REGISTERED on the agent
 * under the exact names the prompt uses, their Zod schemas parse the args the LLM sends, their
 * results flow back as function_call_output events, and book_meeting's slot_datetime contract
 * ("pass it VERBATIM") survives the full round trip.
 *
 * What it deliberately does NOT prove: that gpt-5.4 chooses to call them. That is what the
 * synthetic-caller scenario (`hot_lead_booking` in scenarios.ts) and the real-phone-call merge
 * gate are for.
 */

initializeLogger({ pretty: false, level: 'silent' });

/** A slot that is always in the future and always inside Sun–Thu 09:00–17:00 Israel time. */
function nextBusinessSlot(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 2);
  for (let i = 0; i < 7; i++) {
    const candidate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 7, 0, 0));
    if (isBusinessHours(candidate.toISOString(), 15)) return candidate.toISOString();
    d.setUTCDate(d.getUTCDate() + 1);
  }
  throw new Error('no business day found in a week — impossible');
}

const SLOT = nextBusinessSlot();
const day = (offset: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

function fakeRuntime() {
  const captured = { callInserts: [] as Record<string, unknown>[], leadInserts: [] as Record<string, unknown>[] };
  const awaitable = (extra: Record<string, unknown> = {}) => {
    const p = Promise.resolve(undefined);
    return { ...extra, then: p.then.bind(p), catch: p.catch.bind(p) };
  };
  const db = {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) })),
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
    insert: vi.fn((table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        if (table === scheduledCalls) captured.callInserts.push(vals);
        if (table === leads) captured.leadInserts.push(vals);
        return awaitable({ returning: async () => [{ id: 'lead-new' }] });
      },
    })),
  };
  const slots: TimeSlot[] = [{ start: SLOT, end: SLOT }];
  const provider = {
    getAvailableSlots: vi.fn(async () => slots),
    createBooking: vi.fn(async (params: { start: string }) => ({
      uid: 'evt-flow-1',
      start: params.start,
      end: params.start,
      status: 'confirmed',
      meetLink: 'https://meet.google.com/xyz',
      inviteSent: true,
    })),
  };
  const rt = {
    tenantId: 'tenant-1',
    leadId: null,
    conversationId: null,
    callId: 'call-flow-1',
    callerPhone: '+972501234567',
    env: { GOOGLE_CALENDAR_ID: 'cal@group.calendar.google.com' },
    db,
    closeDb: async () => undefined,
    makeProvider: vi.fn(() => provider),
    report: { recordToolCall: vi.fn() },
    lastCheckedDurationMinutes: null,
    bookingCompleted: false,
    endReason: null,
  } as unknown as ToolRuntimeContext;
  return { rt, captured, provider };
}

// The exact Hebrew turns of the scripted hot lead, and what the "LLM" does on each.
const TURN_ASK_DEMO = 'יש לי חנות אונליין ואני מפספס לידים, אשמח לקבוע דמו השבוע';
const TURN_PICK_SLOT = 'השעה הראשונה שהצעת מתאימה לי. השם דנה לוי, הטלפון אפס חמש אפס אחת שתיים שלוש ארבע חמש שש שבע, המייל דנה את דוגמה נקודה קום';
const TURN_GOODBYE = 'מעולה, תודה רבה!';

describe('scripted conversation — hot lead books a demo through the REAL tool pipeline', () => {
  let session: voice.AgentSession | undefined;

  afterEach(async () => {
    await session?.close().catch(() => undefined);
    session = undefined;
  });

  it('check_calendar_availability → book_meeting (slot VERBATIM) → end_call, in order', async () => {
    const { rt, captured, provider } = fakeRuntime();

    const llm = new voice.testing.FakeLLM([
      {
        input: TURN_ASK_DEMO,
        toolCalls: [
          {
            name: 'check_calendar_availability',
            args: { from_date: day(1), to_date: day(6), duration_minutes: 15 },
          },
        ],
      },
      {
        input: TURN_PICK_SLOT,
        toolCalls: [
          {
            name: 'book_meeting',
            args: {
              name: 'דנה לוי',
              phone: '0501234567',
              email: 'dana@example.com',
              slot_datetime: SLOT, // the contract: VERBATIM from the check tool's output
              notes: 'חנות אונליין, מפספסת לידים',
            },
          },
        ],
      },
      {
        input: TURN_GOODBYE,
        toolCalls: [{ name: 'end_call', args: { reason: 'meeting_booked' } }],
      },
    ]);

    const agent = new voice.Agent({
      instructions: buildSystemPrompt({ toolsEnabled: true }),
      tools: buildAgentTools(rt),
    });
    session = new voice.AgentSession({ llm });
    await session.start({ agent });

    // ── Turn 1: the hot lead asks for a demo → the agent checks the calendar ────────────────
    const r1 = await session.run({ userInput: TURN_ASK_DEMO }).wait();
    r1.expect.skipNextEventIf({ type: 'message', role: 'user' });
    r1.expect.nextEvent({ type: 'function_call' }).isFunctionCall({ name: 'check_calendar_availability' });
    const checkOutput = r1.events.find(voice.testing.isFunctionCallOutputEvent)!;
    expect(checkOutput.item.isError).toBe(false);
    // The output offers OUR slot with the machine-readable handle the next tool needs.
    expect(checkOutput.item.output).toContain(`[slot_datetime: ${SLOT}]`);
    expect(rt.lastCheckedDurationMinutes).toBe(15);

    // ── Turn 2: details confirmed → book_meeting with the EXACT slot_datetime ───────────────
    const r2 = await session.run({ userInput: TURN_PICK_SLOT }).wait();
    r2.expect.skipNextEventIf({ type: 'message', role: 'user' });
    r2.expect
      .nextEvent({ type: 'function_call' })
      .isFunctionCall({ name: 'book_meeting' });
    const bookOutput = r2.events.find(voice.testing.isFunctionCallOutputEvent)!;
    expect(bookOutput.item.isError).toBe(false);
    expect(provider.createBooking).toHaveBeenCalledWith(expect.objectContaining({ start: SLOT }));
    expect(rt.bookingCompleted).toBe(true);
    expect(captured.callInserts[0]).toMatchObject({
      tenantId: 'tenant-1',
      provider: 'google',
      providerRef: 'evt-flow-1',
      status: 'scheduled',
    });

    // ── Turn 3: goodbye → end_call with the reason analytics will read ──────────────────────
    const r3 = await session.run({ userInput: TURN_GOODBYE }).wait();
    r3.expect.skipNextEventIf({ type: 'message', role: 'user' });
    r3.expect.nextEvent({ type: 'function_call' }).isFunctionCall({ name: 'end_call' });
    expect(rt.endReason).toBe('meeting_booked');
  }, 30_000);

  it('a hallucinated slot_datetime is REJECTED by book_meeting — the error reaches the LLM', async () => {
    const { rt, provider } = fakeRuntime();
    const invented = new Date(new Date(SLOT).getTime() + 7 * 60_000).toISOString(); // 7 min off-grid

    const llm = new voice.testing.FakeLLM([
      {
        input: TURN_PICK_SLOT,
        toolCalls: [
          {
            name: 'book_meeting',
            args: {
              name: 'דנה לוי',
              phone: '0501234567',
              email: 'dana@example.com',
              slot_datetime: invented,
            },
          },
        ],
      },
    ]);

    session = new voice.AgentSession({ llm });
    await session.start({
      agent: new voice.Agent({
        instructions: buildSystemPrompt({ toolsEnabled: true }),
        tools: buildAgentTools(rt),
      }),
    });

    const r = await session.run({ userInput: TURN_PICK_SLOT }).wait();
    const output = r.events.find(voice.testing.isFunctionCallOutputEvent)!;
    expect(output.item.isError).toBe(true);
    expect(provider.createBooking).not.toHaveBeenCalled();
    expect(rt.bookingCompleted).toBe(false);
  }, 30_000);
});
