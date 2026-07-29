# AI Sales Agent

Multi-channel AI sales agent (WhatsApp, Email, Voice) that qualifies leads and books calls via Google Calendar (or Trafft).

## Brand — KEREN by ClickScales

- **Company:** ClickScales · **Product:** KEREN (the agent persona is "קרן", female)
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

An earlier version of this section contradicted the TERRITORY RULES on `src/modules/calls/` and `src/modules/leads/` ownership. **The TERRITORY RULES section below is canonical.** Resolution of the contradiction: within `calls/` and `leads/`, ownership splits by file role — VOICE owns services/workers/guards, DASHBOARD owns/extends API routes additively (details below).

- **Open handoff → Voice session (Task 0):** create a `conversations` row (`channel: 'voice'`, `channelRef: <roomName>`) at LiveKit call initiation (outbound + web-call). Note: `web-call-*` rooms have no real lead — needs a placeholder lead or explicit skip (calls list inner-joins leads). Until this lands, LiveKit calls don't appear in the dashboard calls list and the `learnings` join returns null.

### Dev servers — shared machine rules

- Ports: API `:3000` and dashboard `:3001` belong to the **voice session**; the **dashboard session** runs its own dashboard instance on `:3002` (`npm run dev -- --port 3002`).
- **Never kill or restart a dev server you didn't start** — the other session may be mid-test. If a server looks stale, say so in your summary and let Koren decide.
- The vite proxy default is the LOCAL backend (`http://localhost:3000`). Pointing a dev dashboard at production requires an explicit `VITE_PROXY_TARGET=` — never make prod the default (dev clicks mutate real data: lead status PATCH, booking cancel, API-key regeneration).

### Session handoffs (inter-agent communication)

- At the END of every session, write a short summary to `docs/handoffs/YYYY-MM-DD-<workstream>.md`: what shipped (commits), what's blocked, open questions. The architect session (Cowork) reads these directly — Koren should not need to copy-paste.
- If you're blocked on a DECISION (not a bug), write it under an "Questions for architect" heading in your handoff file and move on to unblocked work. Don't guess on cross-workstream contracts.

## Stack

TypeScript + Fastify 5 + Drizzle ORM + PostgreSQL + Redis + BullMQ + Zod + OpenAI gpt-5.4

## ⚠️ PARALLEL WORKSTREAMS — TERRITORY RULES (two Claude Code sessions on this repo)

Two agents work this repo simultaneously. Respect your lane:

**VOICE agent** — owns: `src/modules/channels/voice-livekit/**`, `src/modules/channels/whatsapp/**` (window/consent logic), `src/queues/workers/meeting-reminders*`, `src/modules/scheduling/**` (may extend), `docs/phase-4-*`, `docs/go-live-plan.md`. Branches: `feature/voice-livekit-*`, `feature/meeting-reminders`.

**DASHBOARD agent** — owns: `dashboard/**`, `docs/phase-5-dashboard-*`, `brand_assets/**`. Branches: `feature/dashboard-*`.

**SPLIT-OWNERSHIP modules (`src/modules/calls/**`, `src/modules/leads/**`):**
- VOICE owns **services / workers / guards** (call-analysis, spend-guard, monitor, lead upsert logic)
- DASHBOARD owns/extends **API routes** (`calls.routes.ts`, `leads` timeline endpoint) — additively, read-only queries
- Neither rewrites the other's files in these modules; both announce schema-adjacent changes here first

**SHARED FILES — collision zone. Special rules apply:**
- `src/config/env.ts`, `.env.example`, `package.json`, `server.ts`, `src/plugins/**` — additive-only edits; never reorder/reformat existing lines; pull/rebase before editing.
- `src/db/schema/**` + migrations — **migration numbers are claimed in the table below BEFORE generating.** Never renumber someone else's migration.
- `CLAUDE.md`, `tenants` settings keys — announce in the claims lists below before changing.

**Migration number claims:** 0004 = leads whatsapp fields (VOICE, applied) · 0005 = scheduled_calls.reminders (VOICE, applied) · next free: 0006.

**tenants.settings key claims:** `voice_engine` (VOICE) · `functions_enabled` (VOICE) · `whatsapp_templates` (VOICE) · `toll_fraud` (VOICE) · `reminders` (VOICE) · `flows` (pre-existing, shared) · `billing_provider` (reserved, Workstream D). New keys → add here in the same commit.

**Rules of engagement:**
1. NEVER edit files in the other agent's territory — if you think you must, STOP and tell Koren why.
2. NEVER commit to the other agent's branches; never merge/rebase their branches.
3. Before touching a shared file: `git fetch` + check the other branch for pending changes to that file (`git diff main...<other-branch> -- <file>`). Conflict likely → coordinate via Koren.
4. If you find uncommitted changes you didn't make — do NOT revert/stash them. They're the other agent's work. Tell Koren.
5. New tenants.settings keys: check this section's claims first, add your key to the claims list in the same commit.
6. `npm install`: announce new deps in commit message clearly (`deps: add X for Y`) — the other agent must `npm install` after pulling.

## Current initiative — Voice engine migration (Retell → LiveKit)

The voice module is being migrated from Retell AI to a self-built pipeline on LiveKit + Cartesia + OpenAI Realtime. New code lives in `src/modules/channels/voice-livekit/` **alongside** the existing Retell code (strangler-fig pattern). Selection via per-tenant `voice_engine` flag in `tenants.settings` JSON (`'retell'` | `'livekit'`, default `'retell'`).

**Rationale:** Retell doesn't expose its human-sounding features (audio tags, prosody, emotion) for Hebrew — our primary target language. Direct-to-provider stack unlocks full Cartesia Hebrew quality, drops cost from ~$0.25/min to ~$0.08/min, and removes vendor lock-in.

**Before touching any voice code, read in this order:**
1. `VOICE_MIGRATION_PLAN.md` (project root) — 7-phase migration strategy with success criteria + rollback plan
2. `docs/voice-agent-development-methodology.md` — 10 non-negotiable rules for every voice commit
3. `docs/hebrew-voice-agent-dev-plan.md` — Hebrew-specific stack, prompts, business logic for lead-booking use case
4. `docs/retell-ai-dashboard-reference.md` — feature parity checklist (what Retell has, what we replicate, what we skip)
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
- `npm run screenshot` — screenshot all dashboard routes → `screenshots/*.png` (dashboard dev server must be running on :3001)
- `node scripts/screenshot.mjs <route>` — screenshot a single route (overview, calls, call-detail)

## Architecture

- **App factory pattern:** `buildApp()` in `src/server.ts` — all tests should use this
- **Webhooks** at `/webhooks/*` — authenticated by per-channel signature verification, NOT API auth
- **API** at `/api/v1/*` — dual auth (API key OR JWT)
- **Queue-based processing:** webhook → BullMQ → worker → outbound queue
- **ai-engine** is a service module (no routes) — consumed by channel workers and lead qualification
- All DB tables have `tenant_id` — always filter by it, never skip tenant isolation
- **Dead Letter Queue:** all 3 main workers move exhausted jobs to `dead-letter` queue
- **Circuit breakers:** UChat, Retell, LiveKit, Cartesia, Monday, Google Calendar, Trafft, Airtable each have their own breaker (5 failures → 30s cooldown)

## DB Schema (7 tables)

`tenants`, `leads`, `conversations`, `messages`, `scheduled_calls`, `import_jobs`, `call_learnings`

- `call_learnings` — stores call recordings (Twilio conference monitoring / Retell), Whisper transcripts, GPT sales analysis, outcome labels (`won`/`lost`/`neutral`)

## Workers (5)

- `message-processor` — routes inbound messages, runs `qualifyLead()` after each exchange
- `outbound-sender` — sends WhatsApp / Email outbound messages
- `flow-executor` — runs multi-step automation flows with delays
- `csv-import` — bulk lead creation from uploaded CSVs
- `call-analysis` — downloads call recording → Whisper transcription → GPT sales analysis → injects learnings into future agent prompts (Retell dynamic variables today; also voice-livekit system prompt during migration)

## Modules

- `leads` — CRUD, status workflow, score, manual flow trigger. `GET /:id/timeline` returns lead + conversations + messages + scheduled_calls in one call (consumed by the dashboard Lead Detail page at `/leads/:id`)
- `channels/whatsapp` — UChat inbound/outbound, signature verification, 24h window fallback
- `channels/email` — Resend inbound/outbound, svix signature verification
- `channels/voice` — **[legacy — being replaced]** Zadarma (SIP number / caller ID) + Retell AI (agent/LLM) + Cartesia (TTS); outbound call initiation, learnings injection via Retell dynamic variables. Twilio retained only for conference-call monitoring. See `VOICE_MIGRATION_PLAN.md`.
- `channels/voice-livekit` — **[in progress — Phase 1]** Self-built pipeline: Zadarma SIP inbound trunk → LiveKit Agents (Node.js SDK) → OpenAI Realtime STT → OpenAI GPT LLM → Cartesia Sonic-4 TTS. Full Hebrew voice quality, ~65% cheaper per minute, no Retell vendor lock-in. Enabled per tenant via `tenants.settings.voice_engine='livekit'`. Reuses `google-calendar.provider.ts`, `ai-engine.service.ts`, `SettingsService`, `CallAnalysisService`, `scheduled_calls` and `call_learnings` tables.
- `scheduling` — Google Calendar (default provider), Trafft provider also available; slots query, booking, cancel
- `integrations` — Monday.com (sync/push/webhook), CSV import, Google Sheets, Nango CRM
- `webhooks` — Meta Lead Ads, generic lead intake
- `tenants` — create/read/update, API key generation, flow config storage
- `calls` — list/detail/audio proxy for Retell calls
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

**Root-level (read first for voice work):**
- `VOICE_MIGRATION_PLAN.md` — voice engine migration plan (read this before any voice code change)
- `PRODUCT_ROADMAP.md` — ⚠️ **stale** (last edit May 2026, still mentions ElevenLabs). Trust `VOICE_MIGRATION_PLAN.md` over this for voice.
- `PROJECT_STATUS.md` — ⚠️ **stale** (last updated 2026-04-30, doesn't reflect voice migration)
- `THIRD_PARTY_REPORT.md` — ⚠️ **stale** (also mentions ElevenLabs). Actual current voice provider is Retell (being replaced by self-built LiveKit).

**`docs/` folder — voice migration reference set:**
- `voice-agent-development-methodology.md` — 10 development principles (mandatory before writing voice code)
- `hebrew-voice-agent-dev-plan.md` — 7-phase Hebrew agent build plan with per-phase prompts
- `retell-ai-dashboard-reference.md` — Retell feature parity checklist
- `voice-ai-learning-resources.md` — 30 curated engineering guides & case studies with reading order
