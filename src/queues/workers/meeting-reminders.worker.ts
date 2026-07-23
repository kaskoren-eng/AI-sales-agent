import { Worker } from 'bullmq';
import type { Queue } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../db/client.js';
import { leads, scheduledCalls, tenants } from '../../db/schema/index.js';
import type { ScheduledCallReminders } from '../../db/schema/scheduled-calls.js';
import type { EmailService } from '../../modules/channels/email/email.service.js';
import type { WhatsAppService } from '../../modules/channels/whatsapp/whatsapp.service.js';
import {
  resolveWhatsappSendMode,
  resolveWhatsappTemplates,
} from '../../modules/channels/whatsapp/whatsapp-window.js';
import {
  formatSlotHe,
  israelMinutesOfDay,
  nextIsraelClockTime,
} from '../../modules/channels/voice-livekit/tools/israel-time.js';
import type { BusinessProfile } from '../../modules/settings/settings.service.js';
import {
  inQuietWindow,
  resolveReminderSettings,
} from '../../modules/scheduling/reminders/reminder-settings.js';
import { buildReminderMessage } from '../../modules/scheduling/reminders/reminder-templates.js';
import {
  enqueueMeetingReminder,
  reminderJobId,
  type MeetingReminderJob,
} from '../meeting-reminders.queue.js';
import { handleDeadLetter } from '../dead-letter.js';

/**
 * Fires meeting reminders at their T-24h/T-1h instants. Sends DIRECT via the channel services
 * (no second hop through outbound-sender — one queue delay is enough), but the WhatsApp leg
 * still passes resolveWhatsappSendMode: the 24h window + consent policy holds for reminders
 * exactly as it does for every other business-initiated message.
 *
 * FIRE-TIME AUTHORITY. The job's data is a snapshot from booking time; reality may have moved.
 * Checks run in this order, each one authoritative over the snapshot:
 *   1. the scheduled_calls row must still exist and still be 'scheduled' (cancellation backstop —
 *      even if cancelMeetingReminders missed this job, it dies here);
 *   2. the meeting must not have started yet;
 *   3. an opted-out lead is NEVER messaged (safety boundary, no tenant setting can override);
 *   4. tenant disabled reminders since booking → respect it;
 *   5. quiet hours (Israel wall clock): defer ONCE to the end of the window with a fresh
 *      `-d1` job id (recorded on the row so cancellation still covers it). A deferral that
 *      would land after the meeting starts is dropped instead — a reminder for a meeting
 *      already underway is noise. If the re-fired job somehow lands in quiet hours again
 *      (degenerate custom window), it delivers anyway: max one hop, never a loop.
 */

export interface MeetingRemindersDeps {
  db: Database;
  redis: Redis;
  deadLetterQueue: Queue;
  /** The same 'meeting-reminders' queue — needed to re-enqueue quiet-hours deferrals. */
  remindersQueue: Queue;
  whatsapp?: WhatsAppService;
  email?: EmailService;
  logger?: FastifyBaseLogger;
  /** Test seam — fire-time "now". */
  now?: () => Date;
}

export interface ReminderOutcome {
  outcome: 'sent' | 'skipped' | 'deferred';
  detail?: string;
}

async function loadLeadForReminder(
  db: Database,
  tenantId: string,
  leadId: string | undefined,
  phone: string | null,
): Promise<{ status: string; lastInboundWhatsappAt: Date | null; consentGranted: boolean } | null> {
  const where = leadId
    ? and(eq(leads.id, leadId), eq(leads.tenantId, tenantId))
    : (() => {
        const suffix = (phone ?? '').replace(/\D/g, '').slice(-9);
        if (suffix.length < 7) return null;
        return and(
          eq(leads.tenantId, tenantId),
          sql`regexp_replace(coalesce(${leads.phone}, ''), '\\D', '', 'g') LIKE ${`%${suffix}`}`,
        );
      })();
  if (!where) return null;

  const rows = await db
    .select({
      status: leads.status,
      lastInboundWhatsappAt: leads.lastInboundWhatsappAt,
      whatsappConsent: leads.whatsappConsent,
    })
    .from(leads)
    .where(where)
    .limit(1);
  if (rows.length === 0) return null;
  return {
    status: rows[0]!.status,
    lastInboundWhatsappAt: rows[0]!.lastInboundWhatsappAt,
    consentGranted: rows[0]!.whatsappConsent?.granted === true,
  };
}

/** The processor, exported bare so tests drive it without a live BullMQ worker. */
export async function processMeetingReminder(
  deps: MeetingRemindersDeps,
  data: MeetingReminderJob,
): Promise<ReminderOutcome> {
  const { db, logger } = deps;
  const now = (deps.now ?? (() => new Date()))();

  // 1. The row is the truth about whether this meeting still stands.
  const callRows = await db
    .select({ status: scheduledCalls.status, reminders: scheduledCalls.reminders })
    .from(scheduledCalls)
    .where(and(eq(scheduledCalls.tenantId, data.tenantId), eq(scheduledCalls.id, data.scheduledCallId)))
    .limit(1);
  if (callRows.length === 0 || callRows[0]!.status !== 'scheduled') {
    logger?.info(
      { event: 'reminder_skipped_not_scheduled', scheduledCallId: data.scheduledCallId, tenantId: data.tenantId },
      'Reminder skipped — meeting cancelled or row gone',
    );
    return { outcome: 'skipped', detail: 'not_scheduled' };
  }

  // 2. A reminder for a meeting already underway is noise.
  const meetingStart = new Date(data.meetingStartIso);
  if (meetingStart.getTime() <= now.getTime()) {
    logger?.info(
      { event: 'reminder_past_meeting', scheduledCallId: data.scheduledCallId, tenantId: data.tenantId },
      'Reminder dropped — meeting already started',
    );
    return { outcome: 'skipped', detail: 'past_meeting' };
  }

  // 3. Opt-out is unconditional — checked before anything else that could message the lead.
  const lead = await loadLeadForReminder(
    db,
    data.tenantId,
    data.leadId,
    data.channel === 'whatsapp' ? data.to : null,
  );
  if (lead?.status === 'opted_out') {
    logger?.info(
      { event: 'reminder_skipped_opted_out', scheduledCallId: data.scheduledCallId, tenantId: data.tenantId },
      'Reminder skipped — lead opted out',
    );
    return { outcome: 'skipped', detail: 'opted_out' };
  }

  // One settings read serves everything below: reminder config, template SIDs, business tone.
  const tenantRows = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, data.tenantId))
    .limit(1);
  const settings = tenantRows[0]?.settings;
  const rSettings = resolveReminderSettings(settings);

  // 4. The tenant may have turned reminders off since this was booked.
  if (!rSettings.enabled) return { outcome: 'skipped', detail: 'disabled' };

  // 5. Quiet hours — defer once to the end of the window, drop if that lands after the meeting.
  if (inQuietWindow(israelMinutesOfDay(now), rSettings.quietHours) && data.deferrals === 0) {
    const fireAt = nextIsraelClockTime(now, rSettings.quietHours.end);
    if (fireAt.getTime() >= meetingStart.getTime()) {
      logger?.info(
        { event: 'reminder_deferred_past_meeting', scheduledCallId: data.scheduledCallId, tenantId: data.tenantId },
        'Reminder dropped — quiet-hours deferral would land after the meeting starts',
      );
      return { outcome: 'skipped', detail: 'deferred_past_meeting' };
    }

    const deferred: MeetingReminderJob = { ...data, deferrals: data.deferrals + 1 };
    await enqueueMeetingReminder(deps.remindersQueue, deferred, fireAt.getTime() - now.getTime());
    const newId = reminderJobId(data.scheduledCallId, data.offsetMinutes, data.channel, deferred.deferrals);

    // Record the deferred id on the row so a later cancellation removes it too.
    const existing: ScheduledCallReminders = callRows[0]!.reminders ?? { jobIds: [] };
    await db
      .update(scheduledCalls)
      .set({
        reminders: {
          ...existing,
          jobIds: [...existing.jobIds, newId],
          plannedAt: [...(existing.plannedAt ?? []), fireAt.toISOString()],
        },
      })
      .where(and(eq(scheduledCalls.tenantId, data.tenantId), eq(scheduledCalls.id, data.scheduledCallId)));

    logger?.info(
      { event: 'reminder_deferred_quiet_hours', scheduledCallId: data.scheduledCallId, tenantId: data.tenantId, fireAt: fireAt.toISOString() },
      'Reminder deferred to the end of quiet hours',
    );
    return { outcome: 'deferred', detail: newId };
  }

  // Build the message: tenant tone + overrides, Hebrew slot text relative to NOW (fire time).
  const kind = data.offsetMinutes >= 720 ? 't24' : 't1';
  const profile =
    settings && typeof settings === 'object'
      ? (((settings as Record<string, unknown>).businessProfile as BusinessProfile | undefined) ?? null)
      : null;
  const message = buildReminderMessage({
    kind,
    channel: data.channel,
    leadName: data.leadName,
    slotText: formatSlotHe(data.meetingStartIso, now),
    meetLink: data.meetLink,
    profile,
    overrides: rSettings.templateOverrides,
  });

  if (data.channel === 'whatsapp') {
    if (!deps.whatsapp) throw new Error('WhatsApp service not configured');
    const decision = resolveWhatsappSendMode({
      lastInboundWhatsappAt: lead?.lastInboundWhatsappAt ?? null,
      consentGranted: lead?.consentGranted ?? false,
      templates: resolveWhatsappTemplates(settings),
      templateKey: kind === 't24' ? 'reminder_t24' : 'reminder_t1',
      providerSupportsTemplates: deps.whatsapp.supportsTemplates,
      now,
    });
    if (decision.mode === 'blocked') {
      logger?.warn(
        { event: 'whatsapp_send_blocked', context: 'reminder', tenantId: data.tenantId, reason: decision.reason, scheduledCallId: data.scheduledCallId },
        'Reminder WhatsApp blocked by window/consent policy',
      );
      return { outcome: 'skipped', detail: decision.reason };
    }
    if (decision.mode === 'template') {
      await deps.whatsapp.sendTemplate(data.to, decision.contentSid!, {
        '1': data.leadName,
        '2': formatSlotHe(data.meetingStartIso, now),
        '3': data.meetLink ?? '',
      });
    } else {
      await deps.whatsapp.sendMessage(data.to, message.body);
    }
    return { outcome: 'sent' };
  }

  if (!deps.email) throw new Error('Email service not configured');
  await deps.email.sendEmail(data.to, message.subject ?? 'תזכורת לפגישה', message.body);
  return { outcome: 'sent' };
}

export function createMeetingRemindersWorker(deps: MeetingRemindersDeps) {
  const worker = new Worker<MeetingReminderJob>(
    'meeting-reminders',
    async (job) => processMeetingReminder(deps, job.data),
    {
      connection: deps.redis.duplicate(),
      concurrency: 5,
    },
  );

  worker.on('failed', (job, err) => {
    deps.logger?.error({ jobId: job?.id, err }, 'Meeting reminder failed');
    handleDeadLetter(deps.deadLetterQueue, job, err);
  });

  return worker;
}
