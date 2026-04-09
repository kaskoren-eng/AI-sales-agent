import type { FastifyInstance } from 'fastify';

export async function emailRoutes(app: FastifyInstance) {
  app.post('/', async (request, reply) => {
    // TODO: Validate Resend webhook signature
    // TODO: Parse inbound email, enqueue to message-processor
    app.log.info({ body: request.body }, 'Email webhook received');
    reply.status(200).send({ ok: true });
  });
}
