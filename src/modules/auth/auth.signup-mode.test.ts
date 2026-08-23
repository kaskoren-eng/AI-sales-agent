import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, createMockDb } from '../../test/helpers.js';
import { authRoutes } from './auth.routes.js';

/**
 * WHO MAY MINT A WORKSPACE.
 *
 * `POST /auth/register` does not create a user — it creates a TENANT, with an owner account
 * attached. It is unauthenticated by necessity, because obtaining a credential cannot itself
 * require one, and it sits outside the authenticate hook for that reason.
 *
 * Left open it means anyone who finds the API owns a workspace on a paid product, and since
 * Phase 5a a `usage_period` opens alongside it. That also contradicts how the product is sold:
 * provisioning is hybrid — ClickScales buys the DID, assigns it, and onboards the customer.
 * Nobody self-serves into a working agent, because a workspace with no number and no calendar
 * cannot do anything.
 *
 * So it defaults CLOSED. These tests pin that default, because the failure mode is invisible: an
 * open signup endpoint looks exactly like a closed one until you read the logs, and by then
 * strangers own tenants.
 */

/**
 * No RESEND_API_KEY here, deliberately. It used to be required — `authRoutes` built a Resend
 * client while registering, and the vendor constructor throws on an undefined key, so even tests
 * that never send a byte had to supply one. That workaround was the visible edge of a real bug:
 * an environment without a mailer could not boot the API. The client is lazy now, and the absence
 * of that line here is part of what proves it. See `config/optional-vendor-keys.test.ts`.
 *
 * SIGNUP_MODE is also deliberately unset: these tests assert the production DEFAULT, and a
 * deployment that forgets to configure it must be closed rather than open. Security that depends
 * on remembering to set an env var is not security.
 */
async function buildAuthApp(db: ReturnType<typeof createMockDb>, envOverrides: Record<string, string> = {}) {
  return buildTestApp({
    db,
    envOverrides: { ...envOverrides },
    registerRoutes: async (a) => { await a.register(authRoutes, { prefix: '/api/v1/auth' }); },
  });
}

const VALID_BODY = {
  email: 'stranger@example.com',
  password: 'a-long-enough-password',
  tenantName: 'Stranger Co',
};

describe('SIGNUP_MODE', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); });

  it('403s a registration attempt on the DEFAULT config — nothing needs setting to be safe', async () => {
    const db = createMockDb();
    app = await buildAuthApp(db);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('SIGNUP_CLOSED');
    // NOTHING was written. The tenant and user inserts must not have been reached at all.
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('refuses BEFORE validating the body, so it cannot be used to map the schema', async () => {
    // A closed endpoint that still returns field-level validation errors tells an anonymous caller
    // exactly what a workspace takes. There is no reason to answer that question.
    const db = createMockDb();
    app = await buildAuthApp(db);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ garbage: true }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('SIGNUP_CLOSED');
    // Not a 400/422 — an invalid body and a valid one are indistinguishable from outside.
    expect(JSON.stringify(res.json())).not.toMatch(/email|password|tenantName/i);
  });

  it('tells the caller what to do instead, rather than a bare "forbidden"', async () => {
    // The person hitting this is usually a real customer who was told to sign up. "Forbidden"
    // reads as a bug and generates a support email; naming the invite path does not.
    const db = createMockDb();
    app = await buildAuthApp(db);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.json().message).toMatch(/invit/i);
  });

  it('lets registration through when signup is explicitly opened', async () => {
    // The flag has to actually work, or "flip it the day self-serve trials become the plan" is a
    // promise nobody has tested. Reaching the body parser is the proof the gate opened; the
    // registration itself then fails on these bare mocks, which is fine — that is not this test's
    // subject.
    const db = createMockDb();
    app = await buildAuthApp(db, { SIGNUP_MODE: 'open' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'x', tenantName: '' }),
    });

    // Past the gate: it is now complaining about the BODY, not about being closed.
    expect(res.statusCode).not.toBe(403);
    expect(res.json().error).not.toBe('SIGNUP_CLOSED');
  });

  it('never gates the invite path — that is how a closed instance still adds people', async () => {
    // If SIGNUP_MODE accidentally covered accept-invite, an invite-only deployment would be an
    // deployment nobody new could ever join, including the colleagues an owner just invited.
    const db = createMockDb();
    app = await buildAuthApp(db);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/accept-invite',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'whatever', password: 'a-long-enough-password' }),
    });

    expect(res.statusCode).not.toBe(403);
  });
});
