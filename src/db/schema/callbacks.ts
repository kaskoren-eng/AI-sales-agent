import { pgTable, uuid, varchar, integer, boolean, text, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { leads } from './leads.js';
import { conversations } from './conversations.js';

/**
 * A PROMISE TO CALL SOMEBODY BACK.
 *
 * Design: `docs/phase-8-callback-and-followup-model.md` §2. Until this table existed, a lead who
 * said *"תתקשר אליי עוד שעה"* produced at most an `end_call(reason:'callback_requested')` enum
 * value that mapped to lead status `contacted` and nothing else — no time captured, no job queued,
 * nobody calling back. The lead who was closest to buying is the one we dropped.
 *
 * WHY NOT `scheduled_calls` (which already carries tenant/lead/conversation/scheduledAt/status)?
 * Three reasons, all from the design doc:
 *  - `GET /scheduling/bookings` lists `scheduled_calls` upcoming-first and feeds the dashboard
 *    Bookings page. Callbacks would show up there as booked meetings, and filtering them out is a
 *    change to a route DASHBOARD owns.
 *  - A callback carries state a booking does not — `attempt`, `max_attempts`, `requested_by_lead`,
 *    `last_outcome`, and the lead's own words. Stuffing those into `notes`/`metadata` is exactly
 *    how three unreconciled Airtable write paths grew.
 *  - `provider` / `provider_ref` on a booking mean "a calendar event exists". For a callback none
 *    does. That column has already drifted twice (repaired by migration 0015) *because* its
 *    meaning was unclear.
 *
 * ONE LIVE CALLBACK PER LEAD. The tool supersedes any other `pending` row for the same lead rather
 * than stacking them, so "when is she calling me back" always has exactly one answer.
 */
export const callbacks = pgTable(
  'callbacks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    /** A callback with no lead is meaningless — there would be nobody to dial. */
    leadId: uuid('lead_id').notNull().references(() => leads.id),
    /** The call it was promised on. Nullable: a callback can also be raised off-call. */
    conversationId: uuid('conversation_id').references(() => conversations.id),
    /**
     * The resolved absolute instant to dial. Written by `callback-time.ts`, never by the model —
     * gpt-5.4 doing `Asia/Jerusalem` date arithmetic across a DST boundary is a class of bug whose
     * symptom is a phone ringing at the wrong hour and which no test we have can see.
     */
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    /** pending | dialing | done | exhausted | cancelled | superseded */
    state: varchar('state', { length: 20 }).default('pending').notNull(),
    /**
     * explicit | soft_defer | not_reached | disconnected
     *
     * DELIBERATE DEVIATION from phase-8 §2, which lists only the first three. `disconnected` is
     * owned by the mid-call-disconnect work, which writes a callback when a live call drops before
     * it concluded — a fourth situation the design doc predates. It is admitted here rather than in
     * that task's own migration because a second ALTER on a brand-new column is churn, and because
     * a value the database rejects fails at 3am inside a worker, where nobody is watching.
     */
    kind: varchar('kind', { length: 20 }).notNull(),
    /**
     * Did HE name this time? This is the gate on the wide ("honored") calling window — the lead who
     * asks for 22:00 gets 22:00. Everything else is held to the proactive window. See
     * `voice-livekit/tools/callback-time.ts :: clampToWindow`.
     */
    requestedByLead: boolean('requested_by_lead').default(false).notNull(),
    /** Dials made so far. 0 = the row exists, nothing has rung yet. */
    attempt: integer('attempt').default(0).notNull(),
    /** The ladder stops here. Stopping is a feature: a lead who never picked up is left alone. */
    maxAttempts: integer('max_attempts').default(3).notNull(),
    /** His words, verbatim — for the dashboard, and so the next call can open where this one left off. */
    leadQuote: text('lead_quote'),
    reason: text('reason'),
    /** The live BullMQ job id, so the callback can be cancelled. Deterministic; see the queue. */
    jobId: varchar('job_id', { length: 120 }),
    /**
     * answered | no_answer | busy | voicemail | failed | no_trunk
     *
     * `no_trunk` is the callback worker's addition: `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` unset is a
     * configuration gap, not a lead who did not pick up, and the two must be distinguishable from
     * the database. That distinction is the whole lesson of the weeks production spent reporting
     * placed calls while dialling nothing.
     *
     * `no_answer` is load-bearing beyond this table: a phone that simply rings out is recorded
     * NOWHERE else in this system — the reflex-driven `no_answer`/`voicemail` in `call-reflexes.ts`
     * only fire once a call has CONNECTED.
     */
    lastOutcome: varchar('last_outcome', { length: 20 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // The reconcile sweeper's query: pending rows whose due_at has passed, per tenant.
    index('callbacks_tenant_due_idx').on(table.tenantId, table.state, table.dueAt),
    index('callbacks_lead_idx').on(table.tenantId, table.leadId),
  ],
);

export type Callback = typeof callbacks.$inferSelect;
export type NewCallback = typeof callbacks.$inferInsert;
