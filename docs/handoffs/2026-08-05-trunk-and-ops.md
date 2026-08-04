# Handoff — 2026-08-05 — Trunk reconciliation + Phase 0 ops

Workstream: **production/multi-tenant readiness program** (new). Branch: **`main`**.

## TL;DR for the other sessions

**`main` now exists and contains your work.** `feature/crm-automation` and
`feature/website-clickscales-v2` were merged into a single trunk. Neither branch was rewritten
and neither was deleted — but new work should start from `main` from now on.

- Merge commit: `7dc8323`. Clean, zero conflicts (the branches shared merge-base `9ede542`, only
  4 files were touched on both sides, all auto-merged).
- Verified as a **superset**: 55 test files / 595 tests green, `tsc --noEmit` clean, and
  `git diff feature/website-clickscales-v2 main -- dashboard/ website/` is empty.
- `master` is archived as tag `archive/master-2026-07-10` and is **no longer the default branch**.
  It has not been deleted yet — see "Open" below.

## What shipped (commit `5514631`)

Four ways a deploy could lose data or serve broken traffic, plus the CI that stops them returning.

| Area | Before | Now |
|---|---|---|
| Migrations on deploy | **Never ran.** `db:migrate` is `tsx drizzle-kit migrate` — both devDependencies, stripped by `npm ci --omit=dev`. The CLI was not present in production | `src/db/migrate.ts`, the runtime migrator from drizzle-orm (a real dependency), advisory-locked against concurrent replicas, run before boot in the Dockerfile CMD |
| Migration 0006 | Orphaned — on disk, absent from `meta/_journal.json`, no snapshot. Unappliable, and the next `db:generate` would have re-emitted its column inside 0007 | Regenerated as `0006_volatile_microbe` with journal entry + snapshot, and made `IF NOT EXISTS` |
| Shutdown | No SIGTERM handler. Every `onClose` hook — 6 workers, 7 queues, PG pool, Redis, Sentry flush — was dead code in production | 20s drain on SIGTERM/SIGINT + `unhandledRejection`/`uncaughtException` capture |
| `/health` | `{status:'ok'}` unconditionally; never opened a socket | `src/plugins/health.ts` probes PG + Redis (2s timeout), 503 when either is down. `/health/live` split off so a DB outage can't trigger a restart loop. 9 tests |
| CI | None at all — no `.github/` | Typecheck, tests, dashboard build, **both** Docker images. Green on first run |

## The one finding that changed a decision

Probed the production database before enabling auto-migrations, and it was necessary:

```
drizzle.__drizzle_migrations -> 7 rows (last: 2026-08-02T15:12:24Z)
call_learnings.call_report present: true
```

0006 was **already applied by hand** while the file was orphaned. The regenerated file has new
content and therefore a new journal timestamp, so drizzle's migrator (which compares the last
applied `created_at` against each entry's `folderMillis`) **will re-run it** on the first
auto-migrating deploy. Without `IF NOT EXISTS` that deploy would have died on
`column "call_report" of relation "call_learnings" already exists` and the container would never
have booted. The idempotency is load-bearing, not defensive styling — do not "clean it up".

## Notes for the VOICE session

1. **You have uncommitted work in `C:/AI Sales agent`** (the `feature/website-clickscales-v2`
   checkout). It was deliberately left untouched per the territory rules. Two pieces matter:
   - `infra/livekit-sip/inbound-trunk.json` — the allowlist is already widened to six Zadarma
     CIDRs and the bare `972555070922` form added. **Live infra that git does not reflect.**
     Phase 4 of the readiness program rewrites this file (`"numbers": []` + a `phone_numbers`
     table for DID→tenant routing), so please commit it first.
   - `agent.config.ts` — the gpt-4o-mini A/B writeup (invented a lead's surname, mangled a phone
     number readback). Expensive tribal knowledge sitting uncommitted.
2. **`VOICE_STATE_MACHINE_ENABLED` defaults to `true`** (`src/config/env.ts:365`). Workstream C
   now sits on `main`, so the next `npm run agent:deploy` ships the state machine + reflexes live
   by default — ahead of the 4-behaviour real-call gate. That is a deliberate decision for Koren,
   not something to discover mid-call. Railway does **not** ship it: the agent runs from
   `Dockerfile.agent` on LiveKit Cloud, deployed separately.

## Open — needs Koren

1. **Point Railway at `main`.** Dashboard → service `AI-sales-agent` → Settings → Source →
   Branch. It still tracks `master`, so nothing pushed to `main` has deployed yet. The first
   deploy from `main` runs migrations automatically for the first time; verified safe above.
2. **Do not delete `master` until (1) is done** — Railway's source is still pointed at it.
   After the flip: `git push origin --delete master && git branch -D master` (safe, tagged).
3. **Secret rotation — flag F3**, raised 3× since 2026-07-29, still open.

## Next

Phase 1 — accounts (`users`, `tenant_members`, `auth_sessions`, `invites`, `auth_tokens`;
migration 0007) and `assertTenantUsable()` in `src/plugins/auth.ts`, which finally enforces
`isActive` on both the API-key and JWT paths. Today "suspend tenant" in the admin console writes
the flag and nothing reads it.

Full plan: `C:\Users\kasko\.claude\plans\i-i-want-you-sequential-pretzel.md`
