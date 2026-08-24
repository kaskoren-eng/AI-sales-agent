import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import settingsModule from './index.js';

/**
 * WHERE THE SETTINGS ROUTES ACTUALLY LIVE.
 *
 * `src/modules/settings/index.ts` was wrapped in `fastify-plugin`. `fp()` makes a plugin
 * transparent to encapsulation — correct for anything that decorates the instance, wrong for a
 * bundle of routes, because transparency also discards the `{ prefix }` it was registered with. So
 * `apiScope.register(settingsModule, { prefix: '/api/v1/settings' })` mounted every settings route
 * at the ROOT. The real path in production was `/agent-persona`.
 *
 * It survived to production because the SPA not-found handler answered `/api/v1/settings/...` with
 * `200 text/html`. Two bugs, and the second hid the first: every call to the correct-looking path
 * came back with a success status carrying the dashboard's index.html, so no 404 was ever logged
 * and no client ever saw an error status. Both are fixed; both are pinned here and in
 * `server.notfound.test.ts`.
 *
 * The assertion is deliberately about the ROUTE TABLE rather than a request, because a request
 * against the wrong path would 404 — which is indistinguishable from "the route exists but the
 * test's auth is wrong".
 */

describe('the settings module honours its prefix', () => {
  it('mounts under the prefix it is registered with, not at the root', async () => {
    const app = Fastify({ logger: false });
    // The routes read `request.tenantId`; nothing here calls a handler, but registration must not
    // depend on decorators the real app adds.
    app.decorate('db', {} as never);
    app.decorate('env', {} as never);

    await app.register(settingsModule, { prefix: '/api/v1/settings' });
    await app.ready();

    const routes = app.printRoutes({ commonPrefix: false });

    expect(routes).toContain('/api/v1/settings/agent-persona');
    // The exact shape of the bug: a bare top-level route with no prefix.
    expect(routes).not.toMatch(/^\s*└──\s*agent-persona/m);

    await app.close();
  });

  it('registers more than one settings route under the prefix', async () => {
    // Guards against a fix that special-cases one path.
    const app = Fastify({ logger: false });
    app.decorate('db', {} as never);
    app.decorate('env', {} as never);

    await app.register(settingsModule, { prefix: '/api/v1/settings' });
    await app.ready();

    const routes = app.printRoutes({ commonPrefix: false });
    for (const path of ['/api/v1/settings/agent-persona', '/api/v1/settings/zadarma']) {
      expect(routes).toContain(path);
    }

    await app.close();
  });
});

describe('the SPA fallback must not swallow API routes', () => {
  /**
   * Reproduces the handler from server.ts against a throwaway app. The real one is only installed
   * when `dashboard/dist` exists, which it does not in CI — so testing the rule itself is the
   * honest option, and the rule is what was wrong.
   */
  function appWithFallback() {
    const app = Fastify({ logger: false });
    const sendFile = vi.fn(() => 'INDEX_HTML');
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/webhooks/')) {
        const path = request.url.split('?')[0];
        return reply
          .status(404)
          .send({ error: 'NOT_FOUND', message: `Route ${request.method} ${path} does not exist` });
      }
      return reply.status(200).send(sendFile());
    });
    return app;
  }

  it('404s an unknown API route as JSON', async () => {
    const app = appWithFallback();
    const res = await app.inject({ method: 'GET', url: '/api/v1/settings/agent-persona' });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    // An API client that sees `200 text/html` reports a JSON parse error, not a missing route —
    // which sends whoever debugs it to the client instead of the server.
    expect(res.body).not.toContain('<!doctype');
    await app.close();
  });

  it('404s an unknown webhook route too', async () => {
    // Webhook senders retry on 5xx and give up on 404. Answering 200 tells a provider the delivery
    // succeeded when nothing handled it.
    const app = appWithFallback();
    const res = await app.inject({ method: 'POST', url: '/webhooks/nope' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('does not leak the query string back into the response', async () => {
    const app = appWithFallback();
    const res = await app.inject({ method: 'GET', url: '/api/v1/x?token=secret-value' });

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('secret-value');
    await app.close();
  });

  it('still serves the SPA for a browser route', async () => {
    // The fallback exists for React Router; deep links must keep working.
    const app = appWithFallback();
    const res = await app.inject({ method: 'GET', url: '/leads/123' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('INDEX_HTML');
    await app.close();
  });
});
