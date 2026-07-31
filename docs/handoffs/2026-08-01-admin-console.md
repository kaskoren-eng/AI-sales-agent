# Handoff — Operator console (multi-tenant admin) — 2026-08-01

Workstream: **DASHBOARD** (spans backend — new, unclaimed `src/modules/admin`). Branch: `feature/dashboard-v5-previews`.

## What shipped (MVP)

A super-admin console to manage + monitor all tenants. Commits: backend `82e95ff`, frontend `5c3fcc5`.

**Auth model:** shared secret `ADMIN_API_KEY` (env). Unset → every `/api/v1/admin/*` route 503s (opt-in).
Constant-time check, own scope in `server.ts` (NOT the per-tenant `authenticate` hook), IP rate-limited.
5-case guard unit test (`admin.guard.test.ts`).

**Backend — `src/modules/admin/`:**
- `GET /overview` — system KPIs (tenants active/suspended; totals leads/convos/messages/calls/meetings/voice-minutes; +24h deltas).
- `GET /tenants` — per-tenant rollup (counts + voice minutes + last activity).
- `GET /tenants/:id` — deep stats (leads by status, msgs in/out, calls by outcome, meetings upcoming).
- `POST /tenants` (create, returns key once) · `PATCH /tenants/:id` (rename / suspend via `isActive`) · `POST /tenants/:id/rotate-key`.
- All figures **measured, never estimated** — no fabricated $ cost; voice minutes = `sum(call_learnings.duration_secs)/60` as the billing basis.

**Frontend — `dashboard/src/pages/admin/**` at `/admin/*`:** own shell + sign-in gate (separate `keren.admin_key`),
Overview (KPIs + rollup), Tenants (list, create, detail drawer with usage + suspend/activate + rotate-key confirm/reveal).
English-only (internal tool); theme-aware. `App.tsx` split so tenant app and console never share a shell.

**Security fix (folded in):** the tenant routes had a cross-tenant IDOR — `GET /tenants` listed **all** tenants and
`/:id` / rotate-key acted on **any** tenant under normal tenant auth. Now: list returns self only, create is admin-only,
`/:id` is self-guarded (`id === request.tenantId`), and a real `PATCH /me` was added (the dashboard's self-update was
silently broken — it fell through to `/:id` with id="me"). Cross-tenant powers live ONLY in the admin console.

**No schema change** (reuses `tenants.isActive`). New env `ADMIN_API_KEY` in `.env.example` + `CLAUDE.md`. Migration
counter untouched (next free still 0006).

## To run it
Set `ADMIN_API_KEY=<long random>` in `.env`, restart the API, open `/admin`, sign in with that key.

## ⚠️ For Koren / VOICE session
While committing I found **uncommitted changes I did not make** in VOICE territory —
`src/modules/channels/voice-livekit/agent.config.ts` (+24) and `.../testing/latency-bench.ts` (+6). Per the territory
rules I did **not** commit or revert them; they briefly landed in a commit by accident and were removed (un-committed,
their working-tree changes preserved). They remain uncommitted for the voice session to handle.

## Not in this cut (deferred, per scope decision)
- **Ops & health** pillar (BullMQ queue depths + DLQ, worker/breaker states) — chosen out of the first cut.
- Real admin accounts + login (we chose the shared-secret model); audit log of operator actions.
- Admin i18n (English-only by design for now).
