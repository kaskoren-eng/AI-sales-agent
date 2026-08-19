import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { SipClient } from 'livekit-server-sdk';
import type { Env } from '../../../config/env.js';
import type { Database } from '../../../db/client.js';
import { tenants } from '../../../db/schema/index.js';
import { CircuitBreaker } from '../../../shared/circuit-breaker.js';
import { AppError } from '../../../shared/errors.js';
import { evaluateSpend, countDialAttempt } from '../../calls/spend-guard.js';
import { createVoiceConversation } from './call-record.js';

/**
 * Places outbound calls through LiveKit. This is the only dialer — both the flow executor and
 * POST /api/v1/calls/outbound come through here.
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
  /** Sanitized per-tenant gate config, resolved here (fast DB) so the agent gates off metadata
   * instead of a cold cross-region DB read at pickup. Absent only if the settings load failed. */
  settings?: Record<string, unknown>;
  /** The `conversations` row created at dial time (Task 0) — threaded so the agent finalizes THIS
   * row at call end. Absent if the row could not be created (best-effort; never blocks the dial). */
  conversationId?: string;
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
   * `conversations` row via `channelRef`.
   *
   * Returns `{ callId: 'skipped' }` when the outbound trunk isn't configured, so a missing
   * config degrades rather than throws mid-flow.
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
    // always injects db+redis. The same settings row also feeds the agent's gate (below).
    let gateSettings: Record<string, unknown> | undefined;
    if (this.deps?.db) {
      const [tenantRow] = await this.deps.db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      gateSettings = sanitizeSettingsForAgent(tenantRow?.settings);
      const guardDeps = { db: this.deps.db, redis: this.deps.redis ?? null };
      const decision = await evaluateSpend(guardDeps, tenantId, tenantRow?.settings);
      if (!decision.allowed) {
        console.warn('livekit_dial_blocked_spend_limit', JSON.stringify({ tenantId, reason: decision.reason }));
        throw new AppError('Daily outbound spend limit reached', 429, 'SPEND_LIMIT_EXCEEDED');
      }

      // This is the dialer, so this is where the attempt is counted — once, after the decision to
      // proceed. Counting here rather than inside the check is what lets the flow executor and any
      // future caller check as often as they like without tightening the cap.
      await countDialAttempt(guardDeps, tenantId);
    } else {
      console.warn('livekit_dial_spend_guard_skipped — no db injected (non-production construction)');
    }

    const roomName = `call-out-${randomUUID()}`;

    // Task 0: make the call visible in the dashboard from the moment it's dialled. Best-effort —
    // a failed insert logs and proceeds; a missing calls-list row must never cost a real call.
    // Needs both a DB and a real lead (outbound always has one via the flow executor).
    let conversationId: string | undefined;
    if (this.deps?.db && leadContext?.leadId) {
      try {
        conversationId = await createVoiceConversation(this.deps.db, {
          tenantId,
          leadId: leadContext.leadId,
          roomName,
        });
      } catch (err) {
        console.warn(
          'livekit_conversation_create_failed',
          JSON.stringify({ tenantId, roomName, error: err instanceof Error ? err.message : String(err) }),
        );
      }
    }

    const metadata: OutboundCallMetadata = {
      tenantId,
      leadId: leadContext?.leadId,
      leadName: leadContext?.name,
      leadEmail: leadContext?.email,
      leadPhone: to,
      direction: 'outbound',
      ...(gateSettings ? { settings: gateSettings } : {}),
      ...(conversationId ? { conversationId } : {}),
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
 * May the agent use its Phase 4 tools (calendar check, booking, hang-up) on this tenant's calls?
 *
 * `tenants.settings.functions_enabled` — a plain jsonb key, set via the settings API or SQL:
 *   UPDATE tenants SET settings = jsonb_set(settings, '{functions_enabled}', 'true') WHERE id = ...;
 *
 * STRICT `=== true`, no env fallback, and deliberately no default-on:
 * tools write to the tenant's calendar and tables, so absence of the flag means NO. This is the
 * per-tenant kill switch the migration plan requires before any tool goes near production.
 */
/**
 * The non-secret, voice-relevant subset of `tenants.settings` that the dispatcher (web-call route,
 * outbound dialer) ships to the agent in call metadata — so the agent gates off metadata instead
 * of a cold cross-region DB read at pickup (which was silently disabling every cloud call's tools).
 *
 * WHITELIST, never the raw blob: `tenants.settings` can hold secrets (e.g. monday.encryptedApiToken).
 * Only these keys ever leave the backend in a token the browser holds; the caller is the
 * authenticated tenant anyway.
 */
export const AGENT_SETTINGS_KEYS = [
  'functions_enabled',
  'whatsapp_templates',
  'toll_fraud',
  'reminders',
  'businessProfile',
  // WHO THE AGENT IS — name, gender, company, FAQ, voice. Without this key on the metadata the
  // agent resolves DEFAULT_PERSONA and every tenant's leads are greeted as "קרן מ-ClickScales".
  // It carries no secrets (voice ids and names are not credentials), and the caller is the
  // authenticated tenant anyway.
  'agent_persona',
  // Voice RAG (Phase R2): `{ enabled, top_k?, min_score? }`. Carries no secrets — it is a feature
  // flag and two numbers. Absent means off, which is the default for every tenant.
  'knowledge_base',
] as const;

export function sanitizeSettingsForAgent(settings: unknown): Record<string, unknown> | undefined {
  if (!settings || typeof settings !== 'object') return undefined;
  const src = settings as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of AGENT_SETTINGS_KEYS) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}

export function resolveFunctionsEnabled(settings: unknown): boolean {
  return (
    settings !== null &&
    typeof settings === 'object' &&
    (settings as Record<string, unknown>)['functions_enabled'] === true
  );
}
