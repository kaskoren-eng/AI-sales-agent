import { eq } from 'drizzle-orm';
import type { Env } from '../../../../config/env.js';
import { createDatabase, type Database } from '../../../../db/client.js';
import { tenants } from '../../../../db/schema/index.js';
import { GoogleCalendarProvider } from '../../../scheduling/providers/google-calendar.provider.js';
import type { CallReport, ToolCallLog } from '../call-report.js';
import { resolveFunctionsEnabled, resolveVoiceEngine } from '../voice-livekit.service.js';

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

export interface ToolRuntimeContext {
  tenantId: string;
  /** From outbound dial metadata. Null on inbound — book_meeting upserts the lead by phone. */
  leadId: string | null;
  /** Nothing creates a conversations row for LiveKit calls yet — carried for the day one does. */
  conversationId: string | null;
  /** The LiveKit room name — the call's id everywhere (same role as Retell's call_id). */
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
}

export type ToolRuntimeResult =
  | { runtime: ToolRuntimeContext; disabledReason: null }
  | { runtime: null; disabledReason: string };

/** Injection seam for tests — the default deps hit the real DB. */
export interface ToolRuntimeDeps {
  connectDb?: () => { db: Database; close: () => Promise<void> };
  loadSettings?: (db: Database, tenantId: string) => Promise<unknown>;
}

/** What the outbound dialer put on the SIP participant (voice-livekit.service.ts). */
export function parseOutboundMetadata(
  metadata: string | undefined,
): { tenantId: string; leadId: string | null } | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    if (typeof parsed.tenantId === 'string' && parsed.tenantId.length > 0) {
      return {
        tenantId: parsed.tenantId,
        leadId: typeof parsed.leadId === 'string' && parsed.leadId.length > 0 ? parsed.leadId : null,
      };
    }
  } catch {
    // Malformed metadata is an inbound/console call, not an error.
  }
  return null;
}

/** The pure gate decision, separated from I/O so the fail-closed matrix is unit-testable. */
export function evaluateToolGate(settings: unknown, env: Env): { enabled: boolean; reason: string | null } {
  if (resolveVoiceEngine(settings, env) !== 'livekit') return { enabled: false, reason: 'engine_not_livekit' };
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
  },
  deps: ToolRuntimeDeps = {},
): Promise<ToolRuntimeResult> {
  // 1. Who is this call for? Outbound dials carry it in metadata; inbound falls back to the
  //    single-tenant env var (same pattern as the Retell webhook). No tenant, no tools.
  const identity = parseOutboundMetadata(opts.participantMetadata) ?? (env.VOICE_WEBHOOK_TENANT_ID
    ? { tenantId: env.VOICE_WEBHOOK_TENANT_ID, leadId: null }
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

  let settings: unknown;
  try {
    settings = await withTimeout(load(connection.db, identity.tenantId), FLAG_READ_TIMEOUT_MS);
  } catch (err) {
    await connection.close().catch(() => undefined);
    const reason = err instanceof Error && err.message === 'timeout' ? 'settings_read_timeout' : 'settings_read_failed';
    console.error('tool_runtime_settings_failed', err instanceof Error ? err.message : String(err));
    return { runtime: null, disabledReason: reason };
  }

  // 4. The per-tenant kill switch.
  const gate = evaluateToolGate(settings, env);
  if (!gate.enabled) {
    await connection.close().catch(() => undefined);
    return { runtime: null, disabledReason: gate.reason! };
  }

  const privateKey = env.GOOGLE_CALENDAR_PRIVATE_KEY.replace(/\\n/g, '\n');
  return {
    disabledReason: null,
    runtime: {
      tenantId: identity.tenantId,
      leadId: identity.leadId,
      conversationId: null,
      callId: opts.callId,
      callerPhone: opts.callerPhone,
      db: connection.db,
      closeDb: connection.close,
      makeProvider: (slotMinutes: number) =>
        new GoogleCalendarProvider({
          calendarId: env.GOOGLE_CALENDAR_ID!,
          serviceAccountEmail: env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL!,
          privateKey,
          slotMinutes,
          workStart: PROVIDER_UTC_WORK_START,
          workEnd: PROVIDER_UTC_WORK_END,
        }),
      report: opts.report,
      env,
      lastCheckedDurationMinutes: null,
      bookingCompleted: false,
      endReason: null,
    },
  };
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
