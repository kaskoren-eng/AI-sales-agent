# AI Sales Agent — Project Status

> Last updated: 2026-04-30
> Stack: TypeScript · Fastify 5 · Drizzle ORM · PostgreSQL · Redis · BullMQ · OpenAI gpt-5.4

---

## Current Phase: Phase 5 — Hardening, Observability & Tests

---

## Phase Overview

| Phase | Name | Status |
|-------|------|--------|
| 1 | Foundation & Scaffold | ✅ Complete |
| 2 | Core Channels & AI Engine | ✅ Complete |
| 3 | Lead Intake & Automation Flows | ✅ Complete |
| 4 | Integrations (CSV, Sheets, CRM) | 🔄 Partial (Monday ✅) |
| 5 | Hardening, Observability & Tests | 🔄 In Progress |
| 6 | SaaS Multi-tenancy & Dashboard | 🔜 Planned |

---

## Phase 1 — Foundation & Scaffold ✅ Complete

Everything needed to start building on top of.

- [x] TypeScript + Fastify 5 app factory (`buildApp`)
- [x] Zod env validation — fail-fast at boot
- [x] Docker Compose (PostgreSQL + Redis)
- [x] Drizzle ORM schema: `tenants`, `leads`, `conversations`, `messages`, `scheduled_calls`, `import_jobs`
- [x] All tables have `tenant_id` with composite indexes
- [x] AES-256-GCM encryption utility (`src/shared/crypto.ts`)
- [x] Dual auth: API key (SHA-256 hashed) + JWT (15min access / 7d refresh)
- [x] Webhook signature verification (per-channel, no API auth)
- [x] BullMQ queue infrastructure: `message-processor`, `outbound-sender`, `flow-executor`
- [x] Global error handler with `AppError` subclasses
- [x] Helmet, CORS, rate limiting 
- [x] Health check endpoint (`/health`)
- [x] Audit logging plugin
- [x] Tenant management API (create/read/update, API key generation, flow config storage)
- [x] Lead management API (CRUD, status/score, phone/email lookup)

---

## Phase 2 — Core Channels & AI Engine ✅ Complete

- [x] WhatsApp / UChat — inbound & outbound, subscriber lifecycle, 24h window fallback to template, signature verification
- [x] Voice / Twilio + ElevenLabs — inbound call handling, AI agent registration, outbound call initiation, TwiML generation
- [x] Scheduling / Google Calendar — slots query (freebusy), create booking (event + invite), cancel booking, pluggable provider interface. Replaced Trafft.
- [x] AI Engine — OpenAI gpt-5.4, `generateResponse()` + `qualifyLead()` with JSON mode
- [x] Flow executor — multi-step automation with delays, variable interpolation (`{{name}}`), WhatsApp + Voice + Email steps
- [x] Email / Resend — inbound + outbound, svix signature verification, `send_email` flow step type
- [x] Message processor routing — branches by `lead.status`; auto-runs `qualifyLead()` after each exchange
- [x] Booking `conversationId` persistence — saved to `scheduled_calls`

---

## Phase 3 — Lead Intake & Automation Flows ✅ Complete

- [x] Meta Lead Ads webhook — HMAC-SHA256 verification, payload normalization, deduplication (phone/email)
- [x] Generic webhook lead intake — `tenant_id` from `LEAD_WEBHOOK_TENANT_ID` env var only (no body spoofing)
- [x] Lead status workflow enforcement — `new → contacted → qualifying → qualified / disqualified` with `canTransition()` guard
- [x] Auto-trigger flow on new lead (`flows.lead-intake` in tenant settings)
- [x] Qualified → `flows.qualified` auto-trigger (enqueues first step with configured delay)
- [x] Disqualification reason + score logged to lead metadata
- [x] Conversation summarization — `conversations.summary` populated via AI on qualification
- [x] Manual flow trigger — `POST /api/v1/leads/:id/trigger-flow`

---

## Phase 4 — Integrations 🔄 In Progress

### Done
- [x] Monday.com integration
  - [x] Configure endpoint — validates token, encrypts AES-256-GCM, stores in tenant settings
  - [x] Sync endpoint — pulls items from board/group, normalizes phone (`+` prefix), upserts leads
  - [x] Push endpoint — pushes a lead to Monday as an item
  - [x] Monday webhook — HMAC-SHA256 verification, status change → lead status update
  - [x] Board/column discovery endpoints

### Done
- [x] CSV import — JSON body `{ csvContent }` → PapaParser → bulk lead upsert → progress via `import_jobs`
- [x] CSV import queue worker (`src/queues/workers/csv-import.worker.ts`) — wired in `server.ts`

### Still To Do
- [ ] Google Sheets — OAuth setup, row sync, polling job
- [ ] CRM direct integration — build when specific CRM is chosen (HubSpot / Pipedrive / etc.), same pattern as Monday.com (no Nango — removed)

---

## Phase 5 — Hardening, Observability & Tests 🔄 In Progress

### Done
- [x] Fetch timeouts on all external APIs — UChat (10s), ElevenLabs / Google Calendar / Monday (15s) via `AbortSignal.timeout()`
- [x] Dead Letter Queue (DLQ) — `src/queues/dead-letter.ts`; all 3 workers move exhausted jobs to `dead-letter` queue
- [x] Replay attack protection — `src/shared/webhook-timestamp.ts`; `isTimestampFresh()` on WhatsApp + lead-intake webhooks (5-min window)
- [x] Per-tenant rate limiting — 200 req/min per tenant in API scope via `keyGenerator`
- [x] Circuit breaker — `src/shared/circuit-breaker.ts`; UChat, ElevenLabs, Monday, Google Calendar each have their own breaker (5 failures → 30s cooldown → HALF_OPEN test)
- [x] Auth failure audit logging — every rejected auth logs `event: auth_failure` with `reason`, `ip`, `method`, `url` (never the credential)
- [x] Tenant seed script — `scripts/seed-tenant.mjs` creates a tenant + prints a ready-to-use API key

### Done
- [x] Unit tests — circuit breaker (13), auth plugin (9), webhook timestamp (18), crypto (9), flow schemas (6), errors (8), leads (9+5+9), workers (14+8+7+10) — **142 tests total, all green**
- [x] Integration tests — queue workers (message-processor, flow-executor, outbound-sender, csv-import)
- [x] Call recording webhook — `POST /webhooks/voice/recording-status` (Twilio signature verification, Redis tenant lookup, enqueues call-analysis job)
- [x] Bug #2 fixed — flow-executor now throws `ValidationError` for missing video `url`, missing `text`, and unknown step types; DLQ wired
- [x] Bug #3 fixed — WhatsApp `verifyWebhookSecret()` returns `false` (not `true`) when secret is unconfigured

### Still To Do
- [ ] Sentry error monitoring
- [ ] E2E tests — full conversation flow (WhatsApp in → qualify → book)

---

## Phase 6 — SaaS Multi-tenancy & Dashboard ⏳ Planned

- [ ] Dashboard UI (separate repo / frontend)
- [ ] Tenant self-serve onboarding
- [ ] Billing / quota system
- [ ] Analytics & reporting endpoints (conversion funnel, channel performance, lead scoring)
- [ ] Per-tenant API key rotation
- [ ] Tenant settings UI (flow builder, channel config)

---

## Known Bugs

| # | Severity | Location | Fix |
|---|----------|----------|-----|
| ~~1~~ | ~~High~~ | ~~`lead-intake.routes.ts`~~ | ~~Non-Meta webhooks accepted any `tenant_id` from body~~ — **Fixed:** `LEAD_WEBHOOK_TENANT_ID` env var only; body value ignored |
| ~~2~~ | ~~Medium~~ | ~~`flow-executor.worker.ts`~~ | ~~Misconfigured flow steps failed silently~~ — **Fixed:** throws `ValidationError` for missing `url`/`text`, unknown step types; all errors routed to DLQ |
| ~~3~~ | ~~Low~~ | ~~`whatsapp.service.ts`~~ | ~~`verifyWebhookSecret()` returned `true` when `UCHAT_WEBHOOK_SECRET` was unset~~ — **Fixed:** returns `false` + logs a warning when secret is not configured |

---

## Environment Variables Checklist

| Variable | Required | Status |
|----------|----------|--------|
| `DATABASE_URL` | Yes | ✅ Set |
| `REDIS_URL` | Yes | ✅ Set |
| `ENCRYPTION_KEY` | Yes | ✅ Set |
| `JWT_SECRET` | Yes | ✅ Set |
| `OPENAI_API_KEY` | Yes | ✅ Set |
| `UCHAT_API_TOKEN` | WhatsApp | ✅ Set |
| `UCHAT_WEBHOOK_SECRET` | WhatsApp | ✅ Set |
| `UCHAT_WEBHOOK_TENANT_ID` | WhatsApp | ✅ Set |
| `TWILIO_ACCOUNT_SID` | Voice | — |
| `TWILIO_AUTH_TOKEN` | Voice | — |
| `TWILIO_PHONE_NUMBER` | Voice | — |
| `ELEVENLABS_API_KEY` | Voice | ✅ Set |
| `ELEVENLABS_AGENT_ID` | Voice | ✅ Set |
| `ELEVENLABS_PHONE_NUMBER_ID` | Voice outbound | ✅ Set |
| `RESEND_API_KEY` | Email | — |
| `RESEND_FROM_EMAIL` | Email | — |
| `RESEND_INBOUND_TENANT_ID` | Email webhook | — |
| `GOOGLE_CALENDAR_ID` | Scheduling | ✅ Set |
| `GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL` | Scheduling | ✅ Set |
| `GOOGLE_CALENDAR_PRIVATE_KEY` | Scheduling | ✅ Set |
| `GOOGLE_CALENDAR_SLOT_MINUTES` | Scheduling (optional) | ✅ Set |
| `GOOGLE_CALENDAR_WORK_START` | Scheduling (optional) | ✅ Set |
| `GOOGLE_CALENDAR_WORK_END` | Scheduling (optional) | ✅ Set |
| `META_APP_SECRET` | Meta Leads | — |
| `LEAD_WEBHOOK_SECRET` | Generic webhook | ✅ Set |
| `LEAD_WEBHOOK_TENANT_ID` | Generic webhook | ✅ Set |
| `MONDAY_WEBHOOK_SECRET` | Monday webhook | — |
| `BASE_URL` | Callbacks | — |
| `CORS_ORIGINS` | Security | ✅ Set |
