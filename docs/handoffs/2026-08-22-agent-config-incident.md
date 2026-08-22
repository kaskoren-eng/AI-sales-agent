# 2026-08-22 — the voice agent had no database (and four other fixes)

## The incident

**The LiveKit Cloud agent was created with a laptop config and ran that way for six days.**

`lk agent create` was run with `--secrets-file .env.agent`, and that file holds
`DATABASE_URL=localhost:5432` and `REDIS_URL=redis:6379`. Inside a cloud container `localhost` is
the container and `redis` resolves to nothing, so the agent had no database and no Redis.

It never crashed. Every DB read failed, the tool gate failed **closed** exactly as designed, and
calls ran with no tools, wrote no `call_learnings` row and metered nothing. After DID routing
shipped on 16 August it got stricter: a call that cannot be attributed to a tenant is refused, so
inbound callers got the not-in-service announcement. From the outside the system looked configured
to behave that way.

`--ignore-empty-secrets` was the second half of the trap: `PLATFORM_TENANT_ID` and
`VOICE_WEBHOOK_TENANT_ID` were empty in that file and were dropped silently, so even a working
database would have left ClickScales' agent with no calendar.

**Evidence:** last `call_learnings` row is 2026-08-05. A real inbound call today produced no lead,
no conversation, no message, no call record and no usage event, while `voice_engine=livekit`,
`functions_enabled=true`, `is_active=true` and the DID was mapped an hour beforehand.

**Fixed:** `node scripts/fix-agent-secrets.mjs` ran at ~19:30 and reported "Updated agent secrets".
The agent restarted with Railway's PUBLIC endpoints. **Not yet verified by a call** — see below.

## ⏳ The one thing outstanding

**Call +972555070922 and report what you hear.**

- Keren greeting you → the fix worked. Then ask her to book a meeting: that exercises the tools
  (dead since 16 August) and writes the first `call_learnings` row plus the first real
  `usage_events` row, which also gives Phase 5a metering its first production test.
- "Not in service" → the database is still unreachable and I need another angle.

Note the greeting changed on 17 August and has never been heard on a live call. It should now
name Keren as the digital assistant — the AI disclosure that was missing on 10 of 10 earlier
calls. Listen before trusting it to real leads.

## Shipped today

| Commit | What |
|---|---|
| `db2f92e` | Tenant switcher was `const otherTenants: never[] = []` — dead code behind an impossible condition. Wired to `/auth/me`. |
| `351359f` | REST scheduling booked every tenant into ClickScales' calendar. `resolveCalendarAuth` moved out of the agent's tool-context so both paths share one rule. |
| `08f0091` | `scheduled_calls.lead_id` was NOT NULL in the database and nullable in the schema. Migration 0014. `/book` now rolls back the calendar event if the row write fails. |
| `77fd9f5` | Full schema-vs-migrations audit: one drift left (`provider` default), fixed by 0015. `npm run db:drift` added. |
| `8dce39b` | `apiClient` sent `Content-Type: application/json` with no body, so six buttons silently did nothing. |
| `df61084` | The agent-config guardrails below. |

### Guardrails added

- **`scripts/fix-agent-secrets.mjs`** — repairs deployed agent secrets from Railway's public
  endpoints. No secret printed or pasted; temp file is 0600 and deleted in a `finally`.
  `--dry-run` shows host:port only.
- **`deploy-agent.mjs` refuses a laptop config** — rejects URLs pointing at localhost / 127.0.0.1 /
  redis / postgres / host.docker.internal, and rejects empty required keys. Verified against the
  file that caused this (rejected, all three problems named) and a cloud config (accepted).
- **`did_lookup_failed` is now its own refusal**, separate from `unmapped_did`. A throw from the
  `phone_numbers` query used to be reported as "this number is not mapped" — the opposite
  diagnosis. `new Pool()` does not connect eagerly, so a wrong host builds a healthy-looking pool
  that fails on the first query of the first call. The caller still hears the same announcement and
  a failed lookup still never falls back to the env tenant.
- **`npm run db:drift`** — replays every migration into a throwaway Postgres and diffs against the
  schema. Neither the tests nor `db:generate` can catch drift: tests build tables from the schema,
  and snapshots are generated from it, so both agree with it by construction.

## Verified working

- **Phase 4 calendar gate is closed.** A booking through `keren-gate-test`'s OAuth credentials
  landed in its own calendar, with `inviteSent: true` and a Meet link. Granted scope includes
  `calendar.events`, so nothing was trimmed on the consent screen.
- Google verification **submitted and under review** (branding done, both scope justifications and
  the demo video accepted by the form).
- `phone_numbers` has `+972555070922` → ClickScales, active, provisioned 10:50 UTC.
- All three tenants on `plan_code='internal'`, `billing_status='active'`, enforcement off.
- Production API config audited: 62 variables, no local hosts. The misconfiguration was isolated
  to the agent.

## Open

- **DID routing unverified** — the mapped-number call is the test above. The unmapped case still
  needs one more call after I temporarily unassign the row.
- **Metering has never run in production.** `usage_events` is empty, correctly: the newest lead is
  from 26 July and the newest call from 5 August. Its first real test is the call above.
- **The agent has no persistent logs and no Sentry.** `lk agent logs` only tails a live agent, and
  it sleeps between calls, so today's call logs were unrecoverable. That is the single biggest
  reason this took as long as it did. Phase 8 item; consider promoting it.
- **Google app is still External + Testing** until review completes, so refresh tokens expire after
  7 days. The `keren-gate-test` connection was disconnected during filming and never reconnected.
- `auth_tokens.created_at` is `timestamp` while its siblings are `timestamptz` — display shifts by
  the client's offset. One-line migration, not urgent.
- Koren's calendar has "AI Sales agent Dem" blocks 09:00–15:00+ Sun–Fri. If that is the calendar
  the agent reads for availability, most of the bookable day is invisible. Check before go-live.

## Note for the voice session

`tool-context.ts` is your file. Two changes: `resolveCalendarAuth` moved to
`integrations/google-calendar/resolve-calendar-auth.ts` and is re-exported unchanged, and the DID
lookup now distinguishes a thrown query from an unmapped number. `calendar-isolation.test.ts` and
`tool-context.test.ts` pass unmodified; 858 tests green.
