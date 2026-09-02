/**
 * Test helpers — builds a minimal Fastify app with mocked infrastructure.
 * No real DB, Redis, or queue connections are made.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import { AppError } from '../shared/errors.js';

export type MockDb = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
};

export type MockQueue = {
  add: ReturnType<typeof vi.fn>;
};

export function createMockDb(): MockDb {
  const db: MockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    // Runs the callback against the SAME mock, which is what drizzle's transaction does for a
    // caller's purposes. Without it, any route touching a transaction — usage metering, lead
    // deletion — fails inside its own try/catch and the test passes while logging an error nobody
    // reads. A fake that supports less than the real client makes tests quietly wrong.
    transaction: vi.fn(async (cb: (tx: MockDb) => Promise<unknown>) => cb(db)),
  };
  return db;
}

export function createMockQueue(): MockQueue {
  return { add: vi.fn().mockResolvedValue({ id: 'job-1' }) };
}

/**
 * Creates a minimal Fastify app with mocked db/redis/queues.
 * Registers auth and audit plugins and any provided route modules.
 */
export async function buildTestApp(
  opts: {
    db?: MockDb;
    registerRoutes?: (app: FastifyInstance) => Promise<void>;
    envOverrides?: Record<string, string>;
  } = {},
): Promise<FastifyInstance> {
  const db = opts.db ?? createMockDb();
  const mockQueue = createMockQueue();

  // Minimal test env
  const env = {
    NODE_ENV: 'test' as const,
    PORT: 3000,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent' as const,
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    ENCRYPTION_KEY: 'a'.repeat(64), // 32 bytes in hex
    JWT_SECRET: 'test-jwt-secret-minimum-16-chars',
    // Production's default. Registration is invite-only; the tests that exercise the open
    // mode set it explicitly, so nothing accidentally depends on signup being reachable.
    SIGNUP_MODE: 'invite_only' as const,
    CORS_ORIGINS: 'http://localhost:3001',
    AI_MODEL: 'gpt-5.4',
    CARTESIA_MODEL: 'sonic-3',
    OPENAI_REALTIME_MODEL: 'gpt-realtime-whisper',
    VOICE_LANGUAGE: 'he',
    VOICE_STT_PROMPT: '',
    VOICE_VAD_MIN_SILENCE_MS: 550,
    VOICE_ENDPOINTING_MIN_DELAY_MS: 500,
    VOICE_ENDPOINTING_MAX_DELAY_MS: 3000,
    VOICE_PREEMPTIVE_TTS: false,
    VOICE_PREEMPTIVE_PAUSE_MS: 0,
    VOICE_HOLD_CHECKBACK_MS: 7000,
    VOICE_INSTANT_ACK: false,
    VOICE_VAD_ACTIVATION_THRESHOLD: 0.5,
    VOICE_TTS_SPEED: 1,
    VOICE_TTS_VOLUME: 1,

    STT_PROVIDER: 'openai' as const,
    SONIOX_MODEL: 'stt-rt-v4',
    SONIOX_MAX_ENDPOINT_DELAY_MS: 500,
    VOICE_TURN_DETECTION: 'vad' as const,
    SHADOW_STT_ENABLED: false,
    VOICE_AMD_ENABLED: false,
    VOICE_STATE_MACHINE_ENABLED: true,
    VOICE_SPEECH_NUMBERS_ENABLED: true,
    VOICE_ACK_LEDGER_ENABLED: true,
    VOICE_REGISTER_NUDGE_ENABLED: true,
    VOICE_FACT_MEMORY_ENABLED: true,
    VOICE_ASK_INTENT_ENABLED: true,
    VOICE_NEGATION_SAFETY: true,
    VOICE_PHRASE_LEDGER_ENABLED: true,
    VOICE_SPOKEN_REGISTER_ENABLED: true,
    VOICE_DICTATION_NOD_ENABLED: true,
    VOICE_INTRO_ONCE_ENABLED: true,
    VOICE_ACK_EARNED_ENABLED: true,
    VOICE_FILLER_PAIRING_ENABLED: true,
    VOICE_OPENER_NO_REPEAT_ENABLED: true,
    VOICE_EMAIL_WHATSAPP_HANDBACK_ENABLED: true,
    VOICE_NO_PREAMBLE_ENABLED: true,
    VOICE_ENGAGEMENT_NOTE_ENABLED: true,
    VOICE_TTS_ROUTE: 'cartesia' as const,
    VOICE_TTS_PROVIDER: 'cartesia' as const,
    DEEPDUB_MODEL: 'dd-etts-3.2',
    DEEPDUB_REALTIME: true,
    DEEPDUB_LOCALE: 'he-IL',
    DEEPDUB_EU: true,
    DEEPDUB_SAMPLE_RATE: 24_000,
    DEEPDUB_ACCENT_RATIO: 0.75,
    ELEVENLABS_MODEL: 'eleven_flash_v2_5',
    ELEVENLABS_AUTO_MODE: false,
    ELEVENLABS_SYNC_ALIGNMENT: false,
    ELEVENLABS_USE_HTTP: false,
    VOICE_THINKING_FILLER_MS: 1200,
    VOICE_MAX_HISTORY_ITEMS: 0,
    VOICE_SILENCE_AWAY_MS: 7000,
    VOICE_EMAIL_DICTATION_ENABLED: true,
    VOICE_BOOK_WITHOUT_EMAIL: true,
    VOICE_TOOLCALL_LEAK_GUARD_ENABLED: true,
    VOICE_SILENCE_NUDGE_MS: 20000,
    VOICE_BOOKING_CLAIM_GUARD_WIDE: true,
    VOICE_BOOKING_NOTE_ENABLED: true,
    VOICE_CALLER_PHONE_KNOWN_ENABLED: true,
    VOICE_NAME_DICTATION_ENABLED: true,
    VOICE_LATE_DISQUALIFY_ENABLED: true,
    VOICE_END_CALL_CONFIRM_ENABLED: true,
    VOICE_ACK_EARNED_FROM_CONTEXT: true,
    VOICE_ONE_QUESTION_ENABLED: true,
    VOICE_SELF_NARRATION_GUARD_ENABLED: true,
    VOICE_CALL4_PROMPT_ENABLED: true,
    VOICE_SALES_MODEL_ENABLED: false,
    VOICE_ACK_ONLY_WHEN_NEEDED: true,
    VOICE_REPEAT_GUARD_ENABLED: true,
    VOICE_SLOT_MEMORY_ENABLED: true,
    VOICE_STOP_ANNOUNCE_GUARD_ENABLED: true,
    VOICE_PRODUCT_CLAIM_SLANG_GUARD: true,
    VOICE_VOICE_MODES_ENABLED: false,
    ...opts.envOverrides,
  };

  const app = Fastify({ logger: false });

  // Decorate with env and mocked infrastructure
  app.decorate('env', env);
  app.decorate('db', db as any);
  app.decorate('redis', { duplicate: vi.fn() } as any);
  app.decorate('queues', {
    messageProcessor: mockQueue,
    outboundSender: mockQueue,
    flowExecutor: mockQueue,
    deadLetter: mockQueue,
    csvImport: mockQueue,
    callAnalysis: mockQueue,
  } as any);

  // Register JWT + cookie (needed by auth plugin logic)
  await app.register(import('@fastify/jwt'), {
    secret: env.JWT_SECRET,
  });
  await app.register(import('@fastify/cookie'));

  // Auth decorator
  app.decorate('authenticate', async function (request: any, reply: any) {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Missing authorization header' });
      return;
    }
    const [, token] = authHeader.split(' ');
    if (token === 'test-token') {
      request.tenantId = 'tenant-test-uuid';
      request.authMethod = 'api_key';
      return;
    }
    reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Invalid credentials' });
  });

  // Audit hook (no-op in tests)
  app.addHook('onResponse', async () => {});

  // Health check
  app.get('/health', async () => ({ status: 'ok' }));

  // Error handler — must be registered before child plugins so it's in scope as fallback
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    reply.status((error as any).statusCode ?? 500).send({
      error: 'INTERNAL_ERROR',
      message: (error as Error).message,
    });
  });

  // Register caller-provided routes
  if (opts.registerRoutes) {
    await opts.registerRoutes(app);
  }

  await app.ready();
  return app;
}

/** Sign a JWT for testing authenticated routes */
export async function signTestJwt(
  app: FastifyInstance,
  payload: Record<string, unknown>,
): Promise<string> {
  return app.jwt.sign(payload);
}
