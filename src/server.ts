import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { loadEnv, type Env } from './config/index.js';
import { AppError } from './shared/errors.js';

// Plugins
import databasePlugin from './plugins/database.js';
import redisPlugin from './plugins/redis.js';
import queuePlugin from './plugins/queue.js';
import authPlugin from './plugins/auth.js';
import auditPlugin from './plugins/audit.js';

// Workers
import { createMessageProcessorWorker } from './queues/workers/message-processor.worker.js';
import { createOutboundSenderWorker } from './queues/workers/outbound-sender.worker.js';
import { createFlowExecutorWorker } from './queues/workers/flow-executor.worker.js';
import { WhatsAppService } from './modules/channels/whatsapp/whatsapp.service.js';
import { EmailService } from './modules/channels/email/email.service.js';
import { VoiceService } from './modules/channels/voice/voice.service.js';

// Modules
import leadsModule from './modules/leads/index.js';
import whatsappModule from './modules/channels/whatsapp/index.js';
import emailModule from './modules/channels/email/index.js';
import voiceModule from './modules/channels/voice/index.js';
import schedulingModule from './modules/scheduling/index.js';
import integrationsModule from './modules/integrations/index.js';
import leadIntakeModule from './modules/webhooks/index.js';
import tenantsModule from './modules/tenants/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    env: Env;
    authenticate: (request: any, reply: any) => Promise<void>;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const env = loadEnv();

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport: env.NODE_ENV === 'development'
        ? { target: 'pino-pretty' }
        : undefined,
    },
    bodyLimit: 1_048_576, // 1MB default
  });

  // Decorate env
  app.decorate('env', env);

  // --- Security ---
  await app.register(helmet);
  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()),
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // --- Infrastructure plugins ---
  await app.register(databasePlugin);
  await app.register(redisPlugin);
  await app.register(queuePlugin);

  // --- Auth + audit ---
  await app.register(authPlugin);
  await app.register(auditPlugin);

  // --- Global error handler (must be before route registration for scope fallback to work) ---
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
      });
      return;
    }

    request.log.error(error);
    reply.status(500).send({
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    });
  });

  // --- Health check (no auth) ---
  app.get('/health', async () => ({ status: 'ok' }));

  // --- Webhook routes (signature-based auth, higher rate limit) ---
  await app.register(async (webhookScope) => {
    await webhookScope.register(rateLimit, {
      max: 200,
      timeWindow: '1 minute',
    });
    webhookScope.addContentTypeParser('application/json', { bodyLimit: 262_144 }, (req, body, done) => {
      let data = '';
      body.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      body.on('end', () => {
        try { done(null, JSON.parse(data)); }
        catch (err) { done(err as Error, undefined); }
      });
    });

    await webhookScope.register(whatsappModule, { prefix: '/webhooks/whatsapp' });
    await webhookScope.register(emailModule, { prefix: '/webhooks/email' });
    await webhookScope.register(voiceModule, { prefix: '/webhooks/voice' });
    await webhookScope.register(leadIntakeModule, { prefix: '/webhooks/leads' });
  });

  // --- Tenant management (no auth for MVP — secure before production) ---
  await app.register(tenantsModule, { prefix: '/api/v1/tenants' });

  // --- API routes (auth required) ---
  await app.register(async (apiScope) => {
    apiScope.addHook('onRequest', app.authenticate);
    await apiScope.register(leadsModule, { prefix: '/api/v1/leads' });
    await apiScope.register(schedulingModule, { prefix: '/api/v1/scheduling' });
    await apiScope.register(integrationsModule, { prefix: '/api/v1/integrations' });
  });

  // --- Workers ---
  const messageProcessorWorker = createMessageProcessorWorker({
    db: app.db,
    env,
    redis: app.redis,
    outboundQueue: app.queues.outboundSender,
  });

  const whatsappService = new WhatsAppService(app);
  const emailService = new EmailService(app);
  const voiceService = new VoiceService(app);

  const outboundSenderWorker = createOutboundSenderWorker({
    db: app.db,
    redis: app.redis,
    whatsapp: whatsappService,
    email: emailService,
  });

  const flowExecutorWorker = createFlowExecutorWorker({
    db: app.db,
    env,
    redis: app.redis,
    flowExecutorQueue: app.queues.flowExecutor,
    whatsapp: whatsappService,
    voice: voiceService,
  });

  app.addHook('onClose', async () => {
    await messageProcessorWorker.close();
    await outboundSenderWorker.close();
    await flowExecutorWorker.close();
  });

  return app;
}
