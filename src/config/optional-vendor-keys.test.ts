import { describe, expect, it, vi } from 'vitest';
import { buildTestApp, createMockDb } from '../test/helpers.js';
import { authRoutes } from '../modules/auth/auth.routes.js';
import { membersRoutes } from '../modules/auth/members.routes.js';
import { AuthService } from '../modules/auth/auth.service.js';
import { EmailService } from '../modules/channels/email/email.service.js';
import { CallAnalysisService } from '../modules/calls/call-analysis.service.js';
import { AIEngineService } from '../modules/ai-engine/ai-engine.service.js';
import type { Env } from './env.js';
import type { FastifyInstance } from 'fastify';

/**
 * AN OPTIONAL KEY MUST NOT BE FATAL AT BOOT.
 *
 * `RESEND_API_KEY` and `OPENAI_API_KEY` are both `.optional()` in env.ts — a deliberate promise
 * that the API runs without a mailer and without OpenAI, with those features degraded. Three
 * services broke that promise the same way: they built their vendor client in the constructor, and
 * `new Resend(undefined)` / `new OpenAI({ apiKey: undefined })` throw from inside the vendor's own
 * code. Two of those constructors run at boot — `authRoutes` and `membersRoutes` registering, and
 * `createCallAnalysisWorker` — so the process died during startup with a third-party stack trace
 * naming nothing an operator could act on.
 *
 * Nobody noticed because the only environment anyone had stood up already had both keys. It
 * surfaces the first time someone builds a NEW one: staging, a DR restore, a second region, a new
 * developer's first `npm run dev`. That is exactly when a clear error is worth the most and a
 * mystery costs the most.
 *
 * Two contracts, and both halves matter: the process BOOTS without the key, and the feature then
 * fails at the point of use with OUR error naming the variable to set. Booting quietly and then
 * failing silently would only move the mystery further from its cause.
 */

const envWithout = (keys: string[]) => {
  const env: Record<string, unknown> = {
    AI_MODEL: 'gpt-5.4',
    OPENAI_API_KEY: 'sk-test',
    RESEND_API_KEY: 're_test',
  };
  for (const k of keys) delete env[k];
  return env as unknown as Env;
};

describe('a missing RESEND_API_KEY', () => {
  it('does not stop authRoutes registering', async () => {
    // The exact failure: `new Resend(undefined)` threw "Missing API key" while this plugin
    // registered, so `buildApp()` rejected and the whole API was down — not just email.
    const app = await buildTestApp({
      registerRoutes: async (a) => {
        await a.register(authRoutes, { prefix: '/api/v1/auth' });
      },
    });

    await expect(app.ready()).resolves.toBeDefined();
    await app.close();
  });

  it('does not stop membersRoutes registering', async () => {
    const app = await buildTestApp({
      registerRoutes: async (a) => {
        await a.register(membersRoutes, { prefix: '/api/v1/members' });
      },
    });

    await expect(app.ready()).resolves.toBeDefined();
    await app.close();
  });

  it('reports itself through `configured`, so callers can pick a fallback', () => {
    const withKey = new EmailService({
      env: { RESEND_API_KEY: 're_x' },
      log: {},
    } as unknown as FastifyInstance);
    const without = new EmailService({ env: {}, log: {} } as unknown as FastifyInstance);

    expect(withKey.configured).toBe(true);
    expect(without.configured).toBe(false);
  });

  it('makes sendEmail a logged no-op rather than a crash', async () => {
    const warn = vi.fn();
    const svc = new EmailService({ env: {}, log: { warn } } as unknown as FastifyInstance);

    await expect(svc.sendEmail('a@b.co', 'Subject', '<p>body</p>')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[1])).toMatch(/RESEND_API_KEY/);
  });
});

describe('an invite that cannot be mailed', () => {
  /**
   * The fallback that was broken. `membersRoutes` returns the raw token when an invite cannot be
   * delivered, so an operator can still onboard someone by hand — but it decided that on
   * `DASHBOARD_BASE_URL` alone. With a base URL set and no mailer it answered `{ sent: true }` for
   * a mail dropped on the floor, and the admin had no other copy of the token. Half-configured is
   * the normal state of a new environment, not an edge case.
   */
  async function inviteApp(envOverrides: Record<string, string>) {
    vi.spyOn(AuthService.prototype, 'createInvite').mockResolvedValue({
      token: 'inv_raw_token',
    } as Awaited<ReturnType<AuthService['createInvite']>>);

    return buildTestApp({
      db: createMockDb(),
      envOverrides: { DASHBOARD_BASE_URL: 'https://app.example.test', ...envOverrides },
      registerRoutes: async (a) => {
        // An invite is a person acting, not a machine: give the request a real user session with
        // an owner role, which is what `requireRole('admin')` and the route both expect.
        a.addHook('onRequest', async (request) => {
          Object.assign(request, { userId: 'user-1', tenantId: 'tenant-test-uuid', role: 'owner' });
        });
        await a.register(membersRoutes, { prefix: '/api/v1/members' });
      },
    });
  }

  it('hands the operator the raw token when there is no mailer', async () => {
    const app = await inviteApp({});

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/members/invites',
      headers: { authorization: 'Bearer test-token' },
      payload: { email: 'colleague@example.test', role: 'admin' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ sent: false, token: 'inv_raw_token' });
    await app.close();
  });

  it('keeps the token on the server once it can actually be sent', async () => {
    const app = await inviteApp({ RESEND_API_KEY: 're_test_key' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/members/invites',
      headers: { authorization: 'Bearer test-token' },
      payload: { email: 'colleague@example.test', role: 'admin' },
    });

    expect(res.json()).toEqual({ sent: true });
    await app.close();
  });
});

describe('a missing OPENAI_API_KEY', () => {
  it('lets CallAnalysisService be constructed — the worker builds it at boot', () => {
    expect(() => new CallAnalysisService(envWithout(['OPENAI_API_KEY']))).not.toThrow();
  });

  it('lets AIEngineService be constructed', () => {
    expect(() => new AIEngineService(envWithout(['OPENAI_API_KEY']))).not.toThrow();
  });

  it('fails transcription with OUR error, naming the variable to set', async () => {
    const svc = new CallAnalysisService(envWithout(['OPENAI_API_KEY']));

    // Not "Missing credentials. Please pass an `apiKey`…" — that sentence sends an operator to the
    // OpenAI SDK's source instead of to their own env file.
    await expect(svc.analyzeTranscript([{ speaker: 'lead', text: 'hello' }])).rejects.toThrow(
      /OPENAI_API_KEY/,
    );
    await expect(
      svc.analyzeTranscript([{ speaker: 'lead', text: 'hello' }]),
    ).rejects.toMatchObject({ statusCode: 503, code: 'OPENAI_NOT_CONFIGURED' });
  });

  it('fails AI replies with the same error', async () => {
    const svc = new AIEngineService(envWithout(['OPENAI_API_KEY']));

    await expect(
      svc.generateResponse({ systemPrompt: 'x', conversationHistory: [] }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'OPENAI_NOT_CONFIGURED' });
  });

  it('still constructs normally when the key IS present', () => {
    // The lazy getter must not have made the configured path conditional on anything else.
    expect(() => new CallAnalysisService(envWithout([]))).not.toThrow();
    expect(() => new AIEngineService(envWithout([]))).not.toThrow();
  });
});
