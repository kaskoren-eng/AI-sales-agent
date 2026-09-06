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
// The status-transition guard is shared with the voice CRM-sync path — one source of truth.
// The chat qualifier only ever attempts the original stepwise edges, all still allowed there.
import { canTransition } from '../../modules/leads/lead-status.js';
import {
  classifyStopSignal,
  stopConfirmationText,
  type StopClassifier,
} from '../../modules/leads/stop-signals.js';
import { applyStopSignal } from '../../modules/leads/stop-guard.js';
import { meterLead } from '../../modules/billing/usage.service.js';

interface WorkerDeps {
  db: Database;
  env: Env;
  redis: Redis;
  outboundQueue: Queue;
  flowExecutorQueue: Queue;
  deadLetterQueue: Queue;
  /**
   * Optional — when absent a stop signal still lands on the lead, it just cannot remove the
   * queued BullMQ job. `callbacks.worker.ts` re-checks both flags at fire time, so the guarantee
   * holds either way; this only saves a pointless wake-up.
   */
  callbacksQueue?: Queue;
  logger?: FastifyBaseLogger;
}

export function createMessageProcessorWorker(deps: WorkerDeps) {
  const { db, env, redis, outboundQueue, flowExecutorQueue, deadLetterQueue, logger } = deps;

  const aiEngine = env.OPENAI_API_KEY ? new AIEngineService(env) : null;

  /**
   * The LLM half of the stop guard. Null when there is no OpenAI key, and `classifyStopSignal`
   * then runs on the deterministic phrase lists alone — which is the point of having them.
   */
  const stopClassifier: StopClassifier | null = aiEngine
    ? {
        complete: ({ systemPrompt, userText }) =>
          aiEngine.generateResponse({
            systemPrompt,
            conversationHistory: [{ role: 'user', content: userText }],
          }),
      }
    : null;

  const worker = new Worker<MessageProcessorJob>(
    'message-processor',
    async (job) => {
      const { tenantId, channel, channelRef, from, content, contentType } = job.data;

      // 1. Find or create lead (track whether it was just created)
      const { lead: initialLead, isNew: isNewLead } = await findOrCreateLead(db, tenantId, channel, from);
      let lead = initialLead;

      // 1b. DOES HE WANT US TO STOP? (Koren, 2026-09-04)
      //
      // Runs BEFORE the terminal-status early return below, and before the lead-intake flow, on
      // purpose. Two bugs live in doing it later:
      //   · a `qualified` lead who writes "stop calling me" used to return at the guard below and
      //     his opt-out was never recorded — status is not a reason to ignore a DNC instruction;
      //   · a brand-new WhatsApp lead whose FIRST message is "תפסיקו לשלוח לי" used to trigger the
      //     lead-intake flow, which calls him.
      // See `src/modules/leads/stop-signals.ts` for the three tiers.
      const stopSignal = await classifyStopSignal(content ?? '', stopClassifier);
      if (stopSignal.verdict !== 'continue') {
        const stopConversation = await findOrCreateConversation(db, tenantId, lead.id, channel, channelRef);
        // Stored first: the message that ended the conversation is the evidence for having ended it.
        await db.insert(messages).values({
          tenantId,
          conversationId: stopConversation.id,
          direction: 'inbound',
          role: 'lead',
          content,
          contentType,
        });
        const applied = await applyStopSignal(
          { db, callbacksQueue: deps.callbacksQueue ?? null, logger },
          {
            tenantId,
            leadId: lead.id,
            currentStatus: lead.status,
            followupStoppedAt: lead.followupStoppedAt,
            signal: stopSignal,
            channel,
          },
        );
        // ONE LINE BACK, AND ONLY ONE (Koren approved, 2026-09-06). No AI reply is generated —
        // answering someone who just asked us to stop is the complaint we are avoiding — but a
        // fixed confirmation is sent, because for a do-not-call request the confirmation IS the
        // record that we honoured it. Copy and its three rules: `stop-signals.ts`.
        //
        // The 24h WhatsApp window needs no template here: his own message opened it seconds ago.
        const confirmation = stopConfirmationText(stopSignal.verdict);
        if (confirmation) {
          try {
            await db.insert(messages).values({
              tenantId,
              conversationId: stopConversation.id,
              direction: 'outbound',
              role: 'agent',
              content: confirmation,
              contentType: 'text',
            });
            await enqueueOutbound(outboundQueue, {
              tenantId,
              channel,
              to: from,
              content: confirmation,
              conversationId: stopConversation.id,
            });
          } catch (err) {
            // The STOP is already recorded and is what matters. A confirmation we could not send
            // must never turn into a BullMQ retry that re-runs the whole stop path.
            logger?.error(
              { event: 'stop_confirmation_failed', tenantId, leadId: lead.id, err: String(err) },
              'Could not send the stop confirmation',
            );
          }
        }

        return {
          leadId: lead.id,
          conversationId: stopConversation.id,
          stopped: stopSignal.verdict,
          action: applied.action,
          confirmationSent: !!confirmation,
        };
      }

      // Skip processing if lead is already in a terminal state
      if (lead.status === 'qualified' || lead.status === 'disqualified') {
        return { leadId: lead.id, skipped: true, reason: `lead is ${lead.status}` };
      }

      // He is talking to us again, so a standing soft stop is over. No-op unless one is set.
      if (lead.followupStoppedAt) {
        await applyStopSignal(
          { db, callbacksQueue: deps.callbacksQueue ?? null, logger },
          {
            tenantId,
            leadId: lead.id,
            currentStatus: lead.status,
            followupStoppedAt: lead.followupStoppedAt,
            signal: stopSignal,
            channel,
          },
        );
        lead = { ...lead, followupStoppedAt: null, followupStopReason: null };
      }

      // 2. Find or create conversation
      const conversation = await findOrCreateConversation(db, tenantId, lead.id, channel, channelRef);

      // 3a. New WhatsApp lead — trigger lead-intake flow (reply + call) instead of AI
      if (isNewLead && channel === 'whatsapp') {
        await db.insert(messages).values({
          tenantId,
          conversationId: conversation.id,
          direction: 'inbound',
          role: 'lead',
          content,
          contentType,
        });
        const triggered = await triggerLeadIntakeFlow(db, flowExecutorQueue, tenantId, lead);
        if (triggered) {
          logger?.info({ leadId: lead.id, tenantId }, 'New WhatsApp lead — lead-intake flow triggered');
          return { leadId: lead.id, conversationId: conversation.id, triggeredFlow: 'lead-intake' };
        }
      }

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
              await summarizeConversation(db, aiEngine, tenantId, conversation.id, aiHistory);

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
  tenantId: string,
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
      // Scoped by tenant as well as id. The id is a uuid from a tenant-scoped read, so this is
      // belt-and-braces — but it is the line whose absence turned the Monday webhook into a
      // cross-tenant write when the id started arriving from a request body.
      .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)));
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

  if (existing) return { lead: existing, isNew: false };

  const [created] = await db
    .insert(leads)
    .values({
      tenantId,
      [channel === 'email' ? 'email' : 'phone']: from,
      source: channel,
      status: 'new',
    })
    .returning();

  // BILLABLE — someone messaged this tenant on WhatsApp or email and was not already on file.
  if (created) await meterLead(db, { tenantId, leadId: created.id, source: channel });

  return { lead: created, isNew: true };
}

async function triggerLeadIntakeFlow(
  db: Database,
  flowExecutorQueue: Queue,
  tenantId: string,
  lead: any,
): Promise<boolean> {
  try {
    const [tenant] = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const settings = tenant?.settings as Record<string, any> | null;
    const rawFlow = settings?.flows?.['lead-intake'];
    if (!rawFlow) return false;

    const flowParsed = flowDefinitionSchema.safeParse(rawFlow);
    if (!flowParsed.success || !flowParsed.data.enabled || !flowParsed.data.steps.length) return false;

    const firstStep = flowParsed.data.steps[0];
    await enqueueFlowStep(
      flowExecutorQueue,
      {
        tenantId,
        leadId: lead.id,
        flowName: 'lead-intake',
        stepIndex: 0,
        leadPhone: lead.phone ?? '',
        leadName: lead.name,
        leadEmail: lead.email,
      },
      firstStep.delayMinutes * 60_000,
    );
    return true;
  } catch {
    return false;
  }
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
