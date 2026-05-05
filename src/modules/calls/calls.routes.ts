import fp from 'fastify-plugin';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { CallsService } from './calls.service.js';

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

async function callsRoutes(app: FastifyInstance) {
  const service = new CallsService({ db: app.db, redis: app.redis, env: app.env, logger: app.log });

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
  // GET /:id/audio — proxy ElevenLabs audio
  // -------------------------------------------------------------------------
  app.get(
    '/:id/audio',
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

      // 1. Verify call belongs to tenant and audio is available
      const audioCheck = await service.checkAudioAvailable(tenantId, id);

      if (audioCheck === null) {
        // Not found or wrong tenant / wrong channel
        return reply.status(404).send({ error: 'Call not found' });
      }

      if (audioCheck === false) {
        // Found but no channel_ref
        return reply.status(404).send({ error: 'No audio available for this call' });
      }

      const channelRef = audioCheck;

      // 2. Proxy to ElevenLabs
      const elRes = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversations/${channelRef}/audio`,
        {
          headers: {
            'xi-api-key': app.env.ELEVENLABS_API_KEY ?? '',
          },
        },
      );

      if (elRes.status === 404) {
        return reply.status(404).send({ error: 'Audio not yet available' });
      }

      if (!elRes.ok) {
        return reply.status(502).send({ error: 'Upstream audio fetch failed' });
      }

      // 3. Set response headers
      reply.header('Content-Type', 'audio/mpeg');
      reply.header('Content-Disposition', `inline; filename="call-${id}.mp3"`);
      reply.header('Cache-Control', 'private, max-age=3600');

      const contentLength = elRes.headers.get('content-length');
      if (contentLength) {
        reply.header('Content-Length', contentLength);
      }

      // 4. Stream body directly — do not buffer in memory
      if (!elRes.body) {
        return reply.status(502).send({ error: 'Upstream audio fetch failed' });
      }

      // Pipe using Node's raw response stream to avoid buffering the full audio
      const { Readable } = await import('node:stream');
      const nodeStream = Readable.fromWeb(elRes.body as import('stream/web').ReadableStream);

      return reply.send(nodeStream);
    },
  );
}

export default fp(callsRoutes);
