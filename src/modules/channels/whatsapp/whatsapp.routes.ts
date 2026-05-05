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

export async function whatsappRoutes(app: FastifyInstance) {
  const service = new WhatsAppService(app);

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
