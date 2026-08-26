-- Switch the billable unit from LEADS to MINUTES.
--
-- Additive only. The lead columns stay: every usage_periods row already written froze its plan into
-- included_leads/overage_per_lead_agorot, and a snapshot has to remain readable for the month it
-- priced. Nothing enforced included_leads anyway — it was a display and snapshot value — so no
-- enforcement behaviour changes here.

ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "included_minutes" integer;
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "overage_per_minute_agorot" integer DEFAULT 0 NOT NULL;

ALTER TABLE "usage_periods" ADD COLUMN IF NOT EXISTS "included_minutes" integer;
ALTER TABLE "usage_periods" ADD COLUMN IF NOT EXISTS "overage_per_minute_agorot" integer DEFAULT 0 NOT NULL;
-- Seconds, not minutes: a running total of a raw measurement. Rounding to whole minutes per call
-- would inflate a busy month by roughly the number of calls made.
ALTER TABLE "usage_periods" ADD COLUMN IF NOT EXISTS "seconds_used" integer DEFAULT 0 NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- PROVISIONAL BUNDLE SIZES — these numbers need Koren's sign-off before a customer is sold one.
--
-- Derived from the arithmetic already in docs/gtm/pricing-model.md, which assumes ~60% answer rate
-- and a ~3 minute average call: 150 leads ≈ 270 min and 400 leads ≈ 720 min, rounded to 300/750.
-- Overage mirrors the lead-overage shape (the larger bundle gets the cheaper marginal rate).
-- Measured cost is ~₪0.23/min, so both rates carry a wide margin.
--
-- UPDATE, not INSERT ... ON CONFLICT DO NOTHING: 0013 already seeded these rows, so an insert
-- would silently no-op and leave every bundle NULL.
UPDATE "plans" SET "included_minutes" = 300, "overage_per_minute_agorot" = 300 WHERE "code" = 'base';
UPDATE "plans" SET "included_minutes" = 750, "overage_per_minute_agorot" = 250 WHERE "code" = 'growth';
-- custom and internal stay NULL = unmetered, which is what every production tenant is on today.

-- ---------------------------------------------------------------------------------------------
-- Backfill the ledger. Calls were recorded with billable_units = 0 back when they were a pure cost
-- signal; their duration was kept in metadata. Promote it so history and counters agree.
UPDATE "usage_events"
   SET "billable_units" = GREATEST(0, ROUND(("metadata" ->> 'durationSec')::numeric)::integer)
 WHERE "kind" = 'call'
   AND "billable_units" = 0
   AND ("metadata" ->> 'durationSec') IS NOT NULL;

-- Rebuild every open period's counters from the ledger, filtered by kind. Periods opened before
-- this migration have included_minutes = NULL and ensureOpenPeriod returns existing rows untouched,
-- so without this the current month would never learn its allowance.
UPDATE "usage_periods" p SET
  "leads_used"   = COALESCE(agg.lead_units, 0),
  "seconds_used" = COALESCE(agg.call_seconds, 0),
  "calls_count"  = COALESCE(agg.calls, 0),
  "updated_at"   = now()
FROM (
  SELECT period_id,
         SUM(billable_units) FILTER (WHERE kind = 'lead') AS lead_units,
         SUM(billable_units) FILTER (WHERE kind = 'call') AS call_seconds,
         COUNT(*) FILTER (WHERE kind = 'call') AS calls
    FROM "usage_events"
   WHERE period_id IS NOT NULL
   GROUP BY period_id
) agg
WHERE p.id = agg.period_id AND p.status = 'open';

-- Give open periods the bundle their plan now carries, so the current month is measurable.
UPDATE "usage_periods" p SET
  "included_minutes"           = pl."included_minutes",
  "overage_per_minute_agorot"  = pl."overage_per_minute_agorot"
FROM "plans" pl
WHERE p.plan_code = pl.code AND p.status = 'open' AND p."included_minutes" IS NULL;
