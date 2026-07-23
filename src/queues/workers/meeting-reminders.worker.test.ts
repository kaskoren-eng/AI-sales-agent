import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Database } from '../../db/client.js';
import { leads, scheduledCalls, tenants } from '../../db/schema/index.js';
import type { MeetingReminderJob } from '../meeting-reminders.queue.js';
import { processMeetingReminder, type MeetingRemindersDeps } from './meeting-reminders.worker.js';

/**
 * All instants are pinned. Israel is UTC+3 (IDT) in July, UTC+2 (IST) in December.
 * Default quiet hours 21:00–08:00 Israel.
 */

const HOUR = 3_600_000;

interface DbState {
  call?: { status: string; reminders?: { jobIds: string[]; plannedAt?: string[] } | null } | null;
  lead?: { status: string; lastInboundWhatsappAt: Date | null; whatsappConsent?: { granted: boolean } | null } | null;
  settings?: unknown;
}

function fakeDb(state: DbState) {
  const updates: { set: Record<string, unknown> }[] = [];
  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === scheduledCalls) return state.call ? [{ reminders: null, ...state.call }] : [];
            if (table === leads) return state.lead ? [{ whatsappConsent: null, ...state.lead }] : [];
            if (table === tenants) return [{ settings: state.settings ?? {} }];
            return [];
          },
        }),
      }),
    })),
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ set: vals });
        },
      }),
    })),
  } as unknown as Database;
  return { db, updates };
}

function makeDeps(state: DbState, now: Date) {
  const { db, updates } = fakeDb(state);
  const added: { data: MeetingReminderJob; opts: Record<string, unknown> }[] = [];
  const remindersQueue = {
    add: vi.fn(async (_n: string, data: MeetingReminderJob, opts: Record<string, unknown>) => {
      added.push({ data, opts });
    }),
  } as unknown as Queue;
  const whatsapp = {
    supportsTemplates: true,
    sendMessage: vi.fn(async (_to: string, _body: string) => undefined),
    sendTemplate: vi.fn(async (_to: string, _sid: string, _vars: Record<string, string>) => undefined),
  };
  const email = { sendEmail: vi.fn(async (_to: string, _subject: string, _body: string) => undefined) };
  const deps = {
    db,
    redis: {} as Redis,
    deadLetterQueue: {} as Queue,
    remindersQueue,
    whatsapp,
    email,
    now: () => now,
  } as unknown as MeetingRemindersDeps;
  return { deps, updates, added, whatsapp, email };
}

const job = (over: Partial<MeetingReminderJob> = {}): MeetingReminderJob => ({
  tenantId: 'tenant-1',
  scheduledCallId: 'sc-1',
  leadId: 'lead-1',
  channel: 'whatsapp',
  offsetMinutes: 60,
  to: '+972501234567',
  leadName: 'דנה',
  meetingStartIso: '2026-07-22T08:00:00.000Z', // 11:00 IDT
  meetLink: 'https://meet.google.com/abc',
  deferrals: 0,
  ...over,
});

const SCHEDULED = { status: 'scheduled' };
const LEAD_IN_WINDOW = (now: Date) => ({
  status: 'qualified',
  lastInboundWhatsappAt: new Date(now.getTime() - HOUR),
});

describe('processMeetingReminder — fire-time authority checks', () => {
  const NOON = new Date('2026-07-22T07:00:00.000Z'); // 10:00 IDT, T-1h before an 11:00 meeting

  it('cancelled meeting (row status changed) → skipped, nothing sent — the cancellation backstop', async () => {
    const { deps, whatsapp, email } = makeDeps({ call: { status: 'cancelled' }, lead: LEAD_IN_WINDOW(NOON) }, NOON);
    const out = await processMeetingReminder(deps, job());
    expect(out).toEqual({ outcome: 'skipped', detail: 'not_scheduled' });
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it('row gone entirely → skipped', async () => {
    const { deps } = makeDeps({ call: null }, NOON);
    expect((await processMeetingReminder(deps, job())).detail).toBe('not_scheduled');
  });

  it('meeting already started → dropped', async () => {
    const late = new Date('2026-07-22T08:30:00.000Z');
    const { deps, whatsapp } = makeDeps({ call: SCHEDULED, lead: LEAD_IN_WINDOW(late) }, late);
    expect((await processMeetingReminder(deps, job())).detail).toBe('past_meeting');
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  it('opted-out lead is NEVER messaged — unconditional, before any channel logic', async () => {
    const { deps, whatsapp, email } = makeDeps(
      { call: SCHEDULED, lead: { status: 'opted_out', lastInboundWhatsappAt: new Date(NOON.getTime() - HOUR) } },
      NOON,
    );
    expect((await processMeetingReminder(deps, job())).detail).toBe('opted_out');
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it('tenant disabled reminders since booking → respected at fire time', async () => {
    const { deps } = makeDeps(
      { call: SCHEDULED, lead: LEAD_IN_WINDOW(NOON), settings: { reminders: { enabled: false } } },
      NOON,
    );
    expect((await processMeetingReminder(deps, job())).detail).toBe('disabled');
  });
});

describe('processMeetingReminder — delivery per channel', () => {
  const NOON = new Date('2026-07-22T07:00:00.000Z');

  it('email: sends with Hebrew subject + body carrying the reply hook', async () => {
    const { deps, email } = makeDeps({ call: SCHEDULED, lead: LEAD_IN_WINDOW(NOON) }, NOON);
    const out = await processMeetingReminder(deps, job({ channel: 'email', to: 'dana@example.com' }));
    expect(out.outcome).toBe('sent');
    const [to, subject, body] = email.sendEmail.mock.calls[0]!;
    expect(to).toBe('dana@example.com');
    expect(subject).toContain('שעה'); // T-1h subject
    expect(body).toContain('תענה לי כאן');
  });

  it('whatsapp in-window (lead messaged us 1h ago) → FREEFORM body', async () => {
    const { deps, whatsapp } = makeDeps({ call: SCHEDULED, lead: LEAD_IN_WINDOW(NOON) }, NOON);
    const out = await processMeetingReminder(deps, job());
    expect(out.outcome).toBe('sent');
    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(whatsapp.sendMessage.mock.calls[0]![1]).toContain('דנה');
  });

  it('whatsapp out-of-window + consent + configured SID → TEMPLATE with interpolated variables', async () => {
    const { deps, whatsapp } = makeDeps(
      {
        call: SCHEDULED,
        lead: { status: 'qualified', lastInboundWhatsappAt: null, whatsappConsent: { granted: true } },
        settings: { whatsapp_templates: { reminder_t24: { contentSid: 'HX_T24' } } },
      },
      NOON,
    );
    const out = await processMeetingReminder(deps, job({ offsetMinutes: 1440 }));
    expect(out.outcome).toBe('sent');
    const [to, sid, vars] = whatsapp.sendTemplate.mock.calls[0]!;
    expect(to).toBe('+972501234567');
    expect(sid).toBe('HX_T24');
    expect(vars['1']).toBe('דנה');
    expect(vars['3']).toBe('https://meet.google.com/abc');
  });

  it('whatsapp out-of-window WITHOUT consent → blocked, logged outcome, nothing sent', async () => {
    const { deps, whatsapp } = makeDeps(
      {
        call: SCHEDULED,
        lead: { status: 'qualified', lastInboundWhatsappAt: null, whatsappConsent: null },
        settings: { whatsapp_templates: { reminder_t1: { contentSid: 'HX_T1' } } },
      },
      NOON,
    );
    const out = await processMeetingReminder(deps, job());
    expect(out).toEqual({ outcome: 'skipped', detail: 'no_consent' });
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  });
});

describe('processMeetingReminder — quiet hours (Israel wall clock, DST-pinned)', () => {
  it('IDT: fires at 22:00 Israel → deferred to next 08:00 (10h), -d1 id recorded on the row', async () => {
    const now = new Date('2026-07-20T19:00:00.000Z'); // 22:00 IDT
    const { deps, added, updates, whatsapp } = makeDeps(
      { call: { status: 'scheduled', reminders: { jobIds: ['reminder-sc-1-t1440-wa'] } }, lead: LEAD_IN_WINDOW(now) },
      now,
    );
    const out = await processMeetingReminder(
      deps,
      job({ offsetMinutes: 1440, meetingStartIso: '2026-07-21T19:00:00.000Z' }),
    );
    expect(out.outcome).toBe('deferred');
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
    expect(added).toHaveLength(1);
    expect(added[0]!.opts.jobId).toBe('reminder-sc-1-t1440-wa-d1');
    expect(added[0]!.opts.delay).toBe(10 * HOUR); // 22:00 → 08:00 IDT
    expect(added[0]!.data.deferrals).toBe(1);
    const persisted = updates[0]!.set.reminders as { jobIds: string[] };
    expect(persisted.jobIds).toEqual(['reminder-sc-1-t1440-wa', 'reminder-sc-1-t1440-wa-d1']);
  });

  it('IST (winter): 22:00 Israel is a different UTC hour, deferral is still exactly 10h of wall clock', async () => {
    const now = new Date('2026-12-15T20:00:00.000Z'); // 22:00 IST
    const { deps, added } = makeDeps({ call: SCHEDULED, lead: LEAD_IN_WINDOW(now) }, now);
    const out = await processMeetingReminder(
      deps,
      job({ meetingStartIso: '2026-12-16T10:00:00.000Z' }),
    );
    expect(out.outcome).toBe('deferred');
    expect(added[0]!.opts.delay).toBe(10 * HOUR);
  });

  it('deferral that would land AFTER the meeting starts → dropped, not deferred', async () => {
    // Meeting 07:30 IDT (04:30Z); T-1h fires 06:30 IDT — deferring to 08:00 would be too late.
    const now = new Date('2026-07-22T03:30:00.000Z');
    const { deps, added } = makeDeps({ call: SCHEDULED, lead: LEAD_IN_WINDOW(now) }, now);
    const out = await processMeetingReminder(deps, job({ meetingStartIso: '2026-07-22T04:30:00.000Z' }));
    expect(out).toEqual({ outcome: 'skipped', detail: 'deferred_past_meeting' });
    expect(added).toHaveLength(0);
  });

  it('morning-meeting defer-then-deliver: 08:30 meeting → T-1h at 07:30 → deferred to 08:00 → DELIVERS', async () => {
    // The named edge case (Koren, 2026-07-21). Meeting 08:30 Israel (05:30Z, IDT).
    const meetingStartIso = '2026-07-22T05:30:00.000Z';

    // Leg 1 — the original T-1h job fires 07:30 Israel: inside quiet hours, deferral fits
    // before the meeting (08:00 + 30min margin), so it re-enqueues itself as -d1.
    const fire1 = new Date('2026-07-22T04:30:00.000Z');
    const first = makeDeps(
      {
        call: { status: 'scheduled', reminders: { jobIds: ['reminder-sc-1-t60-wa'] } },
        lead: LEAD_IN_WINDOW(fire1),
      },
      fire1,
    );
    const out1 = await processMeetingReminder(first.deps, job({ meetingStartIso }));
    expect(out1).toEqual({ outcome: 'deferred', detail: 'reminder-sc-1-t60-wa-d1' });
    expect(first.whatsapp.sendMessage).not.toHaveBeenCalled();
    expect(first.added[0]!.opts.delay).toBe(30 * 60_000); // 07:30 → 08:00
    // -d1 bookkeeping: the row now carries BOTH ids, so cancellation still covers the deferral.
    expect((first.updates[0]!.set.reminders as { jobIds: string[] }).jobIds).toEqual([
      'reminder-sc-1-t60-wa',
      'reminder-sc-1-t60-wa-d1',
    ]);

    // Leg 2 — the -d1 job fires at 08:00: quiet hours are over (end-exclusive), the meeting is
    // still 30min away, so the past-meeting check must NOT drop it — it DELIVERS.
    const fire2 = new Date('2026-07-22T05:00:00.000Z');
    const second = makeDeps({ call: SCHEDULED, lead: LEAD_IN_WINDOW(fire2) }, fire2);
    const out2 = await processMeetingReminder(
      second.deps,
      { ...first.added[0]!.data },
    );
    expect(out2).toEqual({ outcome: 'sent' });
    expect(second.whatsapp.sendMessage).toHaveBeenCalledTimes(1);
    expect(second.added).toHaveLength(0); // max one hop — no second deferral
  });
});
