import { createHmac, timingSafeEqual } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { enqueueMessage } from '../../../queues/message-processor.queue.js';

// Resend signs webhooks via svix: HMAC-SHA256 over "{svix-id}.{svix-timestamp}.{raw_body}"
// Headers: svix-id, svix-timestamp, svix-signature ("v1,<base64> ...")
function verifyResendSignature(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): boolean {
  const msgId = String(headers['svix-id'] ?? '');
  const timestamp = String(headers['svix-timestamp'] ?? '');
  const signature = String(headers['svix-signature'] ?? '');

  if (!msgId || !timestamp || !signature) return false;

  // Reject messages older than 5 minutes
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const signedContent = `${msgId}.${timestamp}.${rawBody}`;
  const expected = createHmac('sha256', secret).update(signedContent).digest('base64');

  const sigs = signature.split(' ').map((s) => s.replace(/^v1,/, ''));
  return sigs.some((sig) => {
    try {
      return timingSafeEqual(Buffer.from(sig, 'base64'), Buffer.from(expected, 'base64'));
    } catch {
      return false;
    }
  });
}

export async function emailRoutes(app: FastifyInstance) {
  app.post<{ Body: Record<string, any> }>('/', async (request, reply) => {
    const webhookSecret = app.env.RESEND_WEBHOOK_SECRET;
    if (!webhookSecret) {
      app.log.warn('Email webhook: RESEND_WEBHOOK_SECRET not configured — rejecting request');
      return reply.status(401).send({ error: 'Webhook secret not configured' });
    }
    const rawBody: string = (request as any).rawBody ?? JSON.stringify(request.body);
    const valid = verifyResendSignature(rawBody, request.headers as any, webhookSecret);
    if (!valid) {
      app.log.warn('Email webhook: invalid signature');
      return reply.status(401).send({ error: 'Invalid signature' });
    }

    const body = request.body;
    app.log.info({ type: body?.type }, 'Email webhook received');

    // Only process inbound email events
    if (body?.type !== 'email.received') {
      return reply.status(200).send({ ok: true });
    }

    const data: Record<string, any> = body?.data ?? {};
    const from: string = data?.from ?? '';
    const subject: string = data?.subject ?? '(no subject)';
    const text: string = data?.text ?? data?.html ?? '';

    if (!from) {
      return reply.status(400).send({ error: 'Missing from address' });
    }

    // For MVP, route to the tenant configured in RESEND_INBOUND_TENANT_ID.
    // Multi-tenant routing (e.g. via To address) is a Phase 3 concern.
    const tenantId = app.env.RESEND_INBOUND_TENANT_ID;
    if (!tenantId) {
      app.log.warn('Email webhook: RESEND_INBOUND_TENANT_ID not set — cannot route inbound email');
      return reply.status(200).send({ ok: true });
    }

    await enqueueMessage(app.queues.messageProcessor, {
      tenantId,
      channel: 'email',
      channelRef: data?.email_id ?? from,
      from,
      content: `Subject: ${subject}\n\n${text}`,
      contentType: 'text',
      rawPayload: data,
    });

    return reply.status(200).send({ ok: true });
  });
}
