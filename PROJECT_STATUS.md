# AI Sales Agent — Project Status

> Last updated: 2026-07-19
> Stack: TypeScript · Fastify 5 · Drizzle ORM · PostgreSQL · Redis · BullMQ · OpenAI gpt-5.4

---

## Current Phase: Phase 7 — Voice Engine Migration (Retell → self-built LiveKit)

Voice engine history: **ElevenLabs (POC, retired) → Retell (deprecated, removed from the repo 2026-08-05) → self-built LiveKit + Cartesia + Soniox (live in production since 2026-07-29)**. See `VOICE_MIGRATION_PLAN.md` for the full 7-phase plan.

---

## Phase Overview

| Phase | Name | Status |
|-------|------|--------|
| 1 | Foundation & Scaffold | ✅ Complete |
| 2 | Core Channels & AI Engine | ✅ Complete |
| 3 | Lead Intake & Automation Flows | ✅ Complete |
| 4 | Integrations (CSV, Sheets, CRM) | 🔄 Partial (Monday ✅, Airtable ✅, Sheets ⏳) |
| 5 | Hardening, Observability & Tests | ✅ Complete (Sentry live, 142+ tests) |
| 6 | SaaS Multi-tenancy & Dashboard | 🔄 Partial (dashboard live, self-serve pending) |
| 7 | Voice Engine Migration (Retell → LiveKit) | ✅ Live since 2026-07-29; legacy code removed 2026-08-05 |

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
- [x] Voice / Twilio + ElevenLabs — inbound call handling, AI agent registration, outbound call initiation, TwiML generation *(historical — subsequently replaced by Retell + Zadarma + Cartesia; now being replaced again in Phase 7)*
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
- [x] Fetch timeouts on all external APIs — UChat (10s), Google Calendar / Monday (15s) via `AbortSignal.timeout()`
- [x] Dead Letter Queue (DLQ) — `src/queues/dead-letter.ts`; all main workers (message-processor, outbound-sender, flow-executor) move exhausted jobs to `dead-letter` queue
- [x] Replay attack protection — `src/shared/webhook-timestamp.ts`; `isTimestampFresh()` on WhatsApp + lead-intake webhooks (5-min window)
- [x] Per-tenant rate limiting — 200 req/min per tenant in API scope via `keyGenerator`
- [x] Circuit breaker — `src/shared/circuit-breaker.ts`; UChat, LiveKit, Cartesia, Monday, Google Calendar, Trafft, Airtable each have their own breaker (5 failures → 30s cooldown → HALF_OPEN test).
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

## Phase 6 — SaaS Multi-tenancy & Dashboard 🔄 Partial

- [x] Dashboard UI — `dashboard/` folder, live routes (overview, leads, calls, flows, call-detail); screenshot script `npm run screenshot`
- [ ] Tenant self-serve onboarding
- [ ] Billing / quota system
- [ ] Analytics & reporting endpoints (conversion funnel, channel performance, lead scoring)
- [ ] Per-tenant API key rotation
- [ ] Tenant settings UI (flow builder, channel config)

---

## Phase 7 — Voice Engine Migration (Retell → self-built LiveKit) ✅ Live

Replace Retell with LiveKit + Cartesia + OpenAI Realtime pipeline. Full plan in `VOICE_MIGRATION_PLAN.md`. Reference docs in `docs/`.

**Why:** Retell doesn't expose human-sounding features in Hebrew (primary target language); direct-to-provider stack cuts per-minute cost ~65% and removes vendor lock-in.

**Sub-phases:**

| # | Sub-phase | Status |
|---|---|---|
| 7.1 | Skeleton — add `@livekit/agents` to project, create `src/modules/channels/voice-livekit/` module | ✅ Done (2026-07-13) — live Hebrew multi-turn agent, own process, `npm run voice:dev` |
| 7.2 | Hebrew tuning — voice A/B, prompt v2, latency instrumentation | 🔄 Partial — Soniox STT swap, speech-guard (pronunciation + honesty), thinking fillers, CallReport; **open:** no Hebrew end-of-turn model exists → ~0.9–1.4s EOU; DeepDub TTS built behind `VOICE_TTS_PROVIDER` flag (user prefers it 6:1, not switched yet) |
| 7.3 | Zadarma → LiveKit SIP inbound trunk | ✅ Trunk configured; real inbound calls placed during Phase 1–2 testing |
| 7.4 | Business logic — agent function tools | ✅ Built (2026-07-17/18, branch `feature/voice-livekit-phase-4-tools`, unmerged): `check_calendar_availability` / `book_meeting` / `end_call(reason)` behind per-tenant `voice_engine`+`functions_enabled` gate; opt_out→DNC; recording-notice pre-roll + AI-disclosure tracking; `call_learnings` persistence; Google Calendar Domain-Wide Delegation granted → real email invites + Meet links |
| 7.5 | Testing — unit + scripted conversation + latency benchmark | ✅ ~90 new tests incl. FakeLLM scripted flow (check→book→end in order); synthetic-caller audio harness; **browser Voice Simulator** (dashboard `/voice`) verified end-to-end incl. a real human conversation |
| 7.6 | Production deploy — `lk agent deploy`, switch Koren's tenant to `livekit` | ⏳ Blocked on the real-phone-call merge gate (user abroad); stale 07-14 cloud deployment deleted 2026-07-18 |
| 7.7 | Weekly iteration loop — human review of 20 sampled calls/week + regression tests | ⏳ Not started (ongoing) |

**Merge gate for 7.4:** a real phone call — qualify → book → event visible in Google Calendar within 5s + `scheduled_calls` + `call_learnings.analysis.tool_calls`. Until then the branch stays unmerged.

**Rollback plan:** ⚠️ **None.** The previous engine was decommissioned and its code removed from the repo (2026-08-05). `voice_engine` no longer exists as a setting. Fix forward.

**Success criteria (carried over from the decommissioning gate — still open):**
- Latency P95 < 800ms, P50 < 500ms per turn
- Blind test: 3+ humans can't reliably identify agent as bot
- 30 days of clean operation on Koren's tenant
- Verified cost < $0.12/min

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
| `TWILIO_ACCOUNT_SID` | Voice (conference monitoring only) | ✅ Set |
| `TWILIO_AUTH_TOKEN` | Voice (conference monitoring only) | ✅ Set |
| `TWILIO_WHATSAPP_NUMBER` | WhatsApp (Twilio path — legacy) | — |
| `ZADARMA_API_KEY` | Voice — SIP number / caller ID | ✅ Set |
| `ZADARMA_API_SECRET` | Voice — SIP number / caller ID | ✅ Set |
| `ZADARMA_PHONE_NUMBER` | Voice — the actual phone number | ✅ Set |
| `LIVEKIT_URL` | Voice — Phase 7 target engine | ⏳ To add |
| `LIVEKIT_API_KEY` | Voice — Phase 7 target engine | ⏳ To add |
| `LIVEKIT_API_SECRET` | Voice — Phase 7 target engine | ⏳ To add |
| `CARTESIA_API_KEY` | Voice — TTS | ⏳ To add |
| `CARTESIA_VOICE_ID_HE` | Voice — Hebrew voice selection | ⏳ To add |
| `OPENAI_REALTIME_MODEL` | Voice — Phase 7 STT (default: `gpt-realtime-whisper`) | ⏳ To add |
| ~~`ELEVENLABS_API_KEY`~~ | ~~Voice (original POC)~~ | Retired |
| ~~`ELEVENLABS_AGENT_ID`~~ | ~~Voice (original POC)~~ | Retired |
| ~~`ELEVENLABS_PHONE_NUMBER_ID`~~ | ~~Voice outbound (original POC)~~ | Retired |
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
