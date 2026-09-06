-- SOFT STOP on a lead — "I'm not interested", said in WhatsApp, email or on a call.
--
-- Hand-written, like 0014/0015/0017/0019 before it: `db:generate` on a voice branch renumbers
-- against a journal that is not production's. See CLAUDE.md, "Migration number claims".
--
-- Distinct from `leads.status = 'opted_out'` on purpose. Opt-out is a do-not-contact INSTRUCTION:
-- permanent, cross-channel, legally binding, and a status because every path must honour it. This
-- is a refusal of the OFFER: it stops the follow-up ladder, a human may still reach out, and an
-- inbound message from the lead himself clears it. Collapsing the two either burns every lead who
-- ever said "not for me" or ignores everyone who never used the magic words.
--
-- See src/modules/leads/stop-signals.ts for the three tiers and how they are detected.
ALTER TABLE "leads" ADD COLUMN "followup_stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "followup_stop_reason" text;--> statement-breakpoint
-- "Who did we stop chasing this month, and why" — the report that says whether the follow-up
-- rhythm is wrong. Same shape as leads_callback_idx.
CREATE INDEX "leads_followup_stop_idx" ON "leads" USING btree ("tenant_id","followup_stopped_at");
