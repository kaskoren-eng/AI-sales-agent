import { eq, and, ne, desc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { CircuitBreaker } from '../../../shared/circuit-breaker.js';
import { callLearnings } from '../../../db/schema/call-learnings.js';
import { tenants } from '../../../db/schema/index.js';
import { AppError } from '../../../shared/errors.js';
import { evaluateSpend, countDialAttempt } from '../../calls/spend-guard.js';
import { CallAnalysisService } from '../../calls/call-analysis.service.js';
import { SettingsService } from '../../settings/settings.service.js';

const RETELL_API_BASE = 'https://api.retellai.com';
const RETELL_TIMEOUT_MS = 15_000;

const retellCircuit = new CircuitBreaker({ name: 'retell', failureThreshold: 5, cooldownMs: 30_000 });

export class VoiceService {
  private settingsService: SettingsService;

  constructor(private app: FastifyInstance) {
    this.settingsService = new SettingsService(app.db, app.env.ENCRYPTION_KEY);
  }

  private _fetch(url: string, opts: RequestInit): Promise<Response> {
    return retellCircuit.execute(() => fetch(url, opts));
  }

  private retellHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.app.env.RETELL_API_KEY ?? ''}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Build Retell LLM dynamic variables from tenant business profile and call learnings.
   * These are injected into the Retell agent's prompt at call time.
   */
  async buildDynamicVariables(tenantId: string): Promise<Record<string, string> | null> {
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

      const vars: Record<string, string> = {};

      if (businessProfile) {
        vars['company_name'] = businessProfile.companyName;
        vars['company_description'] = businessProfile.description;
        vars['product'] = businessProfile.product;
        if (businessProfile.targetAudience) vars['target_audience'] = businessProfile.targetAudience;
        if (businessProfile.pricing) vars['pricing'] = businessProfile.pricing;
        if (businessProfile.toneOfVoice) vars['tone'] = businessProfile.toneOfVoice;
        if (businessProfile.language) vars['language'] = businessProfile.language;
        if (businessProfile.commonObjections) vars['common_objections'] = businessProfile.commonObjections;
      }

      if (learningRows.length > 0) {
        vars['call_learnings'] = CallAnalysisService.formatLearningsForPrompt(learningRows);
      }

      return Object.keys(vars).length > 0 ? vars : null;
    } catch (err) {
      this.app.log.warn({ err }, 'VoiceService: dynamic variables build failed — proceeding without context');
      return null;
    }
  }

  /**
   * Initiate an outbound call via Retell AI.
   * Uses the Zadarma number as the caller ID (configured as a SIP trunk in Retell).
   */
  async initiateOutboundCall(
    to: string,
    tenantId: string,
    leadContext?: { name?: string; email?: string; phone?: string; [key: string]: string | undefined },
  ): Promise<{ callId: string }> {
    const { RETELL_API_KEY, RETELL_AGENT_ID, ZADARMA_PHONE_NUMBER } = this.app.env;

    if (!RETELL_API_KEY || !RETELL_AGENT_ID || !ZADARMA_PHONE_NUMBER) {
      this.app.log.warn({ to }, 'Retell outbound not fully configured — skipping call');
      return { callId: 'skipped' };
    }

    // Toll-fraud brake — the SERVICE is the choke point every dial path shares (flow executor,
    // HTTP /outbound, anything future). AppError → the HTTP layer answers 429.
    const [tenantRow] = await this.app.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const guardDeps = { db: this.app.db, redis: this.app.redis };
    const decision = await evaluateSpend(guardDeps, tenantId, tenantRow?.settings);
    if (!decision.allowed) {
      this.app.log.warn({ tenantId, ...decision }, 'Outbound dial blocked by daily spend limit');
      throw new AppError('Daily outbound spend limit reached', 429, 'SPEND_LIMIT_EXCEEDED');
    }

    // The dialer counts, once. See evaluateSpend()'s header for why the read and the count are
    // separate functions.
    await countDialAttempt(guardDeps, tenantId);

    const dynamicVars = await this.buildDynamicVariables(tenantId);

    const mergedVars: Record<string, string> = {};
    if (leadContext) {
      for (const [k, v] of Object.entries(leadContext)) {
        if (v !== undefined) mergedVars[k] = v;
      }
    }
    if (dynamicVars) Object.assign(mergedVars, dynamicVars);

    const body: Record<string, unknown> = {
      from_number: ZADARMA_PHONE_NUMBER,
      to_number: to,
      override_agent_id: RETELL_AGENT_ID,
    };

    if (Object.keys(mergedVars).length > 0) {
      body['retell_llm_dynamic_variables'] = mergedVars;
    }

    const response = await this._fetch(`${RETELL_API_BASE}/v2/create-phone-call`, {
      method: 'POST',
      headers: this.retellHeaders(),
      signal: AbortSignal.timeout(RETELL_TIMEOUT_MS),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.text();
      this.app.log.error({ status: response.status, body: errBody, to }, 'Retell outbound call failed');
      throw new Error(`Retell outbound call failed: ${response.status}`);
    }

    const data = (await response.json()) as { call_id: string };
    this.app.log.info({ to, tenantId, callId: data.call_id }, 'Outbound call initiated via Retell');
    return { callId: data.call_id };
  }

  /**
   * Fetch call details from Retell AI (transcript, analysis, recording URL).
   * Returns null if the API key is not configured or the request fails.
   */
  async fetchCallDetails(callId: string): Promise<RetellCall | null> {
    const apiKey = this.app.env.RETELL_API_KEY;
    if (!apiKey) return null;

    const response = await this._fetch(`${RETELL_API_BASE}/v1/call/${callId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(RETELL_TIMEOUT_MS),
    });

    if (!response.ok) {
      this.app.log.warn({ callId, status: response.status }, 'Retell: failed to fetch call details');
      return null;
    }

    return (await response.json()) as RetellCall;
  }
}

// ---- Retell API types ----

export interface RetellTranscriptTurn {
  role: 'agent' | 'user';
  content: string;
  words?: Array<{ word: string; start: number; end: number }>;
}

export interface RetellCallAnalysis {
  call_summary?: string;
  in_voicemail?: boolean;
  user_sentiment?: string;
  call_successful?: boolean;
}

export interface RetellCall {
  call_id: string;
  call_type: string;
  call_status: string;
  agent_id?: string;
  from_number?: string;
  to_number?: string;
  start_timestamp?: number;
  end_timestamp?: number;
  duration_ms?: number;
  recording_url?: string;
  transcript?: string;
  transcript_object?: RetellTranscriptTurn[];
  call_analysis?: RetellCallAnalysis;
  retell_llm_dynamic_variables?: Record<string, string>;
}
