# 2026-08-24 — multi-tenant readiness: what onboarding a tenant actually found

Goal for the session: infrastructure readiness for a second customer. Not the call — that is the
voice session's.

## The finding that framed everything

Production had three tenants and **no tenant had ever had a phone number and a calendar at the same
time**. ClickScales has telephony on the *platform's* calendar; `keren-gate-test` had its own OAuth
calendar and no phone. Each half had been proven separately, which is why everything looked green
and the configuration a real customer needs had never existed anywhere.

So I built one: `keren-gate-test` is now on a real plan, with its own calendar, its own agent
persona, and verified isolation. Three bugs surfaced doing it, each invisible from customer #1.

## Bugs found and fixed

| Commit | Bug | Why it was invisible |
|---|---|---|
| `7e72faf` | **A tenant's plan could never be changed.** `updateTenantSchema` had no `planCode`, `billingStatus` or `quotaEnforcement` — so no upgrade, no downgrade, no way off the internal tier, no way to mark an account `past_due`. Every price change meant SQL against production. | All three workspaces were on `internal`, where the missing capability costs nothing. |
| `03f8ec3` | **The operator console could set billing fields it could not show.** `tenantDetail` builds an explicit projection (right shape — it is why `api_key_hash` has never leaked) and the new columns were not added to it, so the PATCH saved and the GET returned `undefined`. The drawer rendered a blank plan for a tenant that had one. | Fails silently: an absent field, not an error. Found by driving a real change and reading it back. |
| `2a29a57` | **The entire settings API was mounted at the root.** `settings/index.ts` was wrapped in `fastify-plugin`; `fp()` discards the `{prefix}` it is registered with, so every settings route lived at `/agent-persona`, not `/api/v1/settings/agent-persona`. Settings was the only module wrapped this way. | See below — this one had an accomplice. |

### The 404 that wasn't

The SPA fallback answered **every** unmatched route with `200 text/html`, `/api/*` included. An API
client cannot tell that from success: `if (res.ok)` passes, `res.json()` throws on a `<`, and the
caller reports a parse error rather than a missing route — which sends whoever debugs it to the
client instead of the server.

That is what kept the misregistration alive. Every dashboard Settings pane in production has been
receiving `index.html` with a success status. There is a comment in `Settings.tsx` from an earlier
session concluding the Voice pane 404'd because it called `/settings/twilio` instead of
`/settings/zadarma`; the name was wrong, but **correcting it could not have worked either**, because
the whole module was somewhere else.

Anything under `/api/` or `/webhooks/` now gets a JSON 404. Browser routes still get `index.html`, so
React Router deep links keep working. Webhooks matter here too: a provider reading `200` believes the
delivery succeeded when nothing handled it.

## Verified working in production

- Plan assignment, read-back, and audit on change. A plan change **does not reprice the open period**
  (`usage_periods` snapshots at period open), so the response carries `openPeriodStillPricedAs` and
  the drawer shows it — the operator has usually just quoted the customer the new price.
- A tenant **cannot** change its own plan (`PATCH /tenants/me` → 400), read another tenant (403), or
  choose its own TTS voice (`.strict()` → 400: a bad voice id makes Cartesia return a *silent
  stream*, not an error).
- `keren-gate-test` books into **its own** calendar — `usesPlatformCredentials: false`, token still
  valid despite the 7-day expiry window.
- A tenant names its own agent, and the generated Hebrew greeting is correct including gender
  inflection: `שלום, מדברת מאיה, העוזרת הדיגיטלית של Acme Dental`.

## Shipped

- `docs/runbook-onboard-tenant.md` — onboarding, written by doing it, blockers first.
- `scripts/verify-tenant.mjs` / `npm run verify:tenant` — **read-only by design.** The obvious way to
  test the tenant-facing half is to rotate the tenant's key; that breaks every integration holding
  the old one. It takes an optional `--key` and reports those checks as SKIPPED rather than quietly
  passing. Negative-tested: exits 1 on a tenant still on `internal`.
- 894 tests (+25 today), typecheck and dashboard build clean.

## Open — needs Koren

1. **The SIP trunk only accepts ClickScales' number** (`Numbers: +972555070922, …`). Tenant #2's DID
   is rejected **at the trunk**, before routing runs. Phase 4 called for `numbers: []`; that makes the
   IP allowlist the only boundary on that trunk, which the plan accepted explicitly. **This is the
   hard blocker for inbound.**
2. **Outbound caller identity is global** — scoped in `docs/phase-4b-outbound-tenant-identity.md`,
   not built. Every tenant would dial from ClickScales' number.
3. **Nothing enforces quota or concurrency.** `quota_enforcement` is stored and unread;
   `plans.max_concurrent_calls` is a column nothing reads.
4. **The `default` tenant** is an empty leftover appearing in the console as a live workspace.
   Suspending it was blocked by the safety classifier — it needs a human: `PATCH
   /admin/tenants/<id> {"isActive": false}`. Confirmed empty and referenced by no env var.
5. A custom persona has still **never been heard on a live call**.

## Note for whoever picks this up

Work in `C:\keren-main` on `main`. `C:\AI Sales agent` is a second checkout ~92 commits behind on a
merged branch, holding only the `.env` files — reading it is how you conclude that `phone_numbers`
and the billing schema do not exist.

The Railway Postgres TCP proxy (`switchback.proxy.rlwy.net:14655`) was blocked outbound from the dev
machine today while HTTPS worked fine. Everything here went through the production API instead, which
is the better test anyway: it exercises the code an operator actually runs.
