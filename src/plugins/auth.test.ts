import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, createMockDb } from '../test/helpers.js';

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function hashApiKey(key: string) {
  return createHash('sha256').update(key).digest('hex');
}

/** Build a query-builder chain that always resolves to `rows`. */
function makeSelectChain(rows: any[]) {
  const b: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return b;
}

/**
 * Build a test app that mounts the *real* auth plugin (not the stub from
 * helpers.ts) plus a protected route so we can exercise it end-to-end.
 */
async function buildAuthTestApp(db: ReturnType<typeof createMockDb>) {
  // We build a Fastify instance using the helpers' base, then swap the
  // `authenticate` decorator for the real one.
  const Fastify = (await import('fastify')).default;
  const fp = (await import('fastify-plugin')).default;

  const env = {
    NODE_ENV: 'test' as const,
    PORT: 3000,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent' as const,
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    ENCRYPTION_KEY: 'a'.repeat(64),
    JWT_SECRET: 'test-jwt-secret-minimum-16-chars',
    CORS_ORIGINS: 'http://localhost:3001',
    AI_MODEL: 'gemini-2.5-flash',
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
    VOICE_PHRASE_LEDGER_ENABLED: true,
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
  };

  const app = Fastify({ logger: false });
  app.decorate('env', env);
  app.decorate('db', db as any);
  app.decorate('redis', { duplicate: vi.fn() } as any);
  app.decorate('queues', {} as any);

  // Register the real auth plugin
  const authPlugin = (await import('./auth.js')).default;
  await app.register(authPlugin);

  // Error handler
  const { AppError } = await import('../shared/errors.js');
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    reply.status((error as any).statusCode ?? 500).send({
      error: 'INTERNAL_ERROR',
      message: (error as Error).message,
    });
  });

  // A protected route
  app.get('/protected', { preHandler: app.authenticate }, async (req: any) => ({
    tenantId: req.tenantId,
    authMethod: req.authMethod,
    userId: req.userId ?? null,
  }));

  await app.ready();
  return app;
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe('auth plugin — API key', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('valid API key passes and sets tenantId + authMethod', async () => {
    const tenantId = 'tenant-uuid-123';
    const rawKey = 'my-raw-api-key';
    const hashed = hashApiKey(rawKey);

    // The auth plugin queries tenants.id == hashed key
    db.select.mockReturnValue(makeSelectChain([{ id: tenantId }]));

    app = await buildAuthTestApp(db);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${rawKey}` },
    });

    // JWT verify will fail (not a JWT), so it falls through to API key path.
    // The DB query will match and return the tenant.
    // NOTE: the plugin uses eq(tenants.id, hashedKey) — so `tenant.id` is the
    // UUID returned from the row, not the hash.
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenantId).toBe(tenantId);
    expect(body.authMethod).toBe('api_key');
  });

  it('unknown API key → 401', async () => {
    // No tenant found
    db.select.mockReturnValue(makeSelectChain([]));

    app = await buildAuthTestApp(db);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer unknown-key' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHORIZED');
  });

  it('missing Authorization header → 401', async () => {
    app = await buildAuthTestApp(db);

    const res = await app.inject({ method: 'GET', url: '/protected' });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHORIZED');
    expect(res.json().message).toMatch(/missing authorization header/i);
  });

  it('Authorization header with wrong scheme → 401', async () => {
    app = await buildAuthTestApp(db);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('auth plugin — JWT', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('valid JWT passes and sets tenantId + userId + authMethod', async () => {
    const tenantId = 'tenant-jwt-uuid';
    const userId = 'user-sub-123';

    // DB should NOT be called for JWT — but mock it just in case
    db.select.mockReturnValue(makeSelectChain([]));

    app = await buildAuthTestApp(db);

    // Sign with the same secret the plugin uses
    const token = app.jwt.sign({ tenantId, sub: userId });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenantId).toBe(tenantId);
    expect(body.userId).toBe(userId);
    expect(body.authMethod).toBe('jwt');
  });

  it('expired JWT → 401', async () => {
    db.select.mockReturnValue(makeSelectChain([]));

    app = await buildAuthTestApp(db);

    // Sign with very short expiry — use past iat trick
    const token = app.jwt.sign({ tenantId: 't1', sub: 'u1', exp: Math.floor(Date.now() / 1000) - 100 });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it('malformed JWT → 401', async () => {
    db.select.mockReturnValue(makeSelectChain([]));

    app = await buildAuthTestApp(db);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer not.a.jwt.at.all' },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('auth plugin — dual auth (both paths work on API routes)', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('JWT path works when DB returns no tenant', async () => {
    // JWT is tried first — if valid, DB is never queried
    db.select.mockReturnValue(makeSelectChain([]));

    app = await buildAuthTestApp(db);

    const tenantId = 'tenant-dual-jwt';
    const token = app.jwt.sign({ tenantId, sub: 'user-1' });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().authMethod).toBe('jwt');
    expect(res.json().tenantId).toBe(tenantId);
  });

  it('API key path works when token is not a JWT', async () => {
    const tenantId = 'tenant-dual-apikey';
    db.select.mockReturnValue(makeSelectChain([{ id: tenantId }]));

    app = await buildAuthTestApp(db);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer plain-api-key-not-a-jwt' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().authMethod).toBe('api_key');
    expect(res.json().tenantId).toBe(tenantId);
  });
});
