import { llm } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { leads, scheduledCalls } from '../../../../db/schema/index.js';
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
    env: { GOOGLE_CALENDAR_ID: 'cal@group.calendar.google.com' },
    db,
    makeProvider,
    report: { recordToolCall: vi.fn() },
    lastCheckedDurationMinutes: opts.lastCheckedDurationMinutes ?? 15,
    bookingCompleted: false,
    endReason: null,
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
  it('outbound call: updates the known lead, inserts nothing into leads', async () => {
    const { rt, captured } = fakeRt({ leadId: 'lead-known' });
    await executeBookMeeting(rt, args(), NOW);
    expect(captured.leadUpdates).toHaveLength(1);
    expect(captured.leadUpdates[0]).toMatchObject({ status: 'qualified' });
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
