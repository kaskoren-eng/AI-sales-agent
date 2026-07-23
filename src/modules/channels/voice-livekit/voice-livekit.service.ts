import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { SipClient } from 'livekit-server-sdk';
import type { Env } from '../../../config/env.js';
import type { Database } from '../../../db/client.js';
import { tenants } from '../../../db/schema/index.js';
import { CircuitBreaker } from '../../../shared/circuit-breaker.js';
import { AppError } from '../../../shared/errors.js';
import { checkDailySpendLimit } from '../../calls/spend-guard.js';

/**
 * Places outbound calls through LiveKit instead of Retell.
 *
 * Deliberately mirrors `VoiceService.initiateOutboundCall()` in ../voice/voice.service.ts so the
 * flow executor can pick an engine per tenant without caring which one it got. See
 * `resolveVoiceEngine()`.
 *
 * The dial goes: our API -> LiveKit -> Zadarma SIP outbound trunk -> the lead's phone. The agent
 * (`agent.ts`) is auto-dispatched into the room and starts talking when the lead picks up.
 */

const livekitCircuit = new CircuitBreaker({
  name: 'livekit-sip',
  failureThreshold: 5,
  cooldownMs: 30_000,
});

/** Metadata handed to the agent so it knows who it just dialled and on whose behalf. */
export interface OutboundCallMetadata {
  tenantId: string;
  leadId?: string;
  leadName?: string;
  leadEmail?: string;
  leadPhone: string;
  direction: 'outbound';
}

export class LiveKitVoiceService {
  private sip: SipClient;

  constructor(
    private env: Env,
    private deps?: { db?: Database; redis?: Redis },
  ) {
    if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
      throw new AppError('LiveKit is not configured', 500, 'LIVEKIT_NOT_CONFIGURED');
    }
    this.sip = new SipClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  }

  /**
   * Dials a lead. Returns the room name, which is our call id — it is what ties the call to the
   * `conversations` row, the same role `channelRef` plays for Retell's call_id.
   *
   * Returns `{ callId: 'skipped' }` when the outbound trunk isn't configured, matching
   * VoiceService's behaviour so a missing config degrades rather than throws mid-flow.
   */
  async initiateOutboundCall(
    to: string,
    tenantId: string,
    leadContext?: { leadId?: string; name?: string; email?: string },
  ): Promise<{ callId: string }> {
    const trunkId = this.env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID;
    if (!trunkId) {
      return { callId: 'skipped' };
    }

    // Toll-fraud brake at the dial itself (defense in depth with the flow-executor pre-check).
    // Bench/test constructions without deps skip it WITH A WARNING — production (server.ts)
    // always injects db+redis.
    if (this.deps?.db) {
      const [tenantRow] = await this.deps.db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const decision = await checkDailySpendLimit(
        { db: this.deps.db, redis: this.deps.redis ?? null },
        tenantId,
        tenantRow?.settings,
      );
      if (!decision.allowed) {
        console.warn('livekit_dial_blocked_spend_limit', JSON.stringify({ tenantId, reason: decision.reason }));
        throw new AppError('Daily outbound spend limit reached', 429, 'SPEND_LIMIT_EXCEEDED');
      }
    } else {
      console.warn('livekit_dial_spend_guard_skipped — no db injected (non-production construction)');
    }

    const roomName = `call-out-${randomUUID()}`;
    const metadata: OutboundCallMetadata = {
      tenantId,
      leadId: leadContext?.leadId,
      leadName: leadContext?.name,
      leadEmail: leadContext?.email,
      leadPhone: to,
      direction: 'outbound',
    };

    await livekitCircuit.execute(() =>
      this.sip.createSipParticipant(trunkId, to, roomName, {
        participantIdentity: `lead-${to}`,
        participantName: leadContext?.name ?? to,
        // The agent reads this to load tenant context + the lead's history.
        participantMetadata: JSON.stringify(metadata),
        // Don't start talking into a ringing phone: wait for an actual answer.
        waitUntilAnswered: true,
        playDialtone: false,
      }),
    );

    return { callId: roomName };
  }
}

/**
 * Which voice engine should this tenant use?
 *
 * Per-tenant override in `tenants.settings.voice_engine`, falling back to VOICE_ENGINE_DEFAULT.
 * This is the rollback switch: set a tenant back to 'retell' and the Retell path — which is
 * still fully wired — takes over on the next call.
 */
export function resolveVoiceEngine(
  settings: unknown,
  env: Env,
): 'retell' | 'livekit' {
  const engine =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>)['voice_engine']
      : undefined;
  return engine === 'livekit' || engine === 'retell' ? engine : env.VOICE_ENGINE_DEFAULT;
}

/**
 * May the agent use its Phase 4 tools (calendar check, booking, hang-up) on this tenant's calls?
 *
 * `tenants.settings.functions_enabled` — a plain jsonb key, set via the settings API or SQL:
 *   UPDATE tenants SET settings = jsonb_set(settings, '{functions_enabled}', 'true') WHERE id = ...;
 *
 * STRICT `=== true`, no env fallback, and unlike voice_engine there is deliberately no default-on:
 * tools write to the tenant's calendar and tables, so absence of the flag means NO. This is the
 * per-tenant kill switch the migration plan requires before any tool goes near production.
 */
export function resolveFunctionsEnabled(settings: unknown): boolean {
  return (
    settings !== null &&
    typeof settings === 'object' &&
    (settings as Record<string, unknown>)['functions_enabled'] === true
  );
}
