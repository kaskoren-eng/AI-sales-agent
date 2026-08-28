# AI Sales Agent — Project Status

> Last updated: 2026-08-02
> Stack: TypeScript · Fastify 5 · Drizzle ORM · PostgreSQL · Redis · BullMQ · OpenAI gpt-5.4

---

## Current Phase: Launch

The voice engine migration is **done and live in production**. The work now is closing the launch
gates: getting through the Phase-6 verification layers and flipping the website's lead intake on.

Voice engine history: **ElevenLabs (POC, retired) → Retell (deprecated, removed from the repo 2026-08-05) → self-built LiveKit + Soniox + Cartesia (live since 2026-07-29)**. See `VOICE_MIGRATION_PLAN.md`.

> **Branch reality:** `main` is the trunk. `master` was retired and deleted in the Phase-0 cutover
> (tagged `archive/master-2026-07-10`). `feature/crm-automation` was merged into `main` on
> 2026-08-16; despite what earlier revisions of this file said, Workstreams B and C were ALREADY on
> `main` before that merge — its actual content was the Retell removal.

---

## Phase Overview

| Phase | Name | Status |
|-------|------|--------|
| 1 | Foundation & Scaffold | ✅ Complete |
| 2 | Core Channels & AI Engine | ✅ Complete |
| 3 | Lead Intake & Automation Flows | ✅ Complete |
| 4 | Integrations (CSV, Sheets, CRM) | ✅ Complete (Monday, Airtable, Sheets, CRM sync) |
| 5 | Hardening, Observability & Tests | ✅ Complete (Sentry live, ~715 tests) |
| 6 | SaaS Multi-tenancy & Dashboard | ✅ Complete for MVP (billing + self-serve onboarding deferred) |
| 7 | Voice Engine Migration (Retell → LiveKit) | ✅ Live since 2026-07-29; legacy engine removed from the repo 2026-08-05 |
| 8 | Operations & Launch | 🔄 In Progress (admin console ✅, metrics ✅, dashboard v5 ✅, accounts ✅, tenant isolation ✅, website 🔄) |

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
- [x] Voice — inbound call handling, AI agent registration, outbound call initiation *(historical: Twilio + ElevenLabs → Retell + Zadarma + Cartesia → self-built LiveKit stack, live since 2026-07-29. See Phase 7.)*
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

## Phase 4 — Integrations ✅ Complete

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

### Done
- [x] Google Sheets — `src/modules/integrations/google-sheets.service.ts`
- [x] Airtable — `src/modules/integrations/airtable/`
- [x] CRM direct integration — **Workstream B**, `src/modules/integrations/crm-sync.service.ts`. Call outcome → lead status → push to Monday + Airtable, plus a GPT call summary as a Monday update / Airtable long-text. One hook at the end of the LiveKit call-analysis worker; `syncCallToCrm()` never throws. Per-tenant `tenants.settings.crm_sync`. **Built and tested (31 tests) on `feature/crm-automation`, not yet merged** — see Workstreams below. (No Nango — removed.)

### Still To Do
- [ ] Fireberry connector (B3) — explicitly out of scope so far
- [ ] CRM config UI — no dashboard surface for `crm_sync` yet

---

## Phase 5 — Hardening, Observability & Tests ✅ Complete

### Done
- [x] Fetch timeouts on all external APIs — UChat (10s), Google Calendar / Monday (15s) via `AbortSignal.timeout()`
- [x] Dead Letter Queue (DLQ) — `src/queues/dead-letter.ts`; all main workers (message-processor, outbound-sender, flow-executor) move exhausted jobs to `dead-letter` queue
- [x] Replay attack protection — `src/shared/webhook-timestamp.ts`; `isTimestampFresh()` on WhatsApp + lead-intake webhooks (5-min window)
- [x] Per-tenant rate limiting — 200 req/min per tenant in API scope via `keyGenerator`
- [x] Circuit breaker — `src/shared/circuit-breaker.ts`; UChat, LiveKit, Cartesia, Monday, Google Calendar, Trafft, Airtable each have their own breaker (5 failures → 30s cooldown → HALF_OPEN test)
- [x] Auth failure audit logging — every rejected auth logs `event: auth_failure` with `reason`, `ip`, `method`, `url` (never the credential)
- [x] Tenant seed script — `scripts/seed-tenant.mjs` creates a tenant + prints a ready-to-use API key

### Done
- [x] Unit tests — **~563 tests passing** across shared utilities, workers, routes, voice tools, state machine and CRM sync. (Known: 2 pre-existing failures in `lead.service` / `lead.routes`.)
- [x] Sentry error monitoring — `src/plugins/sentry.ts`, registered in `src/server.ts`; `SENTRY_DSN` + `SENTRY_ENVIRONMENT`
- [x] Integration tests — queue workers (message-processor, flow-executor, outbound-sender, csv-import)
- [x] Call recording webhook — `POST /webhooks/voice/recording-status` (Twilio signature verification, Redis tenant lookup, enqueues call-analysis job)
- [x] Bug #2 fixed — flow-executor now throws `ValidationError` for missing video `url`, missing `text`, and unknown step types; DLQ wired
- [x] Bug #3 fixed — WhatsApp `verifyWebhookSecret()` returns `false` (not `true`) when secret is unconfigured

### Still To Do
- [ ] E2E tests — full conversation flow (WhatsApp in → qualify → book)

---

## Phase 6 — SaaS Multi-tenancy & Dashboard ✅ Complete for MVP

- [x] Dashboard UI — `dashboard/`, React 19 + Vite 8 + Tailwind 4. Real routes: `/`, `/leads`, `/leads/:id`, `/calls`, `/calls/:id`, `/voice`, `/bookings`, `/integrations`, `/settings`, `/chat` (Copilot), `/agent` (Personality), `/simulator`, `/styleguide`, `/admin`, `/admin/tenants`. *(There is no `flows` page — the old note claiming one was wrong.)*
- [x] Bilingual HE+EN — react-i18next, English source + `he.json`, RTL, Heebo; full v5 design-system migration across all 8 core pages, token bridge retired
- [x] Responsive shell (mobile) + full-app QA pass
- [x] Analytics & reporting endpoints — `src/modules/metrics/`, `GET /api/v1/metrics/summary?range=` (Overview KPIs, pipeline, quality, trend); Overview wired to real data
- [x] Per-tenant API key rotation — `POST /api/v1/admin/tenants/:id/rotate-key`
- [x] Tenant settings UI — `Settings.tsx`, `Integrations.tsx`, `AgentPersonality.tsx`
- [ ] Tenant self-serve onboarding
- [ ] Billing / quota system (Workstream D — SUMIT / Green Invoice; `billing_provider` key reserved, not built)

**Open dashboard items:**
- Calendar cancel is broken: the frontend calls `GET /scheduling/bookings` ([dashboard/src/lib/api.ts:55](dashboard/src/lib/api.ts#L55)) but `scheduling.routes.ts` only registers `/slots`, `/book`, `/cancel/:bookingUid` — **the page is wired to a 404**. Cancel also has nothing to pass, because the frontend `Booking` type never exposes `providerRef`. Both fixes are VOICE territory.
- Copilot (`/chat`) is UI-only — there is no assistant/chat backend endpoint, so the conversation can't be built without one.
- `/voice` (VoiceChat) and `/simulator` now both do a real LiveKit web-call — open decision whether to fold them together.
- Settings inner-tab i18n awaits Koren's native Hebrew copy.

---

## Phase 8 — Operations & Launch 🔄 In Progress

- [x] **Admin / operator console** — `src/modules/admin/`, super-admin cross-tenant. Gated by `ADMIN_API_KEY` (unset → every `/api/v1/admin/*` route 503s; opt-in). Own scope in `server.ts`, IP-rate-limited, constant-time key check. `GET /overview`, `GET /tenants`, `GET /tenants/:id`, `POST /tenants`, `PATCH /tenants/:id` (rename / suspend via `isActive`), `POST /tenants/:id/rotate-key`. Frontend at `/admin/*` (separate shell + key gate), English-only. No schema change.
- [x] **Cross-tenant IDOR fix** (shipped alongside) — `GET /tenants` had listed *all* tenants, and `/:id` + rotate-key acted on *any* tenant under normal tenant auth. Now self-only, plus a real `PATCH /me` (the dashboard's self-update had been silently broken).
- [x] **Marketing website** — `website/`, static clickscales.com (EN primary + `he/`), deployed on Netlify
- [ ] **Website lead intake** — `website/netlify/functions/lead.js` is deployed but **inert**; ready for the go-live flip
- [ ] Meta pixel + accessibility patch — prescribed in `docs/website-patch/`, completion unconfirmed
- [ ] Ops & health pillar in the admin console (queue depths, DLQ, breaker states) — deferred
- [ ] Real admin accounts + operator audit log — deferred (shared secret today)

---

## Phase 7 — Voice Engine Migration (Retell → self-built LiveKit) ✅ Live in production

Retell replaced by **LiveKit + Soniox STT + OpenAI LLM + Cartesia TTS**. Cut over on 2026-07-29 on the ClickScales tenant (`613d826c`). Full plan in `VOICE_MIGRATION_PLAN.md`. Reference docs in `docs/`.

**Why:** Retell doesn't expose human-sounding features in Hebrew (primary target language); direct-to-provider stack cuts per-minute cost ~65% and removes vendor lock-in.

**Sub-phases:**

| # | Sub-phase | Status |
|---|---|---|
| 7.1 | Skeleton — add `@livekit/agents` to project, create `src/modules/channels/voice-livekit/` module | ✅ Done (2026-07-13) — live Hebrew multi-turn agent, own process, `npm run voice:dev` |
| 7.2 | Hebrew tuning — voice A/B, prompt v2, latency instrumentation | ✅ Done — **Soniox `stt-rt-v5` is now the default STT** (`STT_PROVIDER=soniox`; semantic WER 4.3% vs OpenAI Realtime's 34.9% on real Hebrew calls), shadow-STT mode, speech-guard (pronunciation + honesty), thinking fillers, niqqud stripping before TTS, CallReport. **Open:** no Hebrew end-of-turn model exists → ~0.9–1.4s EOU; DeepDub TTS built behind `VOICE_TTS_PROVIDER` (Koren prefers it 6:1, not switched on) |
| 7.3 | Zadarma → LiveKit SIP inbound trunk | ✅ Trunk configured (`infra/livekit-sip/inbound-trunk.json`); real inbound calls placed |
| 7.4 | Business logic — agent function tools | ✅ **Six tools** behind per-tenant `voice_engine`+`functions_enabled`: `check_calendar_availability`, `book_meeting`, `end_call(reason)`, `capture_lead_info`, and two confirmation tools. Plus 20 prompt-injection tests, opt_out→DNC, recording-notice pre-roll + AI-disclosure tracking, dual daily spend caps (toll-fraud brake), `call_learnings` persistence, Google Calendar Domain-Wide Delegation → real email invites + Meet links. `transfer_to_human` was planned but **not built** |
| 7.5 | Testing — unit + scripted conversation + latency benchmark | ✅ FakeLLM scripted flow (check→book→end in order), synthetic-caller audio harness, Hebrew STT corpus + TTS niqqud A/B, **browser Voice Simulator** verified end-to-end incl. a real human conversation. Measured: **median EOU 591ms · LLM 841ms · TTS 162ms · worst turn 1594ms · prompt cache 88%** |
| 7.6 | Production deploy — `lk agent deploy`, switch tenant to `livekit` | ✅ **Live 2026-07-29** on tenant `613d826c`, LiveKit Cloud eu-central. Deploy gotcha: `.dockerignore` silently broke the agent image build. Three cutover-day bugs found and fixed (see below) |
| 7.7 | Weekly iteration loop — human review of 20 sampled calls/week + regression tests | ⏳ Not started. No `weekly_review/` yet, though `call-reports/` holds 25 real call JSONs and `docs/risk/measured-findings-from-call-reports.md` is a manual first pass |

**Cutover-day bugs (found and fixed 2026-07-29):** `capture_lead_info` null-loop (gpt-5.4 sends `null`, the Zod schemas used `.optional()` → validation failed → silent retry loop, presenting as the agent going silent for 20–44s); calendar offering one slot per day instead of a range; WhatsApp E.164 normalization (Twilio 21211).

**Rollback plan: none, and that is now literal.** The Retell code was removed from the repo on
2026-08-05 (merged to `main` 2026-08-16). Fix forward.

Note for anyone reading old docs: `tenants.settings.voice_engine` **still exists** — it was not
deleted with the engine. It is no longer an engine selector; it is one half of the agent's
fail-closed tool gate (tools run only when `voice_engine='livekit'` AND `functions_enabled=true`,
see `voice-livekit/tools/tool-context.ts`). A tenant missing it gets a working call with no tools.

**Success criteria (carried over from the decommissioning gate) — status:**
- Latency P50 < 500ms ✅ / **P95 < 800ms ❌** (EOU-bound, see 7.2)
- Blind test: 3+ humans can't reliably identify agent as bot — **not formally run**
- 30 days of clean operation — clock started 2026-07-29, **not demonstrated**
- Verified cost < $0.12/min — **never measured**
- **10 real calls without incident ❌ — 5 so far, all internal verification calls. No external inbound lead calls yet.**

Verification layers 1–5 of `docs/phase-6-verification-checklist.md` are Koren's to run; Layer 0 is green. Layer 6 (10 real calls) is the outstanding gate.

---

## Workstreams (post-migration)

| # | Workstream | Status |
|---|---|---|
| A | Voice tools + Tier-1 security (6 tools, injection defense, WhatsApp window/consent, toll-fraud caps) | ✅ Shipped |
| B | **CRM automation** — B1 outcome→status→CRM push (Monday + Airtable), B2 GPT summary + captured facts | ✅ On `main`. **Still unverified end-to-end:** no real call has yet landed an outcome in a connected CRM. B3 Fireberry not started |
| C | **Conversation state machine** — C1–C5: advisory stage machine + working memory, Hebrew stage lines, 3 reflexes (silence 2-strike nudge→hangup, barge-in analytics-only, voicemail behind `VOICE_AMD_ENABLED` default OFF), objection playbook, system-only end reasons, booking guardrails | ✅ On `main`. Still needs a real PSTN call to verify 4 behaviours: `UserStateChanged→'away'` fires on a live line, `OverlappingSpeech` emits in this cascade, AMD fires on real voicemail, and a `say()` nudge doesn't clip the caller |
| C1 | Meeting reminders — DST-safe, quiet hours, per-tenant `reminders` settings (migration 0005) | ✅ Shipped |
| D | Billing (SUMIT / Green Invoice) | ⏳ Not started. `billing_provider` key reserved only |

*(Naming collision to be aware of: "C1" in `docs/go-live-plan.md` means meeting reminders, while C1–C5 in the voice handoffs mean the state machine.)*

---

## Known Bugs

| # | Severity | Location | Fix |
|---|----------|----------|-----|
| ~~1~~ | ~~High~~ | ~~`lead-intake.routes.ts`~~ | ~~Non-Meta webhooks accepted any `tenant_id` from body~~ — **Fixed:** `LEAD_WEBHOOK_TENANT_ID` env var only; body value ignored |
| ~~2~~ | ~~Medium~~ | ~~`flow-executor.worker.ts`~~ | ~~Misconfigured flow steps failed silently~~ — **Fixed:** throws `ValidationError` for missing `url`/`text`, unknown step types; all errors routed to DLQ |
| ~~3~~ | ~~Low~~ | ~~`whatsapp.service.ts`~~ | ~~`verifyWebhookSecret()` returned `true` when `UCHAT_WEBHOOK_SECRET` was unset~~ — **Fixed:** returns `false` + logs a warning when secret is not configured |

### Open — from the 2026-07-25 code review (`docs/handoffs/2026-07-25-code-review-findings.md`)

None of these are confirmed fixed.

| # | Severity | Location | Problem |
|---|----------|----------|---------|
| 4 | 🔴 High | `flow-executor.worker.ts:212` + dialer | **Daily call cap enforced at half its value** — double `redis.incr`. `dailyCallLimit=100` blocks the tenant after ~50 real calls. The later `0dc54dc` "dual daily spend caps" commit may touch this — unverified |
| 5 | 🟠 Med | `meeting-reminders.worker.ts:201` | Custom reminder offsets mislabelled — anything `<720min` gets the "in an hour" template |
| 6 | 🟠 Med | `spend-guard.ts:166` | Dollar cap can silently die with no alert — `if (dbOk \|\| redisOk) recordSuccess()` |
| 7 | 🟡 Low | `settings.service.ts:96` | Settings save is read-modify-write over the whole JSON with no lock — cross-cutting between both workstreams |
| 8 | 🟡 Low | `whatsapp-window.ts:105` | WhatsApp window stamp hits every lead sharing a 9-digit phone suffix |

### Open — other

| Area | Problem |
|---|---|
| Scheduling ↔ dashboard | `GET /scheduling/bookings` does not exist; the dashboard Calendar page calls it and gets a 404. Cancel also needs `providerRef` exposed on the frontend `Booking` type. VOICE territory, unowned |
| Secrets | **Flag F3, raised 3× since 2026-07-29 and still open:** files with live keys (one marked "ROTATE, exposed in chat") are still in project knowledge. `.env.agent.bak` and `.env.bak-soniox` sit untracked in the working tree. Strip to `.env.example` and rotate |
| WhatsApp | Business templates still awaiting Twilio/Meta approval — `whatsapp_send_blocked` is expected until then |

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
| `LIVEKIT_URL` | Voice — **current engine** | ✅ Set |
| `LIVEKIT_API_KEY` | Voice — current engine | ✅ Set |
| `LIVEKIT_API_SECRET` | Voice — current engine | ✅ Set |
| `VOICE_LANGUAGE` | Voice — agent spoken language (`he`) | ✅ Set |
| `STT_PROVIDER` | Voice — `soniox` (default) \| `openai` | ✅ Set |
| `SONIOX_API_KEY` | Voice — STT | ✅ Set |
| `SONIOX_MODEL` | Voice — STT (`stt-rt-v5`) | ✅ Set |
| `SONIOX_MAX_ENDPOINT_DELAY_MS` | Voice — STT endpointing (500) | ✅ Set |
| `SHADOW_STT_ENABLED` | Voice — run a second recognizer in parallel (default false) | ✅ Set |
| `OPENAI_REALTIME_MODEL` | Voice — STT **fallback** (default `gpt-realtime-whisper`) | ✅ Set |
| `VOICE_TTS_PROVIDER` | Voice — `cartesia` (default) \| `deepdub` | ✅ Set |
| `CARTESIA_API_KEY` | Voice — TTS | ✅ Set |
| `CARTESIA_MODEL` | Voice — TTS model (`sonic-3`) | ✅ Set |
| `CARTESIA_VOICE_ID_PRIMARY` / `_SECONDARY` / `_TERTIARY` | Voice — Hebrew voice slots *(replaced `CARTESIA_VOICE_ID_HE`)* | ✅ Set |
| `DEEPDUB_API_KEY` + 7 more `DEEPDUB_*` | Voice — alternative TTS behind the flag | ✅ Set |
| `VOICE_TURN_DETECTION` | Voice — `vad` (no Hebrew EOU model exists) | ✅ Set |
| `VOICE_VAD_MIN_SILENCE_MS` / `VOICE_ENDPOINTING_MIN_DELAY_MS` / `_MAX_DELAY_MS` | Voice — turn-taking tuning | ✅ Set |
| `VOICE_LLM_MODEL` | Voice — overrides `AI_MODEL` for the voice turn (optional) | — |
| `VOICE_WEBHOOK_TENANT_ID` | Voice webhook | ✅ Set |
| ~~`ELEVENLABS_API_KEY`~~ | ~~Voice (original POC)~~ | Retired |
| ~~`ELEVENLABS_AGENT_ID`~~ | ~~Voice (original POC)~~ | Retired |
| ~~`ELEVENLABS_PHONE_NUMBER_ID`~~ | ~~Voice outbound (original POC)~~ | Retired |
| `RESEND_API_KEY` | Email | — |
| `RESEND_FROM_EMAIL` | Email | — |
| `RESEND_INBOUND_TENANT_ID` | Email webhook | — |
| `GOOGLE_CALENDAR_ID` | Scheduling | ✅ Set |
| `GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL` | Scheduling | ✅ Set |
| `GOOGLE_CALENDAR_PRIVATE_KEY` | Scheduling | ✅ Set |
| `GOOGLE_CALENDAR_IMPERSONATE_USER` | Scheduling — Domain-Wide Delegation (real invites + Meet links) | ✅ Set |
| `GOOGLE_CALENDAR_SLOT_MINUTES` | Scheduling (optional) | ✅ Set |
| `GOOGLE_CALENDAR_WORK_START` | Scheduling (optional) | ✅ Set |
| `GOOGLE_CALENDAR_WORK_END` | Scheduling (optional) | ✅ Set |
| `META_APP_SECRET` | Meta Leads | — |
| `LEAD_WEBHOOK_SECRET` | Generic webhook | ✅ Set |
| `LEAD_WEBHOOK_TENANT_ID` | Generic webhook | ✅ Set |
| `MONDAY_WEBHOOK_SECRET` | Monday webhook | — |
| `ADMIN_API_KEY` | **Operator console** — unset ⇒ all `/api/v1/admin/*` routes 503 (opt-in) | ✅ Set |
| `SENTRY_DSN` | Error monitoring | ✅ Set |
| `SENTRY_ENVIRONMENT` | Error monitoring | ✅ Set |
| `DASHBOARD_BASE_URL` | CRM sync — deep links back into the dashboard (optional) | — |
| `AI_MODEL` | LLM — default `gpt-5.4` | ✅ Set |
| `BASE_URL` | Callbacks | — |
| `CORS_ORIGINS` | Security | ✅ Set |
