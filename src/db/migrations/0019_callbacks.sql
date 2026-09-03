-- callbacks: a durable promise to call somebody back, plus the lead-side mirror of it.
--
-- Design: docs/phase-8-callback-and-followup-model.md §2. A lead saying "תתקשר אליי עוד שעה" has
-- until now produced nothing but an end_call enum value; there is no column, no queue, no job.
-- This migration is step 1 of that plan — the table only. The queue, worker and tool land later.
--
-- HAND-WRITTEN, ON PURPOSE. `db:generate` numbers migrations from this repo's journal, and the
-- voice trunk's journal has historically lagged what is applied in production; a generated file
-- would collide. 0018 is reserved on paper by docs/phase-7-onboarding-call-corpus.md §5
-- (onboarding_samples / onboarding_insights) and is deliberately skipped here — a gap in the
-- numbering is harmless (the runner applies files in sorted order), a duplicate is not.
-- Both numbers are claimed in CLAUDE.md's claims line in the same commit as this file.
--
-- `kind` is a varchar rather than a Postgres enum on purpose: this table already needs a fourth
-- value ('disconnected') that the design doc predates, and adding a value to a live enum type is a
-- migration where adding a string is not.
CREATE TABLE "callbacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"conversation_id" uuid,
	"due_at" timestamp with time zone NOT NULL,
	"state" varchar(20) DEFAULT 'pending' NOT NULL,
	"kind" varchar(20) NOT NULL,
	"requested_by_lead" boolean DEFAULT false NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"lead_quote" text,
	"reason" text,
	"job_id" varchar(120),
	"last_outcome" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "callbacks" ADD CONSTRAINT "callbacks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "callbacks" ADD CONSTRAINT "callbacks_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "callbacks" ADD CONSTRAINT "callbacks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The reconcile sweeper's query: pending rows whose due_at has passed, per tenant. Redis is not
-- the source of truth — the ladder spans days, and a Redis flush must not silently drop every
-- pending callback in the system.
CREATE INDEX "callbacks_tenant_due_idx" ON "callbacks" USING btree ("tenant_id","state","due_at");--> statement-breakpoint
CREATE INDEX "callbacks_lead_idx" ON "callbacks" USING btree ("tenant_id","lead_id");--> statement-breakpoint
-- Denormalised mirror of the earliest pending callback, so "who am I calling today" needs no join.
-- Follows the leads.handoff_requested_at precedent (0017): deliberately NOT a lead status, because
-- a lead can be `qualified` AND owed a callback, and LEAD_STATUSES is a transition-checked machine
-- that a scheduling fact has no business entering.
ALTER TABLE "leads" ADD COLUMN "next_callback_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "leads_callback_idx" ON "leads" USING btree ("tenant_id","next_callback_at");
