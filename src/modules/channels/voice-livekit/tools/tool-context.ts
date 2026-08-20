import { and, eq, inArray } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Env } from '../../../../config/env.js';
import { createDatabase, type Database } from '../../../../db/client.js';
import { phoneNumbers, tenants } from '../../../../db/schema/index.js';
import { didCandidates } from '../../../../shared/phone-number.js';
import {
  GoogleCalendarProvider,
  type GoogleCalendarAuth,
} from '../../../scheduling/providers/google-calendar.provider.js';
import {
  GoogleCalendarConnectionService,
  isInvalidGrant,
} from '../../../integrations/google-calendar/google-calendar.connection.js';
import {
  resolveCalendarAuth,
  type ResolvedCalendar,
} from '../../../integrations/google-calendar/resolve-calendar-auth.js';
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
  /**
   * Called when a calendar tool fails because the tenant's Google grant is dead (`invalid_grant`).
   *
   * Fire-and-forget by contract: marking the connection revoked is bookkeeping for the dashboard,
   * and must never turn a failed booking into a failed CALL. Undefined for the platform tenant,
   * whose service account cannot be revoked by a customer.
   */
  onCalendarRevoked?: () => void;
  /** The advisory conversation state machine (stage + working memory + situations). The SAME
   * instance lives on the agent instance too — tools advance it via onToolCall / read it for
   * guardrails; the agent advances it on turns and reflex events. `undefined` when the advisory
   * layer is disabled (VOICE_STATE_MACHINE_ENABLED=false) — every tool reads it as `rt.callState?.`. */
  callState: CallStateMachine | undefined;
}

/**
 * `settings` is returned SEPARATELY from `runtime`, and on every path including the failures.
 *
 * The tool gate and the agent's IDENTITY are different questions that happen to need the same row.
 * When they shared a return value, a tenant with `functions_enabled: false` got `runtime: null` —
 * and with it, ClickScales' name, company, FAQ and greeting, because the settings that said who
 * they were had been thrown away along with the tools. "You have not enabled booking" must never
 * mean "your agent now introduces itself as someone else's".
 */
export type ToolRuntimeResult =
  | { runtime: ToolRuntimeContext; disabledReason: null; settings: unknown }
  | { runtime: null; disabledReason: string; settings: unknown };

/** Injection seam for tests — the default deps hit the real DB/Redis. */
export interface ToolRuntimeDeps {
  connectDb?: () => { db: Database; close: () => Promise<void> };
  loadSettings?: (db: Database, tenantId: string) => Promise<unknown>;
  /** Overrides the `phone_numbers` lookup used to route inbound calls. */
  lookupNumber?: PhoneNumberLookup;
  /** Overrides the per-tenant Google Calendar connection lookup. */
  loadCalendarConnection?: (
    db: Database,
    tenantId: string,
  ) => Promise<{ calendarId: string; auth: GoogleCalendarAuth } | null>;
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
 * WHOSE CALL IS THIS, and how do we know.
 *
 * `source` is not diagnostics decoration — it is the answer to the only question that matters when
 * a call ends up in the wrong place. Before this existed, every inbound call on every number
 * resolved to `env.VOICE_WEBHOOK_TENANT_ID`, so with two customers tenant #2's caller reached
 * tenant #1's agent and any lead created landed in tenant #1's data. There was nothing in the logs
 * to say that had happened, because from the code's point of view nothing unusual had.
 */
export type CallIdentitySource =
  /** An outbound dial we placed — the dispatcher stamped the tenant on the participant. */
  | 'outbound_metadata'
  /** An inbound PSTN call matched to a `phone_numbers` row by the dialled DID. */
  | 'did_lookup'
  /** No DID matched, and the single-tenant env var stood in. NON-PRODUCTION ONLY — see below. */
  | 'env_fallback';

export interface CallIdentity {
  tenantId: string;
  leadId: string | null;
  conversationId: string | null;
  settings?: unknown;
  source: CallIdentitySource;
}

/** Why a call could not be attributed to a tenant. Each one answers the phone and hangs up. */
export type CallIdentityRefusal = 'no_tenant' | 'unmapped_did' | 'number_unassigned' | 'number_inactive';

/**
 * The refusals that mean "a real person dialled a real number and we will not serve them".
 *
 * The agent answers these with the not-in-service announcement and hangs up, creating no lead, no
 * conversation and no call record. Distinguished from `no_tenant` — which is a misconfigured
 * console session, not a caller — because only these should ever reach a human ear.
 */
export const DID_REFUSALS: readonly CallIdentityRefusal[] = [
  'unmapped_did',
  'number_unassigned',
  'number_inactive',
];

export function isDidRefusal(reason: string | null): boolean {
  return reason !== null && (DID_REFUSALS as readonly string[]).includes(reason);
}

export type CallIdentityResult =
  | { identity: CallIdentity; refusal: null }
  | { identity: null; refusal: CallIdentityRefusal };

/**
 * The `phone_numbers` lookup, as an injectable seam — same pattern as `loadSettings` above.
 *
 * It is a function rather than a `Database` because the routing decision deserves a test that
 * asserts on the CANDIDATES it asked for, not on drizzle's query object. The first version of the
 * test tried to reach into the `inArray` fragment to recover them; that structure is circular and
 * internal, so the test was really asserting on drizzle's shape rather than on our routing.
 */
export type PhoneNumberLookup = (
  candidates: string[],
) => Promise<{ tenantId: string | null; isActive: boolean } | null>;

/** The real lookup: exact match over the candidate spellings, one row. */
export function makePhoneNumberLookup(db: Database): PhoneNumberLookup {
  return async (candidates) => {
    const [row] = await db
      .select({ tenantId: phoneNumbers.tenantId, isActive: phoneNumbers.isActive })
      .from(phoneNumbers)
      .where(inArray(phoneNumbers.e164, candidates))
      .limit(1);
    return row ?? null;
  };
}

/**
 * Resolve the tenant for a call, in priority order.
 *
 * 1. OUTBOUND METADATA — we placed the call, so we already know. Nothing can override this.
 * 2. DID LOOKUP — an inbound PSTN call, matched on the number that was dialled. Exact match over
 *    candidate spellings (see `shared/phone-number.ts`); a suffix match could route across tenants.
 * 3. ENV FALLBACK — `VOICE_WEBHOOK_TENANT_ID`, and ONLY when no DID was dialled at all. That means
 *    console calls and the browser Simulator, which have no dialled number by definition.
 *
 * THE CRITICAL RULE IS WHAT DOES *NOT* HAPPEN: a call that dialled a real number we cannot map
 * NEVER falls through to the env tenant. Falling through is how tenant #2's caller ends up in
 * tenant #1's data, and it is indistinguishable from working correctly until a customer notices.
 * An unmapped number is refused, and the agent answers with "not in service".
 */
export async function resolveCallIdentity(
  env: Env,
  opts: { participantMetadata: string | undefined; calledNumber: string | null },
  deps: { lookupNumber?: PhoneNumberLookup } = {},
): Promise<CallIdentityResult> {
  const fromMetadata = parseOutboundMetadata(opts.participantMetadata);
  if (fromMetadata) {
    return { identity: { ...fromMetadata, source: 'outbound_metadata' }, refusal: null };
  }

  const candidates = didCandidates(opts.calledNumber);

  if (candidates.length > 0) {
    // A number WAS dialled. From here the only acceptable answers are "this tenant" or "refuse" —
    // never the env fallback.
    if (!deps.lookupNumber) return { identity: null, refusal: 'unmapped_did' };

    const row = await deps.lookupNumber(candidates);

    if (!row) return { identity: null, refusal: 'unmapped_did' };
    if (!row.isActive) return { identity: null, refusal: 'number_inactive' };
    // Bought but not yet assigned to a customer. A real state, and not one to guess about.
    if (!row.tenantId) return { identity: null, refusal: 'number_unassigned' };

    return {
      identity: { tenantId: row.tenantId, leadId: null, conversationId: null, source: 'did_lookup' },
      refusal: null,
    };
  }

  // No dialled number: a console session or a browser web-call that carried no metadata.
  if (env.VOICE_WEBHOOK_TENANT_ID) {
    return {
      identity: {
        tenantId: env.VOICE_WEBHOOK_TENANT_ID,
        leadId: null,
        conversationId: null,
        source: 'env_fallback',
      },
      refusal: null,
    };
  }
  return { identity: null, refusal: 'no_tenant' };
}

/**
 * Whose calendar this tenant books into.
 *
 * The implementation moved to `integrations/google-calendar/resolve-calendar-auth.ts` when the
 * REST scheduling routes needed the same answer: they were building a provider straight from
 * `GOOGLE_CALENDAR_*` env, so every tenant's API booking landed in ClickScales' calendar. A rule
 * about whose diary a meeting goes into cannot live inside one caller.
 *
 * Re-exported rather than re-pointed at each call site so the agent's imports and tests are
 * unchanged by the move.
 */
export { resolveCalendarAuth, type ResolvedCalendar };


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
    /** The DID the caller dialled — OURS, not theirs. Null for console and web calls. */
    calledNumber?: string | null;
    participantMetadata: string | undefined;
    report: CallReport;
    /** The per-call state machine, constructed in agent.ts and shared with the agent instance.
     * `undefined` when the advisory layer is disabled (VOICE_STATE_MACHINE_ENABLED=false). */
    callState: CallStateMachine | undefined;
  },
  deps: ToolRuntimeDeps = {},
): Promise<ToolRuntimeResult> {
  // The DB is opened BEFORE identity is resolved, because resolving an inbound call now requires a
  // `phone_numbers` lookup. Outbound calls never reach that query — their tenant is on the metadata
  // — so the dialer's hot path is unchanged.
  const connect = deps.connectDb ?? (() => {
    const { db, pool } = createDatabase(env.DATABASE_URL);
    return { db, close: () => pool.end() };
  });

  let identityConnection: { db: Database; close: () => Promise<void> } | null = null;
  try {
    identityConnection = connect();
  } catch (err) {
    console.error('tool_runtime_db_connect_failed', err instanceof Error ? err.message : String(err));
    // Without a DB an inbound DID cannot be mapped. Refusing beats guessing a tenant.
    if (!parseOutboundMetadata(opts.participantMetadata)) {
      return { runtime: null, disabledReason: 'db_connect_failed', settings: null };
    }
  }

  // 1. Who is this call for? See `resolveCallIdentity` — the important part is that an inbound call
  //    to a number we cannot map is REFUSED rather than handed to the env-var tenant.
  const resolved = await resolveCallIdentity(
    env,
    { participantMetadata: opts.participantMetadata, calledNumber: opts.calledNumber ?? null },
    {
      ...(deps.lookupNumber
        ? { lookupNumber: deps.lookupNumber }
        : identityConnection
          ? { lookupNumber: makePhoneNumberLookup(identityConnection.db) }
          : {}),
    },
  );

  if (!resolved.identity) {
    await identityConnection?.close().catch(() => undefined);
    console.warn(
      'call_identity_refused',
      JSON.stringify({ reason: resolved.refusal, calledNumber: opts.calledNumber ?? null }),
    );
    // `unmapped_did` and friends surface to the agent, which plays the not-in-service notice.
    return { runtime: null, disabledReason: resolved.refusal, settings: null };
  }

  const identity = resolved.identity;
  console.log(
    'call_identity',
    JSON.stringify({
      tenantId: identity.tenantId,
      source: identity.source,
      calledNumber: opts.calledNumber ?? null,
    }),
  );

  // Whatever the dispatcher already shipped. Held separately so every failure path below can still
  // hand the agent its identity — see the note on ToolRuntimeResult.
  const metadataSettings = 'settings' in identity ? identity.settings : undefined;

  // 2. One settings read, timeboxed — the greeting must not wait on a hung database.
  const load = deps.loadSettings ?? (async (db: Database, tenantId: string) => {
    const rows = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (rows.length === 0) throw new Error('tenant_not_found');
    return rows[0]!.settings;
  });

  // REUSE the pool opened for the identity lookup. Opening a second one here would mean two pools
  // per call, and only one of them ever gets closed — a leak that only shows up under call volume,
  // which is the worst time to find it.
  let connection: { db: Database; close: () => Promise<void> };
  if (identityConnection) {
    connection = identityConnection;
  } else {
    try {
      connection = connect();
    } catch (err) {
      console.error('tool_runtime_db_connect_failed', err instanceof Error ? err.message : String(err));
      return { runtime: null, disabledReason: 'db_connect_failed', settings: metadataSettings ?? null };
    }
  }

  // 3. The gate config. PREFER the settings the dispatcher already resolved and shipped in the
  //    metadata (backend-side, fast+correct DB) — the agent then gates instantly and never depends
  //    on a cold cross-region DB read at pickup. Only inbound SIP (no dispatcher settings) falls
  //    back to the timeboxed agent-side read. Tenant id is logged on failure so a mis-stamped or
  //    missing tenant is diagnosable instead of a silent "settings_read_failed".
  let settings: unknown;
  if (metadataSettings !== undefined) {
    settings = metadataSettings;
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
      return { runtime: null, disabledReason: reason, settings: null };
    }
  }

  // 4. WHOSE CALENDAR. Tools without a calendar can only disappoint — the prompt promises booking.
  //
  //    This check used to run BEFORE the settings read, which was cheaper and wrong: it returned
  //    before the tenant's identity had been loaded, so a missing calendar credential silently
  //    renamed the agent. The gate is about tools; it must not decide who is speaking.
  //
  //    It also used to resolve to the GLOBAL `GOOGLE_CALENDAR_*` env for every tenant. That is the
  //    bug this step closes: customer #2's agent would qualify a lead, agree a time, and write the
  //    meeting into ClickScales' calendar. Nothing errors — the tool succeeds, and the agent tells
  //    the lead it is booked — while their salesperson never sees it.
  const calendar = await resolveCalendarAuth(env, identity.tenantId, connection.db, deps);
  if (!calendar) {
    await connection.close().catch(() => undefined);
    return { runtime: null, disabledReason: 'calendar_not_configured', settings };
  }

  // 5. The per-tenant kill switch.
  const gate = evaluateToolGate(settings);
  if (!gate.enabled) {
    await connection.close().catch(() => undefined);
    return { runtime: null, disabledReason: gate.reason!, settings };
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

  // (The private key is unescaped inside resolveCalendarAuth now — it belongs with the credentials
  // it decodes, not here, where it was read from env regardless of whose calendar was in use.)
  return {
    disabledReason: null,
    settings,
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
          calendarId: calendar.calendarId,
          auth: calendar.auth,
          slotMinutes,
          workStart: PROVIDER_UTC_WORK_START,
          workEnd: PROVIDER_UTC_WORK_END,
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
      // Only an OAuth grant can be revoked BY THE CUSTOMER. The platform service account fails for
      // other reasons, and marking it "revoked" would put a reconnect prompt in ClickScales' own
      // dashboard for a connection that has no connect button.
      ...(calendar.source === 'tenant_oauth'
        ? {
            onCalendarRevoked: () => {
              console.error(
                'gcal_grant_revoked',
                JSON.stringify({ tenantId: identity.tenantId, calendarId: calendar.calendarId }),
              );
              void new GoogleCalendarConnectionService(connection.db, env.ENCRYPTION_KEY)
                .markRevoked(identity.tenantId)
                .catch((err) =>
                  console.error(
                    'gcal_mark_revoked_failed',
                    err instanceof Error ? err.message : String(err),
                  ),
                );
            },
          }
        : {}),
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
    // EVERY calendar tool comes through here, which makes this the one place that sees a dead
    // grant regardless of which tool tripped over it. Without this, a customer who revokes us in
    // their Google settings gets bookings that silently stop working: the agent keeps trying, the
    // dashboard keeps saying "Connected", and the first anyone hears of it is an empty diary.
    if (isInvalidGrant(err)) rt.onCalendarRevoked?.();
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
