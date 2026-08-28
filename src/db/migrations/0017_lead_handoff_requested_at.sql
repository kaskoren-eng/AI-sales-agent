ALTER TABLE "leads" ADD COLUMN "handoff_requested_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "leads_handoff_idx" ON "leads" ("tenant_id","handoff_requested_at");
