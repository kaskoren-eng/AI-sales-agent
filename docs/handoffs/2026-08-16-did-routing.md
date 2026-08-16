# 2026-08-16 — Phase 4 (part 1): inbound DID routing

Workstream: VOICE. Branch: `main`.

## 🔴 BLOCKING PRE-DEPLOY STEP — read this before `npm run agent:deploy`

**Provision ClickScales' live number BEFORE deploying the agent, or production inbound breaks.**

Until now every inbound call resolved to `VOICE_WEBHOOK_TENANT_ID`. After this change a call is
routed by the number that was dialled, and a number with no `phone_numbers` row is **refused** —
the caller hears "not in service" and hangs up. That is the correct new behaviour and it is exactly
what would happen to `+972555070922` on the first call after deploy.

```bash
node scripts/provision-number.mjs --number +972555070922 --tenant 613d826c-... --label "ClickScales main"
node scripts/provision-number.mjs --list     # confirm before deploying
```

Run the migration first (`npm run db:migrate` — 0011 creates the table). Then provision. Then
deploy. Getting the order wrong costs a live customer's inbound line.

I deliberately did **not** add an "if the table is empty, fall back to env" safety net. It would
have made this step optional, and it would also mean that a truncated or mis-migrated
`phone_numbers` silently resumes routing every customer's calls to one tenant — which is the leak
this whole phase closes. The refusal is loud, logs the number, and logs the exact command to fix it.

## What shipped

- **Migration 0011 — `phone_numbers`**: `e164` unique, `tenant_id` **nullable** (null = bought but
  unassigned, a real state), `is_active` for parking a number between customers.
- **`resolveCallIdentity()`** in `tools/tool-context.ts`, returning a tagged `source`:
  `outbound_metadata` → `did_lookup` → `env_fallback`, in that priority.
- **`shared/phone-number.ts`** — `toE164()` and `didCandidates()`.
- **Refusal path in `agent.ts`**: an unattributable call plays a short announcement and disconnects,
  creating no lead, no conversation, no call record.
- **`scripts/provision-number.mjs`** (`npm run provision:number`) — assign / unassign / deactivate /
  list.
- **`scripts/generate-system-announcements.mjs`** — generalised from the recording-notice generator;
  now also produces `assets/not-in-service.wav`.
- **`infra/livekit-sip/inbound-trunk.json`** — `"numbers": []`.
- 19 new tests (758 total).

## Decisions worth knowing

- **`env_fallback` now fires ONLY when no number was dialled at all** — console sessions and the
  browser Simulator, which have no DID by definition. A call that dialled a number we cannot map
  never reaches it. That single rule is the phase.
- **Exact matching, not suffix matching.** `tools/lead-store.ts` matches leads on their last 9
  digits, which is right there — the question is "same person?" and a false match merges a contact.
  Routing is a different question with a different blast radius: a 9-digit suffix collision across
  countries would hand tenant A's caller to tenant B. Exact match over candidate spellings
  (`+972…` and `972…`, since Zadarma sends both), and fail closed.
- **The trunk change makes the IP allowlist the only boundary.** `"numbers": []` means the trunk
  accepts any dialled number from Zadarma's ranges. Documented in `infra/livekit-sip/README.md`;
  the app-side refusal is the second line of defence.
- **The announcement is best-effort, the refusal is not.** If `assets/not-in-service.wav` is missing
  the player logs and returns null and we still disconnect. Security behaviour must not depend on a
  file being present.
- **The lookup is an injected function, not a `Database`.** My first test tried to recover the
  queried candidates by walking drizzle's `inArray` fragment; that object is circular and internal,
  so the test was asserting on drizzle's shape and failed for reasons unrelated to routing. It is
  now a seam like `loadSettings`, and the test asserts on the candidates the routing code actually
  asked for.

## Also fixed on the way

`buildToolRuntime` opened a second connection pool per call once identity resolution needed a DB —
and only one of them was ever closed. Caught before commit; it now reuses the pool it opened, and a
test asserts the pool is closed even when the call is refused (a scanner sweeping DID ranges would
otherwise exhaust it).

## Still open in Phase 4

- **Per-tenant Google Calendar OAuth** — not started. Every tenant still books into ClickScales'
  calendar (`tool-context.ts` builds the provider from global `GOOGLE_CALENDAR_*` env).
- **The two process-wide statics** — `GoogleCalendarProvider.attendeeInvitesBlocked` (one
  service-account tenant's 403 permanently disables attendee invites for every tenant in the
  process) and the module-level `gcalCircuit` (one tenant's broken calendar opens the breaker for
  everyone). Cheap now, incidents later.
- **`assets/not-in-service.wav` has not been generated** — needs `CARTESIA_API_KEY`, which is not in
  this checkout. Run `npm run announcements:generate not-in-service`. Until then a refused call
  disconnects silently, which is correct but abrupt.
- **No real inbound call has been made against this.** The Phase 4 gate is: a mapped DID lands in
  the right tenant, an unmapped DID plays the notice and creates no data.
