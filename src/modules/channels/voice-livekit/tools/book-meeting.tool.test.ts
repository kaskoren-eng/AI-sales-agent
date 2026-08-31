import { llm } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { leads, scheduledCalls } from '../../../../db/schema/index.js';
import { CallStateMachine } from '../call-state.js';
import type { TimeSlot } from '../../../scheduling/providers/provider.interface.js';
import {
  executeBookMeeting,
  normalizeEmail,
  phoneSuffix,
  type BookMeetingArgs,
} from './book-meeting.tool.js';
import type { ToolRuntimeContext } from './tool-context.js';

/** Thursday morning, Israel summer. The lead picked Sunday 10:00 Israel = 07:00Z. */
const NOW = new Date('2026-07-16T08:00:00.000Z');
const SLOT = '2026-07-19T07:00:00.000Z';

const mk = (start: string): TimeSlot => ({ start, end: start });

interface DbCapture {
  leadInserts: Record<string, unknown>[];
  leadUpdates: Record<string, unknown>[];
  callInserts: Record<string, unknown>[];
}

function fakeDb(opts: { phoneMatch?: string | null; failWrites?: boolean } = {}) {
  const captured: DbCapture = { leadInserts: [], leadUpdates: [], callInserts: [] };

  const awaitable = (extra: Record<string, unknown> = {}) => {
    const p = opts.failWrites ? Promise.reject(new Error('db down')) : Promise.resolve(undefined);
    p.catch(() => undefined); // keep the base promise from ever being "unhandled"
    return {
      ...extra,
      then: p.then.bind(p),
      catch: p.catch.bind(p),
    };
  };

  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (opts.failWrites) throw new Error('db down');
            return opts.phoneMatch ? [{ id: opts.phoneMatch }] : [];
          },
        }),
      }),
    })),
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => {
        captured.leadUpdates.push(vals);
        return { where: async () => (opts.failWrites ? Promise.reject(new Error('db down')) : undefined) };
      },
    })),
    insert: vi.fn((table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        if (table === leads) captured.leadInserts.push(vals);
        if (table === scheduledCalls) captured.callInserts.push(vals);
        return awaitable({
          returning: async () => {
            if (opts.failWrites) throw new Error('db down');
            return [{ id: 'lead-new' }];
          },
        });
      },
    })),
  };
  return { db, captured };
}

function fakeRt(opts: {
  available?: TimeSlot[];
  leadId?: string | null;
  phoneMatch?: string | null;
  failWrites?: boolean;
  lastCheckedDurationMinutes?: number | null;
  inviteSent?: boolean;
  callState?: CallStateMachine;
  /** VOICE_BOOK_WITHOUT_EMAIL. Production default is true. */
  bookWithoutEmail?: boolean;
} = {}) {
  const getAvailableSlots = vi.fn(async () => opts.available ?? [mk(SLOT)]);
  const createBooking = vi.fn(async (params: { start: string }) => ({
    uid: 'evt-123',
    start: params.start,
    end: params.start,
    status: 'confirmed',
    meetLink: 'https://meet.google.com/abc',
    inviteSent: opts.inviteSent ?? true,
  }));
  const makeProvider = vi.fn(() => ({ getAvailableSlots, createBooking }));
  const { db, captured } = fakeDb(opts);

  const rt = {
    tenantId: 'tenant-1',
    leadId: opts.leadId ?? null,
    conversationId: null,
    callId: 'call-1',
    callerPhone: null,
    env: {
      GOOGLE_CALENDAR_ID: 'cal@group.calendar.google.com',
      VOICE_BOOK_WITHOUT_EMAIL: opts.bookWithoutEmail ?? true,
    },
    db,
    makeProvider,
    report: { recordToolCall: vi.fn() },
    lastCheckedDurationMinutes: opts.lastCheckedDurationMinutes ?? 15,
    bookingCompleted: false,
    endReason: null,
    callState: opts.callState,
  } as unknown as ToolRuntimeContext;

  return { rt, makeProvider, getAvailableSlots, createBooking, captured };
}

const args = (over: Partial<BookMeetingArgs> = {}): BookMeetingArgs => ({
  name: 'דנה לוי',
  phone: '050-1234567',
  email: 'dana@example.com',
  slot_datetime: SLOT,
  notes: 'חנות אונליין, מחפשת אוטומציה',
  ...over,
});

describe('executeBookMeeting — happy path', () => {
  it('re-checks on the offered grid, books on the meeting duration, persists provider=google', async () => {
    const { rt, makeProvider, createBooking, captured } = fakeRt();
    const out = await executeBookMeeting(rt, args(), NOW);

    // Grid re-check first (15+15=30), then the event itself at plain 15.
    expect(makeProvider).toHaveBeenNthCalledWith(1, 30);
    expect(makeProvider).toHaveBeenNthCalledWith(2, 15);
    expect(createBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        start: SLOT,
        attendee: expect.objectContaining({ email: 'dana@example.com', timezone: 'Asia/Jerusalem' }),
      }),
    );

    // The scheduled_calls row fixes the legacy route's provider bug and carries the duration.
    expect(captured.callInserts[0]).toMatchObject({
      tenantId: 'tenant-1',
      provider: 'google',
      providerRef: 'evt-123',
      duration: 15,
      status: 'scheduled',
      attendees: [expect.objectContaining({ email: 'dana@example.com' })],
    });

    expect(rt.bookingCompleted).toBe(true);
    expect(out).toContain('יום ראשון, 19 ביולי, בשעה 10:00');
    expect(out).toContain('end_call');
  });

  it('books on the grid the lead was actually offered (30-min meeting → 45-min blocks)', async () => {
    const { rt, makeProvider } = fakeRt({ lastCheckedDurationMinutes: 30 });
    await executeBookMeeting(rt, args(), NOW);
    expect(makeProvider).toHaveBeenNthCalledWith(1, 45);
    expect(makeProvider).toHaveBeenNthCalledWith(2, 30);
  });
});

describe('executeBookMeeting — the re-check kills races and hallucinations', () => {
  it('rejects a taken slot and offers the two nearest real alternatives', async () => {
    const { rt, createBooking } = fakeRt({
      available: [mk('2026-07-19T08:00:00.000Z'), mk('2026-07-19T09:00:00.000Z'), mk('2026-07-19T10:00:00.000Z')],
    });
    const err = await executeBookMeeting(rt, args(), NOW).catch((e: Error) => e);
    expect(err).toBeInstanceOf(llm.ToolError);
    expect((err as Error).message).toContain('[slot_datetime: 2026-07-19T08:00:00.000Z]');
    expect((err as Error).message).toContain('[slot_datetime: 2026-07-19T09:00:00.000Z]');
    expect((err as Error).message).not.toContain('10:00:00.000Z]'); // two alternatives, not three
    expect(createBooking).not.toHaveBeenCalled();
    expect(rt.bookingCompleted).toBe(false);
  });

  it('an invented slot_datetime is never free — same rejection path', async () => {
    const { rt, createBooking } = fakeRt({ available: [mk(SLOT)] });
    await expect(
      executeBookMeeting(rt, args({ slot_datetime: '2026-07-19T07:07:00.000Z' }), NOW),
    ).rejects.toThrowError(llm.ToolError);
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('a fully-booked day says so and points back to check_calendar_availability', async () => {
    const { rt } = fakeRt({ available: [] });
    await expect(executeBookMeeting(rt, args(), NOW)).rejects.toThrow('check_calendar_availability');
  });
});

describe('executeBookMeeting — argument validation', () => {
  it('rejects a nonsense email with a retryable instruction', async () => {
    const { rt } = fakeRt();
    await expect(executeBookMeeting(rt, args({ email: 'not an email' }), NOW)).rejects.toThrowError(
      llm.ToolError,
    );
  });

  it('normalizes an STT-style email ("dana at example dot com")', async () => {
    const { rt, createBooking } = fakeRt();
    await executeBookMeeting(rt, args({ email: 'Dana at example dot com' }), NOW);
    expect(createBooking).toHaveBeenCalledWith(
      expect.objectContaining({ attendee: expect.objectContaining({ email: 'dana@example.com' }) }),
    );
  });

  it('rejects a past slot_datetime', async () => {
    const { rt } = fakeRt();
    await expect(
      executeBookMeeting(rt, args({ slot_datetime: '2026-07-01T07:00:00.000Z' }), NOW),
    ).rejects.toThrowError(llm.ToolError);
  });
});

describe('executeBookMeeting — lead identity, always tenant-scoped', () => {
  it('outbound call: updates the known lead (backfill + verbal consent), inserts nothing', async () => {
    const { rt, captured } = fakeRt({ leadId: 'lead-known' });
    await executeBookMeeting(rt, args(), NOW);
    // Two updates: the contact backfill (status: qualified) and the verbal WhatsApp consent —
    // he just confirmed his number for confirmations on a recorded call.
    expect(captured.leadUpdates).toHaveLength(2);
    expect(captured.leadUpdates[0]).toMatchObject({ status: 'qualified' });
    expect(captured.leadUpdates[1]).toHaveProperty('whatsappConsent');
    expect(captured.leadInserts).toHaveLength(0);
    expect(captured.callInserts[0]).toMatchObject({ leadId: 'lead-known' });
  });

  it('inbound with a phone match: reuses the existing lead', async () => {
    const { rt, captured } = fakeRt({ phoneMatch: 'lead-existing' });
    await executeBookMeeting(rt, args(), NOW);
    expect(captured.leadInserts).toHaveLength(0);
    expect(captured.callInserts[0]).toMatchObject({ leadId: 'lead-existing' });
  });

  it('inbound stranger: creates a qualified voice-livekit lead', async () => {
    const { rt, captured } = fakeRt({ phoneMatch: null });
    await executeBookMeeting(rt, args(), NOW);
    expect(captured.leadInserts[0]).toMatchObject({
      tenantId: 'tenant-1',
      source: 'voice-livekit',
      status: 'qualified',
      email: 'dana@example.com',
    });
    expect(captured.callInserts[0]).toMatchObject({ leadId: 'lead-new' });
  });
});

describe('executeBookMeeting — she never claims an email that was not sent', () => {
  it('inviteSent=true → the confirmation mentions the emailed invite', async () => {
    const { rt } = fakeRt({ inviteSent: true });
    const out = await executeBookMeeting(rt, args(), NOW);
    expect(out).toContain('emailed to dana@example.com');
    expect(out).toContain('an invite was sent');
  });

  it('inviteSent=false (service-account 403 fallback) → "team will email details", no invite claim', async () => {
    const { rt } = fakeRt({ inviteSent: false });
    const out = await executeBookMeeting(rt, args(), NOW);
    expect(out).toContain('NO email invite was sent');
    expect(out).toContain('do NOT claim an invite was already sent');
    expect(out).not.toContain('an invite was sent to their email');
    expect(rt.bookingCompleted).toBe(true); // the MEETING is still real
  });
});

describe('executeBookMeeting — calendar beats database', () => {
  it('a DB failure AFTER the event exists still returns success — the meeting is real', async () => {
    const { rt, createBooking } = fakeRt({ failWrites: true });
    const out = await executeBookMeeting(rt, args(), NOW);
    expect(createBooking).toHaveBeenCalled();
    expect(rt.bookingCompleted).toBe(true);
    expect(out).toContain('Meeting booked');
    expect(out).toContain('end_call');
  });
});

describe('executeBookMeeting — meeting reminders hook (C1)', () => {
  const attachQueue = (rt: ToolRuntimeContext, impl?: () => Promise<void>) => {
    const added: { data: Record<string, unknown>; opts: Record<string, unknown> }[] = [];
    (rt as { remindersQueue: unknown }).remindersQueue = {
      add: vi.fn(async (_name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
        if (impl) await impl();
        added.push({ data, opts });
      }),
    };
    return added;
  };

  it('booking ~71h out → 4 delayed jobs (T-24h + T-1h × wa/email) keyed to the scheduled_calls row, jobIds persisted', async () => {
    const { rt, captured } = fakeRt();
    const added = attachQueue(rt);
    await executeBookMeeting(rt, args(), NOW);

    expect(added).toHaveLength(4);
    // The insert mock returns id 'lead-new' for every .returning() — so that's the row id here.
    const ids = added.map((a) => a.opts.jobId);
    expect(ids).toContain('reminder-lead-new-t1440-wa');
    expect(ids).toContain('reminder-lead-new-t60-email');
    expect(added.every((a) => a.data.tenantId === 'tenant-1')).toBe(true);
    // jobIds land on the row so the cancel endpoint can find them.
    const persisted = captured.leadUpdates.find((u) => 'reminders' in u) as
      | { reminders: { jobIds: string[] } }
      | undefined;
    expect(persisted?.reminders.jobIds).toHaveLength(4);
  });

  it('reminder scheduling failure NEVER fails the booking (invariant 2 extends to reminders)', async () => {
    const { rt } = fakeRt();
    attachQueue(rt, async () => {
      throw new Error('redis down');
    });
    const out = await executeBookMeeting(rt, args(), NOW);
    expect(out).toContain('Meeting booked');
    expect(rt.bookingCompleted).toBe(true);
  });

  it('no remindersQueue (Redis was down at call start) → booking proceeds, hook silently skipped', async () => {
    const { rt } = fakeRt(); // fakeRt sets no remindersQueue
    const out = await executeBookMeeting(rt, args(), NOW);
    expect(out).toContain('Meeting booked');
  });
});

describe('executeBookMeeting — state-machine guardrails', () => {
  /** A machine advanced into scheduling — the normal state when Keren books. */
  function schedulingMachine(): CallStateMachine {
    const m = new CallStateMachine();
    m.onUserTurn(); // opening → discovery
    m.onToolCall('check_calendar_availability', true); // → scheduling
    return m;
  }

  it('refuses to book straight out of the greeting (stage=opening — an injection, not a lead)', async () => {
    const { rt, createBooking } = fakeRt({ callState: new CallStateMachine() }); // fresh = opening
    await expect(executeBookMeeting(rt, args(), NOW)).rejects.toThrow(/too early/i);
    expect(createBooking).not.toHaveBeenCalled();
    expect(rt.bookingCompleted).toBe(false);
  });

  it('refuses a SECOND booking on the same call (one meeting per call)', async () => {
    const { rt, createBooking } = fakeRt({ callState: schedulingMachine() });
    rt.bookingCompleted = true; // a booking already happened
    await expect(executeBookMeeting(rt, args(), NOW)).rejects.toThrow(/already booked/i);
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('advances the machine to closing on a successful booking', async () => {
    const cs = schedulingMachine();
    const { rt } = fakeRt({ callState: cs });
    await executeBookMeeting(rt, args(), NOW);
    expect(rt.bookingCompleted).toBe(true);
    expect(cs.stage).toBe('closing');
  });
});

describe('helpers', () => {
  it('normalizeEmail handles case, spaces, and spoken at/dot', () => {
    expect(normalizeEmail('  Dana@Example.COM ')).toBe('dana@example.com');
    expect(normalizeEmail('dana at example dot com')).toBe('dana@example.com');
    expect(normalizeEmail('no-at-sign.com')).toBeNull();
    expect(normalizeEmail('two@@example.com')).toBeNull();
    expect(normalizeEmail('dana@nodot')).toBeNull();
  });

  it('phoneSuffix matches Israeli numbers across formats', () => {
    expect(phoneSuffix('+972-50-123-4567')).toBe('501234567');
    expect(phoneSuffix('0501234567')).toBe('501234567');
  });
});

/**
 * THE MEETING IS WORTH MORE THAN THE FIELD.
 *
 * 2026-08-31 production call: the demo was agreed at 450s and the call ended at 602s with NO
 * booking, having spent its last 54 seconds failing to transfer one email address over an 8kHz
 * line. `book_meeting` was never called — the schema required a valid email, so "keep the meeting,
 * drop the field" was not a move the agent could make. These tests pin the exit.
 */
describe('executeBookMeeting — booking WITHOUT an email (VOICE_BOOK_WITHOUT_EMAIL)', () => {
  it('books on an explicit null, with no attendee email and no invite claimed', async () => {
    const { rt, createBooking, captured } = fakeRt();
    const out = await executeBookMeeting(rt, args({ email: null }), NOW);

    expect(createBooking).toHaveBeenCalledWith(
      expect.objectContaining({ attendee: expect.objectContaining({ email: undefined }) }),
    );
    expect(rt.bookingCompleted).toBe(true);
    expect(rt.lastBooking?.email).toBeNull();
    // inviteSent must be false even though the fake provider reports true: there is no address.
    expect(rt.lastBooking?.inviteSent).toBe(false);

    // The lead is still saved, against the phone number.
    expect(captured.leadInserts[0]).toMatchObject({ phone: '050-1234567' });
    expect(captured.leadInserts[0]!.email).toBeUndefined();
    expect(captured.callInserts[0]).toMatchObject({ providerRef: 'evt-123' });

    // And she is told to close, not to go back for the address.
    expect(out).toContain('WITHOUT an email address');
    expect(out).toMatch(/do NOT ask for his email again/u);
    expect(out).toContain('end_call');
  });

  it('omits an email address from the result — there is none to read out', async () => {
    const { rt } = fakeRt();
    const out = await executeBookMeeting(rt, args({ email: null }), NOW);
    expect(out).not.toMatch(/emailed to/u);
    expect(out).not.toMatch(/send_email_confirmation/u);
  });

  it('an email that is PRESENT but unparseable still fails — a guess is the original defect', async () => {
    const { rt } = fakeRt();
    await expect(executeBookMeeting(rt, args({ email: 'nope' }), NOW)).rejects.toThrow(llm.ToolError);
    expect(rt.bookingCompleted).toBe(false);
  });

  it('and that failure names the exit, because the old error text WAS the doomed retry loop', async () => {
    const { rt } = fakeRt();
    const err = await executeBookMeeting(rt, args({ email: 'nope' }), NOW).catch((e: unknown) => e as Error) as Error;
    expect(err.message).toMatch(/email set to null/u);
    expect(err.message).toMatch(/twice/u);
  });

  it('KILL-SWITCH off: a null email throws, so the prompt and the tool can never disagree', async () => {
    const { rt } = fakeRt({ bookWithoutEmail: false });
    const err = await executeBookMeeting(rt, args({ email: null }), NOW).catch((e: unknown) => e as Error) as Error;
    expect(err).toBeInstanceOf(llm.ToolError);
    // The old wording, with no mention of an exit that no longer exists.
    expect(err.message).not.toMatch(/set to null/u);
    expect(rt.bookingCompleted).toBe(false);
  });

  it('an omitted email is the same as an explicit null', async () => {
    const { rt } = fakeRt();
    const { email: _dropped, ...rest } = args();
    await executeBookMeeting(rt, rest as BookMeetingArgs, NOW);
    expect(rt.lastBooking?.email).toBeNull();
  });

  it('still refuses a SECOND meeting on the same call', async () => {
    const { rt } = fakeRt();
    await executeBookMeeting(rt, args({ email: null }), NOW);
    await expect(executeBookMeeting(rt, args({ email: null }), NOW)).rejects.toThrow(llm.ToolError);
  });
});
