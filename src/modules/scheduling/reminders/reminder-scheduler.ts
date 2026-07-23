import { and, eq } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import type { Database } from '../../../db/client.js';
import { scheduledCalls } from '../../../db/schema/index.js';
import type { ScheduledCallReminders } from '../../../db/schema/scheduled-calls.js';
import {
  enqueueMeetingReminder,
  reminderJobId,
  type MeetingReminderJob,
} from '../../../queues/meeting-reminders.queue.js';
import type { ReminderSettings } from './reminder-settings.js';

/**
 * Which reminders to enqueue for a booking, and when. Split in two:
 *
 *  - `computeReminderPlan` is PURE — (now, meeting start, settings, contact info) in, a list of
 *    (channel, offset, delay) out. All arithmetic is epoch milliseconds, which makes it
 *    inherently DST-safe: "24 hours before the meeting" is exactly 86,400,000 ms before the
 *    meeting's instant, regardless of what Israeli wall clocks do in between. (Quiet-hours
 *    wall-clock logic lives in the WORKER, at fire time — not here.)
 *  - `scheduleReminders` does the I/O: enqueue each entry as a delayed job, then persist every
 *    job id on the scheduled_calls row (tenant-scoped) so cancellation can find them.
 *
 * The "skip T-24h when booking <24h out" rule falls out naturally: its fire time is already in
 * the past, delay ≤ 0, entry dropped. The 60s floor also drops reminders that would fire
 * within the same minute as booking — a reminder racing the confirmation message is noise.
 */

const MIN_DELAY_MS = 60_000;

export interface ReminderPlanEntry {
  channel: 'whatsapp' | 'email';
  offsetMinutes: number;
  delayMs: number;
  fireAtIso: string;
}

export function computeReminderPlan(params: {
  now: Date;
  meetingStart: Date;
  settings: ReminderSettings;
  phone: string | null;
  email: string | null;
}): ReminderPlanEntry[] {
  const { now, meetingStart, settings } = params;
  if (!settings.enabled) return [];

  const entries: ReminderPlanEntry[] = [];
  for (const offsetMinutes of settings.offsetsMinutes) {
    const fireAt = meetingStart.getTime() - offsetMinutes * 60_000;
    const delayMs = fireAt - now.getTime();
    if (delayMs <= MIN_DELAY_MS) continue; // already past (booking <offset out) or racing the confirmation
    for (const channel of settings.channels) {
      if (channel === 'whatsapp' && !params.phone) continue;
      if (channel === 'email' && !params.email) continue;
      entries.push({ channel, offsetMinutes, delayMs, fireAtIso: new Date(fireAt).toISOString() });
    }
  }
  return entries;
}

export interface ScheduleRemindersParams {
  tenantId: string;
  scheduledCallId: string;
  leadId?: string;
  leadName: string;
  phone: string | null;
  email: string | null;
  meetingStartIso: string;
  meetLink?: string;
  bookingUid?: string;
  settings: ReminderSettings;
  now?: Date;
}

/**
 * Enqueues the plan and records the job ids on the booking row. Callers wrap this in their own
 * try/catch — a reminder that fails to schedule must NEVER fail the booking it belongs to.
 */
export async function scheduleReminders(
  deps: { queue: Queue; db: Database },
  params: ScheduleRemindersParams,
): Promise<ScheduledCallReminders> {
  const now = params.now ?? new Date();
  const plan = computeReminderPlan({
    now,
    meetingStart: new Date(params.meetingStartIso),
    settings: params.settings,
    phone: params.phone,
    email: params.email,
  });
  if (plan.length === 0) return { jobIds: [] };

  const jobIds: string[] = [];
  const plannedAt: string[] = [];
  for (const entry of plan) {
    const job: MeetingReminderJob = {
      tenantId: params.tenantId,
      scheduledCallId: params.scheduledCallId,
      leadId: params.leadId,
      channel: entry.channel,
      offsetMinutes: entry.offsetMinutes,
      to: entry.channel === 'whatsapp' ? params.phone! : params.email!,
      leadName: params.leadName,
      meetingStartIso: params.meetingStartIso,
      meetLink: params.meetLink,
      bookingUid: params.bookingUid,
      deferrals: 0,
    };
    await enqueueMeetingReminder(deps.queue, job, entry.delayMs);
    jobIds.push(reminderJobId(params.scheduledCallId, entry.offsetMinutes, entry.channel));
    plannedAt.push(entry.fireAtIso);
  }

  const reminders: ScheduledCallReminders = { jobIds, plannedAt };
  await deps.db
    .update(scheduledCalls)
    .set({ reminders })
    .where(
      and(eq(scheduledCalls.tenantId, params.tenantId), eq(scheduledCalls.id, params.scheduledCallId)),
    );
  return reminders;
}
