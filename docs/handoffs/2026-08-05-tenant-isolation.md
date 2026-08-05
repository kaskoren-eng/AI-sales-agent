# Handoff — 2026-08-05 — Phase 2: tenant isolation hardening

Session: production/multi-tenant readiness (the `main` trunk). Continues the phased program from
`docs/handoffs/2026-08-05-trunk-and-ops.md`.

**Phase 2 is complete and deployed.** All work is on `main`, CI green, 712 tests passing.
Production is running `228d051` — `/health` now reports the commit, so this is checkable rather
than assumed.

---

## ⚠️ Read this first if you are the VOICE session

**1. `checkDailySpendLimit` was split in two.** It both read the caps and incremented the dial
counter, and it was called twice per outbound call (flow executor + dial service), so every call
counted as two and `dailyCallLimit: 100` actually blocked at ~50.

It is now `evaluateSpend()` (read-only) + `countDialAttempt()` (the side effect, called once by
whoever dials). **The old name still exists as a deprecated shim** that does evaluate-then-count,
specifically so `feature/crm-automation` still compiles and behaves correctly after merge — your
remaining call site is a dialer, which is exactly the case the shim handles. Please switch it to
the explicit pair when you next touch that file, and do not add new callers of the old name: using
it from a second place re-creates the double-count.

**2. This session edited three files in your territory.** Flagged rather than hidden:

- `src/modules/calls/spend-guard.ts` — the Phase 2.4 fix itself
- `src/modules/channels/voice/voice.service.ts` — one call site (your branch deletes this file
  entirely; resolve the modify/delete conflict by accepting your delete)
- `src/modules/channels/voice-livekit/voice-livekit.service.ts` — one call site, ~4 lines

The spend-guard fix cannot be made without touching its call sites. Koren approved the phased plan
containing this work, but it is your lane and you should know.

**3. Five writes in your files have no tenant predicate.** None is a live leak — all update by
UUID primary key from a tenant-scoped read — but the Monday webhook had exactly that shape and
became an unauthenticated cross-tenant write when the id started arriving in a request body. They
are listed with reasons in `src/db/tenant-predicate.test.ts` (`ACKNOWLEDGED`) and were left alone
because they are yours:

- `modules/calls/monitor-call.service.ts`
- `modules/channels/voice/voice.routes.ts` (×2)
- `modules/channels/voice-livekit/stt/shadow-stt.ts`
- `queues/workers/call-analysis.worker.ts`

Worth adding `eq(table.tenantId, tenantId)` next time you are in each.

---

## ⚠️ Action required from Koren

**Re-point the Monday webhook.** The old unsigned URL now returns 410. Paste this into the board's
integration settings:

```
https://ai-sales-agent-production-9736.up.railway.app/webhooks/leads/monday/613d826c-ad00-4302-9817-1c0649ed4f98.4d99184ee2e40b5acccb91ea12c5fbc4
```

Treat it as a credential — anyone holding it can post events into the ClickScales tenant. It is
derived from `ENCRYPTION_KEY`, so **the scheduled pre-launch secret rotation will change it** and
the vendor will need updating again. Regenerate with `node scripts/webhook-url.mjs clickscales`
(see the script header for the production invocation).

---

## What shipped

| Commit | What |
|---|---|
| `85a4ee3` | password-reset emails were created and never sent |
| `9098b86` | settings: allowlisted writes, redacted reads, merge semantics |
| `610ca4a` | Monday webhook was an unauthenticated cross-tenant write |
| `87b19bc` | a tenant without Airtable was writing into ClickScales' base |
| `eb21d26` | spend guard: the call cap fired at half its configured value |
| `f229211` | audit_events, call_learnings FK + index, tenant-predicate lint |
| `228d051` | migration 0010 was silently skipped — poisoned journal watermark |

### The three that mattered most

**The Monday webhook was an unauthenticated cross-tenant write, live on the internet.** It read
`boardId` from the request BODY and scanned every tenant for a match — so the caller chose the
tenant — and signature verification was gated on `MONDAY_WEBHOOK_SECRET`, which was never set in
production. Verified reachable with an anonymous curl, and non-theoretical: ClickScales has board
`8854910976` configured with a lead carrying a `mondayItemId`. The tenant now comes from a signed
URL; the lead lookup is indexed and tenant-scoped; the update carries the predicate.

**The spend guard's call cap fired at half its configured value**, and a live Redis masked a dead
Postgres so the "brake is broken" alert could never fire for the dollar cap. Both fixed; the caps
now have independent health tracking and the alert names which one died.

**Migration 0010 was silently skipped.** Drizzle stores a single watermark — the `when` of the last
applied migration — and applies only entries greater than it. A hand-written 0009 entry carried an
invented timestamp ~1.2h in the future, which poisoned the watermark, so the next generated
migration was skipped while the migrator logged success. Caught by querying production rather than
trusting the log line. Four journal invariants now guard it, including "no `when` in the future" —
the one that actually catches it, since a single future timestamp looks perfectly monotonic until
the next migration is generated.

### Also

- `PATCH /tenants/me/settings/:namespace` replaces the blanket settings blob. Closed by default:
  an unclassified section is refused, so forgetting to classify one fails as "this won't save"
  rather than "tenants can edit their own spend cap".
- Settings reads are redacted by pattern (word-based, so `apiToken` redacts and `tokenizerModel`
  does not) at any depth, on the tenant AND operator paths.
- The dashboard's "Flow Configuration" pane was editing the entire settings document — it loaded
  every tenant credential into a visible textarea and PATCHed it all back. Now scoped to `flows`.
- `audit_events` exists and is written on suspend/activate, key rotation, and refused settings
  writes. `recordAudit` never throws.
- `/health` reports the running commit, branch and start time.

### New env vars (both set in Railway)

- `DASHBOARD_BASE_URL` — was missing, which is why password resets silently sent nothing
- `PLATFORM_TENANT_ID` — ClickScales' own tenant; gates the global integration credentials

---

## Open / next

- **Phase 3 — per-tenant voice identity.** `GREETING_HE` is a const saying "מדברת קרן
  מ-ClickScales" and the prompt carries a hardcoded founder FAQ. This is VOICE territory and needs
  coordination before anyone starts.
- **Phase 4 — DID routing + per-tenant Google Calendar.** Every tenant currently books into
  ClickScales' calendar via the global `GOOGLE_CALENDAR_*` env — the same pattern as the Airtable
  leak fixed here, and it should get the same `PLATFORM_TENANT_ID` gate.
- **Secret rotation** stays deferred to just before launch, by Koren's decision. Note
  `ENCRYPTION_KEY` cannot be rotated naively: it seals `monday.encryptedApiToken`, and
  `settings.service.ts:222` swallows decrypt failures and returns null, so breakage would be
  silent. The keyed-ciphertext change (`v1.iv:tag:ct`) has to land first. Rotation also changes
  every signed webhook URL.
