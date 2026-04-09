import type { FastifyInstance } from 'fastify';

export async function voiceRoutes(app: FastifyInstance) {
  app.post('/', async (request, reply) => {
    // TODO: Validate Twilio request signature
    // TODO: Route to ElevenLabs Conversational AI agent
    app.log.info({ body: request.body }, 'Voice webhook received');
    reply.type('text/xml').send(
      '<Response><Say>Thank you for calling. Our AI agent will be with you shortly.</Say></Response>'
    );
  });
}
