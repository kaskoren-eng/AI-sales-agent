import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { VoiceService } from './voice.service.js';
import { conversations, messages, callLearnings, leads, tenants } from '../../../db/schema/index.js';
import { enqueueCallAnalysis } from '../../../queues/call-analysis.queue.js';
import { enqueueFlowStep } from '../../../queues/flow-executor.queue.js';

export async function voiceRoutes(app: FastifyInstance) {
  const service = new VoiceService(app);

  /**
   * Retell AI webhook — receives call_started and call_analyzed events.
   *
   * Retell sends:
   *   Header: x-retell-signature: <hmac_sha256_hex>
   *   HMAC key: RETELL_API_KEY
   *   HMAC message: raw request body
   *
   * Configure in Retell dashboard → Agent settings → Webhook URL:
   *   https://<your-domain>/webhooks/voice/retell
   *
   * call_started  → create conversation record, link to lead by phone
   * call_analyzed → store transcript, update conversation, trigger post-call flow
   */
  app.post('/retell', async (request, reply) => {
    const apiKey = app.env.RETELL_API_KEY;

    if (apiKey) {
      const sig = request.headers['x-retell-signature'] as string | undefined;
      const rawBody = (request as any).rawBody as string | undefined;

      if (!sig || !rawBody) {
        app.log.warn('Retell webhook: missing signature or raw body');
        return reply.status(401).send({ error: 'Missing signature' });
      }

      if (!verifyRetellSignature(rawBody, sig, apiKey)) {
        app.log.warn('Retell webhook: invalid signature');
        return reply.status(401).send({ error: 'Invalid signature' });
      }
    }

    const body = request.body as Record<string, any>;
    const event = body?.event as string | undefined;
    const call = body?.call as Record<string, any> | undefined;

    if (!event || !call) {
      return reply.status(400).send({ error: 'Invalid payload' });
    }

    const callId = call['call_id'] as string | undefined;
    if (!callId) {
      return reply.status(400).send({ error: 'Missing call_id' });
    }

    app.log.info({ event, callId }, 'Retell webhook received');

    // ----------------------------------------------------------------
    // call_started — create conversation record and link to lead
    // ----------------------------------------------------------------
    if (event === 'call_started') {
      const tenantId = app.env.VOICE_WEBHOOK_TENANT_ID;
      if (!tenantId) {
        app.log.warn('VOICE_WEBHOOK_TENANT_ID not set — skipping call_started');
        return reply.status(200).send({ ok: true });
      }

      const fromNumber = call['from_number'] as string | undefined;

      // Find existing lead by phone number, or create a placeholder
      let leadId: string | null = null;
      if (fromNumber) {
        const [existingLead] = await app.db
          .select({ id: leads.id })
          .from(leads)
          .where(and(eq(leads.tenantId, tenantId), eq(leads.phone, fromNumber)))
          .limit(1);

        if (existingLead) {
          leadId = existingLead.id;
        } else {
          // Create placeholder lead so the conversation record is valid
          const [newLead] = await app.db
            .insert(leads)
            .values({ tenantId, phone: fromNumber, name: null, status: 'new' })
            .returning({ id: leads.id });
          leadId = newLead?.id ?? null;
        }
      }

      if (!leadId) {
        app.log.warn({ callId, tenantId }, 'Retell call_started: no phone number — skipping conversation creation');
        return reply.status(200).send({ ok: true });
      }

      await app.db
        .insert(conversations)
        .values({
          tenantId,
          leadId,
          channel: 'voice',
          channelRef: callId,
          status: 'active',
        })
        .onConflictDoNothing();

      app.log.info({ callId, tenantId, leadId }, 'Retell conversation record created');
      return reply.status(200).send({ ok: true });
    }

    // ----------------------------------------------------------------
    // call_analyzed — store transcript, update conversation, post-call flow
    // ----------------------------------------------------------------
    if (event === 'call_analyzed') {
      const transcriptObject = call['transcript_object'] as Array<Record<string, any>> | undefined;
      const callAnalysis = call['call_analysis'] as Record<string, any> | undefined;
      const durationMs = call['duration_ms'] as number | undefined;

      // Find conversation by Retell call_id
      const [convo] = await app.db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.channel, 'voice'),
            eq(conversations.channelRef, callId),
          ),
        )
        .limit(1);

      if (!convo) {
        app.log.warn({ callId }, 'Retell call_analyzed: no matching conversation record — skipping');
        return reply.status(200).send({ ok: true, skipped: true });
      }

      // Store transcript turns as messages
      if (transcriptObject?.length) {
        const turns = transcriptObject.map((turn, idx) => ({
          tenantId: convo.tenantId,
          conversationId: convo.id,
          direction: turn['role'] === 'agent' ? 'outbound' : 'inbound',
          role: turn['role'] === 'agent' ? 'agent' : 'lead',
          content: typeof turn['content'] === 'string' ? turn['content'] : '',
          contentType: 'transcript',
          metadata:
            durationMs && idx === transcriptObject.length - 1
              ? { call_duration_secs: Math.round(durationMs / 1000) }
              : {},
        }));

        await app.db.insert(messages).values(turns);
      }

      // Update conversation status and summary
      const summary = callAnalysis?.['call_summary'] as string | undefined;
      await app.db
        .update(conversations)
        .set({
          status: 'ended',
          ...(summary ? { summary } : {}),
          updatedAt: new Date(),
        } as any)
        .where(eq(conversations.id, convo.id));

      app.log.info(
        { callId, convoId: convo.id, turns: transcriptObject?.length ?? 0 },
        'Retell transcript stored',
      );

      // Trigger post-call flow if configured
      try {
        const [lead] = await app.db
          .select({ id: leads.id, phone: leads.phone, name: leads.name, email: leads.email })
          .from(leads)
          .where(and(eq(leads.id, convo.leadId), eq(leads.tenantId, convo.tenantId)))
          .limit(1);

        if (lead?.phone) {
          const [tenantRow] = await app.db
            .select({ settings: tenants.settings })
            .from(tenants)
            .where(eq(tenants.id, convo.tenantId))
            .limit(1);

          const postCallFlow = (tenantRow?.settings as Record<string, any> | null)?.flows?.['post-call'];
          if (postCallFlow?.enabled) {
            await enqueueFlowStep(
              app.queues.flowExecutor,
              {
                tenantId: convo.tenantId,
                leadId: convo.leadId,
                flowName: 'post-call',
                stepIndex: 0,
                leadPhone: lead.phone,
                leadName: lead.name ?? undefined,
                leadEmail: lead.email ?? undefined,
                flowContext: { callSummary: summary ?? '' },
              },
              0,
            );
            app.log.info({ tenantId: convo.tenantId, leadId: convo.leadId, callId }, 'Post-call flow enqueued');
          }
        }
      } catch (err) {
        app.log.warn({ err, callId }, 'Post-call flow trigger failed — non-fatal');
      }

      return reply.status(200).send({ ok: true, turns: transcriptObject?.length ?? 0 });
    }

    // Unknown event — acknowledge without error
    return reply.status(200).send({ ok: true });
  });

  /**
   * Zadarma verification challenge — responds to GET ?zd_echo=<value> with the value as plain text.
   * Zadarma sends this when you first register a notification URL to confirm ownership.
   */
  app.get('/zadarma', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const echo = query['zd_echo'];
    if (echo) {
      return reply.status(200).type('text/plain').send(echo);
    }
    return reply.status(200).send({ ok: true });
  });

  /**
   * Zadarma notification webhook — fired when a monitored call ends and recording is ready.
   * Zadarma POSTs application/x-www-form-urlencoded with:
   *   call_id, disposition, recording (URL), from_number, called_number, duration
   *
   * Configure in Zadarma portal → My Notifications:
   *   https://<your-domain>/webhooks/voice/zadarma
   */
  app.post('/zadarma', async (request, reply) => {
    const params = request.body as Record<string, string>;
    const { call_id, disposition, recording, duration } = params;

    // Only process answered calls with a recording
    if (disposition !== 'answered' || !recording) {
      return reply.status(204).send();
    }

    app.log.info({ call_id, recording }, 'Zadarma recording notification received');

    if (!call_id) {
      app.log.warn({ params }, 'Zadarma notify: missing call_id');
      return reply.status(200).send({ ok: true, skipped: true });
    }

    // Resolve tenant from Redis mapping created when the monitor call was started
    const redisKey = `monitor_call:${call_id}`;
    const mapping = await app.redis.get(redisKey);
    if (!mapping) {
      app.log.warn({ call_id }, 'Zadarma notify: no tenant mapping found — not a monitored call');
      return reply.status(200).send({ ok: true, skipped: true });
    }

    const { tenantId } = JSON.parse(mapping) as { tenantId: string };

    // Update the learning record with recording details
    await app.db
      .update(callLearnings)
      .set({ recordingUrl: recording })
      .where(
        and(
          eq(callLearnings.tenantId, tenantId),
          eq(callLearnings.conferenceName, call_id),
        ),
      );

    // Fetch learning ID for the queue job
    const [row] = await app.db
      .select({ id: callLearnings.id })
      .from(callLearnings)
      .where(
        and(
          eq(callLearnings.tenantId, tenantId),
          eq(callLearnings.conferenceName, call_id),
        ),
      )
      .limit(1);

    if (!row) {
      app.log.warn({ call_id, tenantId }, 'Zadarma notify: learning record not found');
      return reply.status(200).send({ ok: true, skipped: true });
    }

    await enqueueCallAnalysis(app.queues.callAnalysis, {
      tenantId,
      learningId: row.id,
      recordingUrl: recording,
      recordingSid: call_id,
      durationSecs: duration ? parseInt(duration, 10) : 0,
    });

    app.log.info({ learningId: row.id, tenantId }, 'Call analysis job enqueued from Zadarma');
    return reply.status(200).send({ ok: true });
  });
}

/**
 * Verify Retell webhook signature.
 * Retell signs the raw request body with HMAC-SHA256 using the API key.
 */
/**
 * Verify Retell webhook signature.
 * Format: v=<unix_timestamp_ms>,<hmac_sha256_hex>
 * Retell signs: <timestamp><rawBody> with HMAC-SHA256 using the API key.
 * Rejects requests older than 5 minutes to prevent replay attacks.
 */
function verifyRetellSignature(rawBody: string, signature: string, apiKey: string): boolean {
  try {
    // Parse "v=<ts>,<hex_sig>" format
    const match = signature.match(/^v=(\d+),([0-9a-f]+)$/i);
    if (!match) return false;

    const [, tsStr, receivedHex] = match;
    const ts = parseInt(tsStr, 10);

    // Reject requests older than 5 minutes
    if (Math.abs(Date.now() - ts) > 5 * 60 * 1000) return false;

    const expected = createHmac('sha256', apiKey).update(tsStr + rawBody).digest('hex');
    const expBuf = Buffer.from(expected, 'hex');
    const sigBuf = Buffer.from(receivedHex, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}
