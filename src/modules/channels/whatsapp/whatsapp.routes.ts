import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { WhatsAppService } from './whatsapp.service.js';
import { enqueueMessage } from '../../../queues/message-processor.queue.js';
import { isTimestampFresh } from '../../../shared/webhook-timestamp.js';

/**
 * Expected webhook payload from UChat's External Request action.
 * Configure UChat to POST this JSON structure to /webhooks/whatsapp.
 *
 * In UChat Flow Builder:
 * 1. Add an "External Request" action
 * 2. Set URL to: https://<your-domain>/webhooks/whatsapp
 * 3. Method: POST, Content-Type: application/json
 * 4. Add header: x-webhook-secret = <your UCHAT_WEBHOOK_SECRET>
 * 5. Map the body fields below from UChat variables:
 *    - user_ns: {{user_ns}}
 *    - phone: {{phone}}
 *    - name: {{name}}
 *    - message: {{last_user_input}}
 *
 * Tenant is resolved server-side from UCHAT_WEBHOOK_TENANT_ID — never from the body.
 */
const webhookPayloadSchema = z.object({
  user_ns: z.string().min(1),
  phone: z.string().min(1),
  name: z.string().optional(),
  message: z.string().min(1),
  // Optional fields UChat can forward
  channel: z.string().optional(),
  message_type: z.string().default('text'),
});

/**
 * Verify Twilio's X-Twilio-Signature header.
 * HMAC-SHA1(authToken, url + sorted_params_concat), base64-encoded.
 */
function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string): boolean {
  const sorted = Object.keys(params).sort();
  const data = url + sorted.map(k => k + params[k]).join('');
  const expected = createHmac('sha1', authToken).update(data).digest('base64');
  return expected === signature;
}

export async function whatsappRoutes(app: FastifyInstance) {
  const service = new WhatsAppService(app);

  /**
   * POST /webhooks/whatsapp/twilio — inbound WhatsApp messages from Twilio.
   *
   * Configure in Twilio Console → Phone Numbers → +15559689713 → Messaging → Webhook:
   *   https://<your-domain>/webhooks/whatsapp/twilio
   *   Method: HTTP POST
   */
  app.post('/twilio', async (request, reply) => {
    const { TWILIO_AUTH_TOKEN, TWILIO_ACCOUNT_SID, TWILIO_WHATSAPP_TENANT_ID } = app.env;

    if (!TWILIO_AUTH_TOKEN || !TWILIO_ACCOUNT_SID) {
      return reply.status(503).send({ error: 'Twilio not configured' });
    }

    // Verify Twilio signature
    const sig = request.headers['x-twilio-signature'] as string | undefined;
    if (sig && app.env.BASE_URL) {
      const fullUrl = `${app.env.BASE_URL}/webhooks/whatsapp/twilio`;
      const params = request.body as Record<string, string>;
      if (!verifyTwilioSignature(TWILIO_AUTH_TOKEN, fullUrl, params, sig)) {
        app.log.warn('Twilio WhatsApp webhook: invalid signature');
        return reply.status(403).send({ error: 'Invalid signature' });
      }
    }

    const body = request.body as Record<string, string>;
    const from = body['From']?.replace('whatsapp:', '') ?? '';
    const messageSid = body['MessageSid'] ?? '';
    const text = body['Body'] ?? '';

    if (!from || !text) {
      return reply.status(400).send({ error: 'Missing From or Body' });
    }

    const tenantId = TWILIO_WHATSAPP_TENANT_ID;
    if (!tenantId) {
      app.log.error('Twilio WhatsApp webhook: TWILIO_WHATSAPP_TENANT_ID not configured');
      return reply.status(503).send({ error: 'WhatsApp intake not configured' });
    }

    await enqueueMessage(app.queues.messageProcessor, {
      tenantId,
      channel: 'whatsapp',
      channelRef: messageSid,
      from,
      content: text,
      contentType: 'text',
      rawPayload: body,
    });

    app.log.info({ from, messageSid, tenantId }, 'Twilio WhatsApp message enqueued');

    // Twilio expects TwiML response (empty is fine — we send outbound separately)
    return reply.status(200).type('text/xml').send('<Response></Response>');
  });

  app.post('/', async (request, reply) => {
    // 1. Verify shared secret
    const secret = request.headers['x-webhook-secret'] as string | undefined;
    if (!service.verifyWebhookSecret(secret)) {
      app.log.warn('WhatsApp webhook: invalid secret');
      reply.status(401).send({ error: 'Invalid webhook secret' });
      return;
    }

    // 1b. Replay attack protection — reject stale requests (optional header)
    const ts = request.headers['x-timestamp'] as string | undefined;
    if (ts && !isTimestampFresh(Number(ts))) {
      app.log.warn({ ts }, 'WhatsApp webhook: stale timestamp — possible replay attack');
      reply.status(401).send({ error: 'Stale request' });
      return;
    }

    // 2. Parse and validate payload
    const parsed = webhookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      app.log.warn({ errors: parsed.error.flatten() }, 'WhatsApp webhook: invalid payload');
      reply.status(400).send({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
      return;
    }

    const { user_ns, phone, name, message, message_type } = parsed.data;

    // 3. Resolve tenant from server config — never from request body
    const tenantId = app.env.UCHAT_WEBHOOK_TENANT_ID;
    if (!tenantId) {
      app.log.error('WhatsApp webhook: UCHAT_WEBHOOK_TENANT_ID not configured');
      reply.status(503).send({ error: 'WhatsApp intake not configured' });
      return;
    }

    // 4. Enqueue for processing
    await enqueueMessage(app.queues.messageProcessor, {
      tenantId,
      channel: 'whatsapp',
      channelRef: user_ns,
      from: phone,
      content: message,
      contentType: message_type,
      rawPayload: request.body as Record<string, unknown>,
    });

    app.log.info({ phone, userNs: user_ns, tenantId }, 'WhatsApp message enqueued');

    // 4. Return 200 immediately — processing happens async in the worker
    reply.status(200).send({ ok: true });
  });
}
