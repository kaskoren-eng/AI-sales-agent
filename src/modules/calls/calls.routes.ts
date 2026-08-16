import fp from 'fastify-plugin';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { CallsService } from './calls.service.js';
import { LiveKitVoiceService } from '../channels/voice-livekit/voice-livekit.service.js';

// ---------------------------------------------------------------------------
// Query / param schemas
// ---------------------------------------------------------------------------

const listCallsQuerySchema = z.object({
  status: z.enum(['active', 'ended']).optional(),
  qualification: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const callIdParamSchema = z.object({
  id: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const outboundCallBodySchema = z.object({
  to: z.string().min(7),
  leadName: z.string().optional(),
  leadEmail: z.string().optional(),
});

async function callsRoutes(app: FastifyInstance) {
  const service = new CallsService({ db: app.db, redis: app.redis, env: app.env, logger: app.log });

  // Constructing the dialer throws when LiveKit isn't configured. Stay undefined and 503 the
  // outbound route rather than failing plugin registration and taking the whole API down.
  let voiceService: LiveKitVoiceService | undefined;
  try {
    voiceService = new LiveKitVoiceService(app.env, { db: app.db, redis: app.redis });
  } catch {
    app.log.warn('LiveKit voice not configured — POST /calls/outbound will return 503');
  }

  // -------------------------------------------------------------------------
  // GET / — list calls
  // -------------------------------------------------------------------------
  app.get(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['active', 'ended'] },
            qualification: { type: 'string' },
            from: { type: 'string' },
            to: { type: 'string' },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const query = listCallsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.status(422).send({
          error: 'VALIDATION_ERROR',
          message: 'Invalid query parameters',
          details: query.error.flatten().fieldErrors,
        });
      }

      const { status, qualification, from, to, page, limit } = query.data;
      const tenantId = request.tenantId;

      const { calls, total } = await service.listCalls({
        tenantId,
        status,
        qualification,
        from,
        to,
        page,
        limit,
      });

      const totalPages = Math.ceil(total / limit);

      return reply.status(200).send({
        data: calls,
        meta: {
          page,
          limit,
          total,
          total_pages: totalPages,
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /:id — call detail
  // -------------------------------------------------------------------------
  app.get(
    '/:id',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const params = callIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(404).send({ error: 'Call not found' });
      }

      const { id } = params.data;
      const tenantId = request.tenantId;

      const call = await service.getCall(tenantId, id);

      if (!call) {
        return reply.status(404).send({ error: 'Call not found' });
      }

      return reply.status(200).send(call);
    },
  );

  // -------------------------------------------------------------------------
  // POST /outbound — initiate an outbound call via the LiveKit agent
  // -------------------------------------------------------------------------
  app.post('/outbound', async (request, reply) => {
    const body = outboundCallBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(422).send({ error: 'VALIDATION_ERROR', details: body.error.flatten().fieldErrors });
    }

    if (!voiceService) {
      return reply.status(503).send({ error: 'Voice engine not configured' });
    }

    const { to, leadName, leadEmail } = body.data;
    const tenantId = request.tenantId;

    const result = await voiceService.initiateOutboundCall(to, tenantId, {
      name: leadName,
      email: leadEmail,
    });

    return reply.status(200).send({ ok: true, callId: result.callId });
  });
}

export default fp(callsRoutes);
