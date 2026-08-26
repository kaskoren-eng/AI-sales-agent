# 2026-08-26 — DASHBOARD — Voice Ops, minutes billing, and the cost that was 6.5× wrong

Six PRs merged to `main`, all deployed to Railway. Latest production commit `4ba9dd5`.

| PR | What |
|---|---|
| #1 | Voice Ops supervision page + `GET /api/v1/metrics/voice` |
| #2 | Handoff doc |
| #3 | Stop serving our provider cost to tenants |
| #4 | Minutes become the billable unit (migration 0016) |
| #5 | Admin: minutes bundle + per-tenant cost |
| #6 | Price the whole call + cost rubrics in admin |

## The headline: voice minutes cost ~₪0.29, not ~₪0.045

Every LLM, STT and TTS figure in the ledger was **₪0.00**; only the platform/SIP leg was priced, so
a call cost its SIP minutes and nothing else. Real split for a 472s call:
**TTS ₪1.22 · LLM ₪0.84 · platform ₪0.35 · STT ₪0.07** — speech synthesis is the largest line, not
the LLM.

The cause is the failure `pricing.ts` predicted in its own header: the SDK moved from flat
`UsageSummary` fields to `modelUsage[]`, and `readUsageSummary` read only the old shape. It degraded
to zeros rather than throwing — as designed — so nothing broke and nothing surfaced it. The mirrored
pricer in `scripts/reconcile-usage.mjs` had the identical bug. Both fixed, with tests built from a
real production payload.

**Rule of thumb this leaves behind:** a cost component at *exactly* zero while others move is a
parsing failure, not a free provider. The admin panel now says so on screen.

⚠️ Even ₪0.29 is likely low: the rate card is list prices, and its GPT output rate ($10/M) is below
the published $15/M. Reconciling against a real invoice is still the open Phase 6 gate.

## Billing now meters minutes, not leads

`plans.includedMinutes` / `overagePerMinuteAgorot`, `usage_periods.secondsUsed`, and `meterCall`
records the call's **seconds** as `billableUnits` (was 0 — "calls are a COST signal, never an
invoice line"). Seconds rather than minutes so rounding happens once per period; rounding per call
inflates a busy month by roughly the number of calls in it.

🔴 **`billable_units` now means leads on one row and seconds on another.** Every sum must
`FILTER (WHERE kind = ...)`. An unfiltered sum inflates `leads_used` by call seconds, and then the
reconcile drift check "fixes" the honest counter to the wrong value. Fixed in `usage.service.ts`
and in the hand-mirrored SQL in `reconcile-usage.mjs` — those two must always move together.

Additive: lead columns stay, because every existing `usage_periods` row froze its plan into them.
Nothing enforced `includedLeads` anyway.

## Cost is operator-only now

Removed from the tenant **endpoint**, not just the UI — the JSON was serving `perMinuteRateUsd` and
`estimatedUsd` to anyone holding a tenant API key. A test asserts the response carries no cost
field. It lives at `/admin/tenants` → tenant → **This billing period**, with the rubrics.

## Open, needing Koren

1. **Bundle sizes are provisional and unsigned**: base 300 min @ ₪3/extra, growth 750 @ ₪2.50,
   derived from `docs/gtm/pricing-model.md`'s own arithmetic. Inert — all three prod tenants are on
   the unmetered `internal` plan.
2. **`--reprice` not applied.** `node scripts/reconcile-usage.mjs --reprice --apply` would correct
   4 mispriced events (+₪3.58) and backfill **~26 early-August calls that were never metered at
   all**. Dry-run by default by design.
3. **Nothing enforces any quota.** `quotaEnforcement` is stored, audited and rendered — and read by
   no code. A minutes cap today is a number on a screen, not a limit that stops a call.
4. **No design preview** was approved for the Voice Ops page; latency budgets (1000ms worst case,
   split 500/300/200) are a proposal, not a decision.

## Smaller findings, not acted on

- **Duplicate voice conversations**: written in pairs a second apart with different `channel_ref`
  (48 conversations against 29 calls), so the Calls list likely shows some calls twice. Several
  also stay `active` long after the call ended. VOICE territory — untouched.
- **CSP blocks the inline theme script** in `index.html`, so dark-mode users get a white flash on
  load. Pre-existing, cosmetic; needs a hash or nonce in the CSP header.
- **`call_learnings.created_at` is `timestamp` without time zone**, unlike `scheduled_calls`. It
  round-trips correctly only because Railway's Postgres and container both run UTC; read from a
  non-UTC client every timestamp shifts. Cast `::text` when the exact instant matters.
- **Tenant confusion is the top support answer**: Koren owns `clickscales` and `keren-gate-test`,
  the session binds a tenant, and signing in lands on whichever was last used. An empty-looking
  dashboard is almost always the wrong workspace, not a broken one.
