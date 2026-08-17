CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"dedupe_key" varchar(128) NOT NULL,
	"billable_units" integer DEFAULT 0 NOT NULL,
	"cost_milli_agorot" bigint DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"period_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_dedupe_uq" UNIQUE("tenant_id","kind","dedupe_key"),
	CONSTRAINT "usage_events_kind_ck" CHECK (kind IN ('lead', 'call'))
);
--> statement-breakpoint
CREATE TABLE "usage_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"plan_code" varchar(40),
	"monthly_price_agorot" integer DEFAULT 0 NOT NULL,
	"included_leads" integer,
	"overage_per_lead_agorot" integer DEFAULT 0 NOT NULL,
	"leads_used" integer DEFAULT 0 NOT NULL,
	"calls_count" integer DEFAULT 0 NOT NULL,
	"measured_cost_milli_agorot" bigint DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"invoice_ref" varchar(100),
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_periods_tenant_start_uq" UNIQUE("tenant_id","period_start")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"code" varchar(40) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"name_he" varchar(100),
	"monthly_price_agorot" integer NOT NULL,
	"setup_fee_agorot" integer DEFAULT 0 NOT NULL,
	"included_leads" integer,
	"overage_per_lead_agorot" integer DEFAULT 0 NOT NULL,
	"max_concurrent_calls" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "plan_code" varchar(40);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "included_leads_override" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "overage_per_lead_agorot_override" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "monthly_price_agorot_override" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "billing_status" varchar(20) DEFAULT 'trialing' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "billing_anchor_day" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "quota_enforcement" varchar(20) DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_periods" ADD CONSTRAINT "usage_periods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_events_tenant_occurred_idx" ON "usage_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_period_idx" ON "usage_events" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX "usage_periods_tenant_status_idx" ON "usage_periods" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_billing_anchor_day_ck" CHECK (billing_anchor_day BETWEEN 1 AND 28);--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_billing_status_ck" CHECK (billing_status IN ('trialing', 'active', 'past_due', 'suspended'));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_quota_enforcement_ck" CHECK (quota_enforcement IN ('off', 'soft', 'hard'));--> statement-breakpoint
-- The tiers from docs/gtm/pricing-model.md, option א׳ (subscription + quota), which that doc
-- recommends and which the website advertises. Prices are AGOROT: 149000 = ₪1,490.00.
--
-- Seeded here rather than in a seed script because a tenant row carries a foreign key to this
-- table: an empty `plans` on a fresh database means no tenant can be assigned a plan, which turns
-- a missing seed step into a broken onboarding rather than an obvious blank screen.
--
-- ON CONFLICT DO NOTHING so re-running against a database where these already exist — or where
-- prices have since been edited in place — is a no-op rather than a silent repricing.
INSERT INTO "plans" ("code", "name", "name_he", "monthly_price_agorot", "setup_fee_agorot", "included_leads", "overage_per_lead_agorot", "max_concurrent_calls", "sort_order") VALUES
  ('base',    'Base',    'בסיס',  149000, 350000,  150, 600,  1, 10),
  ('growth',  'Growth',  'צמיחה', 249000, 350000,  400, 500,  3, 20),
  ('custom',  'Custom',  'מותאם', 400000,      0, NULL,   0, 10, 30)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
-- ClickScales' own tenant is not a customer of ClickScales. Without a plan that says so, the
-- platform tenant sits on the `trialing` default with no included leads, and the first thing
-- Phase 5b's hard enforcement would do is throttle the live production tenant.
INSERT INTO "plans" ("code", "name", "name_he", "monthly_price_agorot", "setup_fee_agorot", "included_leads", "overage_per_lead_agorot", "max_concurrent_calls", "is_active", "sort_order") VALUES
  ('internal', 'Internal', 'פנימי', 0, 0, NULL, 0, 10, false, 99)
ON CONFLICT ("code") DO NOTHING;
