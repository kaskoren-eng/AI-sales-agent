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
    leftJoin: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return b;
}

const VALID_SID = '11111111-1111-1111-1111-111111111111';

/** A live session row, as loadSession() returns it. */
function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: VALID_SID,
    userId: 'user-sub-123',
    tenantId: 'tenant-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    role: 'member',
    ...over,
  };
}

/**
 * The JWT path makes up to two queries, in order: loadSession, then the tenant-status lookup
 * (only on a cache miss). Mock them in that order.
 */
function mockJwtFlow(
  db: ReturnType<typeof createMockDb>,
  opts: { session?: Record<string, unknown> | null; tenant?: Record<string, unknown> | null } = {},
) {
  const session = opts.session === undefined ? sessionRow() : opts.session;
  const tenant = opts.tenant === undefined ? { isActive: true } : opts.tenant;
  db.select
    .mockReturnValueOnce(makeSelectChain(session ? [session] : []))
    .mockReturnValueOnce(makeSelectChain(tenant ? [tenant] : []));
}

/** Sign an access token the way the auth module will: tenant + subject + session id. */
function signAccess(app: FastifyInstance, claims: Record<string, unknown>) {
  return app.jwt.sign({ sid: VALID_SID, ...claims });
}

/**
 * Redis stand-in for the tenant-status cache. Defaults to a permanent cache MISS so that every
 * test exercises the Postgres fallback path unless it deliberately seeds the cache.
 */
function makeMockRedis(opts: { get?: (k: string) => Promise<string | null> } = {}) {
  return {
    duplicate: vi.fn(),
    get: vi.fn(opts.get ?? (async () => null)),
    setex: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
  } as any;
}

async function buildAuthTestApp(db: ReturnType<typeof createMockDb>, redis = makeMockRedis()) {
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
    // Production's default. Registration is invite-only; the tests that exercise the open
    // mode set it explicitly, so nothing accidentally depends on signup being reachable.
    SIGNUP_MODE: 'invite_only' as const,
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
    VOICE_ACK_LEDGER_ENABLED: true,
    VOICE_REGISTER_NUDGE_ENABLED: true,
    VOICE_FACT_MEMORY_ENABLED: true,
    VOICE_NEGATION_SAFETY: true,
    VOICE_PHRASE_LEDGER_ENABLED: true,
    VOICE_SPOKEN_REGISTER_ENABLED: true,
    VOICE_DICTATION_NOD_ENABLED: true,
    VOICE_INTRO_ONCE_ENABLED: true,
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
  app.decorate('redis', redis);
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

    // A signed token is no longer sufficient on its own: it must name a live session belonging
    // to the claimed tenant, and that tenant must exist and be active.
    mockJwtFlow(db, {
      session: sessionRow({ tenantId, userId }),
      tenant: { isActive: true },
    });

    app = await buildAuthTestApp(db);

    const token = signAccess(app, { tenantId, sub: userId });

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

  it('JWT for a tenant that does not exist → 401', async () => {
    // THIS TEST WAS INVERTED. It previously asserted that a valid-looking JWT was accepted even
    // when the database had no such tenant — "JWT is tried first, so the DB is never queried" —
    // which is the vulnerability written down as a requirement. Anyone holding JWT_SECRET could
    // mint a token for any tenantId, including deleted ones, and be trusted without a lookup.
    // Harmless only while nothing minted JWTs; the moment login shipped it became the primary
    // auth path.
    mockJwtFlow(db, {
      session: sessionRow({ tenantId: 'tenant-that-was-deleted' }),
      tenant: null,
    });

    app = await buildAuthTestApp(db);
    const token = signAccess(app, { tenantId: 'tenant-that-was-deleted', sub: 'user-1' });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it('JWT for an existing, active tenant is accepted', async () => {
    const tenantId = 'tenant-dual-jwt';
    mockJwtFlow(db, { session: sessionRow({ tenantId }), tenant: { isActive: true } });

    app = await buildAuthTestApp(db);
    const token = signAccess(app, { tenantId, sub: 'user-1' });

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
    db.select.mockReturnValue(makeSelectChain([{ id: tenantId, isActive: true }]));

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

// ──────────────────────────────────────────────────────────────────────────
// Forged tokens
//
// JWT_SECRET is present in four .env files in the working tree, one of them flagged in
// PROJECT_STATUS.md as exposed. These tests assert the property that makes that survivable:
// signing a token is not enough, because access requires a session row the attacker cannot
// create. Rotating the secret is still necessary — this is what stops the NEXT leak.
// ──────────────────────────────────────────────────────────────────────────

describe('auth plugin — a leaked JWT_SECRET is not a master key', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('a perfectly signed token with no session claim → 401', async () => {
    db.select.mockReturnValue(makeSelectChain([{ isActive: true }]));
    app = await buildAuthTestApp(db);

    // Exactly what an attacker with the secret would produce: correct signature, active tenant.
    const forged = app.jwt.sign({ tenantId: 'tenant-clickscales', sub: 'attacker' });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it('a perfectly signed token naming a session that does not exist → 401', async () => {
    // The session lookup resolves to nothing.
    db.select.mockReturnValue(makeSelectChain([]));
    app = await buildAuthTestApp(db);

    const forged = app.jwt.sign({
      tenantId: 'tenant-clickscales',
      sub: 'attacker',
      sid: '00000000-0000-0000-0000-000000000000',
      rol: 'owner', // claiming owner buys nothing — role is read from tenant_members
    });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(res.statusCode).toBe(401);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Suspension enforcement
//
// `tenants.isActive` shipped in the first migration and the operator console has had a
// suspend switch for as long as the admin module has existed — and NOTHING read the flag.
// Suspending a tenant changed nothing: their key kept working and their agent kept dialling
// on our provider bill. These tests are the enforcement that was missing.
// ──────────────────────────────────────────────────────────────────────────

describe('auth plugin — suspended tenants', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('API key belonging to a suspended tenant → 403', async () => {
    db.select.mockReturnValue(makeSelectChain([{ id: 'tenant-suspended', isActive: false }]));

    app = await buildAuthTestApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer some-api-key' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('FORBIDDEN');
  });

  it('JWT for a suspended tenant → 403', async () => {
    mockJwtFlow(db, {
      session: sessionRow({ tenantId: 'tenant-suspended' }),
      tenant: { isActive: false },
    });

    app = await buildAuthTestApp(db);
    const token = signAccess(app, { tenantId: 'tenant-suspended', sub: 'user-1' });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('honours a cached "inactive" without querying Postgres', async () => {
    const redis = makeMockRedis({ get: async () => 'inactive' });
    // One query only — the session lookup. The tenant read must be served from cache.
    db.select.mockReturnValueOnce(makeSelectChain([sessionRow({ tenantId: 'tenant-suspended' })]));

    app = await buildAuthTestApp(db, redis);
    const token = signAccess(app, { tenantId: 'tenant-suspended', sub: 'user-1' });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    expect(db.select).toHaveBeenCalledTimes(1); // session only, no tenant read
  });

  it('falls back to Postgres — never to "allow" — when Redis is down', async () => {
    // The failure policy that matters: a cache outage must not silently disable suspension.
    const redis = makeMockRedis({
      get: async () => {
        throw new Error('redis down');
      },
    });
    mockJwtFlow(db, {
      session: sessionRow({ tenantId: 'tenant-suspended' }),
      tenant: { isActive: false },
    });

    app = await buildAuthTestApp(db, redis);
    const token = signAccess(app, { tenantId: 'tenant-suspended', sub: 'user-1' });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    expect(db.select).toHaveBeenCalled();
  });

  it('caches the tenant status after a Postgres read', async () => {
    const redis = makeMockRedis();
    mockJwtFlow(db, { session: sessionRow({ tenantId: 'tenant-active' }), tenant: { isActive: true } });

    app = await buildAuthTestApp(db, redis);
    const token = signAccess(app, { tenantId: 'tenant-active', sub: 'user-1' });

    await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(redis.setex).toHaveBeenCalledWith('tenant:status:tenant-active', 30, 'active');
  });

  it('treats isActive = null as active (legacy rows predate the default)', async () => {
    db.select.mockReturnValue(makeSelectChain([{ id: 'tenant-legacy', isActive: null }]));

    app = await buildAuthTestApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer some-api-key' },
    });

    expect(res.statusCode).toBe(200);
  });
});
