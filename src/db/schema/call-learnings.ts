import { pgTable, uuid, varchar, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export interface TranscriptSegment {
  speaker: string;
  text: string;
  start?: number;
  end?: number;
}

export interface SalesCallAnalysis {
  /** One-paragraph plain-language recap of the call — shown as conversations.summary in the
   * dashboard calls list/detail. Filled by both the LiveKit and the recording/Whisper paths. */
  summary?: string;
  opening_technique?: string;
  pain_points_uncovered?: string[];
  objections?: Array<{ objection: string; response: string; handled_well: boolean }>;
  closing_technique?: string;
  rapport_building?: string;
  key_questions_asked?: string[];
  what_worked?: string[];
  what_didnt_work?: string[];
  overall_effectiveness_score?: number;
  recommendations?: string[];
  // ---- Phase 4 (voice-livekit) — written by the agent itself, not the GPT analysis ----
  /** Every LLM tool invocation on the call: name, ms-since-start, duration, outcome. */
  tool_calls?: Array<{ atMs: number; name: string; durationMs: number; ok: boolean; error?: string }>;
  /** What end_call was told: meeting_booked | not_qualified | opt_out | ... */
  end_reason?: string;
  /** Compliance: the recorded-call notice pre-roll actually played (provable per call). */
  recording_notice_played?: boolean;
  recording_notice_at?: string;
  /** Compliance: when the caller learned they were talking to an AI. 'missed' should never happen. */
  ai_disclosure?: 'during_call' | 'at_end' | 'missed';
  // ---- Conversation state machine (voice-livekit) — the advisory awareness layer ----
  /** Coarse stage the call ended in (opening | discovery | qualifying | scheduling | closing | terminal). */
  final_stage?: string;
  /** The stage timeline: each stage entered with ms-since-call-start. */
  stage_history?: Array<{ stage: string; atMs: number }>;
  /** Reflex-worthy events that fired during the call (silence | barge_in | voicemail | objection). */
  situations?: Array<{ type: string; atMs: number; detail?: string }>;
  /** "What we knew by the end" — the facts capture_lead_info gathered, mirrored for the dashboard. */
  working_memory?: {
    name?: string;
    businessType?: string;
    painPoint?: string;
    budget?: string;
    timeline?: string;
    qualification?: string;
  };
}

/**
 * What shadow mode records on a live call: both engines' transcripts, side by side.
 *
 * NEITHER SIDE IS GROUND TRUTH, and the analysis must never pretend otherwise. Two STT engines
 * disagreeing tells you they disagree — not which one is right. The only thing this data can
 * measure without a human is the DIVERGENCE rate; deciding who was correct means a person reading
 * the pairs. `scripts/analyze-shadow-stt.mjs` surfaces the worst disagreements for exactly that.
 *
 * The two engines also SEGMENT differently — one may hear a pause as end-of-turn where the other
 * hears a hesitation — so their turns do not line up one-to-one. Both are stored as independent
 * time-stamped sequences rather than forced into pairs, and aligned at analysis time.
 */
export interface ShadowSttTranscript {
  authoritativeEngine: string;
  shadowEngine: string;
  shadowModel: string;
  /** ms since call start, so the two sequences can be aligned without a shared clock. */
  authoritative: Array<{ atMs: number; text: string }>;
  shadow: Array<{ atMs: number; text: string; endpointMs: number | null }>;
  /** Shadow-side failures. Recorded, never thrown — a shadow outage must not touch the caller. */
  errors: string[];
}

/**
 * The per-call CallReport (voice-livekit) persisted verbatim, so every call's latency + transcript
 * is queryable from the DB regardless of whether an ephemeral `lk agent logs` capture happened to be
 * running. Written ONCE by the agent at call end into its OWN column — deliberately NOT nested inside
 * `analysis`, because the later GPT call-analysis worker overwrites `analysis` and would wipe it.
 * Shape mirrors CallReport.toJson() (modules/channels/voice-livekit/call-report.ts); the deep arrays
 * are loosely typed on purpose so the report can evolve without a migration (jsonb is schemaless).
 */
export interface PersistedCallReport {
  room: string;
  callerPhone: string | null;
  startedAt: string;
  durationSec: number;
  config: {
    sttProvider: string;
    sttModel: string;
    turnDetection: string;
    llmModel: string;
    ttsModel: string;
  };
  summary: {
    turnsHeard: number;
    ttsSegments: number;
    cutOffs: number;
    fragmentedTurns: number;
    duplicateReplies: number;
    promptCacheHitPct: number | null;
    endOfTurnMedianMs: number | null;
    llmTtftMedianMs: number | null;
    ttsTtfbMedianMs: number | null;
    worstCaseMs: number | null;
  };
  transcript?: unknown[];
  metrics?: unknown[];
  toolCalls?: unknown[];
  compliance?: unknown;
  usage?: unknown;
  shadow?: unknown;
}

export const callLearnings = pgTable('call_learnings', {
  id: uuid('id').primaryKey().defaultRandom(),
  /**
   * FK added late (migration 0010). This column was a bare uuid for most of the project's life:
   * nothing stopped a row referencing a tenant that never existed, and deleting a tenant left its
   * call recordings and transcripts behind as orphans — recorded voice data with no owner, which
   * is a problem the privacy policy has opinions about.
   */
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  // Friendly name we generate — used to correlate the Twilio recording webhook
  conferenceName: varchar('conference_name', { length: 64 }),
  // Twilio's own SID — populated from the recording webhook payload
  conferenceSid: varchar('conference_sid', { length: 64 }),
  recordingSid: varchar('recording_sid', { length: 64 }),
  recordingUrl: varchar('recording_url', { length: 512 }),
  transcript: jsonb('transcript').$type<TranscriptSegment[]>().default([]),
  // Both STT engines' transcripts from a live call, when SHADOW_STT_ENABLED=true. Nullable: it is
  // null for every call not run in shadow mode, which is almost all of them.
  shadowSttTranscript: jsonb('shadow_stt_transcript').$type<ShadowSttTranscript>(),
  analysis: jsonb('analysis').$type<SalesCallAnalysis>().default({} as SalesCallAnalysis),
  // The full per-call CallReport (latency medians, per-turn metrics, transcript, usage). Nullable:
  // only LiveKit calls write it, and it is the durable home for the stats that used to live only in
  // ephemeral logs. Isolated from `analysis` so the GPT-analysis worker can never overwrite it.
  callReport: jsonb('call_report').$type<PersistedCallReport>(),
  // won | lost | neutral — set manually via API or inferred by AI
  outcome: varchar('outcome', { length: 20 }),
  durationSecs: integer('duration_secs'),
  label: varchar('label', { length: 255 }),
  // pending → transcribing → analyzed | failed
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  /**
   * The spend guard's query, run before EVERY outbound dial:
   *   WHERE tenant_id = ? AND created_at >= start_of_israel_day
   *
   * The table had exactly one index — the primary key — so that check was a sequential scan, on
   * the hot path of the one component that talks to customers, growing with every call ever made.
   */
  index('call_learnings_tenant_created_idx').on(t.tenantId, t.createdAt),
]);
