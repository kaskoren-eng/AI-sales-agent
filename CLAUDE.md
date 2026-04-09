# AI Sales Agent

Multi-channel AI sales agent (WhatsApp, Email, Voice) that qualifies leads and books calls via Trafft.

## Stack

TypeScript + Fastify 5 + Drizzle ORM + PostgreSQL + Redis + BullMQ + Zod

## Commands

- `npm run dev` — start dev server (tsx watch)
- `npm run build` — typecheck + compile
- `npm test` — vitest
- `npx drizzle-kit generate` — generate migration from schema changes
- `npx drizzle-kit migrate` — apply migrations
- `docker compose up -d` — start Postgres + Redis

## Architecture

- **App factory pattern:** `buildApp()` in `src/server.ts` — all tests should use this
- **Webhooks** at `/webhooks/*` — authenticated by per-channel signature verification, NOT API auth
- **API** at `/api/v1/*` — dual auth (API key OR JWT)
- **Queue-based processing:** webhook → BullMQ → worker → outbound queue
- **ai-engine** is a service module (no routes) — consumed by channel workers and lead qualification
- All DB tables have `tenant_id` — always filter by it, never skip tenant isolation

## Conventions

- All imports use `.js` extensions (Node16 module resolution)
- Plugins use `fastify-plugin` (fp) wrapper
- Env vars validated with Zod at boot (`src/config/env.ts`) — add new vars there + `.env.example`
- Errors use `AppError` subclasses from `src/shared/errors.ts`
- Schema changes go in `src/db/schema/` then run `drizzle-kit generate`

## Security rules

- Tenant secrets encrypted AES-256-GCM — use `src/shared/crypto.ts`
- API keys stored as SHA-256 hashes, never plaintext
- Never log PII or credentials
- Webhook endpoints verify signatures before processing
