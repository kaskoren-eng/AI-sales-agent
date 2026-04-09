import { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { OutboundSenderJob } from '../outbound-sender.queue.js';
import type { Database } from '../../db/client.js';
import { messages } from '../../db/schema/index.js';
import type { WhatsAppService } from '../../modules/channels/whatsapp/whatsapp.service.js';
import type { EmailService } from '../../modules/channels/email/email.service.js';
import type { Redis } from 'ioredis';

interface WorkerDeps {
  db: Database;
  redis: Redis;
  whatsapp?: WhatsAppService;
  email?: EmailService;
}

export function createOutboundSenderWorker(deps: WorkerDeps) {
  const { db, redis, whatsapp, email } = deps;

  const worker = new Worker<OutboundSenderJob>(
    'outbound-sender',
    async (job) => {
      const { tenantId, channel, to, content, conversationId } = job.data;

      switch (channel) {
        case 'whatsapp':
          if (!whatsapp) throw new Error('WhatsApp service not configured');
          await whatsapp.sendMessage(to, content);
          break;

        case 'email':
          if (!email) throw new Error('Email service not configured');
          await email.sendEmail(to, 'Follow up', content);
          break;

        case 'voice':
          // Voice is real-time, not queue-based — log and skip
          console.log(`Voice outbound skipped (real-time channel): ${to}`);
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
    console.error(`Outbound send failed for job ${job?.id}:`, err);
  });

  return worker;
}
