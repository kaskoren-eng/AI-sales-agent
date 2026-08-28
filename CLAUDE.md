# AI Sales Agent

Multi-channel AI sales agent (WhatsApp, Email, Voice) that qualifies leads and books meetings via Google Calendar (a Trafft provider also exists, unused).

## Brand — ClickScales Voice Agent Platform (internal codename: KEREN)

- **Company:** ClickScales · **Product:** a multi-tenant voice AI agent platform — **the
  product is NOT named "KEREN"**. Platform branding (sidebar, login, billing) is ClickScales
  until a product name is chosen. **KEREN (קרן) is ClickScales' own agent** and the sample
  persona in all docs — wherever a doc says "Keren", read: the agent this tenant named.
- **Every tenant names their own agent at onboarding (mandatory, no default).** The UI never
  hardcodes an agent name: all agent-mentioning strings interpolate `{agentName}`, and
  Hebrew strings carry gender variants ("קרן סיימה" / "דניאל סיים") driven by the agent's
  configured gender. Agent persona (name, gender, voice) is a tenant setting — proposed key
  `agent_persona`, **VOICE-owned** (selects TTS voice + prompt grammar), DASHBOARD reads for
  display. Claim in the key-claims list before use; cross-workstream contract, do not
  improvise.
- **Two language settings, never collapsed into one:**
  - **Agent spoken language (VOICE-owned): Hebrew first.** Keren speaks Hebrew to leads by
    default, English on switch. This is the product — the entire Retell→LiveKit migration
    exists because Retell's human-sounding features are unavailable in Hebrew. Nothing in
    the dashboard changes this.
  - **Dashboard interface language (DASHBOARD-owned): English default**, Hebrew available
    via toggle. `<html lang="en" dir="ltr">`, English is the i18n source, `he.json` is the
    translation. Never derive one setting from the other. If a `tenants.settings` key is
    ever needed for interface language it is `ui_locale` — never `language` — and it must
    be claimed in this file's key-claims list before use.
- **"Danie" is deprecated.** `brand_assets/brand_identity` (v2) and brief v3 are superseded
  by `brand_assets/keren-brand-brief-v5.md` — the single source of truth for all dashboard
  design work (tokens, typography, light/dark theming, i18n/RTL rules, component DoD).
  v3 stays in git history; v5 §12 defines exactly what changed and why the number skips
  ("v4" internally meant the dead cream palette — never reuse it).
- Palette is the **cool technical** system derived from the ClickScales landing page —
  flat cool surfaces, indigo accent, mono for data, zero gradients, full light/dark toggle
  (`data-theme` on `<html>`). The cream/glass direction is dead; do not reintroduce it.
- Dashboard is **bilingual (HE+EN) from day one**: react-i18next, all UI strings via
  `t('...')`, CSS logical properties only, `dir="auto"` on all user content. English
  primary must not become Hebrew broken — no page is done until reviewed in Hebrew.
  See brief v5 §4.

## Parallel workstreams — see ⚠️ TERRITORY RULES below (single source of truth)

### Every session, before the first edit (non-negotiable)

Several Claude Code sessions run on this machine at once, each in its own worktree/branch. The only shared truth is `origin/main`.

1. `git fetch origin && git status` — confirm which branch/worktree you are in and that it is clean. If you find changes you didn't make → rule 4 below.
2. `git rebase origin/main` (or `git merge origin/main` if the branch is shared). **Every day, not just at PR time** — a branch 30 commits behind is how the 2026-08-26 wrong-tenant deploy happened.
3. Read the newest file in `docs/handoffs/` for EVERY workstream, not only yours — that is where the other sessions tell you what changed under you.
4. `git worktree prune` if `git worktree list` shows `prunable` entries.

**How work reaches production:** branch → PR to `main` → CI green (`ci.yml`: typecheck, tests, dashboard build, both Docker images; `guardrails.yml`: lane check, migration-claims check) → merge → deploy. Never push to `main` directly; never deploy from a feature branch. The LiveKit agent is deployed only via `npm run agent:deploy`, which refuses a tree behind `origin/main` or one that would drop another session's live work (`scripts/deploy-agent.mjs`, `refs/deploys/agent/*`).

An earlier version of this section contradicted the TERRITORY RULES on `src/modules/calls/` and `src/modules/leads/` ownership. **The TERRITORY RULES section below is canonical.** Resolution of the contradiction: within `calls/` and `leads/`, ownership splits by file role — VOICE owns services/workers/guards, DASHBOARD owns/extends API routes additively (details below).

### Dev servers — shared machine rules

- Ports: API `:3000` and dashboard `:3001` belong to the **voice session**; the **dashboard session** runs its own dashboard instance on `:3002` (`npm run dev -- --port 3002`).
- **Never kill or restart a dev server you didn't start** — the other session may be mid-test. If a server looks stale, say so in your summary and let Koren decide.
- The vite proxy default is the LOCAL backend (`http://localhost:3000`). Pointing a dev dashboard at production requires an explicit `VITE_PROXY_TARGET=` — never make prod the default (dev clicks mutate real data: lead status PATCH, booking cancel, API-key regeneration).

### Session handoffs (inter-agent communication)

- At the END of every session, write a short summary to `docs/handoffs/YYYY-MM-DD-<workstream>.md`: what shipped (commits), what's blocked, open questions. The architect session (Cowork) reads these directly — Koren should not need to copy-paste.
- If you're blocked on a DECISION (not a bug), write it under an "Questions for architect" heading in your handoff file and move on to unblocked work. Don't guess on cross-workstream contracts.

## Stack

TypeScript + Fastify 5 + Drizzle ORM + PostgreSQL + Redis + BullMQ + Zod + OpenAI gpt-5.4

## ⚠️ PARALLEL WORKSTREAMS — TERRITORY RULES (multiple Claude Code sessions on this repo — lanes are enforced by `scripts/ci/territory-check.sh` + `CODEOWNERS`; change all three together)

Two agents work this repo simultaneously. Respect your lane:

**VOICE agent** — owns: `src/modules/channels/voice-livekit/**`, `src/modules/channels/whatsapp/**` (window/consent logic), `src/queues/workers/meeting-reminders*`, `src/modules/scheduling/**` (may extend), `docs/phase-4-*`, `docs/go-live-plan.md`. Branches: `feature/voice-livekit-*`, `feature/meeting-reminders`.

**DASHBOARD agent** — owns: `dashboard/**`, `src/modules/admin/**`, `src/modules/metrics/**`, `docs/phase-5-dashboard-*`, `brand_assets/**`. Branches: `feature/dashboard-*`.

**WEBSITE** — `website/**` (marketing site + Netlify functions). De-facto third territory; whoever picks it up says so. Branch: `feature/website-*`.

**INTEGRATIONS** — `src/modules/integrations/**` (Monday, Airtable, Google Sheets, Google Calendar connection, CSV, `crm-sync.service.ts`). **Claimed 2026-08-27** — it had no owner, which is how three separate Airtable code paths grew without anyone reconciling them. De-facto fourth territory, same rule as WEBSITE: whoever picks it up says so here. VOICE keeps `crm-sync.service.ts` (Workstream B) and the `update_airtable` / `update_monday` flow-executor step handlers. Branch: `feature/airtable-*`, `feature/crm-*`.

**SPLIT-OWNERSHIP modules (`src/modules/calls/**`, `src/modules/leads/**`):**
- VOICE owns **services / workers / guards** (call-analysis, spend-guard, monitor, lead upsert logic)
- DASHBOARD owns/extends **API routes** (`calls.routes.ts`, `leads` timeline endpoint) — additively, read-only queries
- Neither rewrites the other's files in these modules; both announce schema-adjacent changes here first

**SHARED FILES — collision zone. Special rules apply:**
- `src/config/env.ts`, `.env.example`, `package.json`, `server.ts`, `src/plugins/**` — additive-only edits; never reorder/reformat existing lines; pull/rebase before editing.
- `src/db/schema/**` + migrations — **migration numbers are claimed in the table below BEFORE generating.** Never renumber someone else's migration.
- `CLAUDE.md`, `tenants` settings keys — announce in the claims lists below before changing.

**Migration number claims:** 0000–0003 = initial schema, api-key hash, call_learnings (pre-claims era) · 0004 = leads whatsapp fields · 0005 = scheduled_calls.reminders · 0006–0010 = identity/audit/monday-lookup · 0011 = `phone_numbers` (DID→tenant routing) · 0012 = `oauth_connections` (per-tenant Google Calendar) · 0013 = billing (`plans`, `usage_events`, `usage_periods`, tenant billing columns) · 0014 = `scheduled_calls.lead_id` DROP NOT NULL · 0015 = `scheduled_calls.provider` default → 'google' (both hand-written schema-drift repairs — the snapshots already matched the schema, so `db:generate` could never emit them) · 0016 = billable minutes (`usage_events` minutes columns) · **next free: 0017.** CI (`guardrails.yml`) fails a PR whose migration is missing from this line or whose number ≥ "next free".

⚠️ **Schema drift is invisible to both the tests and `db:generate`** — tests build tables from the schema, and snapshots are
generated from the schema, so both agree with it by construction. Two `scheduled_calls` columns had disagreed with the
live database since migration 0000; the first surfaced only when a booking was created in a customer's real calendar and
the row insert failed. **Run `npm run db:drift` after any schema change** — it replays every migration into a throwaway
Postgres (Docker) and diffs the result against the schema. Exit 1 = drift, listed.

**tenants.settings key claims:** `voice_engine` (VOICE) · `functions_enabled` (VOICE) · `whatsapp_templates` (VOICE) · `toll_fraud` (VOICE) · `reminders` (VOICE) · `crm_sync` (VOICE, Workstream B) · `businessProfile` (shared) · `zadarma` (VOICE) · `monday` (shared) · `airtable` (shared) · `flows` (pre-existing, shared) · `billing_provider` (reserved, Workstream D) · `agent_persona` (**CLAIMED 2026-08-16, VOICE-owned** — agent name/gender/company/FAQ/voice. Operator-only through the generic settings escape hatch, because a wrong TTS `voiceId` makes Cartesia and ElevenLabs return a *silent stream* rather than an error. Tenants edit the CONTENT half through the typed route `PUT /settings/agent-persona`, which has no `tts` field and is `.strict()`. See `src/modules/channels/voice-livekit/persona.ts`) · `ui_locale` (**reserved** for dashboard interface language — never `language`). New keys → add here in the same commit.

**Rules of engagement:**
1. NEVER edit files in the other agent's territory — if you think you must, STOP and tell Koren why.
2. NEVER commit to the other agent's branches; never merge/rebase their branches.
3. Before touching a shared file: `git fetch` + check the other branch for pending changes to that file (`git diff main...<other-branch> -- <file>`). Conflict likely → coordinate via Koren.
4. If you find uncommitted changes you didn't make — do NOT revert/stash them. They're the other agent's work. Tell Koren.
5. New tenants.settings keys: check this section's claims first, add your key to the claims list in the same commit.
6. `npm install`: announce new deps in commit message clearly (`deps: add X for Y`) — the other agent must `npm install` after pulling.

## Current initiative — Launch

The voice engine migration is **complete and live in production since 2026-07-29** (ClickScales tenant `613d826c`). The current work is closing the launch gates:

- **Workstream B — CRM automation:** built, tested and **on `main`**. Still unproven end to end: no real call has yet landed an outcome in a connected CRM.
- **Workstream C — conversation state machine + reflexes:** built, tested and **on `main`**. Four behaviours still need a live PSTN call to verify.
- **Website go-live:** `website/netlify/functions/lead.js` is deployed but inert, awaiting the flip.
- **Verification:** Layer 6 of `docs/phase-6-verification-checklist.md` — 10 real calls. Only 4 production calls so far, all internal.

**`main` is the trunk.** `master` was retired and deleted in the Phase-0 cutover (tagged `archive/master-2026-07-10`); `feature/crm-automation` was merged into `main` on 2026-08-16 and is done.

### The voice stack, as built

`src/modules/channels/voice-livekit/` — Zadarma SIP → LiveKit → **Soniox `stt-rt-v5`** (STT) → OpenAI `gpt-5.4` (LLM) → **Cartesia `sonic-3`** (TTS). `tenants.settings.voice_engine` survives, but NOT as an engine selector — LiveKit is the only engine. It is now one half of the agent's fail-closed tool gate: tools run only when `voice_engine='livekit'` AND `functions_enabled=true` (see `tools/tool-context.ts`). A tenant without it gets a working call with no tools. (The `VOICE_ENGINE_DEFAULT` env var, by contrast, WAS removed with the Retell code on 2026-08-05.)

Two divergences from the original plan that trip people up: **STT is Soniox, not OpenAI Realtime** (semantic WER 4.3% vs 34.9% on real Hebrew calls — don't "fix" it back), and **DeepDub is a fully built TTS alternative behind `VOICE_TTS_PROVIDER`** that is deliberately not the default despite winning a blind A/B 6:1.

**Rationale for the migration:** Retell doesn't expose its human-sounding features (audio tags, prosody, emotion) for Hebrew — our primary target language. Direct-to-provider unlocks full Hebrew quality, cuts per-minute cost, and removes vendor lock-in.

**Before touching any voice code, read in this order:**
1. `VOICE_MIGRATION_PLAN.md` (project root) — the 7 phases, as-built corrections, and what postdates the plan
2. `docs/voice-agent-development-methodology.md` — 10 non-negotiable rules for every voice commit
3. `docs/hebrew-voice-agent-dev-plan.md` — Hebrew-specific stack, prompts, business logic for lead-booking use case
4. `docs/retell-ai-dashboard-reference.md` — **archived** feature-parity checklist; still the clearest statement of the dashboard backlog (what we replicate, what we skip)
5. `docs/voice-ai-learning-resources.md` — 30 curated engineering guides + case studies (start with Tier 1)

## Commands

- `npm run dev` — start dev server (tsx watch, loads `.env`)
- `npm run build` — typecheck + compile
- `npm run start` — run compiled build (`dist/index.js`)
- `npm test` — vitest
- `npm run db:generate` — generate migration from schema changes
- `npm run db:migrate` — apply migrations
- `npm run db:studio` — Drizzle Studio (visual DB browser)
- `docker compose up -d` — start Postgres + Redis
- `node scripts/seed-tenant.mjs` — create first tenant + print ready-to-use API key
- `npm run usage:reconcile` — rebuild missing `usage_events` from `leads` + `call_learnings`, and recompute period counters from the ledger. **Dry run by default**; `--apply` writes.
- `npm run screenshot` — screenshot all dashboard routes → `screenshots/*.png` (targets the **voice** session's dashboard on `:3001`)
- `npm run screenshot:dash` — same, against the **dashboard** session's instance on `:3002`
- `node scripts/screenshot.mjs <route>` — screenshot a single route (overview, calls, call-detail)
- ⚠️ `scripts/screenshot.mjs` reads **`BASE_URL`**, not `PORT`. Setting `PORT=3002` silently screenshots `:3001` instead — use `screenshot:dash` or pass `BASE_URL=`.

**Voice / ops scripts** (see `package.json` for the full list): `voice:dev` · `voice:connect` · `voice:test` · `stt:ab` · `stt:shadow` · `bench:tts` · `bench:llm` · `call:report` · `agent:deploy` · `agent:logs`

## Architecture

- **App factory pattern:** `buildApp()` in `src/server.ts` — all tests should use this
- **Webhooks** at `/webhooks/*` — authenticated by per-channel signature verification, NOT API auth
- **API** at `/api/v1/*` — dual auth (API key OR JWT)
- **Queue-based processing:** webhook → BullMQ → worker → outbound queue
- **ai-engine** is a service module (no routes) — consumed by channel workers and lead qualification
- All DB tables have `tenant_id` — always filter by it, never skip tenant isolation
- **Dead Letter Queue:** all 3 main workers move exhausted jobs to `dead-letter` queue
- **Circuit breakers:** UChat, LiveKit, Cartesia, Monday, Google Calendar, Trafft, Airtable each have their own breaker (5 failures → 30s cooldown)

## DB Schema

Core: `tenants`, `leads`, `conversations`, `messages`, `scheduled_calls`, `import_jobs`, `call_learnings`
Accounts: `users`, `tenant_members`, `auth_sessions`, `invites`, `auth_tokens`, `audit_events`
Provisioning: `phone_numbers` (DID→tenant, 0011), `oauth_connections` (per-tenant Google Calendar, 0012)
Billing (0013): `plans`, `usage_events`, `usage_periods` + billing columns on `tenants`

- `call_learnings` — stores call recordings (LiveKit; legacy Twilio conference monitoring), Whisper transcripts, GPT sales analysis, outcome labels (`won`/`lost`/`neutral`)

## Workers (6)

- `message-processor` — routes inbound messages, runs `qualifyLead()` after each exchange
- `outbound-sender` — sends WhatsApp / Email outbound messages
- `flow-executor` — runs multi-step automation flows with delays
- `csv-import` — bulk lead creation from uploaded CSVs
- `call-analysis` — downloads call recording → Whisper transcription → GPT sales analysis → injects learnings into the voice-livekit system prompt. Also the hook point for CRM sync
- `meeting-reminders` — dispatches reminders before scheduled calls; DST-safe, quiet-hours aware, per-tenant `reminders` settings (migration 0005)

## Modules

- `billing` — **usage metering write path (Phase 5a: meters run silently — no enforcement, no UI).** `usage_events` is an append-only ledger; `usage_periods` is a CACHE of it, and drift is always resolved TOWARDS the ledger. Billable unit is the LEAD (₪1,490/150, ₪2,490/400 + overage); calls are recorded at **zero billable units** as a cost signal only (`pricing.ts`, milli-agorot, versioned rate card whose numbers are **unverified list prices**). Idempotency is the `(tenant_id, kind, dedupe_key)` unique index, not application logic. `meterLead`/`meterCall` never throw — safe only because both units are rebuildable by `npm run usage:reconcile`. A new `insert(leads)` site that neither meters nor carries a `usage-metering: exempt` marker fails `metering-coverage.test.ts`.
- `leads` — CRUD, status workflow, score, manual flow trigger. `GET /:id/timeline` returns lead + conversations + messages + scheduled_calls in one call (consumed by the dashboard Lead Detail page at `/leads/:id`). **`DELETE /:id`** erases the lead, its conversations, messages and bookings and writes an `audit_events` row — the usage ledger and any Google Calendar events deliberately SURVIVE (see the route comment).
- `channels/whatsapp` — UChat inbound/outbound, signature verification, 24h window fallback
- `channels/email` — Resend inbound/outbound, svix signature verification
- `channels/voice-livekit` — **the only voice engine, live in production since 2026-07-29.** Zadarma SIP inbound trunk → LiveKit Agents (Node.js SDK) → **Soniox `stt-rt-v5`** STT → OpenAI `gpt-5.4` LLM → **Cartesia `sonic-3`** TTS (DeepDub adapter available behind `VOICE_TTS_PROVIDER`). Six agent tools, conversation state machine + reflexes, speech-guard, compliance (recording notice + AI disclosure), per-call `CallReport`, browser web-call path for the dashboard Simulator. Reuses `google-calendar.provider.ts`, `ai-engine.service.ts`, `SettingsService`, `CallAnalysisService`, `scheduled_calls` and `call_learnings`.
- `channels/zadarma` — Zadarma recording-notification webhooks at `/webhooks/voice/zadarma`, feeding `call_learnings`. Engine-independent; extracted when the legacy Retell module was deleted (2026-08-05). **The URL is configured in the Zadarma portal — do not change the prefix.** Twilio retained for the WhatsApp bridge and conference monitoring.
- `scheduling` — Google Calendar (default provider), Trafft provider also available; slots query, booking, cancel, and `GET /scheduling/bookings` (tenant-scoped, upcoming-first — consumed by the dashboard Bookings page). **Per-tenant since 2026-08-16:** a booking goes into the tenant's OWN connected Google account (`oauth_connections`, OAuth consent from the Integrations page), or — for the ClickScales tenant alone, keyed on `PLATFORM_TENANT_ID` — the service account. There is deliberately NO fallback from "not connected" to the platform credentials: that fallback was the bug (every tenant's meetings landed in ClickScales' diary). A tenant with no calendar gets no booking tools. A grant is verified against the API before it is stored, and an `invalid_grant` from any calendar tool marks the connection revoked.
- `integrations` — Monday.com (sync/push/webhook), Airtable, CSV import, Google Sheets, `crm-sync.service.ts` (post-call outcome + summary push, per-tenant `crm_sync`). *(Nango was removed.)* Airtable and Monday are self-service from the dashboard Integrations page; the global `AIRTABLE_*` env credentials are ClickScales' own and only `PLATFORM_TENANT_ID` may fall back to them.
  ⚠️ **There are now THREE distinct Airtable write paths — do not merge them.** (1) `crm-sync.service.ts`, post-call outcome → the *tenant's own* base, tenant-settings-only. (2) the `update_airtable` flow step, tenant settings with a `PLATFORM_TENANT_ID`-gated `AIRTABLE_*` env fallback — updates only, never creates. (3) `airtable/lead-board.ts` + the `airtable-lead-push` queue, new lead → **ClickScales' own sales board**, a DIFFERENT base (`AIRTABLE_LEADS_*` env, `PLATFORM_TENANT_ID` only, one-way, creates only, never reads back). They cache their record ids under **different** metadata keys — `airtableRecordId` for (1)/(2), `clickscalesLeadsRecordId` for (3) — because they point at different bases. All three share the one module-level `airtable` circuit breaker.
- `settings` — per-tenant settings read/write, business profile
- `flows` — flow definitions consumed by the flow-executor worker
- `metrics` — `GET /api/v1/metrics/summary?range=` — Overview KPIs, pipeline, quality, trend. Consumed by the dashboard Overview page.
- `webhooks` — Meta Lead Ads, generic lead intake, and the Monday webhook at a **signed per-tenant URL** (`/webhooks/leads/monday/<tenantId>.<hmac>` — see `webhook-tokens.ts`; the old unsigned URL returns 410).
- `tenants` — **self-service only** now (`/me` + self-guarded `/:id`). Cross-tenant powers moved to `admin`. Settings are written one classified section at a time via `PATCH /me/settings/:namespace` and redacted on read — see `settings-policy.ts`. A tenant can no longer read/mutate another tenant or create tenants.
- `auth` — accounts, sessions, invites, password reset. **`POST /auth/register` creates a TENANT, and it is gated by `SIGNUP_MODE` (default `invite_only` → 403).** Open signup contradicts hybrid provisioning: ClickScales buys and assigns the DID, so nobody self-serves into a working agent. Closed locks nobody out — owners invite colleagues, and the first human on a workspace comes from `scripts/bootstrap-user.mjs` (needs DB access). Flip to `open` the day self-serve trials are the plan.
- `admin` — **operator console (super-admin, cross-tenant).** Gated by `ADMIN_API_KEY` env (unset → every `/api/v1/admin/*` route 503s; the console is opt-in). Own scope in `server.ts` (NOT the per-tenant `authenticate` hook), IP-rate-limited, constant-time key check. Endpoints: `GET /overview` (system KPIs), `GET /tenants` (rollup), `GET /tenants/:id` (deep stats/usage), `POST /tenants` (create), `PATCH /tenants/:id` (rename / suspend via `isActive`), `POST /tenants/:id/rotate-key`. Frontend at `/admin/*` (separate shell + admin-key gate, `dashboard/src/pages/admin/**`). No schema change (reuses `tenants.isActive`). New env key: `ADMIN_API_KEY` (in `.env.example`). **MVP** — the Ops & health pillar (queue depths, DLQ, breaker states) is deferred; the operator audit log now exists (`audit_events`).
- `calls` — list/detail. Serves LiveKit calls (outbound, inbound and web-call; web-call rooms use a placeholder "Web simulator" lead since the list inner-joins leads) plus historical rows from the retired engine, rendered from the DB. **No audio proxy** — `GET /:id/audio` streamed recordings out of Retell's API and went with it; LiveKit writes `call_learnings.recording_url` but nothing serves it yet. **`DELETE /:id`** erases one call's transcript, analysis and messages, audited; the LEAD survives, and provider-side audio is reported as `recordingsNotDeleted` rather than silently implied gone.
- `calls/monitor` — create Twilio conference calls for monitoring, label outcomes

## Frontend

- All frontend/UI tasks must use the `frontend-design` plugin (`frontend-design@claude-code-plugins`) — it activates automatically when building UI, so just describe the component/page with enough context (audience, aesthetic, tone) for bold, production-quality output

## Conventions

- All imports use `.js` extensions (Node16 module resolution)
- Plugins use `fastify-plugin` (fp) wrapper
- Env vars validated with Zod at boot (`src/config/env.ts`) — add new vars there + `.env.example`
- Errors use `AppError` subclasses from `src/shared/errors.ts`
- Schema changes go in `src/db/schema/` then run `npm run db:generate`
- `AI_MODEL` env var controls the OpenAI model (default: `gpt-5.4`)

## Security rules

- Tenant secrets encrypted AES-256-GCM — use `src/shared/crypto.ts`
- API keys stored as SHA-256 hashes, never plaintext
- Never log PII or credentials
- Webhook endpoints verify signatures before processing
- Replay attack protection on WhatsApp + lead-intake webhooks (`src/shared/webhook-timestamp.ts`, 5-min window)
- Per-tenant rate limiting: 200 req/min per tenant in API scope

## Reference documents

All four root docs were refreshed on **2026-08-02** and are current as of that date.

**Root-level (read first for voice work):**
- `VOICE_MIGRATION_PLAN.md` — the 7 phases, as-built corrections, and "what postdates this plan" (read before any voice code change)
- `PROJECT_STATUS.md` — phase + workstream status, known bugs, env checklist
- `THIRD_PARTY_REPORT.md` — vendor inventory, who owns which key, cost model
- `PRODUCT_ROADMAP.md` — shipped vs planned product surface, plus the raw wishlist log

**`docs/` folder — voice reference set:**
- `voice-agent-development-methodology.md` — 10 development principles (mandatory before writing voice code)
- `hebrew-voice-agent-dev-plan.md` — 7-phase Hebrew agent build plan with per-phase prompts
- `phase-4-known-issues.md` — tribal knowledge: levers that look worth pulling and aren't
- `phase-6-verification-checklist.md` — the launch gates, layers 0–6 (Layer 0 green, 1–6 open)
- `learnings-dreamserver-voice-agent.md` — postmortem lessons from an external LiveKit agent
- `retell-ai-dashboard-reference.md` — **archived** feature-parity checklist *(Retell removed 2026-08-05; kept for the feature→phase backlog table)*
- `voice-ai-learning-resources.md` — 30 curated engineering guides & case studies with reading order

**`docs/` subfolders:**
- `handoffs/` — end-of-session summaries, one per workstream per day. All on `main` since the 2026-08-16 merge.
- `go-live-plan.md` + `risk/` — the A/B/C/D workstream plan and the launch gap/risk register
- `gtm/` — ICP, messaging, pricing, sales process, client onboarding (Hebrew)
- `legal-drafts/` — privacy policy, ToS, DPA, accessibility statement, voice-AI disclosure (Hebrew drafts)
- `website-patch/` — accessibility patch, Meta pixel snippet, lead-forwarder function
- `phase-5-dashboard-frontend-spec.md` — the governing dashboard spec. *(`phase-5-dashboard-development.md` is the stale kickoff doc — don't trust its stack description.)*
