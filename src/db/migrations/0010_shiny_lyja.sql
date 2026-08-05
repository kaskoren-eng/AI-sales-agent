CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"actor_user_id" uuid,
	"actor_type" varchar(20) NOT NULL,
	"actor_label" varchar(255),
	"action" varchar(64) NOT NULL,
	"target_type" varchar(40),
	"target_id" varchar(128),
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_tenant_created_idx" ON "audit_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action","created_at");--> statement-breakpoint
-- `call_learnings.tenant_id` has been a bare uuid with no foreign key for most of this project's
-- life, so nothing prevented rows pointing at tenants that never existed, and deleting a tenant
-- left its recordings and transcripts behind as ownerless rows.
--
-- Adding the constraint fails if any such row exists — and this migration runs at container start,
-- so that failure stops the deploy. Checked first so the error names the problem instead of
-- surfacing as a bare constraint violation at 3am. Production was verified clean (0 orphans of 28
-- rows) before this was written; the guard is for every other environment.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM call_learnings cl
    LEFT JOIN tenants t ON t.id = cl.tenant_id
    WHERE t.id IS NULL
  ) THEN
    RAISE EXCEPTION 'call_learnings contains rows whose tenant_id matches no tenant. Resolve them (reassign or delete) before applying 0010.';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "call_learnings" ADD CONSTRAINT "call_learnings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The spend guard runs `WHERE tenant_id = ? AND created_at >= ?` before EVERY outbound dial. Until
-- now this table's only index was its primary key, so that check was a sequential scan on the hot
-- path of the component that talks to customers, growing with every call ever made.
CREATE INDEX "call_learnings_tenant_created_idx" ON "call_learnings" USING btree ("tenant_id","created_at");