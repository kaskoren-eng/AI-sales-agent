import { pgTable, uuid, varchar, timestamp, jsonb, integer } from 'drizzle-orm/pg-core';

export interface TranscriptSegment {
  speaker: string;
  text: string;
  start?: number;
  end?: number;
}

export interface SalesCallAnalysis {
  /** One-paragraph plain-language recap of the call — shown as conversations.summary in the
   * dashboard calls list/detail. Added for the LiveKit analysis path; the Retell path fills it too. */
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

export const callLearnings = pgTable('call_learnings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
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
  // won | lost | neutral — set manually via API or inferred by AI
  outcome: varchar('outcome', { length: 20 }),
  durationSecs: integer('duration_secs'),
  label: varchar('label', { length: 255 }),
  // pending → transcribing → analyzed | failed
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
