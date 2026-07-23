import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import type { Database } from '../../../db/client.js';
import { cancelMeetingReminders, reminderJobId } from '../../../queues/meeting-reminders.queue.js';
import { REMINDER_DEFAULTS } from './reminder-settings.js';
import { computeReminderPlan, scheduleReminders } from './reminder-scheduler.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const CONTACT = { phone: '+972501234567', email: 'dana@example.com' };

describe('computeReminderPlan — pure epoch math', () => {
  it('meeting 3 days out, defaults, both channels → 4 entries with exact delays', () => {
    const now = new Date('2026-07-20T10:00:00.000Z');
    const meetingStart = new Date(now.getTime() + 3 * DAY);
    const plan = computeReminderPlan({ now, meetingStart, settings: REMINDER_DEFAULTS, ...CONTACT });

    expect(plan).toHaveLength(4); // (T-24h, T-1h) × (whatsapp, email)
    const t24wa = plan.find((e) => e.offsetMinutes === 1440 && e.channel === 'whatsapp')!;
    expect(t24wa.delayMs).toBe(2 * DAY); // fires exactly 24h before a meeting 72h away
    const t1email = plan.find((e) => e.offsetMinutes === 60 && e.channel === 'email')!;
    expect(t1email.delayMs).toBe(3 * DAY - HOUR);
    expect(new Date(t1email.fireAtIso).getTime()).toBe(meetingStart.getTime() - HOUR);
  });

  it('meeting 20h out → the T-24h pair falls out naturally, only T-1h remains', () => {
    const now = new Date('2026-07-20T10:00:00.000Z');
    const plan = computeReminderPlan({
      now,
      meetingStart: new Date(now.getTime() + 20 * HOUR),
      settings: REMINDER_DEFAULTS,
      ...CONTACT,
    });
    expect(plan.map((e) => e.offsetMinutes)).toEqual([60, 60]);
  });

  it('meeting 40min out → no reminders at all', () => {
    const now = new Date('2026-07-20T10:00:00.000Z');
    const plan = computeReminderPlan({
      now,
      meetingStart: new Date(now.getTime() + 40 * 60_000),
      settings: REMINDER_DEFAULTS,
      ...CONTACT,
    });
    expect(plan).toEqual([]);
  });

  it('DST-crossing booking: T-24h is exactly 86,400,000ms before the meeting instant', () => {
    // Booked during IDT (UTC+3), meeting after Israel falls back to IST (UTC+2) on 2026-10-25.
    // Wall clocks shift an hour in between; the epoch math must not care.
    const now = new Date('2026-10-23T09:00:00.000Z'); // Friday, IDT
    const meetingStart = new Date('2026-10-27T09:00:00.000Z'); // Tuesday 11:00 IST
    const plan = computeReminderPlan({ now, meetingStart, settings: REMINDER_DEFAULTS, ...CONTACT });
    const t24 = plan.find((e) => e.offsetMinutes === 1440 && e.channel === 'whatsapp')!;
    expect(new Date(t24.fireAtIso).getTime()).toBe(meetingStart.getTime() - DAY);
    expect(t24.delayMs).toBe(meetingStart.getTime() - DAY - now.getTime());
  });

  it('no phone → email-only entries; disabled → nothing', () => {
    const now = new Date('2026-07-20T10:00:00.000Z');
    const meetingStart = new Date(now.getTime() + 3 * DAY);
    const noPhone = computeReminderPlan({
      now, meetingStart, settings: REMINDER_DEFAULTS, phone: null, email: CONTACT.email,
    });
    expect(noPhone.every((e) => e.channel === 'email')).toBe(true);
    expect(noPhone).toHaveLength(2);

    const off = computeReminderPlan({
      now, meetingStart, settings: { ...REMINDER_DEFAULTS, enabled: false }, ...CONTACT,
    });
    expect(off).toEqual([]);
  });
});

describe('reminderJobId — deterministic, cancellable by name', () => {
  it('encodes call, offset, channel, and deferral hop', () => {
    expect(reminderJobId('sc-1', 1440, 'whatsapp')).toBe('reminder-sc-1-t1440-wa');
    expect(reminderJobId('sc-1', 60, 'email')).toBe('reminder-sc-1-t60-email');
    expect(reminderJobId('sc-1', 60, 'whatsapp', 1)).toBe('reminder-sc-1-t60-wa-d1');
  });
});

function fakeQueue() {
  const added: { name: string; data: Record<string, unknown>; opts: Record<string, unknown> }[] = [];
  const queue = {
    add: vi.fn(async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      added.push({ name, data, opts });
    }),
    remove: vi.fn(async (id: string) => (id.includes('gone') ? 0 : 1)),
  } as unknown as Queue;
  return { queue, added };
}

function fakeDb() {
  const updates: { set: Record<string, unknown>; where: unknown }[] = [];
  const db = {
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => ({
        where: async (cond: unknown) => {
          updates.push({ set: vals, where: cond });
        },
      }),
    })),
  } as unknown as Database;
  return { db, updates };
}

/** Drizzle where-trees hold circular table refs — same cycle-safe trick as the security tests. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[cycle]';
      seen.add(v);
    }
    return v;
  });
}

describe('scheduleReminders — enqueue + tenant-scoped persistence', () => {
  const params = {
    tenantId: 'tenant-1',
    scheduledCallId: 'sc-42',
    leadId: 'lead-7',
    leadName: 'דנה',
    ...CONTACT,
    meetingStartIso: '2026-07-23T08:00:00.000Z',
    meetLink: 'https://meet.google.com/abc',
    bookingUid: 'evt-1',
    settings: REMINDER_DEFAULTS,
    now: new Date('2026-07-20T10:00:00.000Z'), // meeting ~70h out → full 4-job plan
  };

  it('enqueues each entry with its deterministic jobId + delay, persists jobIds on the row', async () => {
    const { queue, added } = fakeQueue();
    const { db, updates } = fakeDb();

    const result = await scheduleReminders({ queue, db }, params);

    expect(added).toHaveLength(4);
    const ids = added.map((a) => a.opts.jobId);
    expect(ids).toContain('reminder-sc-42-t1440-wa');
    expect(ids).toContain('reminder-sc-42-t60-email');
    for (const a of added) {
      expect(a.opts.attempts).toBe(3);
      expect(a.opts.delay).toBeGreaterThan(0);
      expect(a.data.tenantId).toBe('tenant-1');
      expect(a.data.deferrals).toBe(0);
    }
    const wa = added.find((a) => a.opts.jobId === 'reminder-sc-42-t60-wa')!;
    expect(wa.data.to).toBe(CONTACT.phone);

    expect(result.jobIds).toHaveLength(4);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set.reminders).toEqual(result);
    expect(safeStringify(updates[0]!.where)).toContain('tenant-1'); // tenant isolation, always
  });

  it('empty plan (meeting in 30min) → no enqueue, no DB write, empty jobIds', async () => {
    const { queue, added } = fakeQueue();
    const { db, updates } = fakeDb();
    const result = await scheduleReminders(
      { queue, db },
      { ...params, meetingStartIso: new Date(params.now.getTime() + 30 * 60_000).toISOString() },
    );
    expect(result).toEqual({ jobIds: [] });
    expect(added).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});

describe('cancelMeetingReminders', () => {
  it('removes what it can, counts removals, never throws on missing jobs', async () => {
    const { queue } = fakeQueue();
    const removed = await cancelMeetingReminders(queue, [
      'reminder-sc-42-t1440-wa',
      'reminder-sc-42-gone-t60-email', // already ran → remove returns 0
    ]);
    expect(removed).toBe(1);
  });
});
