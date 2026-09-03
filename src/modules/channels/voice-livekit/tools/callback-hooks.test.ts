import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { leads, scheduledCalls } from '../../../../db/schema/index.js';
import type { TimeSlot } from '../../../scheduling/providers/provider.interface.js';
import type { ToolRuntimeContext } from './tool-context.js';

/**
 * THE CANCELLATION HOOKS (F1.6) — a callback must die the moment it stops making sense.
 *
 * Four events end one, and this file proves that three of them actually fire the cancel (the
 * fourth, the supersede, is pinned in schedule-callback.tool.test.ts):
 *
 *   book_meeting              he just booked; ringing him back to ask when he would like to talk
 *                             is the system contradicting itself out loud
 *   end_call(opt_out)         a queued outbound dial is a contact, and he asked for none
 *   request_human_handoff     he belongs to the human now
 *
 * WHY A MOCK AND NOT A REAL DB. What is under test here is the CALL — that each host reaches the
 * hook at the right moment with the right lead id and a reason that survives on the row. The store
 * itself has its own file (callback-store.test.ts) with a real fake database. Mocking the seam
 * between them means deleting a hook turns exactly one test red, which is the whole point.
 *
 * NOTE ON WHAT THESE HOOKS ARE WORTH. The callback worker re-reads opt-out and future bookings at
 * fire time and refuses on its own, so two of these three are belt-and-braces. The HANDOFF is not:
 * nothing the worker checks records a handoff, so that hook is the only thing that stops an
 * automatic dial landing on a lead the owner is already ringing.
 */

const cancelCallbacksForLead = vi.fn(async () => ({ closed: 0, jobsRemoved: 0 }));
vi.mock('./callback-store.js', () => ({
  cancelCallbacksForLead: (...a: unknown[]) => cancelCallbacksForLead(...(a as [])),
  closePendingCallbacks: vi.fn(async () => ({ closed: 0, jobsRemoved: 0 })),
}));

const { executeBookMeeting } = await import('./book-meeting.tool.js');
const { markLeadOptedOut } = await import('./end-call.tool.js');
const { requestHumanHandoffTool } = await import('./request-human-handoff.tool.js');

beforeEach(() => cancelCallbacksForLead.mockClear());

/** The note each host writes onto the row, so the reason a callback stopped is readable later. */
const noteOf = (call: unknown[]): string => call[2] as string;
const leadOf = (call: unknown[]): unknown => call[1];

// ─────────────────────────────────────────────────────────────────────────────
// 1. book_meeting
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-07-16T08:00:00.000Z');
const SLOT = '2026-07-19T07:00:00.000Z';
const mk = (start: string): TimeSlot => ({ start, end: start });

function bookingRt(opts: { available?: TimeSlot[] } = {}) {
  const getAvailableSlots = vi.fn(async () => opts.available ?? [mk(SLOT)]);
  const createBooking = vi.fn(async (p: { start: string }) => ({
    uid: 'evt-1',
    start: p.start,
    end: p.start,
    status: 'confirmed',
    inviteSent: true,
  }));
  const db = {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) })),
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
    insert: vi.fn((table: unknown) => ({
      values: () => {
        const p = Promise.resolve(undefined);
        return {
          then: p.then.bind(p),
          catch: p.catch.bind(p),
          returning: async () => [{ id: table === scheduledCalls ? 'call-1' : 'lead-new' }],
        };
      },
    })),
  };
  return {
    rt: {
      tenantId: 'tenant-1',
      leadId: null,
      conversationId: null,
      callId: 'call-1',
      callerPhone: null,
      env: { GOOGLE_CALENDAR_ID: 'cal@x', VOICE_BOOK_WITHOUT_EMAIL: true },
      db,
      makeProvider: vi.fn(() => ({ getAvailableSlots, createBooking })),
      report: { recordToolCall: vi.fn() },
      lastCheckedDurationMinutes: 15,
      bookingCompleted: false,
      endReason: null,
      callbacksQueue: { remove: vi.fn() },
    } as unknown as ToolRuntimeContext,
    createBooking,
  };
}

const bookArgs = {
  name: 'דנה לוי',
  phone: '050-1234567',
  email: 'dana@example.com',
  slot_datetime: SLOT,
  notes: null,
};

describe('book_meeting cancels the callback', () => {
  it('a lead who just booked is not rung back', async () => {
    const { rt } = bookingRt();
    await executeBookMeeting(rt, bookArgs, NOW);

    expect(cancelCallbacksForLead).toHaveBeenCalledTimes(1);
    // The id from book_meeting's OWN upsert, not the (null) one the call started with.
    expect(leadOf(cancelCallbacksForLead.mock.calls[0]!)).toBe('lead-new');
    expect(noteOf(cancelCallbacksForLead.mock.calls[0]!)).toBe('cancelled:meeting_booked');
  });

  it('a booking that never happened cancels nothing', async () => {
    // The slot is gone, so book_meeting throws before the event exists. Cancelling a callback for
    // a booking that then failed would lose both — which is why the hook sits after the invariants.
    const { rt, createBooking } = bookingRt({ available: [] });
    await expect(executeBookMeeting(rt, bookArgs, NOW)).rejects.toThrow();
    expect(createBooking).not.toHaveBeenCalled();
    expect(cancelCallbacksForLead).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. end_call(opt_out)
// ─────────────────────────────────────────────────────────────────────────────

function optOutRt(opts: { leadId?: string | null; phoneMatch?: string | null; callerPhone?: string } = {}) {
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: async () => (opts.phoneMatch ? [{ id: opts.phoneMatch }] : []) }),
      }),
    })),
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
    insert: vi.fn(() => ({ values: async () => undefined })),
  };
  return {
    tenantId: 'tenant-1',
    leadId: opts.leadId ?? null,
    callId: 'call-1',
    callerPhone: opts.callerPhone ?? null,
    db,
    callbacksQueue: { remove: vi.fn() },
  } as unknown as ToolRuntimeContext;
}

describe('opt-out cancels the callback', () => {
  it('a known lead who says "take me off your list" loses his queued dial', async () => {
    const rt = optOutRt({ leadId: 'lead-1' });
    expect(await markLeadOptedOut(rt)).toBe('lead_updated');
    expect(cancelCallbacksForLead).toHaveBeenCalledTimes(1);
    expect(leadOf(cancelCallbacksForLead.mock.calls[0]!)).toBe('lead-1');
    expect(noteOf(cancelCallbacksForLead.mock.calls[0]!)).toBe('cancelled:opted_out');
  });

  it('so does an inbound caller matched only by his phone number', async () => {
    const rt = optOutRt({ leadId: null, callerPhone: '+972501234567', phoneMatch: 'lead-by-phone' });
    expect(await markLeadOptedOut(rt)).toBe('lead_updated');
    expect(leadOf(cancelCallbacksForLead.mock.calls[0]!)).toBe('lead-by-phone');
  });

  it('a lead created BY the opt-out has nothing to cancel — it did not exist a moment ago', async () => {
    const rt = optOutRt({ leadId: null, callerPhone: '+972501234567', phoneMatch: null });
    expect(await markLeadOptedOut(rt)).toBe('lead_created');
    expect(cancelCallbacksForLead).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. request_human_handoff — the one hook the worker does NOT back up
// ─────────────────────────────────────────────────────────────────────────────

function handoffRt() {
  const db = {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) })),
    update: vi.fn(() => ({
      set: () => ({
        where: () =>
          Object.assign(Promise.resolve([{ id: 'lead-1', name: 'דנה', phone: '+972500000000' }]), {
            returning: async () => [{ id: 'lead-1', name: 'דנה', phone: '+972500000000' }],
          }),
      }),
    })),
    insert: vi.fn(() => ({ values: () => ({ returning: async () => [{ id: 'lead-new' }] }) })),
  };
  return {
    tenantId: 'tenant-1',
    leadId: 'lead-1',
    conversationId: null,
    callId: 'call-1',
    callerPhone: null,
    db,
    report: {
      recordToolCall: vi.fn(),
      recordCompliance: vi.fn(),
      markEndDisclosureRequested: vi.fn(),
      someAgentLine: () => true,
    },
    env: {},
    settings: {},
    outboundQueue: null,
    callbacksQueue: { remove: vi.fn() },
    handoffRequested: false,
    endReason: null,
  } as unknown as ToolRuntimeContext;
}

describe('request_human_handoff cancels the callback', () => {
  it('a lead handed to a human is not also rung by the machine', async () => {
    const rt = handoffRt();
    const session = new EventEmitter() as EventEmitter & { shutdown: () => void };
    session.shutdown = vi.fn();
    const ctx = { session, speechHandle: { addDoneCallback: vi.fn() } } as never;

    await requestHumanHandoffTool(rt).execute({ reason: 'רוצה מנהל' } as never, {
      ctx,
      toolCallId: 'tc-1',
      abortSignal: new AbortController().signal,
    } as never);

    expect(cancelCallbacksForLead).toHaveBeenCalledTimes(1);
    expect(leadOf(cancelCallbacksForLead.mock.calls[0]!)).toBe('lead-1');
    expect(noteOf(cancelCallbacksForLead.mock.calls[0]!)).toBe('cancelled:handoff_requested');
  });

  it('a repeat handoff on the same call does not cancel twice — the latch holds', async () => {
    const rt = handoffRt();
    const session = new EventEmitter() as EventEmitter & { shutdown: () => void };
    session.shutdown = vi.fn();
    const ctx = { session, speechHandle: { addDoneCallback: vi.fn() } } as never;
    const opts = { ctx, toolCallId: 'tc-1', abortSignal: new AbortController().signal } as never;

    await requestHumanHandoffTool(rt).execute({ reason: 'רוצה מנהל' } as never, opts);
    await requestHumanHandoffTool(rt).execute({ reason: 'רוצה מנהל' } as never, opts);
    expect(cancelCallbacksForLead).toHaveBeenCalledTimes(1);
  });
});

// A guard against the mock quietly diverging from the real module's exports.
describe('the mocked seam', () => {
  it('matches the real module', async () => {
    const real = await vi.importActual<typeof import('./callback-store.js')>('./callback-store.js');
    expect(typeof real.cancelCallbacksForLead).toBe('function');
    expect(typeof real.closePendingCallbacks).toBe('function');
  });
});

// `leads` is imported for its identity in the fakes above; referencing it keeps the import honest.
void leads;
