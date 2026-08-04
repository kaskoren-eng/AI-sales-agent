import { eq, and, gte, lte, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { Redis } from 'ioredis';
import type { Env } from '../../config/env.js';
import type { FastifyBaseLogger } from 'fastify';
import { conversations, leads, messages } from '../../db/schema/index.js';

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

    // The transcript is whatever the DB holds. Historical calls from the retired engine kept
    // their turns in `messages` (content_type='transcript'), written at call-analysis time, so
    // they still render here; LiveKit calls write the same rows. There is no live vendor fetch.
    const transcript: CallTranscriptTurn[] = fallbackTranscript;
    const analysis: CallAnalysis | null = null;

    return {
      id: row.id,
      channel_ref: row.channelRef ?? null,
      status: row.status,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      duration_secs: durationSecs,
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
    };
  }

}
