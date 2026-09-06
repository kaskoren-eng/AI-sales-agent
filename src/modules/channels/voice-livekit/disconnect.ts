import { and, eq, sql } from 'drizzle-orm';
import { callbacks, leads } from '../../../db/schema/index.js';
import { meterLead } from '../../billing/usage.service.js';
import type { CallStage } from './call-state.js';
import { phoneSuffix } from './tools/book-meeting.tool.js';
import { CALLBACK_DEFAULTS, clampToWindow } from './tools/callback-time.js';
import { resolveCallbackSettings } from './tools/callback-settings.js';
import { CALLER_HUNGUP_END_REASON } from './tools/end-call.tool.js';
import { resolveHandoffSettings } from './tools/handoff-settings.js';
import { notifyOwner } from './tools/owner-notify.js';
import type { ToolRuntimeContext } from './tools/tool-context.js';

/**
 * THE CALLER HUNG UP AND NOBODY NOTICED.
 *
 * Koren's own top-priority item, in his words: *"אסור שהוא ייפול בין הכיסאות"*. Before this file,
 * a caller who put the phone down in the middle of the conversation produced exactly nothing —
 * `end_reason` stayed NULL, no lead was flagged, no callback was scheduled, and nobody was told.
 * The lead who was most engaged when the line died was the one we dropped, and the metrics were
 * worse than silent about it: `metrics.service.ts` excludes a NULL end reason from the booking-rate
 * denominator, so every silent hangup made the booking rate look BETTER than it was.
 *
 * ── THE DISCRIMINATOR, AND WHY IT HOLDS ──────────────────────────────────────────────────────
 *
 * "The remote participant left AND `rt.endReason` is still null" means the caller hung up. Every
 * agent-initiated ending sets the reason BEFORE the room is torn down — verified by reading all
 * four call sites of `runEndCallTeardown`, which is the only path to `deleteRoom()`:
 *
 *   end-call.tool.ts        `rt.endReason = reason`              before the teardown call
 *   request-human-handoff   `rt.endReason = 'handoff_requested'` before the teardown call
 *   agent.ts (voicemail)    `action.endReason = 'voicemail'`     — decideVoicemailAction always sets it
 *   agent.ts (silence)      `action.endReason` is OPTIONAL       — see the caveat below
 *
 * ⚠️ THE ONE HOLE, AND WHY THE CHECK IS BELT-AND-BRACES. The silence reflex tears down under
 * `if (action.teardown)` but only sets the reason `if (action.endReason)`. `decideSilenceAction`
 * returns `teardown: false` on both of its branches today, so that block is unreachable and the
 * hole is theoretical — but it is one word away from being real, and a false `caller_hung_up`
 * would ring back a lead who had never been on the line. So `shouldMarkCallerHangup` ALSO refuses
 * when the state machine has reached `terminal`, which every code-driven ending sets (via
 * `markTerminal()` or `onToolCall('end_call')`). Either signal alone would do today; requiring
 * both to be absent means a future reflex that forgets its reason still cannot be read as a hangup.
 *
 * ── STAGE-AWARE SEVERITY ─────────────────────────────────────────────────────────────────────
 *
 * A hangup during `opening` — while she is still delivering the AI disclosure — is a wrong number
 * or a mis-dial. Ringing that person back, and waking the business owner to tell him about it, is
 * how a useful alert becomes one nobody reads. From `discovery` onward the caller has spoken at
 * least once, and that is the "we didn't get along, or the line died" case Koren is asking about.
 * BOTH are recorded on the CallReport; only the second raises a callback and an alert.
 *
 * ── IT IS NOT A CRM STATUS ───────────────────────────────────────────────────────────
 *
 * `caller_hung_up` is deliberately absent from `DEFAULT_OUTCOME_STATUS_MAP` in
 * `integrations/crm-sync.settings.ts` — the same reasoning that already keeps `no_answer` and
 * `voicemail` out of it, one step further on. A caller who put the phone down has told us nothing
 * about the deal: he may have lost signal, been interrupted, or hated the call, and the three are
 * indistinguishable from this end. 'disqualified' would bury a lead who is still live; 'contacted'
 * would overwrite whatever a human had already set. What this file raises instead — a callback row
 * and an owner ping — is a TODO for a person, not a verdict about the lead. A tenant who wants a
 * status move can still add one through `statusMap`.
 *
 * (That note belongs in crm-sync.settings.ts as well, but that file is INTEGRATIONS territory and
 * this is a VOICE branch. Requested in docs/handoffs/2026-09-03-voice-disconnect.md instead.)
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────────────────────
 *
 * Nothing dials. There is no callback worker yet, deliberately — the `callbacks` row is a durable
 * marker that survives the call, the process and the deploy, and that marker plus the owner ping
 * IS the guarantee that was asked for. When the worker lands it will find these rows waiting.
 *
 * Nothing here throws. Ever. This runs inside the agent's shutdown path, where a rejection costs
 * the `call_learnings` row that holds the transcript — a strictly worse outcome than a missed
 * callback. Every step is independently try/caught and reduced to a log line.
 */

/** `settings.whatsapp_templates` slot for the owner's hangup ping. */
export const DISCONNECT_ALERT_TEMPLATE_KEY = 'disconnect_alert';

/** Free-text caps, matching the handoff alert: enough to be useful, far too short to smuggle. */
const MAX_QUOTE_CHARS = 200;
const MAX_ESTABLISHED_CHARS = 400;

/**
 * Where the call had got to when the line went dead. `unknown` is not reachable today; it exists so
 * a caller that cannot establish a stage has somewhere honest to put that, rather than guessing.
 */
export type HangupStage = CallStage | 'unknown';

/**
 * Stage ranks, held locally on purpose. `call-state.ts` keeps its own table private, and this needs
 * only the one question — "did we get past the greeting?" — which must not silently change meaning
 * if a stage is inserted there.
 */
const POST_OPENING_STAGES: readonly string[] = [
  'discovery',
  'qualifying',
  'scheduling',
  'closing',
  'terminal',
];

/**
 * The stage to record, given what the state machine says and what the transcript shows.
 *
 * The state machine is ON by default but has a kill-switch, and with it off `stage` is undefined —
 * at which point the honest fallback is the transcript, because `opening → discovery` is defined as
 * the first committed caller turn and nothing else. A call where the caller never spoke is an
 * opening; a call where he did is at least discovery. That keeps this feature working with the
 * advisory layer disabled, instead of quietly switching itself off along with it.
 */
export function effectiveHangupStage(
  stage: CallStage | undefined,
  hadCallerTurn: boolean,
): HangupStage {
  if (stage) return stage;
  return hadCallerTurn ? 'discovery' : 'opening';
}

/** Does this hangup deserve a callback and an owner alert, or only a line in the report? */
export function isAlertableHangupStage(stage: HangupStage): boolean {
  return POST_OPENING_STAGES.includes(stage);
}

export interface HangupDiscriminatorInput {
  /** `rt.endReason` at the moment the participant left. Non-null → somebody already ended this. */
  endReason: string | null;
  /** `callState.isTerminal()`. Undefined when the advisory layer is off. */
  terminal: boolean | undefined;
  /** Was the participant who left the CALLER, or an observer / the agent itself? */
  isCaller: boolean;
}

/**
 * The whole decision, as one pure function, so it is testable without a LiveKit room.
 *
 * Read the chain as: anybody else leaving is not a hangup; a call somebody has already ended is not
 * a hangup; and a call the state machine has driven to `terminal` is not a hangup even if whoever
 * drove it there forgot to name a reason.
 */
export function shouldMarkCallerHangup(input: HangupDiscriminatorInput): boolean {
  if (!input.isCaller) return false;
  if (input.endReason != null) return false;
  if (input.terminal === true) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// The wiring
// ─────────────────────────────────────────────────────────────────────────────

/** Just enough of a LiveKit `Room` to subscribe to one event — so this is testable without one. */
export interface DisconnectRoomLike {
  on(event: string, listener: (participant: { identity?: string }) => void): unknown;
}

export interface DisconnectListenerDeps {
  /** VOICE_DISCONNECT_TRACKING. False → NO listener is registered at all. */
  enabled: boolean;
  /** The identity of the participant this call is with, from `waitForParticipant()`. */
  callerIdentity: string | undefined;
  getEndReason: () => string | null;
  setEndReason: (reason: string) => void;
  /** `callState?.isTerminal()`. Undefined when the advisory layer is off. */
  isTerminal: () => boolean | undefined;
  markTerminal: () => void;
  /** `callState?.stage`. Undefined when the advisory layer is off. */
  currentStage: () => CallStage | undefined;
  /** Did the caller ever complete a turn? The transcript's answer, used when there is no stage. */
  hadCallerTurn: () => boolean;
  /** Called once, synchronously, when a hangup is confirmed. Records it and stashes the stage. */
  onHangup: (stage: HangupStage) => void;
  roomName?: string | null;
}

/**
 * Subscribe to the room's participant-left event and turn it into a hangup — or don't.
 *
 * SEPARATED FROM agent.ts SO IT CAN BE RUN IN A TEST. The alternative was asserting that agent.ts
 * contains a `ctx.room.on(...)` call site, which proves the text exists and nothing about whether
 * the flag actually gates it — and a flag that silently does nothing is precisely the defect this
 * repo has shipped before. Here the OFF case is provable by running it: no listener is registered,
 * so emitting the event does nothing at all, and the return value says so.
 *
 * The event NAME is a parameter rather than an import, so this module never pulls
 * `@livekit/rtc-node` and its native bindings in for the sake of one constant.
 *
 * Everything the handler does is SYNCHRONOUS. Nothing here awaits: the durable writes happen in the
 * agent's shutdown callback, where the DB connection is still open and is closed only afterwards.
 *
 * @returns whether a listener was actually registered.
 */
export function registerDisconnectListener(
  room: DisconnectRoomLike,
  event: string,
  deps: DisconnectListenerDeps,
): boolean {
  if (!deps.enabled) return false;

  room.on(event, (participant) => {
    const isCaller = participant?.identity === deps.callerIdentity;
    if (
      !shouldMarkCallerHangup({
        endReason: deps.getEndReason(),
        terminal: deps.isTerminal(),
        isCaller,
      })
    ) {
      return;
    }
    deps.setEndReason(CALLER_HUNGUP_END_REASON);
    const stage = effectiveHangupStage(deps.currentStage(), deps.hadCallerTurn());
    deps.onHangup(stage);
    deps.markTerminal();
    console.log(
      'caller_hung_up',
      JSON.stringify({
        room: deps.roomName ?? null,
        stage,
        alertable: isAlertableHangupStage(stage),
      }),
    );
  });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// The owner alert
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the call had actually established, as one Hebrew line, from the call's own fact memory.
 *
 * IDENTITY FIELDS REPORT PRESENCE, NOT VALUES. `FactMemory.reportSnapshot()` already replaces a
 * name/phone/email with `true` for exactly this reason, and that contract is honoured rather than
 * worked around: the owner is being told what the conversation covered so he knows how to open the
 * call back, and a WhatsApp message is not the place to restate a stranger's email address.
 */
export function establishedFromFacts(
  snapshot: { held: Record<string, string | true> } | null | undefined,
): string | null {
  if (!snapshot) return null;
  const labels: Array<[string, string]> = [
    ['business', 'עסק'],
    ['process', 'תהליך'],
    ['frustration', 'תסכול'],
    ['closing', 'סגירה'],
    ['volume', 'כמות פניות'],
  ];
  const parts: string[] = [];
  for (const [field, label] of labels) {
    const value = snapshot.held[field];
    if (typeof value === 'string' && value.trim().length > 0) parts.push(`${label}: ${value.trim()}`);
  }
  const heIdentity: Array<[string, string]> = [
    ['name', 'שם'],
    ['phone', 'טלפון'],
    ['email', 'אימייל'],
  ];
  const identity = heIdentity.filter(([f]) => snapshot.held[f] !== undefined).map(([, he]) => he);
  if (identity.length > 0) parts.push(`נמסרו: ${identity.join(', ')}`);
  return parts.length > 0 ? parts.join(' · ').slice(0, MAX_ESTABLISHED_CHARS) : null;
}

export interface DisconnectAlertInput {
  leadName: string | null;
  leadPhone: string | null;
  stage: HangupStage;
  /** The caller's last transcript line, verbatim. Where the next call should pick up. */
  lastQuote: string | null;
  established: string | null;
  leadUrl: string | null;
  /** The clamped instant we intend to ring back. Null when no callback row was raised. */
  dueAt: Date | null;
}

/** Hebrew for each stage, so the owner reads where it stopped instead of an English enum. */
const STAGE_HE: Record<string, string> = {
  opening: 'בפתיחה',
  discovery: 'באמצע הבירור',
  qualifying: 'באמצע האפיון',
  scheduling: 'בזמן תיאום הפגישה',
  closing: 'ממש לפני הסגירה',
  terminal: 'בסוף השיחה',
  unknown: 'באמצע השיחה',
};

function stageHe(stage: HangupStage): string {
  return STAGE_HE[stage] ?? STAGE_HE.unknown!;
}

function formatIsraelTime(d: Date): string {
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/**
 * The owner alert, freeform Hebrew — also the fallback text if a template send downgrades.
 *
 * Same four questions the handoff alert answers, asked of a different event: who was on the phone,
 * where the call stopped, what he last said, and what we already know. Plus the one this event
 * adds — when we are going to try him again — because an alert that reports a problem without
 * saying what has already been done about it only moves the worry.
 */
export function disconnectAlertText(input: DisconnectAlertInput): string {
  return [
    '📵 שיחה נותקה באמצע — ליד קולי',
    `שם: ${input.leadName ?? 'לא ידוע'}`,
    `טלפון: ${input.leadPhone ?? 'לא ידוע'}`,
    `נותק: ${stageHe(input.stage)}`,
    ...(input.lastQuote ? [`מה שאמר לאחרונה: "${input.lastQuote}"`] : []),
    ...(input.established ? [`מה כבר ידוע: ${input.established}`] : []),
    ...(input.dueAt ? [`נחזור אליו אוטומטית: ${formatIsraelTime(input.dueAt)}`] : []),
    ...(input.leadUrl ? [`פרטי הליד: ${input.leadUrl}`] : []),
    'כדאי לחזור אליו בהקדם.',
  ].join('\n');
}

/** The same summary on ONE line, for a WhatsApp template variable (which may not contain a newline). */
export function disconnectReasonLine(input: DisconnectAlertInput): string {
  return [
    `נותק ${stageHe(input.stage)}`,
    ...(input.lastQuote ? [`אמר: ${input.lastQuote}`] : []),
    ...(input.established ? [`ידוע: ${input.established}`] : []),
  ]
    .join(' · ')
    .replace(/\s*\n\s*/gu, ' ')
    .slice(0, 900);
}

// ─────────────────────────────────────────────────────────────────────────────
// The durable side of it
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedDisconnectLead {
  outcome: 'lead_found' | 'lead_created' | 'no_identity';
  leadId: string | null;
  leadName: string | null;
  leadPhone: string | null;
}

/**
 * Who was that, then? The SAME identity ladder as `flagLeadHandoffRequested` and `markLeadOptedOut`
 * — an outbound call knows its lead, an inbound caller is matched on phone suffix, and an unknown
 * caller with a usable number gets a minimal row so the callback has somebody to point at.
 *
 * IT DOES NOT REUSE `flagLeadHandoffRequested`, deliberately: that function stamps
 * `handoff_requested_at`, which is the dashboard's "this person asked for a human". A dropped call
 * is not a request for a human, and marking it as one would put a false red flag in front of the
 * owner on every disconnect.
 *
 * The row it creates is a real lead who really rang the voice channel, so it meters — exactly as
 * the handoff path does, and for the same reason.
 */
export async function resolveDisconnectLead(rt: ToolRuntimeContext): Promise<ResolvedDisconnectLead> {
  if (rt.leadId) {
    const rows = await rt.db
      .select({ id: leads.id, name: leads.name, phone: leads.phone })
      .from(leads)
      .where(and(eq(leads.id, rt.leadId), eq(leads.tenantId, rt.tenantId)))
      .limit(1);
    const row = rows[0];
    return {
      outcome: 'lead_found',
      leadId: row?.id ?? rt.leadId,
      leadName: row?.name ?? null,
      leadPhone: row?.phone ?? rt.callerPhone,
    };
  }

  const suffix = phoneSuffix(rt.callerPhone ?? '');
  if (suffix.length >= 7) {
    const existing = await rt.db
      .select({ id: leads.id, name: leads.name, phone: leads.phone })
      .from(leads)
      .where(
        and(
          eq(leads.tenantId, rt.tenantId),
          sql`regexp_replace(coalesce(${leads.phone}, ''), '\\D', '', 'g') LIKE ${`%${suffix}`}`,
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      const row = existing[0]!;
      return { outcome: 'lead_found', leadId: row.id, leadName: row.name, leadPhone: row.phone };
    }
    const inserted = await rt.db
      .insert(leads)
      .values({ tenantId: rt.tenantId, phone: rt.callerPhone!, source: 'voice-livekit' })
      .returning({ id: leads.id });
    // Same convention as lead-store.ts and the handoff tool: a real lead reached us on the voice
    // channel, so it meters. Unawaited — meterLead swallows its own errors, and a dropped call must
    // never fail on billing.
    if (inserted[0]?.id) {
      void meterLead(rt.db, { tenantId: rt.tenantId, leadId: inserted[0].id, source: 'voice-livekit' });
    }
    return {
      outcome: 'lead_created',
      leadId: inserted[0]?.id ?? null,
      leadName: null,
      leadPhone: rt.callerPhone,
    };
  }

  return { outcome: 'no_identity', leadId: null, leadName: null, leadPhone: null };
}

export interface DisconnectResult {
  /** Did we work out whose call this was? False → nothing durable could be written. */
  attributed: boolean;
  leadId: string | null;
  /** The `callbacks` row raised, if any. */
  callbackId: string | null;
  /** When we intend to ring back — already through the proactive window and the hard floor. */
  dueAt: Date | null;
  /** Which owner channels were actually queued. Empty is normal for an unconfigured tenant. */
  alertChannels: Array<'whatsapp' | 'email'>;
}

const EMPTY_RESULT: DisconnectResult = {
  attributed: false,
  leadId: null,
  callbackId: null,
  dueAt: null,
  alertChannels: [],
};

/**
 * Everything that happens after a mid-conversation hangup, in order of how much it would hurt to
 * lose: the callback row first (durable, survives the process and the deploy), the lead's
 * `next_callback_at` second (what the dashboard reads), the owner alert last (best-effort by every
 * definition in this repo).
 *
 * `now` is a parameter, never `Date.now()` inside, so the window arithmetic is pinnable in tests —
 * the same rule `callback-time.ts` follows, and for the same reason.
 */
export async function handleCallerDisconnect(
  rt: ToolRuntimeContext,
  opts: { stage: HangupStage; now?: Date },
): Promise<DisconnectResult> {
  const now = opts.now ?? new Date();

  // THE STAGE GATE, a second time. agent.ts already refuses to call this for an `opening` hangup,
  // and it is repeated here on purpose: this function creates a lead row and pings a business
  // owner, and both of those are things a wrong number must never cause. A guard that lives only
  // at one call site is a guard that a second call site will not have.
  if (!isAlertableHangupStage(opts.stage)) {
    console.log(
      'disconnect_not_alertable',
      JSON.stringify({ tenantId: rt.tenantId, callId: rt.callId, stage: opts.stage }),
    );
    return EMPTY_RESULT;
  }

  let who: ResolvedDisconnectLead;
  try {
    who = await resolveDisconnectLead(rt);
  } catch (err) {
    console.error('disconnect_lead_lookup_failed', err instanceof Error ? err.message : String(err));
    return EMPTY_RESULT;
  }

  if (!who.leadId) {
    // Nothing to hang a callback on — `callbacks.lead_id` is NOT NULL, and rightly so: a callback
    // with nobody to dial is a row that can only ever be deleted. Logged, never thrown.
    console.warn(
      'disconnect_unattributable',
      JSON.stringify({ tenantId: rt.tenantId, callId: rt.callId, outcome: who.outcome }),
    );
    return EMPTY_RESULT;
  }

  const lastTurn = rt.report.lastCallerTurn();
  const lastQuote = lastTurn?.text?.trim().slice(0, MAX_QUOTE_CHARS) || null;

  // -- HIS OWN TIME OUTRANKS OURS (Koren, 2026-09-06) -------------------------------------------
  //
  // *"אם הלקוח ביקש זמן ספציפי אז לפי מה שביקש."* If he said "תתקשר אליי ב-16:00" and the line then
  // dropped, 16:00 is still the answer. Writing a disconnect row over the top of it would give one
  // lead TWO pending callbacks — breaking the one-live-callback invariant that the supersede in
  // `schedule_callback` exists to maintain — and would ring him at an hour nobody chose, hours
  // before the hour he did.
  //
  // Deliberately NOT narrowed to `kind='explicit'`: any pending callback means something is
  // already owed to this lead, and a second row is wrong whatever wrote the first.
  //
  // The OWNER PING at the end of this function still fires either way — a dropped call is worth
  // telling a human about even when the dial is already on the books.
  let hasPendingCallback = false;
  try {
    const pending = await rt.db
      .select({ id: callbacks.id })
      .from(callbacks)
      .where(
        and(
          eq(callbacks.tenantId, rt.tenantId),
          eq(callbacks.leadId, who.leadId),
          eq(callbacks.state, 'pending'),
        ),
      )
      .limit(1);
    hasPendingCallback = pending.length > 0;
    if (hasPendingCallback) {
      console.log(
        'disconnect_callback_skipped_pending',
        JSON.stringify({ tenantId: rt.tenantId, callId: rt.callId, callbackId: pending[0]!.id }),
      );
    }
  } catch (err) {
    // A failed lookup must not cost us the callback — fall through and write one. A duplicate row
    // is recoverable (the worker supersedes); a lead nobody rings back is not.
    console.error(
      'disconnect_pending_lookup_failed',
      err instanceof Error ? err.message : String(err),
    );
  }

  // WHEN. The TENANT's delay (3 hours by default since 2026-09-06), then the SAME clamp every
  // other callback goes through, with `requestedByLead: false` — nobody asked for this time, so
  // the proactive window and the hard floor both apply and a 23:40 disconnect is not rung at 23:55.
  const cbCfg = resolveCallbackSettings(rt.settings);
  const raw = new Date(now.getTime() + cbCfg.disconnectedDelayMinutes * 60_000);
  const clamped = clampToWindow(raw, { requestedByLead: false, attempt: 0 }, now, cbCfg);

  let callbackId: string | null = null;
  // Skipped entirely when something is already owed to him — see the pending check above.
  if (!hasPendingCallback) try {
    const inserted = await rt.db
      .insert(callbacks)
      .values({
        tenantId: rt.tenantId,
        leadId: who.leadId,
        ...(rt.conversationId ? { conversationId: rt.conversationId } : {}),
        dueAt: clamped.dueAt,
        state: 'pending',
        kind: 'disconnected',
        requestedByLead: false,
        attempt: 0,
        maxAttempts: CALLBACK_DEFAULTS.maxAttempts,
        leadQuote: lastQuote,
        reason: `caller_hung_up:${opts.stage}`,
      })
      .returning({ id: callbacks.id });
    callbackId = inserted[0]?.id ?? null;
    console.log(
      'disconnect_callback_created',
      JSON.stringify({
        tenantId: rt.tenantId,
        callbackId,
        stage: opts.stage,
        dueAt: clamped.dueAt.toISOString(),
        moved: clamped.moved,
        reasons: clamped.reasons,
      }),
    );
  } catch (err) {
    console.error('disconnect_callback_failed', err instanceof Error ? err.message : String(err));
  }

  // The lead's own pointer at the callback — what the dashboard and any future sweeper read. Its
  // own try/catch: losing this must not cost us the `callbacks` row above.
  if (callbackId) {
    try {
      await rt.db
        .update(leads)
        .set({ nextCallbackAt: clamped.dueAt, updatedAt: now })
        .where(and(eq(leads.id, who.leadId), eq(leads.tenantId, rt.tenantId)));
    } catch (err) {
      console.error('disconnect_next_callback_failed', err instanceof Error ? err.message : String(err));
    }
  }

  // THE OWNER PING. Last, and never able to fail anything above it.
  let alertChannels: Array<'whatsapp' | 'email'> = [];
  try {
    const cfg = resolveHandoffSettings(rt.settings);
    const base = rt.env.DASHBOARD_BASE_URL;
    const alert: DisconnectAlertInput = {
      leadName: who.leadName,
      leadPhone: who.leadPhone,
      stage: opts.stage,
      lastQuote,
      established: establishedFromFacts(rt.factMemory?.reportSnapshot()),
      leadUrl: base ? `${base.replace(/\/$/, '')}/leads/${who.leadId}` : null,
      dueAt: callbackId ? clamped.dueAt : null,
    };
    alertChannels = await notifyOwner(rt, cfg, {
      leadId: who.leadId,
      text: disconnectAlertText(alert),
      subject: `📵 שיחה נותקה באמצע${alert.leadName ? ` — ${alert.leadName}` : ''}`,
      template: {
        key: DISCONNECT_ALERT_TEMPLATE_KEY,
        variables: {
          '1': alert.leadName ?? 'לא ידוע',
          '2': alert.leadPhone ?? 'לא ידוע',
          '3': disconnectReasonLine(alert),
          ...(alert.leadUrl ? { '4': alert.leadUrl } : {}),
        },
      },
      logPrefix: 'disconnect',
    });
  } catch (err) {
    console.error('disconnect_alert_failed', err instanceof Error ? err.message : String(err));
  }

  return {
    attributed: true,
    leadId: who.leadId,
    callbackId,
    dueAt: callbackId ? clamped.dueAt : null,
    alertChannels,
  };
}
