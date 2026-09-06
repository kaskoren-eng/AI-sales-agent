/**
 * The operator console's view of individual calls.
 *
 * Registered from inside `adminRoutes`, so the plugin-wide `onRequest requireAdmin` hook covers
 * these routes too. That coupling is invisible in this file and easy to break by registering it one
 * level up by mistake, where it would be a cross-tenant transcript endpoint with no auth at all —
 * so `admin-calls.routes.test.ts` asserts the 401 on both routes rather than trusting the reading.
 *
 * No fastify `response` schema on either route, deliberately. The serializer drops properties a
 * schema does not list, and this payload's whole point is to carry a call report whose summary
 * holds ~35 keys nobody has written down and gains more over time. A response schema here would
 * silently hide exactly the fields the page exists to show.
 */
import type { FastifyInstance } from 'fastify';
import { CallReportService } from '../metrics/call-report.service.js';
import { NotFoundError } from '../../shared/errors.js';

export async function adminCallsRoutes(app: FastifyInstance) {
  const calls = new CallReportService(app.db);

  /**
   * Recent calls across every tenant, newest first.
   *
   * `hasReport` is the column that matters in the list: most historical rows have no report, and
   * an operator should be able to see which calls can actually answer a question before opening
   * one.
   */
  app.get('/calls', async (request) => {
    const q = request.query as { limit?: string; tenantId?: string; withReport?: string };
    const parsed = Number(q.limit);
    return {
      data: await calls.listRecent({
        // A junk `limit` falls back to the default rather than becoming NaN and then, downstream,
        // some other number entirely.
        ...(Number.isFinite(parsed) ? { limit: parsed } : {}),
        ...(q.tenantId ? { tenantId: q.tenantId } : {}),
        ...(q.withReport === 'true' ? { withReportOnly: true } : {}),
      }),
    };
  });

  /**
   * One call's full report. `:id` is a `call_learnings.id` — see the note in `call-report.service.ts`
   * for why it cannot be a conversation id.
   *
   * A call that exists but stored no report is a 200 with `report: null` and an `absence`, not a
   * 404: the call is real, and "we have no report for this one" is the true answer the page needs
   * to print. A 404 is reserved for an id that matches nothing.
   */
  app.get('/calls/:id/report', async (request) => {
    const { id } = request.params as { id: string };
    const envelope = await calls.byLearningId(id);
    if (!envelope) throw new NotFoundError('Call', id);
    return envelope;
  });
}
