import type { Queue } from 'bullmq';

/**
 * Meeting reminders — BullMQ DELAYED jobs (a "snooze alarm" in Redis: the job sits invisible
 * until its fire time, then a worker picks it up). One job per (reminder offset × channel), so
 * a WhatsApp failure never touches the email reminder and vice versa.
 *
 * Job ids are DETERMINISTIC — `reminder-<scheduledCallId>-t<offset>-<wa|email>[-d<n>]` — which is
 * what makes cancellation possible: the booking row stores every id it ever enqueued
 * (scheduled_calls.reminders.jobIds) and the cancel endpoint removes them by name. `-d<n>` marks
 * a quiet-hours deferral re-enqueue (BullMQ refuses to reuse a completed job's id, so the
 * deferred copy needs a fresh one).
 */

export interface MeetingReminderJob {
  tenantId: string;
  scheduledCallId: string;
  leadId?: string;
  channel: 'whatsapp' | 'email';
  /** Which reminder slot this is: minutes before the meeting (1440 = T-24h, 60 = T-1h). */
  offsetMinutes: number;
  /** Phone (whatsapp) or email address. */
  to: string;
  leadName: string;
  meetingStartIso: string;
  meetLink?: string;
  bookingUid?: string;
  /** 0 on the original job; incremented on each quiet-hours re-enqueue (max one hop). */
  deferrals: number;
}

export function reminderJobId(
  scheduledCallId: string,
  offsetMinutes: number,
  channel: 'whatsapp' | 'email',
  deferrals = 0,
): string {
  const ch = channel === 'whatsapp' ? 'wa' : 'email';
  return `reminder-${scheduledCallId}-t${offsetMinutes}-${ch}${deferrals > 0 ? `-d${deferrals}` : ''}`;
}

export function enqueueMeetingReminder(queue: Queue, job: MeetingReminderJob, delayMs: number) {
  return queue.add('meeting-reminder', job, {
    jobId: reminderJobId(job.scheduledCallId, job.offsetMinutes, job.channel, job.deferrals),
    delay: Math.max(0, Math.round(delayMs)),
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
  });
}

/**
 * Best-effort removal of pending reminder jobs (cancellation / reschedule). A job that already
 * ran or doesn't exist is not an error — the worker's own status check (row must still be
 * 'scheduled') is the authoritative backstop for anything this misses.
 */
export async function cancelMeetingReminders(queue: Queue, jobIds: string[]): Promise<number> {
  let removed = 0;
  for (const id of jobIds) {
    try {
      if ((await queue.remove(id)) === 1) removed += 1;
    } catch {
      // Already active/completed or Redis hiccup — the worker's fire-time checks cover it.
    }
  }
  return removed;
}
