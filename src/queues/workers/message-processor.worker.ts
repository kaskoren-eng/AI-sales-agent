import { Worker } from 'bullmq';
import { eq, and, asc } from 'drizzle-orm';
import type { MessageProcessorJob } from '../message-processor.queue.js';
import { enqueueOutbound } from '../outbound-sender.queue.js';
import { enqueueFlowStep } from '../flow-executor.queue.js';
import type { Database } from '../../db/client.js';
import { leads, conversations, messages, tenants } from '../../db/schema/index.js';
import { flowDefinitionSchema } from '../../modules/flows/flow.schemas.js';
import { AIEngineService } from '../../modules/ai-engine/index.js';
import { QUALIFIER_SYSTEM_PROMPT } from '../../modules/ai-engine/prompts/qualifier.prompt.js';
import { RESPONDER_SYSTEM_PROMPT } from '../../modules/ai-engine/prompts/responder.prompt.js';
import type { Env } from '../../config/index.js';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { handleDeadLetter } from '../dead-letter.js';
import type { FastifyBaseLogger } from 'fastify';

interface WorkerDeps {
  db: Database;
  env: Env;
  redis: Redis;
  outboundQueue: Queue;
  flowExecutorQueue: Queue;
  deadLetterQueue: Queue;
  logger?: FastifyBaseLogger;
}

// Valid forward-only status transitions
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  new: ['contacted'],
  contacted: ['qualifying'],
  qualifying: ['qualified', 'disqualified'],
  qualified: [],
  disqualified: [],
};

function canTransition(from: string, to: string): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function createMessageProcessorWorker(deps: WorkerDeps) {
  const { db, env, redis, outboundQueue, flowExecutorQueue, deadLetterQueue, logger } = deps;

  const aiEngine = env.OPENAI_API_KEY ? new AIEngineService(env) : null;

  const worker = new Worker<MessageProcessorJob>(
    'message-processor',
    async (job) => {
      const { tenantId, channel, channelRef, from, content, contentType } = job.data;

      // 1. Find or create lead
      let lead = await findOrCreateLead(db, tenantId, channel, from);

      // Skip processing if lead is already in a terminal state
      if (lead.status === 'qualified' || lead.status === 'disqualified') {
        return { leadId: lead.id, skipped: true, reason: `lead is ${lead.status}` };
      }

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

      // 4. Advance lead status (enforced transitions only)
      if (lead.status === 'new' && canTransition('new', 'contacted')) {
        await db.update(leads).set({ status: 'contacted', updatedAt: new Date() }).where(and(eq(leads.id, lead.id), eq(leads.tenantId, tenantId)));
        lead = { ...lead, status: 'contacted' };
      } else if (lead.status === 'contacted' && canTransition('contacted', 'qualifying')) {
        await db.update(leads).set({ status: 'qualifying', updatedAt: new Date() }).where(and(eq(leads.id, lead.id), eq(leads.tenantId, tenantId)));
        lead = { ...lead, status: 'qualifying' };
      }

      // 5. Load conversation history
      const history = await db
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.conversationId, conversation.id))
        .orderBy(asc(messages.createdAt))
        .limit(50);

      const aiHistory = history.map((m) => ({
        role: (m.role === 'lead' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.content,
      }));

      // 6. Generate AI response
      let responseText: string;
      if (aiEngine) {
        const systemPrompt =
          lead.status === 'contacted' || lead.status === 'qualifying'
            ? QUALIFIER_SYSTEM_PROMPT
            : RESPONDER_SYSTEM_PROMPT;

        responseText = await aiEngine.generateResponse({
          systemPrompt,
          conversationHistory: aiHistory,
        });

        // 6a. Run qualification scoring during the qualifying phase
        if (lead.status === 'qualifying') {
          try {
            const result = await aiEngine.qualifyLead({
              conversationHistory: aiHistory,
              qualificationCriteria: 'Budget, Authority, Need, Timeline (BANT)',
            });

            const updates: Record<string, unknown> = { updatedAt: new Date() };
            if (result.score > 0) updates.score = result.score;

            if (result.qualified && canTransition('qualifying', 'qualified')) {
              updates.status = 'qualified';
              // Store reasoning in metadata
              const existingMeta = (lead.metadata as Record<string, unknown>) ?? {};
              updates.metadata = { ...existingMeta, qualificationReasoning: result.reasoning };

              await db.update(leads).set(updates as any).where(and(eq(leads.id, lead.id), eq(leads.tenantId, tenantId)));
              lead = { ...lead, status: 'qualified' };

              // 6b. Summarize conversation for handoff
              await summarizeConversation(db, aiEngine, conversation.id, aiHistory);

              // 6c. Trigger the qualified flow if configured
              await triggerQualifiedFlow(db, flowExecutorQueue, tenantId, lead, channel);

            } else if (!result.qualified && result.score < 20 && canTransition('qualifying', 'disqualified')) {
              updates.status = 'disqualified';
              const existingMeta = (lead.metadata as Record<string, unknown>) ?? {};
              updates.metadata = {
                ...existingMeta,
                disqualificationReason: result.reasoning,
                disqualificationScore: result.score,
              };
              await db.update(leads).set(updates as any).where(and(eq(leads.id, lead.id), eq(leads.tenantId, tenantId)));
              lead = { ...lead, status: 'disqualified' };
            } else {
              // Score updated but no status change yet
              await db.update(leads).set(updates as any).where(and(eq(leads.id, lead.id), eq(leads.tenantId, tenantId)));
            }
          } catch {
            // Non-fatal — qualification scoring is best-effort
          }
        }
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

      return { leadId: lead.id, conversationId: conversation.id, status: lead.status };
    },
    {
      connection: redis.duplicate(),
      concurrency: 10,
    },
  );

  worker.on('failed', (job, err) => {
    logger?.error({ jobId: job?.id, err }, 'Message processing failed');
    handleDeadLetter(deadLetterQueue, job, err);
  });

  return worker;
}

async function summarizeConversation(
  db: Database,
  aiEngine: AIEngineService,
  conversationId: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
) {
  try {
    const summary = await aiEngine.generateResponse({
      systemPrompt:
        'You are a CRM assistant. Summarize this sales conversation in 3-5 bullet points, highlighting: the lead\'s main need, budget signals, timeline, and any objections. Be concise and factual.',
      conversationHistory: history,
    });
    await db
      .update(conversations)
      .set({ summary, updatedAt: new Date() } as any)
      .where(eq(conversations.id, conversationId));
  } catch {
    // Non-fatal
  }
}

async function triggerQualifiedFlow(
  db: Database,
  flowExecutorQueue: Queue,
  tenantId: string,
  lead: any,
  channel: string,
) {
  try {
    const [tenant] = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const settings = tenant?.settings as Record<string, any> | null;
    const rawFlow = settings?.flows?.['qualified'];
    if (!rawFlow) return;

    const flowParsed = flowDefinitionSchema.safeParse(rawFlow);
    if (!flowParsed.success || !flowParsed.data.enabled || !flowParsed.data.steps.length) return;

    const firstStep = flowParsed.data.steps[0];
    await enqueueFlowStep(
      flowExecutorQueue,
      {
        tenantId,
        leadId: lead.id,
        flowName: 'qualified',
        stepIndex: 0,
        leadPhone: lead.phone ?? '',
        leadName: lead.name,
        leadEmail: lead.email,
      },
      firstStep.delayMinutes * 60_000,
    );
  } catch {
    // Non-fatal
  }
}

async function findOrCreateLead(db: Database, tenantId: string, channel: string, from: string) {
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
