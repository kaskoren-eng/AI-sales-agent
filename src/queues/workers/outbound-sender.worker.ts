import { Worker } from 'bullmq';
import type { Queue } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import type { OutboundSenderJob } from '../outbound-sender.queue.js';
import type { Database } from '../../db/client.js';
import { leads, tenants } from '../../db/schema/index.js';
import type { WhatsAppService } from '../../modules/channels/whatsapp/whatsapp.service.js';
import type { EmailService } from '../../modules/channels/email/email.service.js';
import {
  resolveWhatsappSendMode,
  resolveWhatsappTemplates,
} from '../../modules/channels/whatsapp/whatsapp-window.js';
import type { Redis } from 'ioredis';
import { handleDeadLetter } from '../dead-letter.js';
import type { FastifyBaseLogger } from 'fastify';

interface WorkerDeps {
  db: Database;
  redis: Redis;
  deadLetterQueue: Queue;
  whatsapp?: WhatsAppService;
  email?: EmailService;
  logger?: FastifyBaseLogger;
}

/** The lead fields the WhatsApp send decision needs. Null when no lead matches. */
async function loadLeadForSend(
  db: Database,
  tenantId: string,
  leadId: string | undefined,
  phone: string,
): Promise<{ lastInboundWhatsappAt: Date | null; consentGranted: boolean } | null> {
  const where = leadId
    ? and(eq(leads.id, leadId), eq(leads.tenantId, tenantId))
    : (() => {
        const suffix = phone.replace(/\D/g, '').slice(-9);
        if (suffix.length < 7) return null;
        return and(
          eq(leads.tenantId, tenantId),
          sql`regexp_replace(coalesce(${leads.phone}, ''), '\\D', '', 'g') LIKE ${`%${suffix}`}`,
        );
      })();
  if (!where) return null;

  const rows = await db
    .select({ lastInboundWhatsappAt: leads.lastInboundWhatsappAt, whatsappConsent: leads.whatsappConsent })
    .from(leads)
    .where(where)
    .limit(1);
  if (rows.length === 0) return null;
  return {
    lastInboundWhatsappAt: rows[0]!.lastInboundWhatsappAt,
    consentGranted: rows[0]!.whatsappConsent?.granted === true,
  };
}

export function createOutboundSenderWorker(deps: WorkerDeps) {
  const { db, redis, deadLetterQueue, whatsapp, email, logger } = deps;

  const worker = new Worker<OutboundSenderJob>(
    'outbound-sender',
    async (job) => {
      const { tenantId, channel, to, content, conversationId } = job.data;

      switch (channel) {
        case 'whatsapp': {
          if (!whatsapp) throw new Error('WhatsApp service not configured');

          // EVERY outbound WhatsApp passes the window+consent decision — Meta's 24h rule and
          // Israeli spam law are enforced HERE, at the choke point, not by sender goodwill.
          const [lead, tenantRow] = await Promise.all([
            loadLeadForSend(db, tenantId, job.data.leadId, to),
            db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
          ]);
          const decision = resolveWhatsappSendMode({
            lastInboundWhatsappAt: lead?.lastInboundWhatsappAt ?? null,
            consentGranted: lead?.consentGranted ?? false,
            templates: resolveWhatsappTemplates(tenantRow[0]?.settings),
            templateKey: job.data.template?.key ?? null,
            providerSupportsTemplates: whatsapp.supportsTemplates,
          });

          if (decision.mode === 'blocked') {
            // A policy block is a FINAL outcome, not a transient failure — returning (not
            // throwing) keeps it out of retries and the DLQ while staying loudly visible.
            logger?.warn(
              { event: 'whatsapp_send_blocked', tenantId, reason: decision.reason, jobId: job.id },
              'Outbound WhatsApp blocked by window/consent policy',
            );
            return { channel, to, skipped: decision.reason };
          }

          if (decision.mode === 'template') {
            await whatsapp.sendTemplate(to, decision.contentSid!, job.data.template?.variables ?? {});
          } else {
            await whatsapp.sendMessage(to, content);
          }
          break;
        }

        case 'email':
          if (!email) throw new Error('Email service not configured');
          await email.sendEmail(to, job.data.subject ?? 'Follow up', content);
          break;

        case 'voice':
          // Voice is real-time, not queue-based — log and skip
          logger?.info({ channel, jobId: job.id }, 'Voice outbound skipped — real-time channel');
          return;
      }

      return { channel, to, conversationId };
    },
    {
      connection: redis.duplicate(),
      concurrency: 10,
    },
  );

  worker.on('failed', (job, err) => {
    logger?.error({ jobId: job?.id, err }, 'Outbound send failed');
    handleDeadLetter(deadLetterQueue, job, err);
  });

  return worker;
}
