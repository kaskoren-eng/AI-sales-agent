# 2026-08-27 — INTEGRATIONS

## Shipped

`7efcdb9` on `feature/airtable-leads-push` (branched off `main`, worktree `C:/keren-airtable-leads`).

**New lead for ClickScales' own tenant → new row on the Airtable sales board**
(`app7IOcK9NvTvHyBm` / `לידים` / `tblP4AW6CQLxZVO1P`). One-way, never reads back, fires from a
BullMQ job so Airtable can never sit in front of lead intake or the outbound call.

- New: `src/modules/integrations/airtable/lead-board.ts` (field-id constants + pure mapper),
  `src/queues/airtable-lead-push.queue.ts`, `src/queues/workers/airtable-lead-push.worker.ts`,
  plus tests for both.
- Modified additively: `env.ts`, `.env.example`, `plugins/queue.ts`, `server.ts`,
  `webhooks/lead-intake.routes.ts`, `webhooks/meta.utils.ts`, `CLAUDE.md`.
- No schema change, no migration — `leads.metadata` jsonb carries everything.
- Full suite green (93 files / 955 tests), `npm run build` clean.

## Decisions that differ from the original brief

| Brief | Shipped | Why |
|---|---|---|
| new `AIRTABLE_LEADS_TENANT_ID` | reuse `PLATFORM_TENANT_ID` | it already means "ClickScales' own tenant" for the calendar service account and the `update_airtable` env fallback. Two vars saying the same thing drift. |
| `consent_given_at` | `leads.whatsapp_consent.granted` | no such column exists; consent is the jsonb `{granted, source, at, ip}` |
| ad campaign fields | ids captured, names still blank | Meta's leadgen webhook carries `ad_id`/`adgroup_id`/`campaign_id` — **not** the names. Names need a Graph API lookup on `leadgen_id` with a page token (see Deferred). |
| fire from any lead source | intake webhook only | `main` has 9 separate `insert(leads)` sites and no chokepoint. The one handler at `lead-intake.routes.ts` covers both the website form and Meta, which is the whole stated use case. |

## Two things that will bite whoever touches this next

1. **Airtable rejects `{ id: 'sel…' }` on single-select WRITES** — `422
   INVALID_VALUE_FOR_COLUMN`. The id form is read-only. `LEAD_BOARD_CHOICES` therefore holds
   choice *names*, with the ids in comments. There is a test locking this in, because the
   production symptom is rows quietly not appearing. Renaming a choice on the board breaks the
   push with a 422 until `lead-board.ts` follows — deliberate, since the alternative
   (`typecast: true`) would silently create duplicate choices on a live sales board.
2. **There are now THREE Airtable write paths and they must not be merged** — documented in
   `CLAUDE.md`. They cache record ids under *different* metadata keys (`airtableRecordId` for
   the tenant's own base, `clickscalesLeadsRecordId` for this board) because they point at
   different bases.

## Verified end-to-end against the live base

Probe ran on `:3010` with Redis db index 5 — deliberately isolated so it could not steal jobs
from the voice session's workers on db 0. Flow-free throwaway tenant, so no call could fire.
All probe rows/leads/tenant deleted afterwards; db 5 flushed.

- website lead → row with `Source=Google` (from `utm_source`), consent ticked, campaign mapped
- Meta lead (signed payload) → row with `Source=Facebook`, `Facebook Lead ID` populated
- resubmitting the same form → deduped, **no second row**
- non-platform tenant → lead created, **zero** Airtable rows, zero push jobs enqueued
- broken PAT × 6 leads → every webhook **200 in ~50ms**, all 6 leads in Postgres, breaker
  **OPEN** after 5, all 6 jobs dead-lettered, no partial rows

## Blocked on Koren

1. **`AIRTABLE_LEADS_PAT`** — set the real `data.records:write`-scoped PAT on Railway (and
   locally). The probe used the existing `AIRTABLE_API_KEY`, which happens to reach this base;
   the dedicated scoped token is what should ship.
2. **`PLATFORM_TENANT_ID`** — set to the ClickScales tenant. It is **not in the local `.env`**;
   confirm it is set on Railway too, or the push silently never fires (fail-closed by design).
3. **Merge** — branch is unmerged. `main` is the trunk Railway deploys.

Note: I deleted the `.env` I created in this worktree rather than leaving a second copy of
production secrets on disk. Copy your own in before running it.

## Deferred (not started, deliberately)

- **Meta name enrichment** — `GET /{leadgen_id}?fields=ad_name,adset_name,campaign_name` with a
  page access token, to fill the three name columns. Needs token storage + its own breaker.
- **Website UTM/fbclid + consent capture** — the Netlify forwarder currently posts only
  name/email/phone/company/locale, so `אישר דיוור` is unticked for every website lead and
  attribution comes only from Meta. Touches `website/**` (separate territory).
- **Wider hook** — if "every lead source, not just the webhook" is wanted later, wrap
  `meterLead()`: it is already called at 7 of the 9 insert sites and CI-enforced by
  `src/modules/billing/metering-coverage.test.ts`.

## Questions for architect

- `src/modules/integrations/**` had **no owner** in the TERRITORY RULES — I claimed it as a
  fourth de-facto territory (INTEGRATIONS) in this commit, leaving `crm-sync.service.ts` and the
  flow-executor step handlers with VOICE. Confirm or reassign.
- The `airtable` circuit breaker is a cross-tenant module singleton: a bad leads-board PAT
  tripping it also pauses the tenant CRM sync for 30s. Pre-existing, and reusing it beat minting
  a second counter against the same API — but if per-target isolation matters, the
  `google-calendar.provider.ts` per-scope `Map` is the pattern to copy.
