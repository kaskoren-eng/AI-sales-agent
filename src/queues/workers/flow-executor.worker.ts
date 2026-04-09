import { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { FlowExecutorJob } from '../flow-executor.queue.js';
import { enqueueFlowStep } from '../flow-executor.queue.js';
import { flowDefinitionSchema, type FlowStep } from '../../modules/flows/flow.schemas.js';
import type { Database } from '../../db/client.js';
import { tenants } from '../../db/schema/index.js';
import type { WhatsAppService } from '../../modules/channels/whatsapp/whatsapp.service.js';
import type { VoiceService } from '../../modules/channels/voice/voice.service.js';
import type { Env } from '../../config/index.js';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';

interface WorkerDeps {
  db: Database;
  env: Env;
  redis: Redis;
  flowExecutorQueue: Queue;
  whatsapp?: WhatsAppService;
  voice?: VoiceService;
}

export function createFlowExecutorWorker(deps: WorkerDeps) {
  const { db, env, redis, flowExecutorQueue, whatsapp, voice } = deps;

  const worker = new Worker<FlowExecutorJob>(
    'flow-executor',
    async (job) => {
      const { tenantId, leadId, flowName, stepIndex, leadPhone, leadName, leadEmail } = job.data;

      // 1. Load tenant and parse flow config
      const [tenant] = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (!tenant) {
        console.error(`Flow executor: tenant ${tenantId} not found`);
        return;
      }

      const settings = tenant.settings as Record<string, any> | null;
      const rawFlow = settings?.flows?.[flowName];
      if (!rawFlow) {
        console.error(`Flow executor: flow "${flowName}" not found for tenant ${tenantId}`);
        return;
      }

      const parsed = flowDefinitionSchema.safeParse(rawFlow);
      if (!parsed.success) {
        console.error(`Flow executor: invalid flow config for "${flowName}"`, parsed.error.flatten());
        return;
      }

      const flow = parsed.data;
      if (!flow.enabled) return;

      // 2. Get current step
      const step = flow.steps[stepIndex];
      if (!step) return; // No more steps — flow complete

      // 3. Execute the step
      await executeStep(step, { leadPhone, leadName, leadEmail, tenantId });

      // 4. Chain-enqueue next step if exists
      const nextStep = flow.steps[stepIndex + 1];
      if (nextStep) {
        await enqueueFlowStep(
          flowExecutorQueue,
          { tenantId, leadId, flowName, stepIndex: stepIndex + 1, leadPhone, leadName, leadEmail },
          nextStep.delayMinutes * 60_000,
        );
      }

      return { tenantId, leadId, flowName, stepIndex, action: step.type };
    },
    {
      connection: redis.duplicate(),
      concurrency: 10,
    },
  );

  async function executeStep(
    step: FlowStep,
    ctx: { leadPhone: string; leadName?: string; leadEmail?: string; tenantId: string },
  ) {
    switch (step.type) {
      case 'send_whatsapp': {
        if (!whatsapp) {
          console.warn('Flow executor: WhatsApp service not configured — skipping step');
          return;
        }
        const { messageType, url, caption, text } = step.content;
        // Interpolate {{name}} in caption/text
        const interpolate = (s: string) => s.replace(/\{\{name\}\}/gi, ctx.leadName ?? 'there');

        if (messageType === 'video' || messageType === 'image') {
          await whatsapp.sendVideo(ctx.leadPhone, url!, caption ? interpolate(caption) : undefined);
        } else {
          await whatsapp.sendMessage(ctx.leadPhone, interpolate(text ?? ''));
        }
        break;
      }

      case 'make_call': {
        if (!voice) {
          console.warn('Flow executor: Voice service not configured — skipping step');
          return;
        }
        await voice.initiateOutboundCall(ctx.leadPhone, ctx.tenantId);
        break;
      }
    }
  }

  worker.on('failed', (job, err) => {
    console.error(`Flow execution failed for job ${job?.id}:`, err);
  });

  return worker;
}
