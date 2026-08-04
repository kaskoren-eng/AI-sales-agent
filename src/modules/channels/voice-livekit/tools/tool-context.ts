import { eq } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Env } from '../../../../config/env.js';
import { createDatabase, type Database } from '../../../../db/client.js';
import { tenants } from '../../../../db/schema/index.js';
import { GoogleCalendarProvider } from '../../../scheduling/providers/google-calendar.provider.js';
import type { CallReport, ToolCallLog } from '../call-report.js';
import type { CallStateMachine } from '../call-state.js';
import { resolveFunctionsEnabled } from '../voice-livekit.service.js';

/**
 * Per-call runtime for the agent's tools (Phase 4).
 *
 * The agent process has no Fastify and — until this file — had no database. Tools need both a
 * tenant identity (every DB write is tenant-scoped, no exceptions) and a per-tenant kill switch,
 * so this is where the agent grows a DB connection: ONE settings read at call start, one pool,
 * closed when the call ends.
 *
 * THE GATE IS FAIL-CLOSED. If we cannot prove `voice_engine='livekit'` AND
 * `functions_enabled=true` for a known tenant — metadata missing, DB unreachable, query slow,
 * flag off — the call runs exactly as it did before Phase 4: no tools, the no-tools prompt, the
 * speech-guard rewriting any booking claim. A mis-attributed tool call would write bookings into
 * the wrong tenant's calendar and tables; a silent tool-less call is merely yesterday's product.
 * The tell in the logs is `tools_disabled reason=...`.
 */

/** How long the settings read may hold up call pickup. A hung DB must not eat the greeting. */
export const FLAG_READ_TIMEOUT_MS = 2_000;

/**
 * The UTC window handed to GoogleCalendarProvider. Its slot grid is built in RAW UTC (see
 * israel-time.ts for why), so this brackets Israeli business hours in BOTH clock regimes:
 * 06:00Z = 09:00 IDT (summer) and 15:00Z = 17:00 IST (winter). `filterBusinessHours()` then
 * applies the real Sun–Thu 09:00–17:00 rule in Israel local time.
 */
export const PROVIDER_UTC_WORK_START = '06:00';
export const PROVIDER_UTC_WORK_END = '15:00';

/** What book_meeting proved on THIS call — the confirmation tools' single source of truth. */
export interface LastBooking {
  uid: string;
  start: string;
  meetLink?: string;
  name: string;
  email: string;
  phone: string;
  durationMinutes: number;
  inviteSent: boolean;
}

export interface ToolRuntimeContext {
  tenantId: string;
  /** From outbound dial metadata. Null on inbound — book_meeting upserts the lead by phone. */
  leadId: string | null;
  /** The `conversations` row for this call, created at dial/web-call time (Task 0) and threaded in
   * via metadata. Null on inbound SIP (no dispatcher row yet) and on calls where the insert failed.
   * When set, end-of-call finalization updates THIS row (status='ended', summary). */
  conversationId: string | null;
  /** The LiveKit room name — the call's id everywhere. */
  callId: string;
  callerPhone: string | null;
  db: Database;
  closeDb: () => Promise<void>;
  /** Fresh provider per duration — slotMinutes is fixed at construction in the shared provider. */
  makeProvider: (slotMinutes: number) => GoogleCalendarProvider;
  report: CallReport;
  env: Env;
  /**
   * Mutable per-call state, shared across the tools via this object:
   * - lastCheckedDurationMinutes: set by check_calendar_availability, read by book_meeting so a
   *   re-check runs on the SAME grid the lead was offered.
   * - bookingCompleted: flips the speech-guard — she may claim a booking only after a real one.
   * - endReason: what end_call was told, persisted to call_learnings.analysis.end_reason.
   */
  lastCheckedDurationMinutes: number | null;
  bookingCompleted: boolean;
  endReason: string | null;
  /** Raw tenants.settings loaded at gate time — previously discarded; tools read per-tenant
   * config (templates, reminders, limits) from here without a second DB round trip. */
  settings: unknown;
  /** BullMQ handle to 'outbound-sender'. Null when Redis is unreachable — messaging tools then
   * refuse TRUTHFULLY instead of the call failing. */
  outboundQueue: Queue | null;
  /** BullMQ handle to 'meeting-reminders' (same Redis connection). Null on Redis failure. */
  remindersQueue: Queue | null;
  /** BullMQ handle to 'call-analysis' (same Redis connection). Null on Redis failure. Used at call
   * end to enqueue the LiveKit transcript analysis (GPT summary + conversation finalize). */
  callAnalysisQueue: Queue | null;
  /** Set by book_meeting on success; cleared never (one meeting per call). */
  lastBooking: LastBooking | null;
  /** The advisory conversation state machine (stage + working memory + situations). The SAME
   * instance lives on the agent instance too — tools advance it via onToolCall / read it for
   * guardrails; the agent advances it on turns and reflex events. `undefined` when the advisory
   * layer is disabled (VOICE_STATE_MACHINE_ENABLED=false) — every tool reads it as `rt.callState?.`. */
  callState: CallStateMachine | undefined;
}

export type ToolRuntimeResult =
  | { runtime: ToolRuntimeContext; disabledReason: null }
  | { runtime: null; disabledReason: string };

/** Injection seam for tests — the default deps hit the real DB/Redis. */
export interface ToolRuntimeDeps {
  connectDb?: () => { db: Database; close: () => Promise<void> };
  loadSettings?: (db: Database, tenantId: string) => Promise<unknown>;
  makeQueues?: (env: Env) => {
    outboundQueue: Queue;
    remindersQueue: Queue;
    callAnalysisQueue: Queue;
    close: () => Promise<void>;
  };
}

/** What the outbound dialer / web-call route put on the participant. `settings` is the sanitized
 * per-tenant config (see sanitizeSettingsForAgent) — present on cloud dispatch, absent on inbound
 * SIP (which falls back to the agent-side DB read). */
export function parseOutboundMetadata(
  metadata: string | undefined,
): { tenantId: string; leadId: string | null; conversationId: string | null; settings?: unknown } | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    if (typeof parsed.tenantId === 'string' && parsed.tenantId.length > 0) {
      return {
        tenantId: parsed.tenantId,
        leadId: typeof parsed.leadId === 'string' && parsed.leadId.length > 0 ? parsed.leadId : null,
        conversationId:
          typeof parsed.conversationId === 'string' && parsed.conversationId.length > 0
            ? parsed.conversationId
            : null,
        ...(parsed.settings && typeof parsed.settings === 'object' ? { settings: parsed.settings } : {}),
      };
    }
  } catch {
    // Malformed metadata is an inbound/console call, not an error.
  }
  return null;
}

/**
 * The pure gate decision, separated from I/O so the fail-closed matrix is unit-testable.
 *
 * There is only one voice engine now, so the gate rests entirely on `functions_enabled`:
 * STRICT `=== true`, no env fallback, no default-on. Tools write to the tenant's calendar and
 * tables, so absence of the flag means NO.
 */
export function evaluateToolGate(settings: unknown): { enabled: boolean; reason: string | null } {
  if (!resolveFunctionsEnabled(settings)) return { enabled: false, reason: 'functions_disabled' };
  return { enabled: true, reason: null };
}

export async function buildToolRuntime(
  env: Env,
  opts: {
    callId: string;
    callerPhone: string | null;
    participantMetadata: string | undefined;
    report: CallReport;
    /** The per-call state machine, constructed in agent.ts and shared with the agent instance.
     * `undefined` when the advisory layer is disabled (VOICE_STATE_MACHINE_ENABLED=false). */
    callState: CallStateMachine | undefined;
  },
  deps: ToolRuntimeDeps = {},
): Promise<ToolRuntimeResult> {
  // 1. Who is this call for? Outbound dials carry it in metadata; inbound falls back to the
  //    single-tenant env var. No tenant, no tools.
  const identity = parseOutboundMetadata(opts.participantMetadata) ?? (env.VOICE_WEBHOOK_TENANT_ID
    ? { tenantId: env.VOICE_WEBHOOK_TENANT_ID, leadId: null, conversationId: null }
    : null);
  if (!identity) return { runtime: null, disabledReason: 'no_tenant' };

  // 2. Tools without a calendar can only disappoint — the prompt promises booking. Gate on creds.
  if (!env.GOOGLE_CALENDAR_ID || !env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_CALENDAR_PRIVATE_KEY) {
    return { runtime: null, disabledReason: 'calendar_not_configured' };
  }

  // 3. One settings read, timeboxed — the greeting must not wait on a hung database.
  const connect = deps.connectDb ?? (() => {
    const { db, pool } = createDatabase(env.DATABASE_URL);
    return { db, close: () => pool.end() };
  });
  const load = deps.loadSettings ?? (async (db: Database, tenantId: string) => {
    const rows = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (rows.length === 0) throw new Error('tenant_not_found');
    return rows[0]!.settings;
  });

  let connection: { db: Database; close: () => Promise<void> };
  try {
    connection = connect();
  } catch (err) {
    console.error('tool_runtime_db_connect_failed', err instanceof Error ? err.message : String(err));
    return { runtime: null, disabledReason: 'db_connect_failed' };
  }

  // 3. The gate config. PREFER the settings the dispatcher already resolved and shipped in the
  //    metadata (backend-side, fast+correct DB) — the agent then gates instantly and never depends
  //    on a cold cross-region DB read at pickup. Only inbound SIP (no dispatcher settings) falls
  //    back to the timeboxed agent-side read. Tenant id is logged on failure so a mis-stamped or
  //    missing tenant is diagnosable instead of a silent "settings_read_failed".
  let settings: unknown;
  if ('settings' in identity && identity.settings !== undefined) {
    settings = identity.settings;
    // Warm the pool off the hot path so the first mid-call tool WRITE isn't cold. Errors are
    // irrelevant here — the gate already has its answer; writes degrade gracefully (invariant 2).
    void load(connection.db, identity.tenantId).catch(() => undefined);
  } else {
    try {
      settings = await withTimeout(load(connection.db, identity.tenantId), FLAG_READ_TIMEOUT_MS);
    } catch (err) {
      await connection.close().catch(() => undefined);
      const reason = err instanceof Error && err.message === 'timeout' ? 'settings_read_timeout' : 'settings_read_failed';
      console.error(
        'tool_runtime_settings_failed',
        JSON.stringify({ tenantId: identity.tenantId, error: err instanceof Error ? err.message : String(err) }),
      );
      return { runtime: null, disabledReason: reason };
    }
  }

  // 4. The per-tenant kill switch.
  const gate = evaluateToolGate(settings);
  if (!gate.enabled) {
    await connection.close().catch(() => undefined);
    return { runtime: null, disabledReason: gate.reason! };
  }

  // Messaging queues — best-effort: a dead Redis degrades the messaging TOOLS (they refuse
  // truthfully), never the call. One connection, two queues, closed together with the pool.
  let outboundQueue: Queue | null = null;
  let remindersQueue: Queue | null = null;
  let callAnalysisQueue: Queue | null = null;
  let closeQueues: () => Promise<void> = async () => undefined;
  try {
    const built = (deps.makeQueues ?? defaultMakeQueues)(env);
    outboundQueue = built.outboundQueue;
    remindersQueue = built.remindersQueue;
    callAnalysisQueue = built.callAnalysisQueue;
    closeQueues = built.close;
  } catch (err) {
    console.error('tool_runtime_redis_failed', err instanceof Error ? err.message : String(err));
  }

  const closeAll = async (): Promise<void> => {
    await closeQueues().catch(() => undefined);
    await connection.close().catch(() => undefined);
  };

  const privateKey = env.GOOGLE_CALENDAR_PRIVATE_KEY.replace(/\\n/g, '\n');
  return {
    disabledReason: null,
    runtime: {
      tenantId: identity.tenantId,
      leadId: identity.leadId,
      conversationId: identity.conversationId,
      callId: opts.callId,
      callerPhone: opts.callerPhone,
      db: connection.db,
      closeDb: closeAll,
      makeProvider: (slotMinutes: number) =>
        new GoogleCalendarProvider({
          calendarId: env.GOOGLE_CALENDAR_ID!,
          serviceAccountEmail: env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL!,
          privateKey,
          slotMinutes,
          workStart: PROVIDER_UTC_WORK_START,
          workEnd: PROVIDER_UTC_WORK_END,
          impersonateUser: env.GOOGLE_CALENDAR_IMPERSONATE_USER,
        }),
      report: opts.report,
      env,
      lastCheckedDurationMinutes: null,
      bookingCompleted: false,
      endReason: null,
      settings,
      outboundQueue,
      remindersQueue,
      callAnalysisQueue,
      lastBooking: null,
      callState: opts.callState,
    },
  };
}

/** Real queue construction — one Redis connection shared by all queues. */
function defaultMakeQueues(env: Env): {
  outboundQueue: Queue;
  remindersQueue: Queue;
  callAnalysisQueue: Queue;
  close: () => Promise<void>;
} {
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  const outboundQueue = new Queue('outbound-sender', { connection: redis });
  const remindersQueue = new Queue('meeting-reminders', { connection: redis });
  const callAnalysisQueue = new Queue('call-analysis', { connection: redis });
  return {
    outboundQueue,
    remindersQueue,
    callAnalysisQueue,
    close: async () => {
      await outboundQueue.close().catch(() => undefined);
      await remindersQueue.close().catch(() => undefined);
      await callAnalysisQueue.close().catch(() => undefined);
      await redis.quit().catch(() => undefined);
    },
  };
}

/** Timeboxes a queue enqueue so a hung Redis costs the caller milliseconds, not the call. */
export async function timeboxedEnqueue<T>(op: () => Promise<T>, ms = 1_500): Promise<T> {
  return withTimeout(op(), ms);
}

/**
 * Wraps a tool handler with the latency instrumentation every new code path must have
 * (methodology rule: measure before you optimize; phase-4 budget is <500ms per tool call).
 * Duration lands in the console (live tail) AND the CallReport (→ call_learnings.analysis).
 * Failures are recorded too — a tool that errors invisibly is how "she said she booked it"
 * happens — then rethrown so the LLM hears about it.
 */
export async function timedTool<T>(
  rt: ToolRuntimeContext,
  name: string,
  args: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const entry: Omit<ToolCallLog, 'durationMs' | 'ok'> = { atMs: 0, name, args: redactArgs(args) };
  try {
    const result = await fn();
    finish(rt, entry, startedAt, true);
    return result;
  } catch (err) {
    finish(rt, entry, startedAt, false, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

function finish(
  rt: ToolRuntimeContext,
  entry: Omit<ToolCallLog, 'durationMs' | 'ok'>,
  startedAt: number,
  ok: boolean,
  error?: string,
): void {
  const durationMs = Math.round(performance.now() - startedAt);
  const log: ToolCallLog = { ...entry, durationMs, ok, ...(error ? { error } : {}) };
  rt.report.recordToolCall(log);
  console.log('tool_call', JSON.stringify({ name: log.name, durationMs, ok, ...(error ? { error } : {}) }));
}

/** PII never reaches a log line — phones/emails are cut to identifiable-to-us-only suffixes. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    const k = key.toLowerCase();
    if (k.includes('phone')) out[key] = `…${value.slice(-4)}`;
    else if (k.includes('email')) out[key] = `…${value.slice(value.indexOf('@'))}`;
    else if (k.includes('name')) out[key] = `${value.slice(0, 1)}…`;
    else out[key] = value.length > 120 ? `${value.slice(0, 120)}…` : value;
  }
  return out;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
