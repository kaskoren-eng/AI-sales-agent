-- Look up a lead by the Monday item id stored in its metadata, scoped to one tenant.
--
-- The Monday webhook handler used to SELECT every lead belonging to a tenant and search the result
-- in JavaScript for a matching `metadata.mondayItemId`. That is a full table scan into the Node
-- heap on every inbound webhook, and Monday sends a burst of them when someone bulk-edits a board.
--
-- PARTIAL, on purpose: only a small fraction of leads are ever synced to Monday, so indexing only
-- the rows that have the key keeps this small and keeps the write cost off every other insert.
CREATE INDEX IF NOT EXISTS leads_monday_item_idx
  ON leads (tenant_id, (metadata->>'mondayItemId'))
  WHERE metadata ? 'mondayItemId';
