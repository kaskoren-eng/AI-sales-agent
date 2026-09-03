import { llm } from '@livekit/agents';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { callbacks, leads } from '../../../../db/schema/index.js';
import { callbackJobId, enqueueCallback } from '../../../../queues/callbacks.queue.js';
import { resolveDisconnectLead } from '../disconnect.js';
import { resolveCallbackSettings } from './callback-settings.js';
import { closePendingCallbacks } from './callback-store.js';
import {
  CALLBACK_DAYS,
  CALLBACK_DEFAULTS,
  clampToWindow,
  resolveCallbackDueAt,
  type CallbackClampReason,
  type CallbackIntent,
  type CallbackKind,
} from './callback-time.js';
import { formatSlotHe } from './israel-time.js';
import { timedTool, type ToolRuntimeContext } from './tool-context.js';

/**
 * schedule_callback — the 8th tool. "תתקשר אליי עוד שעה", written down.
 *
 * Design: `docs/phase-8-callback-and-followup-model.md` §3.
 *
 * Before this, the best a lead's request for a later call could produce was
 * `end_call(reason:'callback_requested')` — an enum value with NO TIME IN IT and nothing behind it.
 * The lead who was interested enough to name an hour was handled worse than the one who said no.
 *
 * ── WHY THE MODEL NEVER SENDS A TIMESTAMP ────────────────────────────────────────────────────
 *
 * `book_meeting` refuses to let the model do date arithmetic: it echoes back a `slot_datetime`
 * VERBATIM from what `check_calendar_availability` printed. A callback has no availability list to
 * echo, so the equivalent safety is a STRUCTURED INTENT that code resolves. gpt-5.4 turning "מחר
 * בארבע" into an Asia/Jerusalem instant across a DST boundary, without reliably knowing what "now"
 * is, is a class of bug whose symptom is a phone ringing at 04:00 and which no test we have can
 * see. All of the arithmetic is in `callback-time.ts`, which is pure and takes `now` as an argument.
 *
 * ── THE RESULT STRING IS THE ONLY THING THAT CAN STOP HER LYING ──────────────────────────────
 *
 * She reads back what this tool tells her. If the clamp moved 22:40 to tomorrow morning and the
 * result did not SAY so, she says "אחזור אליך בעשרים ואחת ארבעים" and the phone rings fourteen
 * hours later. Same lesson, same shape, as the truthfulness pre-flight in
 * `send-confirmation.tools.ts` — the model is told the resolved time, told when it moved, and told
 * plainly that NO message is going out about it (that is F1.5, and it does not exist yet).
 *
 * ── SHIPS DARK ───────────────────────────────────────────────────────────────────────────────
 *
 * Registered only when `VOICE_CALLBACK_TOOL` is on, and OFF means NOT REGISTERED — the model never
 * sees the name. The system prompt does not mention it either (F1.7). So today this runs in tests
 * and nowhere else, on purpose: the Hebrew a lead would hear about a callback has not been through
 * a listening round.
 */

export const CALLBACK_TOOL_NAME = 'schedule_callback';

/** Same cap as the handoff tool's `reason`: enough to be useful, far too short to smuggle. */
const MAX_QUOTE_CHARS = 200;
const MAX_REASON_CHARS = 200;

/**
 * §3, verbatim. Three rules bind this schema and none of them is stylistic:
 *
 *  1. Every optional field is `.nullable().optional()`, BOTH. gpt-5.4 fills a tool call's unknown
 *     fields with an explicit `null` rather than omitting them, and a bare `.optional()` REJECTS
 *     null — on a live call that means Zod fails and the model retries while the lead waits.
 *     `capture_lead_info` learned it the expensive way.
 *  2. Plain `z.object`, no `.refine()`. A refinement makes it a `ZodEffects`, which LiveKit's tool
 *     definition rejects outright. Cross-field validity ("at_time with neither day nor hour") is
 *     therefore handled by the RESOLVER's documented fallbacks, not by the schema.
 *  3. `in_minutes` bounds mirror `CALLBACK_DEFAULTS.minInMinutes` / `maxInMinutes` (5 minutes …
 *     14 days). The resolver clamps anyway; the schema states the same range to the model.
 */
export const scheduleCallbackSchema = z.object({
  when_kind: z
    .enum(['in_minutes', 'at_time', 'unspecified'])
    .describe(
      'How the lead expressed the time. in_minutes = a relative gap ("עוד שעה", "בעוד עשר דקות") ' +
        '— fill in_minutes. at_time = a clock time and/or a day ("מחר בארבע", "בשמונה בערב") — ' +
        'fill time_hhmm and, if he named one, day. unspecified = he wants to be called later but ' +
        'named NO time ("לא עכשיו", "אני בנהיגה") — leave the other fields null. NEVER guess a ' +
        'time he did not give; unspecified is the honest answer and it schedules a sensible one.',
    ),
  in_minutes: z
    .number()
    .int()
    .min(CALLBACK_DEFAULTS.minInMinutes)
    .max(CALLBACK_DEFAULTS.maxInMinutes)
    .nullable()
    .optional()
    .describe('Minutes from now, when when_kind is in_minutes. "עוד שעה" = 60. 5 minutes to 14 days.'),
  day: z
    .enum(CALLBACK_DAYS)
    .nullable()
    .optional()
    .describe(
      'The day he named, when when_kind is at_time. Omit if he named only an hour — "בארבע" with ' +
        'no day means the next time the clock reads that, which is handled for you.',
    ),
  time_hhmm: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable()
    .optional()
    .describe('24-hour Israel local clock time, when when_kind is at_time. "שמונה בערב" = "20:00".'),
  quote: z
    .string()
    .max(MAX_QUOTE_CHARS)
    .describe(
      'What the lead actually said, in his own words ("תתקשר אליי אחרי שש"). Shown on the ' +
        'dashboard and used to open the next call where this one stopped. Never paraphrase into ' +
        'English and never invent it.',
    ),
  reason: z
    .string()
    .max(MAX_REASON_CHARS)
    .nullable()
    .optional()
    .describe('One short line of WHY now is a bad time ("בפגישה", "נוהג"). Omit if he did not say.'),
});

export type ScheduleCallbackArgs = z.infer<typeof scheduleCallbackSchema>;

/**
 * The one derivation that decides both the ladder and the calling window.
 *
 * ⚠️ NOT taken from `when_kind`, and NOT hard-coded to `true`. Read `clampToWindow`: with
 * `requestedByLead: true` and attempt ≤ 1 the HONORED window applies, which is the hard floor
 * (07:00–23:00) rather than the proactive one (Sun–Thu 09:00–20:00). That wide window exists for
 * exactly one thing — Koren, 2026-09-01: *"אם הוא מבקש שיחה בשעה 22:00 אז יקבל"* — a time the lead
 * NAMED. A soft defer at 19:30 resolves to +3h = 22:30 through the ladder, and passing
 * `requestedByLead: true` there would ring a stranger at half past ten at night on a time nobody
 * chose. That is the precise failure §4 exists to prevent.
 *
 * It is derived from the resolver's BASIS rather than from `when_kind` because the two can
 * disagree: `at_time` with a malformed `time_hhmm` and no `day` falls back to the soft-defer rung
 * (basis `ladder_default`), and an instant nobody named is not an instant anybody asked for —
 * whatever the model claimed it was doing.
 *
 * The same boolean is written to `callbacks.requested_by_lead`, so the worker's own re-clamp at
 * fire time reaches the same verdict this call did.
 */
export function callbackKindFor(basis: string): { kind: CallbackKind; requestedByLead: boolean } {
  return basis === 'ladder_default'
    ? { kind: 'soft_defer', requestedByLead: false }
    : { kind: 'explicit', requestedByLead: true };
}

/** Hebrew-free, model-facing English for why the time moved. She never reads these out. */
const CLAMP_REASON_EN: Record<CallbackClampReason, string> = {
  in_past: 'the time he named had already passed',
  night_floor: 'it fell inside the 23:00–07:00 night floor, which nothing overrides',
  proactive_window: 'it fell outside our calling hours',
  shabbat: 'it fell on Shabbat',
  holiday: 'it fell on an Israeli public holiday',
  unclamped: 'the window search gave up (this should be impossible — report it)',
};

function explainClamp(reasons: readonly CallbackClampReason[]): string {
  const parts = reasons.map((r) => CLAMP_REASON_EN[r]).filter(Boolean);
  return parts.length > 0 ? parts.join(' and ') : 'it fell outside our calling hours';
}

/**
 * Everything the tool does, separated from `llm.tool()` so the tests drive it with a pinned `now`
 * and no LiveKit session — the same split as `executeBookMeeting`.
 */
export async function executeScheduleCallback(
  rt: ToolRuntimeContext,
  args: ScheduleCallbackArgs,
  now: Date = new Date(),
): Promise<string> {
  const cfg = resolveCallbackSettings(rt.settings);

  // A tenant who switched callbacks off gets no promise made in their name. The worker would skip
  // the row at fire time and leave it pending forever, which from the lead's side is a call that
  // simply never comes — the exact failure the whole feature exists to end.
  if (!cfg.enabled) {
    throw new llm.ToolError(
      'Callbacks are switched off for this business, so nothing can be scheduled and no one will ' +
        'ring him back automatically. Do NOT promise a callback or name a time. Offer to book a ' +
        'meeting instead, or say the team will be in touch.',
    );
  }

  // ── 1. WHO ─────────────────────────────────────────────────────────────────────────────────
  //
  // The SAME identity ladder as the disconnect path — outbound calls know their lead, an inbound
  // caller is matched on phone suffix, an unknown caller with a usable number gets a minimal row
  // (metered, like every other real lead who reached the voice channel). Reused rather than copied:
  // `resolveDisconnectLead` is named for its first caller, but what it does is "find or create the
  // lead this callback will point at, WITHOUT stamping handoff_requested_at" — which is precisely
  // why it exists as a separate function from `flagLeadHandoffRequested`. A lead who asked to be
  // called back has not asked for a human, and marking him urgent would put a false red flag in
  // front of the owner.
  let who: Awaited<ReturnType<typeof resolveDisconnectLead>>;
  try {
    who = await resolveDisconnectLead(rt);
  } catch (err) {
    console.error(
      'callback_lead_lookup_failed',
      err instanceof Error ? err.message : String(err),
    );
    throw new llm.ToolError(
      'Could not record the callback — the lead lookup failed. Do NOT tell him you will call back ' +
        'at a specific time. Apologise briefly and ask if he would rather book a short meeting now.',
    );
  }

  if (!who.leadId) {
    // `callbacks.lead_id` is NOT NULL and rightly so: a callback with nobody to dial is a row that
    // can only ever be deleted. A web-call or a withheld number lands here.
    console.warn(
      'callback_unattributable',
      JSON.stringify({ tenantId: rt.tenantId, callId: rt.callId, outcome: who.outcome }),
    );
    throw new llm.ToolError(
      'There is no phone number on this call to ring back, so no callback could be recorded. Do ' +
        'NOT promise to call him back. Ask for the best number to reach him on, or offer to book ' +
        'a meeting instead.',
    );
  }
  const leadId = who.leadId;

  // ── 2. WHEN ────────────────────────────────────────────────────────────────────────────────
  //
  // `resolveCallbackDueAt` + `clampToWindow` rather than the `planCallbackTime` wrapper that
  // composes them: the window context depends on HOW the intent resolved (see `callbackKindFor`),
  // and `planCallbackTime` takes that context up front. Same two functions, same order, same
  // arithmetic — nothing here re-implements a window.
  const intent: CallbackIntent = {
    when_kind: args.when_kind,
    in_minutes: args.in_minutes ?? null,
    day: args.day ?? null,
    time_hhmm: args.time_hhmm ?? null,
  };
  const resolved = resolveCallbackDueAt(intent, now);
  const { kind, requestedByLead } = callbackKindFor(resolved.basis);
  const clamped = clampToWindow(resolved.dueAt, { requestedByLead, attempt: 0 }, now, cfg);

  const quote = args.quote.trim().slice(0, MAX_QUOTE_CHARS) || null;
  const reasonText = args.reason?.trim().slice(0, MAX_REASON_CHARS) || null;

  // ── 3. SUPERSEDE ───────────────────────────────────────────────────────────────────────────
  //
  // ONE LIVE CALLBACK PER LEAD, so "when is she calling me back" always has exactly one answer.
  // Before the insert, not after, so the query cannot see the row it is about to write and there is
  // no id to exclude. Never throws; a supersede that failed leaves an older row that the worker
  // will find superseded at fire time anyway (its state check is the real backstop).
  const superseded = await closePendingCallbacks(
    { db: rt.db, callbacksQueue: rt.callbacksQueue },
    {
      tenantId: rt.tenantId,
      leadId,
      state: 'superseded',
      note: 'superseded_by_schedule_callback',
      // The new row's own `due_at` goes into `leads.next_callback_at` moments from now. Clearing it
      // here would leave a window where the lead's pointer says "no callback" and a row disagrees.
      clearLeadPointer: false,
    },
  );

  // ── 4. THE ROW ─────────────────────────────────────────────────────────────────────────────
  //
  // The durable write comes BEFORE anything she says, and — unlike the disconnect path, which runs
  // at shutdown and can only log — a failure here is a hard tool error. She is about to promise a
  // time out loud, and a promise with no row behind it is the defect this whole feature exists to
  // end, restaged one level up.
  let callbackId: string;
  try {
    const inserted = await rt.db
      .insert(callbacks)
      .values({
        tenantId: rt.tenantId,
        leadId,
        ...(rt.conversationId ? { conversationId: rt.conversationId } : {}),
        dueAt: clamped.dueAt,
        state: 'pending',
        kind,
        requestedByLead,
        attempt: 0,
        // The TENANT's ceiling, not the global default: `resolveCallbackSettings` has already
        // clamped it to 1…MAX_ATTEMPTS_CEILING, and the worker takes the lower of this and its own.
        maxAttempts: cfg.maxAttempts,
        leadQuote: quote,
        reason: reasonText ? `lead_requested:${reasonText}` : 'lead_requested',
      })
      .returning({ id: callbacks.id });
    const id = inserted[0]?.id;
    if (!id) throw new Error('insert returned no id');
    callbackId = id;
  } catch (err) {
    console.error('callback_insert_failed', err instanceof Error ? err.message : String(err));
    throw new llm.ToolError(
      'The callback could NOT be saved. Do not tell him you will ring back at a particular time — ' +
        'nothing was recorded. Offer to book a short meeting instead, or say the team will be in touch.',
    );
  }

  // The lead's own pointer at the callback — what the dashboard reads. Its own try/catch: losing
  // this must not cost the row above, which is the thing that actually causes the call.
  try {
    await rt.db
      .update(leads)
      .set({ nextCallbackAt: clamped.dueAt, updatedAt: now })
      .where(and(eq(leads.id, leadId), eq(leads.tenantId, rt.tenantId)));
  } catch (err) {
    console.error('callback_next_callback_failed', err instanceof Error ? err.message : String(err));
  }

  // ── 5. THE JOB ─────────────────────────────────────────────────────────────────────────────
  //
  // `attempt: 0` — no dial has been made — which makes the job id `callback-<id>-a0` and matches
  // what `cancelCallbacks` will look for. The worker's retry path then takes `-a1` and up, so the
  // ids never collide. The row stores the id so it can be cancelled.
  let queued = false;
  if (rt.callbacksQueue) {
    try {
      const jobId = callbackJobId(callbackId, 0);
      await enqueueCallback(
        rt.callbacksQueue,
        { tenantId: rt.tenantId, callbackId, attempt: 0, deferrals: 0 },
        clamped.dueAt.getTime() - now.getTime(),
      );
      queued = true;
      await rt.db
        .update(callbacks)
        .set({ jobId, updatedAt: now })
        .where(and(eq(callbacks.tenantId, rt.tenantId), eq(callbacks.id, callbackId)));
    } catch (err) {
      console.error('callback_enqueue_failed', err instanceof Error ? err.message : String(err));
    }
  }

  rt.callbackScheduled = true;
  rt.report.recordCallbackScheduled({
    resolvedIso: clamped.dueAt.toISOString(),
    moved: clamped.moved,
  });

  console.log(
    'callback_scheduled',
    JSON.stringify({
      tenantId: rt.tenantId,
      callId: rt.callId,
      callbackId,
      leadOutcome: who.outcome,
      kind,
      requestedByLead,
      basis: resolved.basis,
      fallbacks: resolved.fallbacks,
      requestedIso: resolved.dueAt.toISOString(),
      dueAt: clamped.dueAt.toISOString(),
      moved: clamped.moved,
      reasons: clamped.reasons,
      superseded: superseded.closed,
      queued,
    }),
  );

  // ── 6. THE TRUTH ───────────────────────────────────────────────────────────────────────────
  const spoken = formatSlotHe(clamped.dueAt.toISOString(), now);
  const asked = formatSlotHe(resolved.dueAt.toISOString(), now);

  return (
    `Callback recorded for ${spoken}.` +
    (clamped.moved
      ? ` ⚠️ THIS IS NOT THE TIME HE ASKED FOR. He asked for ${asked}, and ${explainClamp(clamped.reasons)}, ` +
        `so the call will actually be placed ${spoken}. Tell him THAT time, in Hebrew, and say ` +
        `briefly why if it helps — never read back ${asked}, because nobody will ring then.`
      : ` Confirm to him in Hebrew that you will call back ${spoken}.`) +
    (queued
      ? ''
      : ' NOTE: the dial could not be queued right now, so the callback is recorded but not yet' +
        ' automatic — still say the time, the team reconciles these.') +
    ' NO message (WhatsApp or email) is sent about a callback — that does not exist yet — so do' +
    ' NOT tell him a confirmation is on its way.' +
    ' Do not end the call because of this: carry on if he has more to say, or say goodbye and call' +
    " end_call with reason 'callback_requested'."
  );
}

export function scheduleCallbackTool(rt: ToolRuntimeContext) {
  return llm.tool({
    name: CALLBACK_TOOL_NAME,
    description:
      'The lead wants to be called back at another time — "תתקשר אליי עוד שעה", "מחר בבוקר", or ' +
      'just "לא עכשיו". Records the callback so he is actually rung back, instead of the request ' +
      'being lost when the call ends. Pass the time the way HE said it (a gap in minutes, or a ' +
      'clock time and day); never work out a date yourself. Use when_kind "unspecified" when he ' +
      'named no time at all. This does NOT end the call and does NOT send him any message — read ' +
      'back only the time this tool returns.',
    parameters: scheduleCallbackSchema,
    execute: (args, _opts) =>
      timedTool(rt, CALLBACK_TOOL_NAME, args as Record<string, unknown>, () =>
        executeScheduleCallback(rt, args as ScheduleCallbackArgs),
      ),
  });
}
