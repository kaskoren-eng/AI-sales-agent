import { eq, and, gte, lte, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { Redis } from 'ioredis';
import type { Env } from '../../config/env.js';
import type { FastifyBaseLogger } from 'fastify';
import { conversations, leads, messages, callLearnings } from '../../db/schema/index.js';
import type { SalesCallAnalysis, TranscriptSegment } from '../../db/schema/call-learnings.js';

// ---------------------------------------------------------------------------
// Module-level circuit breaker — shared across all CallsService instances
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CallSummaryLead {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface CallQualification {
  status: string | null;
  company_name: string | null;
  lead_name: string | null;
  lead_email: string | null;
  follow_up_scheduled: boolean | null;
  lead_primary_challenge: string | null;
}

export interface CallSummary {
  id: string;
  channel_ref: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  duration_secs: number | null;
  lead: CallSummaryLead;
  qualification: CallQualification;
  summary: string | null;
}

export interface CallTranscriptTurn {
  role: string;
  message: string;
  time_in_call_secs: number | null;
}

// Matches the spec's TranscriptTurn (role narrowed to agent|user)
export interface TranscriptTurn {
  role: 'agent' | 'user';
  message: string;
  timeInCallSecs?: number;
}

export interface CallAnalysis {
  call_successful: string | null;
  transcript_summary: string | null;
}

// The GPT sales analysis written by the call-analysis worker. Null until the worker
// has run — the agent-written keys (tool_calls, compliance) arrive at call teardown,
// the sales analysis only after transcription + GPT analysis complete.
export interface CallSalesAnalysis {
  overall_effectiveness_score: number | null;
  opening_technique: string | null;
  closing_technique: string | null;
  rapport_building: string | null;
  pain_points_uncovered: string[];
  objections: Array<{ objection: string; response: string; handled_well: boolean }>;
  key_questions_asked: string[];
  what_worked: string[];
  what_didnt_work: string[];
  recommendations: string[];
}

export interface CallLearnings {
  status: 'pending' | 'transcribing' | 'analyzed' | 'failed';
  outcome: 'won' | 'lost' | 'neutral' | null;
  end_reason: string | null;
  tool_calls: Array<{ atMs: number; name: string; durationMs: number; ok: boolean; error?: string }>;
  compliance: {
    recording_notice_played: boolean | null;
    recording_notice_at: string | null;
    ai_disclosure: 'during_call' | 'at_end' | 'missed' | null;
  };
  sales_analysis: CallSalesAnalysis | null;
}

export interface CallDetail {
  id: string;
  channel_ref: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  duration_secs: number | null;
  lead: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    status: string;
    score: number | null;
  };
  transcript: CallTranscriptTurn[];
  analysis: CallAnalysis | null;
  qualification: CallQualification;
  summary: string | null;
  learnings: CallLearnings | null;
}

export interface ListCallsParams {
  tenantId: string;
  status?: 'active' | 'ended';
  qualification?: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractQualification(metadata: Record<string, unknown> | null | undefined): CallQualification {
  const m = metadata ?? {};
  return {
    status: typeof m['lead_qualification_status'] === 'string' ? m['lead_qualification_status'] : null,
    company_name: typeof m['company_name'] === 'string' ? m['company_name'] : null,
    lead_name: typeof m['lead_name'] === 'string' ? m['lead_name'] : null,
    lead_email: typeof m['lead_email'] === 'string' ? m['lead_email'] : null,
    follow_up_scheduled: m['follow_up_scheduled'] != null ? Boolean(m['follow_up_scheduled']) : null,
    lead_primary_challenge: typeof m['lead_primary_challenge'] === 'string' ? m['lead_primary_challenge'] : null,
  };
}

function extractDurationSecs(metadata: Record<string, unknown>): number | null {
  return typeof metadata['call_duration_secs'] === 'number' ? metadata['call_duration_secs'] : null;
}

// Keys only the call-analysis worker writes. Their presence is what distinguishes an
// analyzed call from one where the agent has merely logged its own teardown data.
const GPT_ANALYSIS_KEYS: Array<keyof SalesCallAnalysis> = [
  'overall_effectiveness_score',
  'opening_technique',
  'closing_technique',
  'rapport_building',
  'pain_points_uncovered',
  'objections',
  'key_questions_asked',
  'what_worked',
  'what_didnt_work',
  'recommendations',
];

type CallLearningsRow = typeof callLearnings.$inferSelect;

export function mapLearnings(row: Pick<CallLearningsRow, 'status' | 'outcome' | 'analysis'>): CallLearnings {
  const a: SalesCallAnalysis = row.analysis ?? {};
  const hasSalesAnalysis = GPT_ANALYSIS_KEYS.some((key) => a[key] !== undefined);

  return {
    status: row.status as CallLearnings['status'],
    outcome: (row.outcome as CallLearnings['outcome']) ?? null,
    end_reason: a.end_reason ?? null,
    tool_calls: a.tool_calls ?? [],
    compliance: {
      recording_notice_played: a.recording_notice_played ?? null,
      recording_notice_at: a.recording_notice_at ?? null,
      ai_disclosure: a.ai_disclosure ?? null,
    },
    sales_analysis: hasSalesAnalysis
      ? {
          overall_effectiveness_score: a.overall_effectiveness_score ?? null,
          opening_technique: a.opening_technique ?? null,
          closing_technique: a.closing_technique ?? null,
          rapport_building: a.rapport_building ?? null,
          pain_points_uncovered: a.pain_points_uncovered ?? [],
          objections: a.objections ?? [],
          key_questions_asked: a.key_questions_asked ?? [],
          what_worked: a.what_worked ?? [],
          what_didnt_work: a.what_didnt_work ?? [],
          recommendations: a.recommendations ?? [],
        }
      : null,
  };
}

export function mapLearningsTranscript(segments: TranscriptSegment[]): CallTranscriptTurn[] {
  return segments.map((s) => ({
    role: s.speaker === 'agent' || s.speaker === 'assistant' ? 'agent' : 'user',
    message: s.text,
    time_in_call_secs: typeof s.start === 'number' ? s.start : null,
  }));
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CallsService {
  private db: Database;
  private redis: Redis;
  private env: Env;
  private logger?: FastifyBaseLogger;

  constructor({ db, redis, env, logger }: { db: Database; redis: Redis; env: Env; logger?: FastifyBaseLogger }) {
    this.db = db;
    this.redis = redis;
    this.env = env;
    this.logger = logger;
  }

  // -------------------------------------------------------------------------
  // listCalls
  // -------------------------------------------------------------------------

  async listCalls(params: ListCallsParams): Promise<{ calls: CallSummary[]; total: number }> {
    const { tenantId, status, qualification, from, to, page, limit } = params;
    const offset = (page - 1) * limit;

    // Build WHERE conditions
    const conditions = [
      eq(conversations.tenantId, tenantId),
      eq(conversations.channel, 'voice'),
    ] as ReturnType<typeof eq>[];

    if (status) {
      conditions.push(eq(conversations.status, status));
    }
    if (from) {
      conditions.push(gte(conversations.createdAt, new Date(from)) as ReturnType<typeof eq>);
    }
    if (to) {
      conditions.push(lte(conversations.createdAt, new Date(to)) as ReturnType<typeof eq>);
    }

    // Fetch all matching conversations joined with leads.
    // Qualification filter requires inspecting message metadata, so we fetch all matches
    // first and apply the qualification filter in JS before paginating.
    const rows = await this.db
      .select({
        id: conversations.id,
        channelRef: conversations.channelRef,
        status: conversations.status,
        summary: conversations.summary,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
        lead: {
          id: leads.id,
          name: leads.name,
          email: leads.email,
          phone: leads.phone,
        },
      })
      .from(conversations)
      .innerJoin(leads, eq(conversations.leadId, leads.id))
      .where(and(...conditions))
      .orderBy(conversations.createdAt);

    if (rows.length === 0) {
      return { calls: [], total: 0 };
    }

    // Fetch all messages for these conversations in one query so we can find
    // the terminal message metadata (call_duration_secs, qualification fields).
    const conversationIds = rows.map((r) => r.id);

    const allMessages = await this.db
      .select({
        conversationId: messages.conversationId,
        metadata: messages.metadata,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, tenantId),
          inArray(messages.conversationId, conversationIds),
        ),
      )
      .orderBy(messages.createdAt);

    // Build map: conversationId → last message's metadata (terminal message)
    const terminalMetaMap = new Map<string, Record<string, unknown>>();
    for (const msg of allMessages) {
      // Overwrite each time so the map ends up with the last (terminal) message
      terminalMetaMap.set(msg.conversationId, (msg.metadata as Record<string, unknown>) ?? {});
    }

    // Build CallSummary list and apply qualification filter
    let summaries: CallSummary[] = rows.map((row) => {
      const meta = terminalMetaMap.get(row.id) ?? {};
      return {
        id: row.id,
        channel_ref: row.channelRef ?? null,
        status: row.status,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
        duration_secs: extractDurationSecs(meta),
        lead: {
          id: row.lead.id,
          name: row.lead.name ?? null,
          email: row.lead.email ?? null,
          phone: row.lead.phone ?? null,
        },
        qualification: extractQualification(meta),
        summary: row.summary ?? null,
      };
    });

    if (qualification) {
      summaries = summaries.filter((s) => s.qualification.status === qualification);
    }

    const total = summaries.length;
    const paginated = summaries.slice(offset, offset + limit);

    return { calls: paginated, total };
  }

  // -------------------------------------------------------------------------
  // getCall
  // -------------------------------------------------------------------------

  async getCall(tenantId: string, id: string): Promise<CallDetail | null> {
    // Load conversation with lead — enforce tenant isolation
    const [row] = await this.db
      .select({
        id: conversations.id,
        channelRef: conversations.channelRef,
        status: conversations.status,
        summary: conversations.summary,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
        channel: conversations.channel,
        lead: {
          id: leads.id,
          name: leads.name,
          email: leads.email,
          phone: leads.phone,
          status: leads.status,
          score: leads.score,
        },
      })
      .from(conversations)
      .innerJoin(leads, eq(conversations.leadId, leads.id))
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, id)))
      .limit(1);

    // Return null for 404: not found, wrong tenant, or not a voice conversation
    if (!row || row.channel !== 'voice') return null;

    // Load all messages ordered chronologically (used for fallback transcript + terminal metadata)
    const msgs = await this.db
      .select({
        role: messages.role,
        content: messages.content,
        contentType: messages.contentType,
        metadata: messages.metadata,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(eq(messages.conversationId, id), eq(messages.tenantId, tenantId)))
      .orderBy(messages.createdAt);

    // Terminal message carries call_duration_secs and qualification metadata
    const terminalMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    const terminalMeta = (terminalMsg?.metadata as Record<string, unknown>) ?? {};
    const qual = extractQualification(terminalMeta);
    const durationSecs = extractDurationSecs(terminalMeta);

    // Build fallback transcript from messages with content_type = 'transcript'
    const fallbackTranscript: CallTranscriptTurn[] = msgs
      .filter((m) => m.contentType === 'transcript')
      .map((m) => {
        const meta = (m.metadata as Record<string, unknown>) ?? {};
        return {
          role: m.role,
          message: m.content,
          time_in_call_secs: typeof meta['time_in_call_secs'] === 'number' ? meta['time_in_call_secs'] : null,
        };
      });

    let transcript: CallTranscriptTurn[] = fallbackTranscript;
    let analysis: CallAnalysis | null = null;

    /**
     * Retell is gone; the transcript comes from the `messages` rows the agent writes, and the
     * richer per-call detail from `call_learnings` below. There used to be a live fetch against
     * Retell's API here (cached in Redis for 10 minutes) that overrode both.
     */
    // LiveKit path: the agent's self-analysis lives in call_learnings, keyed by room
    // name (conference_name = channel_ref). Missing row → learnings stays null; a
    // learnings failure must never take down the call page.
    let learnings: CallLearnings | null = null;
    let learningsDurationSecs: number | null = null;
    if (row.channelRef) {
      try {
        const [learningsRow] = await this.db
          .select()
          .from(callLearnings)
          .where(
            and(
              eq(callLearnings.tenantId, tenantId),
              eq(callLearnings.conferenceName, row.channelRef),
            ),
          )
          .limit(1);

        if (learningsRow) {
          learnings = mapLearnings(learningsRow);
          learningsDurationSecs = learningsRow.durationSecs ?? null;

          // The learnings transcript is the only one a LiveKit call has — use it,
          // but never override a transcript the messages path already built.
          if (transcript.length === 0 && (learningsRow.transcript?.length ?? 0) > 0) {
            transcript = mapLearningsTranscript(learningsRow.transcript ?? []);
          }
        }
      } catch (err) {
        this.logger?.warn(
          { event: 'learnings_fetch_failed', conversationId: id, channelRef: row.channelRef, error: err instanceof Error ? err.message : String(err) },
          'call_learnings lookup failed; returning call without learnings',
        );
      }
    }

    return {
      id: row.id,
      channel_ref: row.channelRef ?? null,
      status: row.status,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      // LiveKit calls have no terminal-message metadata — the learnings row carries duration
      duration_secs: durationSecs ?? learningsDurationSecs,
      lead: {
        id: row.lead.id,
        name: row.lead.name ?? null,
        email: row.lead.email ?? null,
        phone: row.lead.phone ?? null,
        status: row.lead.status,
        score: row.lead.score ?? null,
      },
      transcript,
      analysis,
      qualification: qual,
      summary: row.summary ?? null,
      learnings,
    };
  }

  /**
   * ERASE A CALL: the transcript, the recording reference, the analysis, and the messages.
   *
   * The privacy policy promises deletion, and a call is the densest personal data this system
   * holds — a recorded human voice is biometric data, and the transcript is everything they said.
   * "Delete my data" that leaves the transcript behind is not deletion.
   *
   * THE LEAD SURVIVES. Deleting one call must not silently destroy the person's record and every
   * other conversation with them; a caller asking to erase one recording has not asked to be
   * forgotten entirely. `DELETE /leads/:id` is the endpoint for that, and it deletes the calls too.
   *
   * Returns null when the call does not exist for this tenant, so the route can 404 rather than
   * confirm the existence of somebody else's call.
   */
  async deleteCall(tenantId: string, id: string): Promise<CallDeletionSummary | null> {
    const [row] = await this.db
      .select({ id: conversations.id, channelRef: conversations.channelRef, channel: conversations.channel })
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, id)))
      .limit(1);

    if (!row || row.channel !== 'voice') return null;

    const summary: CallDeletionSummary = { callId: id, messages: 0, learnings: 0, recordingRefs: [] };

    await this.db.transaction(async (tx) => {
      // `call_learnings` is matched on the ROOM NAME, not a foreign key — that is how the two
      // tables have always been joined. Skipping this when channelRef is null is deliberate: an
      // unconstrained delete here would take every learnings row whose conference_name is null.
      if (row.channelRef) {
        const gone = await tx
          .delete(callLearnings)
          .where(and(eq(callLearnings.tenantId, tenantId), eq(callLearnings.conferenceName, row.channelRef)))
          .returning({ id: callLearnings.id, recordingUrl: callLearnings.recordingUrl });
        summary.learnings = gone.length;
        summary.recordingRefs = gone.map((g) => g.recordingUrl).filter((u): u is string => Boolean(u));
      }

      const deletedMessages = await tx
        .delete(messages)
        .where(and(eq(messages.tenantId, tenantId), eq(messages.conversationId, id)))
        .returning({ id: messages.id });
      summary.messages = deletedMessages.length;

      await tx.delete(conversations).where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, id)));
    });

    return summary;
  }
}

export interface CallDeletionSummary {
  callId: string;
  messages: number;
  learnings: number;
  /**
   * Recording URLs that were referenced by the deleted rows.
   *
   * The AUDIO ITSELF IS NOT DELETED — it lives with the provider, not in this database, and this
   * method cannot reach it. Returned so the caller can say so plainly rather than let a "deleted"
   * response imply an erasure that did not happen.
   */
  recordingRefs: string[];
}
