# AI Sales Agent

Multi-channel AI sales agent (WhatsApp, Email, Voice) that qualifies leads and books calls via Google Calendar (or Trafft).

## Brand — KEREN by ClickScales

- **Company:** ClickScales · **Product:** KEREN (the agent persona is "קרן", female, Hebrew-first)
- **"Danie" is deprecated.** `brand_assets/brand_identity` (v2) is superseded by `brand_assets/keren-brand-brief-v3.md` — the single source of truth for all dashboard design work (tokens, typography, i18n/RTL rules, component DoD, Danie→KEREN migration checklist).
- Dashboard is **bilingual (HE+EN) from day one**: react-i18next, all UI strings via `t('...')`, CSS logical properties only, `dir="auto"` on all user content. See brief §2 + §7.

## Parallel workstreams (two Claude Code sessions)

- **Voice workstream** owns `src/modules/channels/voice-livekit/` (+ voice docs).
- **Dashboard workstream** owns `dashboard/` + `src/modules/calls/` + `src/modules/leads/`, on `feature/dashboard-*` branches.
- Neither touches the other's territory. Cross-cutting changes are coordinated by updating this file.
- **Open handoff → Voice session (Task 0):** create a `conversations` row (`channel: 'voice'`, `channelRef: <roomName>`) at LiveKit call initiation (outbound + web-call). Note: `web-call-*` rooms have no real lead — needs a placeholder lead or explicit skip (calls list inner-joins leads). Until this lands, LiveKit calls don't appear in the dashboard calls list and the `learnings` join returns null.

## Stack

TypeScript + Fastify 5 + Drizzle ORM + PostgreSQL + Redis + BullMQ + Zod + OpenAI gpt-5.4

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
