import { eq, and, ne, desc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { CircuitBreaker } from '../../../shared/circuit-breaker.js';
import { callLearnings } from '../../../db/schema/call-learnings.js';
import { CallAnalysisService } from '../../calls/call-analysis.service.js';
import { SettingsService } from '../../settings/settings.service.js';

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';
const ELEVENLABS_TIMEOUT_MS = 15_000;
const AGENT_PROMPT_CACHE_TTL = 3600; // 1 hour

const elevenLabsCircuit = new CircuitBreaker({ name: 'elevenlabs', failureThreshold: 5, cooldownMs: 30_000 });

export class VoiceService {
  private settingsService: SettingsService;

  constructor(private app: FastifyInstance) {
    this.settingsService = new SettingsService(app.db, app.env.ENCRYPTION_KEY);
  }

  private _fetch(url: string, opts: RequestInit): Promise<Response> {
    return elevenLabsCircuit.execute(() => fetch(url, opts));
  }

  /**
   * Fetch ElevenLabs agent base prompt and cache in Redis for 1 hour.
   * Returns null if unavailable — callers should degrade gracefully.
   */
  private async _fetchAgentBasePrompt(agentId: string, apiKey: string): Promise<string | null> {
    const cacheKey = `el:agent:prompt:${agentId}`;
    const cached = await this.app.redis.get(cacheKey);
    if (cached) return cached;

    try {
      const res = await this._fetch(`${ELEVENLABS_API_BASE}/v1/convai/agents/${agentId}`, {
        headers: { 'xi-api-key': apiKey },
        signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as Record<string, unknown>;
      const prompt =
        (data?.conversation_config as Record<string, unknown> | undefined)
          ?.agent as Record<string, unknown> | undefined;
      const basePrompt =
        (prompt?.prompt as Record<string, unknown> | undefined)?.prompt as string | undefined;

      if (basePrompt) {
        await this.app.redis.set(cacheKey, basePrompt, 'EX', AGENT_PROMPT_CACHE_TTL);
        return basePrompt;
      }
    } catch {
      // Non-fatal — learning injection is best-effort
    }
    return null;
  }

  /**
   * Build an ElevenLabs override_config block that injects:
   * 1. Tenant business profile (who they are, what they sell, tone, language)
   * 2. Learnings from past monitored calls (winning patterns)
   * Returns null if neither is available or base prompt cannot be fetched.
   */
  private async _buildAgentOverride(tenantId: string): Promise<Record<string, unknown> | null> {
    const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID } = this.app.env;
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) return null;

    try {
      const [businessProfile, learningRows] = await Promise.all([
        this.settingsService.getBusinessProfile(tenantId).catch(() => null),
        this.app.db
          .select({ analysis: callLearnings.analysis, outcome: callLearnings.outcome })
          .from(callLearnings)
          .where(
            and(
              eq(callLearnings.tenantId, tenantId),
              eq(callLearnings.status, 'analyzed'),
              ne(callLearnings.outcome, 'lost'),
            ),
          )
          .orderBy(desc(callLearnings.createdAt))
          .limit(5),
      ]);

      const hasProfile = !!businessProfile;
      const hasLearnings = learningRows.length > 0;

      if (!hasProfile && !hasLearnings) return null;

      const basePrompt = await this._fetchAgentBasePrompt(ELEVENLABS_AGENT_ID, ELEVENLABS_API_KEY);
      if (!basePrompt) return null;

      let enhancedPrompt = basePrompt;

      if (hasProfile && businessProfile) {
        const profileBlock = [
          '\n\n--- BUSINESS CONTEXT ---',
          `Company: ${businessProfile.companyName}`,
          `What we do: ${businessProfile.description}`,
          `What we sell: ${businessProfile.product}`,
          businessProfile.targetAudience ? `Our ideal customer: ${businessProfile.targetAudience}` : '',
          businessProfile.pricing ? `Pricing: ${businessProfile.pricing}` : '',
          businessProfile.commonObjections ? `How to handle objections: ${businessProfile.commonObjections}` : '',
          businessProfile.toneOfVoice ? `Tone of voice: ${businessProfile.toneOfVoice}` : '',
          businessProfile.language !== 'english' ? `Speak primarily in Hebrew unless the lead speaks English.` : '',
          '--- END BUSINESS CONTEXT ---',
        ]
          .filter(Boolean)
          .join('\n');
        enhancedPrompt += profileBlock;
      }

      if (hasLearnings) {
        enhancedPrompt += CallAnalysisService.formatLearningsForPrompt(learningRows);
      }

      return {
        override_config: {
          agent: { prompt: { prompt: enhancedPrompt } },
        },
      };
    } catch (err) {
      this.app.log.warn({ err }, 'VoiceService: agent override build failed — proceeding without override');
      return null;
    }
  }

  /**
   * Get the Twilio auth token for a tenant — first from their settings, then from global env.
   * Returns null if neither is configured.
   */
  async getTwilioAuthToken(tenantId: string): Promise<string | null> {
    const tenantToken = await this.settingsService.getTwilioAuthToken(tenantId).catch(() => null);
    return tenantToken ?? this.app.env.TWILIO_AUTH_TOKEN ?? null;
  }

  /**
   * Handle an inbound Twilio call by registering it with ElevenLabs.
   * Calls POST /v1/convai/twilio/register-call and returns the TwiML response
   * that Twilio uses to connect the caller to the ElevenLabs AI agent.
   * When tenantId is provided, injects learnings from monitored calls into the agent prompt.
   */
  async handleIncomingCall(callSid: string, from: string, to: string, tenantId?: string): Promise<string> {
    const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID } = this.app.env;

    if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
      this.app.log.warn({ callSid }, 'ElevenLabs not configured — using fallback TwiML');
      return '<Response><Say>Thank you for calling. Our team will be with you shortly.</Say></Response>';
    }

    const body: Record<string, unknown> = {
      agent_id: ELEVENLABS_AGENT_ID,
      from_number: from,
      to_number: to,
      direction: 'inbound',
    };

    if (tenantId) {
      const override = await this._buildAgentOverride(tenantId);
      if (override) Object.assign(body, override);
    }

    const response = await this._fetch(`${ELEVENLABS_API_BASE}/v1/convai/twilio/register-call`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const body = await response.text();
      this.app.log.error({ status: response.status, body, callSid }, 'ElevenLabs register-call failed');
      return '<Response><Say>Sorry, our AI agent is temporarily unavailable. Please try again later.</Say></Response>';
    }

    const twiml = await response.text();
    this.app.log.info({ callSid, from }, 'ElevenLabs call registered');
    return twiml;
  }

  /**
   * Initiate an outbound call via ElevenLabs' Twilio integration.
   * Requires ELEVENLABS_PHONE_NUMBER_ID — the phone number ID from the ElevenLabs
   * dashboard after importing your Twilio number.
   */
  async initiateOutboundCall(
    to: string,
    tenantId: string,
    leadContext?: { name?: string; email?: string; phone?: string; [key: string]: string | undefined },
  ): Promise<{ callSid: string; conversationId: string | null }> {
    const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID } = this.app.env;

    if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !ELEVENLABS_PHONE_NUMBER_ID) {
      this.app.log.warn({ to }, 'ElevenLabs outbound not fully configured — skipping call');
      return { callSid: 'skipped', conversationId: null };
    }

    const body: Record<string, unknown> = {
      agent_id: ELEVENLABS_AGENT_ID,
      agent_phone_number_id: ELEVENLABS_PHONE_NUMBER_ID,
      to_number: to,
    };

    if (leadContext && Object.keys(leadContext).length > 0) {
      // Filter out undefined values before sending
      body.dynamic_variables = Object.fromEntries(
        Object.entries(leadContext).filter(([, v]) => v !== undefined),
      );
    }

    const response = await this._fetch(`${ELEVENLABS_API_BASE}/v1/convai/twilio/outbound-call`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const body = await response.text();
      this.app.log.error({ status: response.status, body, to }, 'ElevenLabs outbound-call failed');
      throw new Error(`ElevenLabs outbound call failed: ${response.status} — ${body}`);
    }

    const data = (await response.json()) as {
      success: boolean;
      message?: string;
      conversation_id?: string;
      callSid?: string;
    };

    this.app.log.info(
      { to, tenantId, callSid: data.callSid, conversationId: data.conversation_id },
      'Outbound call initiated via ElevenLabs',
    );
    return { callSid: data.callSid ?? 'initiated', conversationId: data.conversation_id ?? null };
  }

  /**
   * Fetch the full conversation transcript from ElevenLabs.
   * Returns null if the API key is not configured or the request fails.
   */
  async fetchConversationTranscript(conversationId: string): Promise<ElevenLabsConversation | null> {
    const apiKey = this.app.env.ELEVENLABS_API_KEY;
    if (!apiKey) return null;

    const response = await this._fetch(
      `${ELEVENLABS_API_BASE}/v1/convai/conversations/${conversationId}`,
      {
        headers: { 'xi-api-key': apiKey },
        signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      this.app.log.warn(
        { conversationId, status: response.status },
        'ElevenLabs: failed to fetch conversation transcript',
      );
      return null;
    }

    return (await response.json()) as ElevenLabsConversation;
  }
}

// ---- ElevenLabs API types ----

export interface ElevenLabsTranscriptTurn {
  role: 'agent' | 'user';
  message: string;
  time_in_call_secs?: number;
}

export interface ElevenLabsConversation {
  conversation_id: string;
  agent_id: string;
  status: 'processing' | 'done' | 'failed';
  transcript: ElevenLabsTranscriptTurn[];
  metadata?: {
    start_time_unix_secs?: number;
    call_duration_secs?: number;
    from?: string;
    to?: string;
  };
  analysis?: {
    call_successful?: 'success' | 'failure' | 'unknown';
    transcript_summary?: string;
  };
}
