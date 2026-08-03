-- IF NOT EXISTS is deliberate, not boilerplate.
--
-- The original 0006 (`0006_black_randall.sql`) was orphaned: it existed on disk but was never
-- registered in meta/_journal.json and had no snapshot, so drizzle-kit could never apply it and
-- the next `db:generate` would have re-emitted this same column inside 0007. It was regenerated
-- properly here. But the column may already have been applied by hand to production while the
-- file was orphaned, and drizzle has no record either way — so this must be safe to re-run.
--
-- Do not "clean this up" to a plain ADD COLUMN.
ALTER TABLE "call_learnings" ADD COLUMN IF NOT EXISTS "call_report" jsonb;
