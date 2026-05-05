# AI Sales Agent

Multi-channel AI sales agent (WhatsApp, Email, Voice) that qualifies leads and books calls via Google Calendar (or Trafft).

## Stack

TypeScript + Fastify 5 + Drizzle ORM + PostgreSQL + Redis + BullMQ + Zod + OpenAI gpt-5.4

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
- **Circuit breakers:** UChat, ElevenLabs, Monday, Google Calendar, Trafft each have their own breaker (5 failures → 30s cooldown)

## DB Schema (7 tables)

`tenants`, `leads`, `conversations`, `messages`, `scheduled_calls`, `import_jobs`, `call_learnings`

- `call_learnings` — stores Twilio conference recordings, Whisper transcripts, GPT sales analysis, outcome labels (`won`/`lost`/`neutral`)

## Workers (5)

- `message-processor` — routes inbound messages, runs `qualifyLead()` after each exchange
- `outbound-sender` — sends WhatsApp / Email outbound messages
- `flow-executor` — runs multi-step automation flows with delays
- `csv-import` — bulk lead creation from uploaded CSVs
- `call-analysis` — downloads Twilio recording → Whisper transcription → GPT sales analysis → injects learnings into future ElevenLabs agent prompts

## Modules

- `leads` — CRUD, status workflow, score, manual flow trigger
- `channels/whatsapp` — UChat inbound/outbound, signature verification, 24h window fallback
- `channels/email` — Resend inbound/outbound, svix signature verification
- `channels/voice` — Twilio + ElevenLabs, inbound registration, outbound call initiation, learnings injection
- `scheduling` — Google Calendar (default provider), Trafft provider also available; slots query, booking, cancel
- `integrations` — Monday.com (sync/push/webhook), CSV import, Google Sheets, Nango CRM
- `webhooks` — Meta Lead Ads, generic lead intake
- `tenants` — create/read/update, API key generation, flow config storage
- `calls` — list/detail/audio proxy for ElevenLabs conversations
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
