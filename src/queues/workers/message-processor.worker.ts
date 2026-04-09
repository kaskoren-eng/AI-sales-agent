import { Worker } from 'bullmq';
import { eq, and, asc } from 'drizzle-orm';
import type { MessageProcessorJob } from '../message-processor.queue.js';
import { enqueueOutbound } from '../outbound-sender.queue.js';
import type { Database } from '../../db/client.js';
import { leads, conversations, messages } from '../../db/schema/index.js';
import { AIEngineService } from '../../modules/ai-engine/index.js';
import { QUALIFIER_SYSTEM_PROMPT } from '../../modules/ai-engine/prompts/qualifier.prompt.js';
import type { Env } from '../../config/index.js';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';

interface WorkerDeps {
  db: Database;
  env: Env;
  redis: Redis;
  outboundQueue: Queue;
}

export function createMessageProcessorWorker(deps: WorkerDeps) {
  const { db, env, redis, outboundQueue } = deps;

  const aiEngine = env.GOOGLE_AI_API_KEY
    ? new AIEngineService(env)
    : null;

  const worker = new Worker<MessageProcessorJob>(
    'message-processor',
    async (job) => {
      const { tenantId, channel, channelRef, from, content, contentType } = job.data;

      // 1. Find or create lead
      const lead = await findOrCreateLead(db, tenantId, channel, from);

      // 2. Find or create conversation
      const conversation = await findOrCreateConversation(db, tenantId, lead.id, channel, channelRef);

      // 3. Store inbound message
      await db.insert(messages).values({
        tenantId,
        conversationId: conversation.id,
        direction: 'inbound',
        role: 'lead',
        content,
        contentType,
      });

      // 4. Update lead status if new
      if (lead.status === 'new') {
        await db
          .update(leads)
          .set({ status: 'contacted', updatedAt: new Date() })
          .where(eq(leads.id, lead.id));
      }

      // 5. Load conversation history for AI
      const history = await db
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.conversationId, conversation.id))
        .orderBy(asc(messages.createdAt))
        .limit(50);

      // 6. Generate AI response
      let responseText: string;
      if (aiEngine) {
        const aiHistory = history.map((m) => ({
          role: (m.role === 'lead' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: m.content,
        }));

        responseText = await aiEngine.generateResponse({
          systemPrompt: QUALIFIER_SYSTEM_PROMPT,
          conversationHistory: aiHistory,
        });
      } else {
        responseText = 'Thank you for your message. A team member will get back to you shortly.';
      }

      // 7. Store outbound message
      await db.insert(messages).values({
        tenantId,
        conversationId: conversation.id,
        direction: 'outbound',
        role: 'agent',
        content: responseText,
        contentType: 'text',
      });

      // 8. Enqueue outbound delivery
      await enqueueOutbound(outboundQueue, {
        tenantId,
        channel,
        to: from,
        content: responseText,
        conversationId: conversation.id,
      });

      return { leadId: lead.id, conversationId: conversation.id };
    },
    {
      connection: redis.duplicate(),
      concurrency: 10,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`Message processing failed for job ${job?.id}:`, err);
  });

  return worker;
}

async function findOrCreateLead(db: Database, tenantId: string, channel: string, from: string) {
  // Look up by phone (whatsapp/voice) or email
  const identifierColumn = channel === 'email' ? leads.email : leads.phone;
  const [existing] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.tenantId, tenantId), eq(identifierColumn, from)))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(leads)
    .values({
      tenantId,
      [channel === 'email' ? 'email' : 'phone']: from,
      source: channel,
      status: 'new',
    })
    .returning();

  return created;
}

async function findOrCreateConversation(
  db: Database,
  tenantId: string,
  leadId: string,
  channel: string,
  channelRef: string,
) {
  // Find active conversation for this lead + channel
  const [existing] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.leadId, leadId),
        eq(conversations.channel, channel),
        eq(conversations.status, 'active'),
      ),
    )
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(conversations)
    .values({
      tenantId,
      leadId,
      channel,
      channelRef,
      status: 'active',
    })
    .returning();

  return created;
}
