import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { callLearnings } from '../../../db/schema/index.js';
import { enqueueCallAnalysis } from '../../../queues/call-analysis.queue.js';

/**
 * Zadarma call-recording webhooks.
 *
 * These are engine-independent: they belong to the conference-monitoring path
 * (`calls/monitor` creates the `monitor_call:<call_id>` Redis mapping), not to any voice
 * agent. They outlived the Retell engine and are mounted at the SAME `/webhooks/voice`
 * prefix as before, because the URL is configured in the Zadarma portal and changing it
 * would silently stop recordings from ever being analyzed.
 */
export async function zadarmaRoutes(app: FastifyInstance) {
  /**
   * Zadarma verification challenge — responds to GET ?zd_echo=<value> with the value as plain text.
   * Zadarma sends this when you first register a notification URL to confirm ownership.
   */
  app.get('/zadarma', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const echo = query['zd_echo'];
    if (echo) {
      return reply.status(200).type('text/plain').send(echo);
    }
    return reply.status(200).send({ ok: true });
  });

  /**
   * Zadarma notification webhook — fired when a monitored call ends and recording is ready.
   * Zadarma POSTs application/x-www-form-urlencoded with:
   *   call_id, disposition, recording (URL), from_number, called_number, duration
   *
   * Configure in Zadarma portal → My Notifications:
   *   https://<your-domain>/webhooks/voice/zadarma
   */
  app.post('/zadarma', async (request, reply) => {
    const params = request.body as Record<string, string>;
    const { call_id, disposition, recording, duration } = params;

    // Only process answered calls with a recording
    if (disposition !== 'answered' || !recording) {
      return reply.status(204).send();
    }

    app.log.info({ call_id, recording }, 'Zadarma recording notification received');

    if (!call_id) {
      app.log.warn({ params }, 'Zadarma notify: missing call_id');
      return reply.status(200).send({ ok: true, skipped: true });
    }

    // Resolve tenant from Redis mapping created when the monitor call was started
    const redisKey = `monitor_call:${call_id}`;
    const mapping = await app.redis.get(redisKey);
    if (!mapping) {
      app.log.warn({ call_id }, 'Zadarma notify: no tenant mapping found — not a monitored call');
      return reply.status(200).send({ ok: true, skipped: true });
    }

    const { tenantId } = JSON.parse(mapping) as { tenantId: string };

    // Update the learning record with recording details
    await app.db
      .update(callLearnings)
      .set({ recordingUrl: recording })
      .where(
        and(
          eq(callLearnings.tenantId, tenantId),
          eq(callLearnings.conferenceName, call_id),
        ),
      );

    // Fetch learning ID for the queue job
    const [row] = await app.db
      .select({ id: callLearnings.id })
      .from(callLearnings)
      .where(
        and(
          eq(callLearnings.tenantId, tenantId),
          eq(callLearnings.conferenceName, call_id),
        ),
      )
      .limit(1);

    if (!row) {
      app.log.warn({ call_id, tenantId }, 'Zadarma notify: learning record not found');
      return reply.status(200).send({ ok: true, skipped: true });
    }

    await enqueueCallAnalysis(app.queues.callAnalysis, {
      tenantId,
      learningId: row.id,
      recordingUrl: recording,
      recordingSid: call_id,
      durationSecs: duration ? parseInt(duration, 10) : 0,
    });

    app.log.info({ learningId: row.id, tenantId }, 'Call analysis job enqueued from Zadarma');
    return reply.status(200).send({ ok: true });
  });
}
