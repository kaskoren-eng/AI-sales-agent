import { pgTable, uuid, varchar, timestamp, jsonb, integer } from 'drizzle-orm/pg-core';

export interface TranscriptSegment {
  speaker: string;
  text: string;
  start?: number;
  end?: number;
}

export interface SalesCallAnalysis {
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
  analysis: jsonb('analysis').$type<SalesCallAnalysis>().default({} as SalesCallAnalysis),
  // won | lost | neutral — set manually via API or inferred by AI
  outcome: varchar('outcome', { length: 20 }),
  durationSecs: integer('duration_secs'),
  label: varchar('label', { length: 255 }),
  // pending → transcribing → analyzed | failed
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
