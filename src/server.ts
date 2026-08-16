import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { loadEnv, type Env } from './config/index.js';
import { AppError } from './shared/errors.js';

// Plugins
import databasePlugin from './plugins/database.js';
import redisPlugin from './plugins/redis.js';
import queuePlugin from './plugins/queue.js';
import authPlugin from './plugins/auth.js';
import auditPlugin from './plugins/audit.js';
import sentryPlugin from './plugins/sentry.js';
import healthPlugin from './plugins/health.js';

// Workers
import { createMessageProcessorWorker } from './queues/workers/message-processor.worker.js';
import { createOutboundSenderWorker } from './queues/workers/outbound-sender.worker.js';
import { createFlowExecutorWorker } from './queues/workers/flow-executor.worker.js';
import { createCsvImportWorker } from './queues/workers/csv-import.worker.js';
import { createCallAnalysisWorker } from './queues/workers/call-analysis.worker.js';
import { createMeetingRemindersWorker } from './queues/workers/meeting-reminders.worker.js';
import { WhatsAppService } from './modules/channels/whatsapp/whatsapp.service.js';
import { EmailService } from './modules/channels/email/email.service.js';
import { LiveKitVoiceService } from './modules/channels/voice-livekit/voice-livekit.service.js';
import webCallRoutes from './modules/channels/voice-livekit/web-call.routes.js';

// Modules
import leadsModule from './modules/leads/index.js';
import whatsappModule from './modules/channels/whatsapp/index.js';
import emailModule from './modules/channels/email/index.js';
import zadarmaModule from './modules/channels/zadarma/index.js';
import schedulingModule from './modules/scheduling/index.js';
import integrationsModule from './modules/integrations/index.js';
import leadIntakeModule from './modules/webhooks/index.js';
import tenantsModule from './modules/tenants/index.js';
import callsModule from './modules/calls/index.js';
import settingsModule from './modules/settings/index.js';
import adminModule from './modules/admin/index.js';
import metricsModule from './modules/metrics/index.js';
import authModule from './modules/auth/index.js';
import { membersRoutes } from './modules/auth/members.routes.js';
import {
  googleCalendarRoutes,
  googleCalendarPublicRoutes,
} from './modules/integrations/google-calendar/google-calendar.routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    env: Env;
    authenticate: (request: any, reply: any) => Promise<void>;
    sentry?: typeof import('@sentry/node');
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

  // --- Observability ---
  await app.register(sentryPlugin);

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
    app.sentry?.captureException(error);
    reply.status(500).send({
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    });
  });

  // --- Health checks (no auth) --- see src/plugins/health.ts
  await app.register(healthPlugin);

  // --- Webhook routes (signature-based auth, higher rate limit) ---
  await app.register(async (webhookScope) => {
    await webhookScope.register(rateLimit, {
      max: 200,
      timeWindow: '1 minute',
    });
    // Parse application/x-www-form-urlencoded (Zadarma webhooks)
    webhookScope.addContentTypeParser('application/x-www-form-urlencoded', { bodyLimit: 262_144 }, (req, body, done) => {
      let data = '';
      body.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      body.on('end', () => {
        try {
          const parsed = Object.fromEntries(new URLSearchParams(data));
          done(null, parsed);
        } catch (err) { done(err as Error, undefined); }
      });
    });

    // Parse JSON and keep the raw bytes on req.rawBody for signature verification.
    // Using Buffer.concat to avoid corrupting multi-byte UTF-8 chars split across chunks.
    webhookScope.addContentTypeParser('application/json', { bodyLimit: 262_144 }, (req, body, done) => {
      const chunks: Buffer[] = [];
      body.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      body.on('end', () => {
        try {
          const rawBuf = Buffer.concat(chunks);
          const rawStr = rawBuf.toString('utf8');
          (req as any).rawBody = rawStr;
          (req as any).rawBodyBuf = rawBuf;
          done(null, JSON.parse(rawStr));
        }
        catch (err) { done(err as Error, undefined); }
      });
    });

    await webhookScope.register(whatsappModule, { prefix: '/webhooks/whatsapp' });
    await webhookScope.register(emailModule, { prefix: '/webhooks/email' });
    // Zadarma recording notifications. Kept at the /webhooks/voice prefix: the URL is
    // registered in the Zadarma portal, and changing it would silently break call analysis.
    await webhookScope.register(zadarmaModule, { prefix: '/webhooks/voice' });
    await webhookScope.register(leadIntakeModule, { prefix: '/webhooks/leads' });
    // Google's OAuth redirect lands here. It is a top-level browser navigation, so there is no
    // Authorization header to authenticate with — the tenant travels in a signed, expiring `state`
    // parameter instead, verified in the route. See google-calendar.routes.ts.
    await webhookScope.register(googleCalendarPublicRoutes, { prefix: '/webhooks/google-calendar' });
  });

  // --- Auth routes ---
  // Their OWN scope, OUTSIDE the `authenticate` hook: /login and /refresh are how you obtain a
  // credential, so requiring one would be circular. Credential endpoints carry their own much
  // tighter IP rate limit inside the module.
  await app.register(authModule, { prefix: '/api/v1/auth' });

  // --- API routes (auth required, per-tenant rate limiting) ---
  await app.register(async (apiScope) => {
    // Per-tenant rate limiting: each tenant gets their own 200 req/min bucket.
    // Without this, one tenant hammering the API would slow down all others.
    await apiScope.register(rateLimit, {
      max: 200,
      timeWindow: '1 minute',
      keyGenerator: (request: any) => request.tenantId ?? request.ip,
    });

    apiScope.addHook('onRequest', app.authenticate);
    await apiScope.register(tenantsModule, { prefix: '/api/v1/tenants' });
    await apiScope.register(leadsModule, { prefix: '/api/v1/leads' });
    await apiScope.register(schedulingModule, { prefix: '/api/v1/scheduling' });
    await apiScope.register(integrationsModule, { prefix: '/api/v1/integrations' });
    await apiScope.register(callsModule, { prefix: '/api/v1/calls' });
    await apiScope.register(settingsModule, { prefix: '/api/v1/settings' });
    await apiScope.register(metricsModule, { prefix: '/api/v1/metrics' });
    await apiScope.register(membersRoutes, { prefix: '/api/v1/members' });
    await apiScope.register(googleCalendarRoutes, { prefix: '/api/v1/integrations/google-calendar' });
    // Browser voice simulation with the LiveKit agent — see web-call.routes.ts.
    await apiScope.register(webCallRoutes, { prefix: '/api/v1/voice' });
  });

  // --- Operator console (super-admin, cross-tenant) ---
  // Its OWN scope: NOT the per-tenant `authenticate` hook. Every route runs `requireAdmin`
  // (constant-time ADMIN_API_KEY check) inside the module. IP rate-limited to slow key guessing.
  await app.register(async (adminScope) => {
    await adminScope.register(rateLimit, {
      max: 60,
      timeWindow: '1 minute',
      keyGenerator: (request: any) => request.ip,
    });
    await adminScope.register(adminModule, { prefix: '/api/v1/admin' });
  });

  // --- Dashboard static files (production) ---
  // Serve the built React dashboard. In production the dist folder is copied into the image.
  // In development the dashboard runs on its own Vite dev server (port 3001).
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const dashboardDist = join(__dirname, '..', 'dashboard', 'dist');
  if (existsSync(dashboardDist)) {
    await app.register(staticFiles, { root: dashboardDist, prefix: '/' });
    // Serve index.html for all unmatched routes so React Router handles navigation
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html');
    });
  }

  // --- Workers ---
  const messageProcessorWorker = createMessageProcessorWorker({
    db: app.db,
    env,
    redis: app.redis,
    outboundQueue: app.queues.outboundSender,
    flowExecutorQueue: app.queues.flowExecutor,
    deadLetterQueue: app.queues.deadLetter,
    logger: app.log,
  });

  const whatsappService = new WhatsAppService(app);
  const emailService = new EmailService(app);
  // The one and only dialer. Constructing it throws when LiveKit isn't configured, so stay
  // undefined in that case rather than taking the whole app down at boot — the flow executor
  // skips call steps instead. There is no second engine to fall back to.
  let voiceLivekitService: LiveKitVoiceService | undefined;
  try {
    voiceLivekitService = new LiveKitVoiceService(env, { db: app.db, redis: app.redis });
  } catch {
    app.log.warn('LiveKit voice not configured — outbound calls will be skipped');
  }

  const outboundSenderWorker = createOutboundSenderWorker({
    db: app.db,
    redis: app.redis,
    deadLetterQueue: app.queues.deadLetter,
    whatsapp: whatsappService,
    email: emailService,
    logger: app.log,
  });

  const flowExecutorWorker = createFlowExecutorWorker({
    db: app.db,
    env,
    redis: app.redis,
    flowExecutorQueue: app.queues.flowExecutor,
    deadLetterQueue: app.queues.deadLetter,
    whatsapp: whatsappService,
    voiceLivekit: voiceLivekitService,
    email: emailService,
    logger: app.log,
  });

  const csvImportWorker = createCsvImportWorker({
    db: app.db,
    redis: app.redis,
    deadLetterQueue: app.queues.deadLetter,
  });

  const callAnalysisWorker = createCallAnalysisWorker({
    db: app.db,
    env,
    redis: app.redis,
    deadLetterQueue: app.queues.deadLetter,
  });

  const meetingRemindersWorker = createMeetingRemindersWorker({
    db: app.db,
    redis: app.redis,
    deadLetterQueue: app.queues.deadLetter,
    remindersQueue: app.queues.meetingReminders,
    whatsapp: whatsappService,
    email: emailService,
    logger: app.log,
  });

  app.addHook('onClose', async () => {
    await messageProcessorWorker.close();
    await outboundSenderWorker.close();
    await flowExecutorWorker.close();
    await csvImportWorker.close();
    await callAnalysisWorker.close();
    await meetingRemindersWorker.close();
  });

  return app;
}
