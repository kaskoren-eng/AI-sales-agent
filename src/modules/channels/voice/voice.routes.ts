import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import twilio from 'twilio';
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { VoiceService } from './voice.service.js';
import { conversations, messages, callLearnings, leads, tenants } from '../../../db/schema/index.js';
import { enqueueCallAnalysis } from '../../../queues/call-analysis.queue.js';
import { enqueueFlowStep } from '../../../queues/flow-executor.queue.js';

// Twilio sends voice webhooks as application/x-www-form-urlencoded
const twilioWebhookSchema = z.object({
  CallSid: z.string().min(1),
  From: z.string().min(1),
  To: z.string().min(1),
  Direction: z.string().optional(),
  CallStatus: z.string().optional(),
});

export async function voiceRoutes(app: FastifyInstance) {
  const service = new VoiceService(app);

  // Parse form-encoded bodies that Twilio sends for voice webhooks
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post('/', async (request, reply) => {
    const params = request.body as Record<string, string>;

    // 1. Verify Twilio request signature (skip if AUTH_TOKEN not configured)
    const authToken = app.env.TWILIO_AUTH_TOKEN;
    if (authToken) {
      const signature = request.headers['x-twilio-signature'] as string | undefined;
      const baseUrl = app.env.BASE_URL ?? `https://${request.hostname}`;
      const webhookUrl = `${baseUrl}/webhooks/voice`;
      const isValid = twilio.validateRequest(authToken, signature ?? '', webhookUrl, params);
      if (!isValid) {
        app.log.warn({ webhookUrl }, 'Voice webhook: invalid Twilio signature');
        reply.status(403).type('text/xml').send('<Response><Reject/></Response>');
        return;
      }
    }

    // 2. Parse required Twilio fields
    const parsed = twilioWebhookSchema.safeParse(params);
    if (!parsed.success) {
      app.log.warn({ errors: parsed.error.flatten() }, 'Voice webhook: invalid payload');
      reply.type('text/xml').send('<Response><Reject/></Response>');
      return;
    }

    const { CallSid, From, To } = parsed.data;
    app.log.info({ callSid: CallSid, from: From, to: To }, 'Voice inbound call received');

    // 3. Register call with ElevenLabs and return TwiML (pass tenant for learning injection)
    const tenantId = app.env.VOICE_WEBHOOK_TENANT_ID;
    const twiml = await service.handleIncomingCall(CallSid, From, To, tenantId);
    reply.type('text/xml').send(twiml);
  });

  /**
   * ElevenLabs post-call webhook — fired when a conversation ends.
   * ElevenLabs sends:
   *   Header: ElevenLabs-Signature: t=<unix_timestamp>,v0=<hmac_sha256_hex>
   *   HMAC key: ELEVENLABS_WEBHOOK_SECRET
   *   HMAC message: "<timestamp>.<raw_body>"
   *
   * To enable: go to ElevenLabs → Agent settings → Post-call webhook
   * and point it to: https://<your-domain>/webhooks/voice/conversation-end
   */
  app.post('/conversation-end', async (request, reply) => {
    const secret = app.env.ELEVENLABS_WEBHOOK_SECRET;

    // 1. Verify signature (skip if secret not configured)
    if (secret) {
      const sigHeader = request.headers['elevenlabs-signature'] as string | undefined;
      if (!sigHeader) {
        app.log.warn('ElevenLabs webhook: missing signature header');
        return reply.status(401).send({ error: 'Missing signature' });
      }

      const rawBody = (request as any).rawBody as string | undefined;
      if (!rawBody) {
        app.log.warn('ElevenLabs webhook: rawBody not available');
        return reply.status(400).send({ error: 'Could not read raw body' });
      }

      if (!verifyElevenLabsSignature(rawBody, sigHeader, secret)) {
        app.log.warn('ElevenLabs webhook: invalid signature');
        return reply.status(401).send({ error: 'Invalid signature' });
      }
    }

    // 2. Parse conversation_id from body
    const body = request.body as Record<string, any>;
    const conversationId: string | undefined = body?.data?.conversation_id ?? body?.conversation_id;
    if (!conversationId) {
      app.log.warn({ body }, 'ElevenLabs webhook: no conversation_id in payload');
      return reply.status(400).send({ error: 'Missing conversation_id' });
    }

    app.log.info({ conversationId }, 'ElevenLabs conversation-end webhook received');

    // 3. Fetch full transcript from ElevenLabs
    const transcript = await service.fetchConversationTranscript(conversationId);
    if (!transcript || transcript.status !== 'done' || !transcript.transcript.length) {
      app.log.warn({ conversationId, status: transcript?.status }, 'ElevenLabs: transcript not ready or empty');
      return reply.status(200).send({ ok: true, skipped: true });
    }

    // 4. Find the conversation record linked to this ElevenLabs conversationId
    const [convo] = await app.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.channel, 'voice'),
          eq(conversations.channelRef, conversationId),
        ),
      )
      .limit(1);

    if (!convo) {
      app.log.warn({ conversationId }, 'ElevenLabs webhook: no matching conversation record — skipping storage');
      return reply.status(200).send({ ok: true, skipped: true });
    }

    // 5. Store each transcript turn as a message
    const turns = transcript.transcript.map((turn) => ({
      tenantId: convo.tenantId,
      conversationId: convo.id,
      direction: turn.role === 'agent' ? 'outbound' : 'inbound',
      role: turn.role === 'agent' ? 'agent' : 'lead',
      content: turn.message,
      contentType: 'transcript',
      metadata: turn.time_in_call_secs != null ? { timeInCallSecs: turn.time_in_call_secs } : {},
    }));

    if (turns.length > 0) {
      await app.db.insert(messages).values(turns);
    }

    // 6. Update conversation: mark ended, store AI-generated summary if available
    const summary = transcript.analysis?.transcript_summary;
    await app.db
      .update(conversations)
      .set({
        status: 'ended',
        ...(summary ? { summary } : {}),
        updatedAt: new Date(),
      } as any)
      .where(eq(conversations.id, convo.id));

    app.log.info(
      { conversationId, convoId: convo.id, turns: turns.length },
      'ElevenLabs transcript stored',
    );

    // 7. Trigger post-call flow if tenant has one configured
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
              flowContext: {
                callSummary: transcript.analysis?.transcript_summary ?? '',
              },
            },
            0,
          );
          app.log.info({ tenantId: convo.tenantId, leadId: convo.leadId, conversationId }, 'Post-call flow enqueued');
        }
      }
    } catch (err) {
      app.log.warn({ err, conversationId }, 'Post-call flow trigger failed — non-fatal');
    }

    return reply.status(200).send({ ok: true, turns: turns.length });
  });

  /**
   * Twilio recording-status webhook — fired when a conference recording is ready.
   * Looks up the conference by FriendlyName in Redis to resolve the tenant,
   * then enqueues a call-analysis job to transcribe and learn from the recording.
   *
   * To enable: set BASE_URL so Twilio can reach this endpoint at:
   *   POST /webhooks/voice/recording-status
   */
  app.post('/recording-status', async (request, reply) => {
    const params = request.body as Record<string, string>;

    // Verify Twilio signature
    const authToken = app.env.TWILIO_AUTH_TOKEN;
    if (authToken) {
      const signature = request.headers['x-twilio-signature'] as string | undefined;
      const baseUrl = app.env.BASE_URL ?? `https://${request.hostname}`;
      const webhookUrl = `${baseUrl}/webhooks/voice/recording-status`;
      if (!twilio.validateRequest(authToken, signature ?? '', webhookUrl, params)) {
        app.log.warn('Recording-status webhook: invalid Twilio signature');
        return reply.status(403).send();
      }
    }

    const { FriendlyName, RecordingSid, RecordingUrl, RecordingDuration, ConferenceSid, RecordingStatus } = params;

    // Only process completed recordings
    if (RecordingStatus !== 'completed') {
      return reply.status(204).send();
    }

    app.log.info({ FriendlyName, RecordingSid, ConferenceSid }, 'Conference recording ready');

    if (!FriendlyName || !RecordingSid || !RecordingUrl) {
      app.log.warn({ params }, 'Recording-status webhook: missing required fields');
      return reply.status(200).send({ ok: true, skipped: true });
    }

    // Resolve tenant from Redis mapping created when the monitor call was started
    const redisKey = `monitor_call:${FriendlyName}`;
    const mapping = await app.redis.get(redisKey);
    if (!mapping) {
      app.log.warn({ FriendlyName }, 'Recording-status webhook: no tenant mapping found — not a monitored call');
      return reply.status(200).send({ ok: true, skipped: true });
    }

    const { tenantId } = JSON.parse(mapping) as { tenantId: string };

    // Update the placeholder learning record with recording details
    await app.db
      .update(callLearnings)
      .set({
        conferenceSid: ConferenceSid ?? null,
        recordingSid: RecordingSid,
        recordingUrl: RecordingUrl,
      })
      .where(
        and(
          eq(callLearnings.tenantId, tenantId),
          eq(callLearnings.conferenceName, FriendlyName),
        ),
      );

    // Fetch the learning ID for the queue job
    const [row] = await app.db
      .select({ id: callLearnings.id })
      .from(callLearnings)
      .where(
        and(
          eq(callLearnings.tenantId, tenantId),
          eq(callLearnings.conferenceName, FriendlyName),
        ),
      )
      .limit(1);

    if (!row) {
      app.log.warn({ FriendlyName, tenantId }, 'Recording-status webhook: learning record not found');
      return reply.status(200).send({ ok: true, skipped: true });
    }

    // Enqueue the analysis job
    await enqueueCallAnalysis(app.queues.callAnalysis, {
      tenantId,
      learningId: row.id,
      recordingUrl: RecordingUrl,
      recordingSid: RecordingSid,
      durationSecs: RecordingDuration ? parseInt(RecordingDuration, 10) : 0,
    });

    app.log.info({ learningId: row.id, tenantId }, 'Call analysis job enqueued');
    return reply.status(200).send({ ok: true });
  });
}

/**
 * Verify ElevenLabs webhook signature.
 * Header format: ElevenLabs-Signature: t=<timestamp>,v0=<hmac_sha256_hex>
 * Signed content: "<timestamp>.<raw_body>"
 */
function verifyElevenLabsSignature(rawBody: string, header: string, secret: string): boolean {
  try {
    const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
    const timestamp = parts['t'];
    const signature = parts['v0'];
    if (!timestamp || !signature) return false;

    // Reject signatures older than 5 minutes
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

    const signed = `${timestamp}.${rawBody}`;
    const expected = createHmac('sha256', secret).update(signed).digest('hex');
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
