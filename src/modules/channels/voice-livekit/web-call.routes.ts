import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AccessToken } from 'livekit-server-sdk';
import { eq } from 'drizzle-orm';
import { tenants } from '../../../db/schema/index.js';
import { sanitizeSettingsForAgent } from './voice-livekit.service.js';
import { createVoiceConversation, ensureWebCallPlaceholderLead } from './call-record.js';

/**
 * Browser voice simulation — talk to Keren from the dashboard instead of a phone.
 *
 * WHY: the Phase 4 merge gate is a real conversation with the agent, and Koren is abroad with no
 * way to place an Israeli phone call. A browser mic session exercises the ENTIRE pipeline — the
 * recording-notice pre-roll, STT, LLM, the calendar tools against the real calendar, TTS, the
 * speech-guard — everything except the SIP leg itself.
 *
 * HOW IT WORKS: this endpoint mints a short-lived LiveKit room token. The browser joins the room
 * with its microphone; the agent worker (npm run voice:dev, or the deployed LiveKit Cloud agent)
 * auto-dispatches into the new room and picks up, exactly as it does for a SIP call.
 *
 * TENANT CONTEXT: the token carries `metadata: {tenantId}` — the same channel the outbound SIP
 * dialer uses — so the agent's tool gate resolves THIS tenant (voice_engine + functions_enabled)
 * instead of falling back to the env default. Web sessions are therefore a faithful rehearsal of
 * the per-tenant gating too.
 */

/** Browser sessions are ephemeral; a token that outlives the tab is just attack surface. */
const TOKEN_TTL_SECONDS = 60 * 60;

export default async function webCallRoutes(app: FastifyInstance) {
  // POST /web-call — mint a room + token for a browser voice session with the agent.
  app.post('/web-call', async (request, reply) => {
    const tenantId = request.tenantId;
    const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = app.env;
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return reply.status(503).send({
        error: 'NOT_CONFIGURED',
        message: 'LiveKit is not configured on this server',
      });
    }

    // Resolve the gate config HERE, against the backend's fast/correct DB, and ship it in the
    // token — so the cloud agent gates off metadata instead of a cold cross-region DB read at
    // pickup (which was silently disabling every cloud call's tools). Only non-secret voice keys
    // leave the backend (sanitizeSettingsForAgent); the caller is the authenticated tenant anyway.
    let gateSettings: Record<string, unknown> | undefined;
    try {
      const rows = await app.db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      gateSettings = rows[0] ? sanitizeSettingsForAgent(rows[0].settings) : undefined;
      if (!rows[0]) app.log.warn({ tenantId }, 'web-call: tenant not found when resolving gate settings');
    } catch (err) {
      // A DB hiccup here just means the agent falls back to its own read — never block the call.
      app.log.warn({ tenantId, err }, 'web-call: could not resolve gate settings, agent will read them itself');
    }

    const roomName = `web-call-${randomUUID()}`;

    // Task 0: surface the simulator session in the dashboard calls list too. A web call has no real
    // lead, so it hangs off ONE reusable per-tenant placeholder ("Web simulator"). Best-effort — a
    // DB hiccup here must never block a rehearsal; the call just won't be listed.
    let conversationId: string | undefined;
    try {
      const leadId = await ensureWebCallPlaceholderLead(app.db, tenantId);
      conversationId = await createVoiceConversation(app.db, { tenantId, leadId, roomName });
    } catch (err) {
      app.log.warn({ tenantId, roomName, err }, 'web-call: could not create conversation row (call still proceeds)');
    }

    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: `web-${randomUUID().slice(0, 8)}`,
      ttl: TOKEN_TTL_SECONDS,
      // The agent reads this exactly like outbound SIP metadata → per-tenant tool gate.
      metadata: JSON.stringify({
        tenantId,
        direction: 'web',
        ...(gateSettings ? { settings: gateSettings } : {}),
        ...(conversationId ? { conversationId } : {}),
      }),
    });
    token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

    app.log.info({ tenantId, roomName, gateShipped: !!gateSettings }, 'web voice session token minted');
    return reply.send({ url: LIVEKIT_URL, token: await token.toJwt(), roomName });
  });
}
