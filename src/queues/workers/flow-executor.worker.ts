import { Worker } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { FlowExecutorJob, FlowContext } from '../flow-executor.queue.js';
import { enqueueFlowStep } from '../flow-executor.queue.js';
import { flowDefinitionSchema, type FlowStep } from '../../modules/flows/flow.schemas.js';
import { ValidationError } from '../../shared/errors.js';
import type { Database } from '../../db/client.js';
import { tenants, leads } from '../../db/schema/index.js';
import type { WhatsAppService } from '../../modules/channels/whatsapp/whatsapp.service.js';
import type { VoiceService } from '../../modules/channels/voice/voice.service.js';
import type { EmailService } from '../../modules/channels/email/email.service.js';
import type { Env } from '../../config/index.js';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { handleDeadLetter } from '../dead-letter.js';
import { decrypt } from '../../shared/crypto.js';
import { MondayService } from '../../modules/integrations/monday/monday.service.js';
import { AirtableService } from '../../modules/integrations/airtable/airtable.service.js';
import { GoogleCalendarProvider } from '../../modules/scheduling/providers/google-calendar.provider.js';

interface WorkerDeps {
  db: Database;
  env: Env;
  redis: Redis;
  flowExecutorQueue: Queue;
  deadLetterQueue?: Queue;
  whatsapp?: WhatsAppService;
  voice?: VoiceService;
  email?: EmailService;
  logger?: FastifyBaseLogger;
}

interface StepContext {
  leadPhone: string;
  leadName?: string;
  leadEmail?: string;
  leadId: string;
  tenantId: string;
  stepIndex: number;
  flowContext?: FlowContext;
}

function interpolate(s: string, ctx: StepContext): string {
  return s
    .replace(/\{\{name\}\}/gi, ctx.leadName ?? 'there')
    .replace(/\{\{phone\}\}/gi, ctx.leadPhone)
    .replace(/\{\{callSummary\}\}/gi, ctx.flowContext?.callSummary ?? '')
    .replace(/\{\{meetingLink\}\}/gi, ctx.flowContext?.meetingLink ?? '')
    .replace(/\{\{meetingTime\}\}/gi, ctx.flowContext?.meetingTime ?? '')
    .replace(/\{\{meetingDate\}\}/gi, ctx.flowContext?.meetingDate ?? '');
}

export function createFlowExecutorWorker(deps: WorkerDeps) {
  const { db, env, redis, flowExecutorQueue, deadLetterQueue, whatsapp, voice, email, logger } = deps;

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
        logger?.error({ event: 'flow_tenant_missing', tenantId }, 'Flow executor: tenant not found');
        return;
      }

      const settings = tenant.settings as Record<string, any> | null;
      const rawFlow = settings?.flows?.[flowName];
      if (!rawFlow) {
        logger?.error({ event: 'flow_missing', tenantId, flowName }, 'Flow executor: flow not found for tenant');
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
      if (!step) return;

      // 3. Execute the step — may return context updates (e.g. book_calendar returns meetingLink)
      const ctx: StepContext = { leadPhone, leadName, leadEmail, leadId, tenantId, stepIndex, flowContext: job.data.flowContext };
      const ctxUpdate = await executeStep(step, ctx);
      const updatedFlowContext: FlowContext = { ...(job.data.flowContext ?? {}), ...ctxUpdate };

      // 4. Chain-enqueue next step with accumulated context
      const nextStep = flow.steps[stepIndex + 1];
      if (nextStep) {
        await enqueueFlowStep(
          flowExecutorQueue,
          { tenantId, leadId, flowName, stepIndex: stepIndex + 1, leadPhone, leadName, leadEmail, flowContext: updatedFlowContext },
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

  async function executeStep(step: FlowStep, ctx: StepContext): Promise<Partial<FlowContext>> {
    switch (step.type) {
      case 'send_whatsapp': {
        if (!whatsapp) {
          logger?.warn(
            { event: 'flow_step_skip', tenantId: ctx.tenantId, stepIndex: ctx.stepIndex },
            'Flow executor: WhatsApp service not configured — skipping step',
          );
          return {};
        }
        const { messageType, url, caption, text } = step.content;

        if ((messageType === 'video' || messageType === 'image') && !url) {
          const reason = `send_whatsapp step with messageType "${messageType}" is missing required "url"`;
          logger?.error(
            { event: 'flow_step_error', tenantId: ctx.tenantId, stepIndex: ctx.stepIndex, stepType: step.type, reason },
            'Flow step misconfigured',
          );
          throw new ValidationError(reason);
        }

        if (messageType === 'text' && !text) {
          const reason = 'send_whatsapp step with messageType "text" is missing required "text"';
          logger?.error(
            { event: 'flow_step_error', tenantId: ctx.tenantId, stepIndex: ctx.stepIndex, stepType: step.type, reason },
            'Flow step misconfigured',
          );
          throw new ValidationError(reason);
        }

        if (messageType === 'video' || messageType === 'image') {
          await whatsapp.sendVideo(ctx.leadPhone, url!, caption ? interpolate(caption, ctx) : undefined);
        } else {
          await whatsapp.sendMessage(ctx.leadPhone, interpolate(text!, ctx));
        }
        return {};
      }

      case 'make_call': {
        if (!voice) {
          logger?.warn(
            { event: 'flow_step_skip', tenantId: ctx.tenantId, stepIndex: ctx.stepIndex },
            'Flow executor: Voice service not configured — skipping step',
          );
          return {};
        }

        // Build lead context to pass to Retell as dynamic variables
        const leadContext: Record<string, string> = {};
        if (ctx.leadName) leadContext.name = ctx.leadName;
        if (ctx.leadEmail) leadContext.email = ctx.leadEmail;
        if (ctx.leadPhone) leadContext.phone = ctx.leadPhone;

        // Enrich with fresh Monday data if configured
        try {
          const [tenantRow] = await db
            .select({ settings: tenants.settings })
            .from(tenants)
            .where(eq(tenants.id, ctx.tenantId))
            .limit(1);

          const mondayCfg = (tenantRow?.settings as Record<string, any> | null)?.monday;
          if (mondayCfg?.encryptedApiToken) {
            const apiToken = decrypt(mondayCfg.encryptedApiToken, env.ENCRYPTION_KEY);
            const svc = new MondayService({ apiToken, boardId: mondayCfg.boardId, columnMap: mondayCfg.columnMap ?? {} });

            const [lead] = await db
              .select({ metadata: leads.metadata, name: leads.name, email: leads.email })
              .from(leads)
              .where(and(eq(leads.id, ctx.leadId), eq(leads.tenantId, ctx.tenantId)))
              .limit(1);

            const mondayItemId = (lead?.metadata as Record<string, any> | null)?.mondayItemId as string | undefined;
            if (mondayItemId) {
              const item = await svc.getItemById(mondayItemId);
              if (item) {
                const parsed = svc.parseLeadFromItem(item);
                // Use Monday as source of truth for name/email
                if (parsed.name) leadContext.name = parsed.name;
                if (parsed.email) leadContext.email = parsed.email;
                if (parsed.phone) leadContext.phone = parsed.phone;

                // Also update lead in DB with fresh Monday data
                await db.update(leads).set({
                  name: parsed.name || lead?.name || undefined,
                  email: parsed.email || lead?.email || undefined,
                  phone: parsed.phone || ctx.leadPhone,
                  updatedAt: new Date(),
                } as any).where(and(eq(leads.id, ctx.leadId), eq(leads.tenantId, ctx.tenantId)));

                logger?.info({ tenantId: ctx.tenantId, leadId: ctx.leadId, mondayItemId }, 'Lead enriched from Monday before call');
              }
            }
          }
        } catch (err) {
          logger?.warn({ err, leadId: ctx.leadId }, 'Monday enrichment before call failed — non-fatal');
        }

        await voice.initiateOutboundCall(ctx.leadPhone, ctx.tenantId, leadContext);
        return {};
      }

      case 'send_email': {
        if (!email) {
          logger?.warn(
            { event: 'flow_step_skip', tenantId: ctx.tenantId, stepIndex: ctx.stepIndex },
            'Flow executor: Email service not configured — skipping step',
          );
          return {};
        }
        if (!ctx.leadEmail) {
          logger?.warn(
            { event: 'flow_step_skip', tenantId: ctx.tenantId, stepIndex: ctx.stepIndex },
            'Flow executor: send_email step skipped — lead has no email address',
          );
          return {};
        }
        await email.sendEmail(
          ctx.leadEmail,
          interpolate(step.content.subject, ctx),
          interpolate(step.content.html, ctx),
        );
        return {};
      }

      case 'update_monday': {
        const [tenantRow] = await db
          .select({ settings: tenants.settings })
          .from(tenants)
          .where(eq(tenants.id, ctx.tenantId))
          .limit(1);

        const mondayCfg = (tenantRow?.settings as Record<string, any> | null)?.monday;
        if (!mondayCfg?.encryptedApiToken) {
          logger?.warn(
            { event: 'flow_step_skip', tenantId: ctx.tenantId, stepIndex: ctx.stepIndex },
            'Flow executor: Monday.com not configured — skipping update_monday step',
          );
          return {};
        }

        const apiToken = decrypt(mondayCfg.encryptedApiToken, env.ENCRYPTION_KEY);
        const svc = new MondayService({ apiToken, boardId: mondayCfg.boardId, columnMap: mondayCfg.columnMap ?? {} });

        // Look up the Monday item ID stored in lead metadata during sync/push
        const [lead] = await db
          .select({ metadata: leads.metadata })
          .from(leads)
          .where(and(eq(leads.id, ctx.leadId), eq(leads.tenantId, ctx.tenantId)))
          .limit(1);

        const mondayItemId = (lead?.metadata as Record<string, any> | null)?.mondayItemId as string | undefined;
        if (!mondayItemId) {
          logger?.warn(
            { event: 'flow_step_skip', tenantId: ctx.tenantId, leadId: ctx.leadId },
            'Flow executor: update_monday skipped — lead has no mondayItemId in metadata',
          );
          return {};
        }

        const colVals: Record<string, string> = {};
        for (const [colId, value] of Object.entries(step.columnValues)) {
          colVals[colId] = interpolate(value, ctx);
        }

        if (Object.keys(colVals).length > 0) {
          await svc.updateItem(mondayCfg.boardId, mondayItemId, colVals);
          logger?.info({ tenantId: ctx.tenantId, leadId: ctx.leadId, mondayItemId }, 'Monday item updated via flow');
        }
        return {};
      }

      case 'update_airtable': {
        const [tenantRow] = await db
          .select({ settings: tenants.settings })
          .from(tenants)
          .where(eq(tenants.id, ctx.tenantId))
          .limit(1);

        const airtableCfg = (tenantRow?.settings as Record<string, any> | null)?.airtable;
        if (!airtableCfg?.encryptedApiKey) {
          logger?.warn(
            { event: 'flow_step_skip', tenantId: ctx.tenantId },
            'Flow executor: Airtable not configured — skipping update_airtable step',
          );
          return {};
        }

        const apiKey = decrypt(airtableCfg.encryptedApiKey, env.ENCRYPTION_KEY);
        const svc = new AirtableService({
          apiKey,
          baseId: airtableCfg.baseId,
          tableId: airtableCfg.tableId,
          phoneFieldName: airtableCfg.phoneFieldName,
          emailFieldName: airtableCfg.emailFieldName,
        });

        // Look up cached Airtable record ID, or search by phone/email
        const [lead] = await db
          .select({ metadata: leads.metadata, email: leads.email })
          .from(leads)
          .where(and(eq(leads.id, ctx.leadId), eq(leads.tenantId, ctx.tenantId)))
          .limit(1);

        let recordId = (lead?.metadata as Record<string, any> | null)?.airtableRecordId as string | undefined;

        if (!recordId) {
          const found = await svc.findByPhone(ctx.leadPhone).catch(() => null)
            ?? (lead?.email ? await svc.findByEmail(lead.email).catch(() => null) : null);

          if (found) {
            recordId = found.id;
            const existingMeta = (lead?.metadata as Record<string, any>) ?? {};
            await db
              .update(leads)
              .set({ metadata: { ...existingMeta, airtableRecordId: recordId }, updatedAt: new Date() } as any)
              .where(and(eq(leads.id, ctx.leadId), eq(leads.tenantId, ctx.tenantId)));
          }
        }

        if (!recordId) {
          logger?.warn(
            { event: 'flow_step_skip', tenantId: ctx.tenantId, leadId: ctx.leadId },
            'Flow executor: update_airtable skipped — no matching record found by phone or email',
          );
          return {};
        }

        const fields: Record<string, unknown> = {};
        for (const [fieldName, value] of Object.entries(step.fields)) {
          fields[fieldName] = interpolate(value, ctx);
        }

        if (Object.keys(fields).length > 0) {
          await svc.updateRecord(recordId, fields);
          logger?.info({ tenantId: ctx.tenantId, leadId: ctx.leadId, recordId }, 'Airtable record updated via flow');
        }
        return {};
      }

      case 'book_calendar': {
        const { GOOGLE_CALENDAR_ID, GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL, GOOGLE_CALENDAR_PRIVATE_KEY } = env;
        if (!GOOGLE_CALENDAR_ID || !GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL || !GOOGLE_CALENDAR_PRIVATE_KEY) {
          logger?.warn(
            { event: 'flow_step_skip', tenantId: ctx.tenantId, stepIndex: ctx.stepIndex },
            'Flow executor: Google Calendar not configured — skipping book_calendar step',
          );
          return {};
        }
        if (!ctx.leadEmail) {
          logger?.warn(
            { event: 'flow_step_skip', tenantId: ctx.tenantId, stepIndex: ctx.stepIndex },
            'Flow executor: book_calendar skipped — lead has no email address',
          );
          return {};
        }

        const provider = new GoogleCalendarProvider({
          calendarId: GOOGLE_CALENDAR_ID,
          serviceAccountEmail: GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL,
          privateKey: GOOGLE_CALENDAR_PRIVATE_KEY.replace(/\\n/g, '\n'),
          slotMinutes: env.GOOGLE_CALENDAR_SLOT_MINUTES ?? 30,
          workStart: env.GOOGLE_CALENDAR_WORK_START ?? '09:00',
          workEnd: env.GOOGLE_CALENDAR_WORK_END ?? '18:00',
        });

        // Search the next 7 days starting from tomorrow for the first open slot
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const searchEnd = new Date(tomorrow);
        searchEnd.setDate(searchEnd.getDate() + 7);

        const slots = await provider.getAvailableSlots({
          startDate: tomorrow.toISOString().slice(0, 10),
          endDate: searchEnd.toISOString().slice(0, 10),
          serviceId: GOOGLE_CALENDAR_ID,
          timezone: 'UTC',
        });

        if (!slots.length) {
          logger?.warn(
            { event: 'flow_step_skip', tenantId: ctx.tenantId, leadId: ctx.leadId },
            'Flow executor: book_calendar — no available slots in next 7 days',
          );
          return {};
        }

        const booking = await provider.createBooking({
          start: slots[0].start,
          serviceId: GOOGLE_CALENDAR_ID,
          attendee: { name: ctx.leadName ?? 'Lead', email: ctx.leadEmail, timezone: 'UTC' },
          notes: step.notes ? interpolate(step.notes, ctx) : undefined,
        });

        const startDt = new Date(booking.start);
        const meetingDate = startDt.toLocaleDateString('en-US', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
        });
        const meetingTime = startDt.toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
        });

        logger?.info(
          { tenantId: ctx.tenantId, leadId: ctx.leadId, bookingUid: booking.uid, start: booking.start },
          'Calendar booking created via flow',
        );

        return {
          meetingLink: booking.meetLink ?? `https://calendar.google.com/calendar/r`,
          meetingTime,
          meetingDate,
        };
      }

      default: {
        const unknownStep = step as { type: string };
        const stepType = unknownStep.type;
        const reason = `Unknown flow step type: ${stepType}`;
        logger?.error(
          { event: 'flow_step_error', tenantId: ctx.tenantId, stepIndex: ctx.stepIndex, stepType, reason },
          'Flow step misconfigured',
        );
        throw new ValidationError(reason);
      }
    }
  }

  worker.on('failed', (job, err) => {
    if (deadLetterQueue) handleDeadLetter(deadLetterQueue, job, err);
    else logger?.error({ jobId: job?.id, err }, 'Flow execution failed');
  });

  return worker;
}
