import type { FastifyInstance } from 'fastify';
import { settingsRoutes } from './settings.routes.js';

/**
 * NOT wrapped in `fastify-plugin`, and that is the whole point of this comment.
 *
 * `fp()` exists to make a plugin transparent to encapsulation — which is what you want for
 * something that decorates the instance (auth, db, redis), and exactly what you do NOT want for a
 * bundle of routes, because transparency also discards the `{ prefix }` the caller registered it
 * with. This module was wrapped, so `apiScope.register(settingsModule, { prefix: '/api/v1/settings' })`
 * silently mounted every settings route at the ROOT: the real path was `/agent-persona`, not
 * `/api/v1/settings/agent-persona`.
 *
 * It went unnoticed because the SPA fallback answered the correct-looking path with `200 text/html`
 * — see the not-found handler in server.ts, now fixed to 404 anything under /api/. Two bugs, and
 * the second is what hid the first: every settings call returned a success status carrying the
 * dashboard's index.html.
 *
 * Every sibling module (tenants, leads, scheduling, integrations, calls, metrics) is a plain
 * plugin like this one. Settings was the only outlier.
 */
export default async function settingsModule(app: FastifyInstance) {
  await app.register(settingsRoutes);
}
