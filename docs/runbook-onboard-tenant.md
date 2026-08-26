# Runbook — onboarding a new tenant

Written by doing it. Every step below was exercised against production on 2026-08-24 except the two
marked ⛔, which are blocked on things that do not exist yet.

**Read the blockers first.** Two of them mean a tenant onboarded today would greet its leads as
ClickScales and dial out from ClickScales' number. They are not edge cases.

---

## Blockers — resolve before a paying customer

| # | Blocker | Consequence if ignored |
|---|---|---|
| 1 | ~~The SIP trunk only accepts ClickScales' number.~~ **Resolved 2026-08-26.** `provision-number.mjs` now syncs the trunk list from `phone_numbers` on every write, and `verify-tenant.mjs` fails if the two disagree. The list is kept on purpose — see the note below the table. | — |
| 2 | **Outbound caller identity is global.** One `LIVEKIT_SIP_OUTBOUND_TRUNK_ID`, no per-tenant from-number. See [phase-4b-outbound-tenant-identity.md](phase-4b-outbound-tenant-identity.md). | Tenant #2's leads see ClickScales' number and reach ClickScales' agent when they call back. |
| 3 | **A custom persona has never been heard on a live call.** The mechanism is built and tenant-editable (`PUT /settings/agent-persona`); ClickScales deliberately runs `DEFAULT_PERSONA`, so the custom branch has only ever been exercised by tests. | If it misbehaves, a tenant's leads are greeted as "קרן from ClickScales" — including a founder FAQ naming Koren. Set it, then hear it. |
| 4 | **Nothing enforces quota or concurrency.** `quota_enforcement` is stored and unread; `plans.max_concurrent_calls` is a column nothing reads. | A tenant can run past their plan on your vendor bill with no ceiling. |
| 5 | **Google app verification is pending.** Until it completes, OAuth refresh tokens expire after 7 days. | The tenant's calendar silently disconnects a week after onboarding. |

**Do not empty the trunk's `numbers` list**, despite what `infra/livekit-sip/README.md` still
recommends. Its reasoning — onboarding a number should be a database step, not a deploy step — is
right, and the sync script satisfies it without giving up the boundary. An empty list means every
INVITE from the allow-listed ranges reaches the agent, costing a room and a process each; with one
agent replica a flood starves real callers before it costs real money. See the header of
`scripts/lib/trunk-numbers.mjs`.

The IP allowlist stays the primary boundary either way. Do not widen it, and never remove entries
"to debug" — an unrestricted inbound trunk is a SIP endpoint anyone on the internet can dial.

---

## Prerequisites

- `ADMIN_API_KEY` — never paste it into a shell. Run scripts through `railway run --service
  AI-sales-agent`, which injects it into the process without it appearing on screen or in history.
- A DID purchased in Zadarma for this customer.
- The customer has a Google account for the calendar the agent will book into.

> **Direct Postgres access is not required for any step here**, and on some networks the Railway TCP
> proxy (`switchback.proxy.rlwy.net:14655`) is blocked outbound while HTTPS works fine. Everything
> below goes through the API, which is the better test anyway: it exercises the code a real operator
> path runs, not the raw tables underneath it.

---

## Steps

### 1. Create the workspace, with a plan

```bash
curl -sX POST https://ai-sales-agent-production-9736.up.railway.app/api/v1/admin/tenants \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"Acme Dental","slug":"acme-dental","planCode":"base"}'
```

Plans today: `base` (₪1,490 / 150 leads) · `growth` (₪2,490 / 400) · `custom` (₪4,000 / unlimited) ·
`internal` (₪0, not sellable — our own workspaces).

**The plan is mandatory and cannot be usefully deferred.** `usage_periods` snapshots plan values when
the period opens, so a workspace created without one bills as free and unlimited for its entire first
month, and assigning the real plan later does not fix the month you most want to bill for.

**The API key in the response is shown once.** Store it in the customer's password manager entry now.
If it is lost, `POST /admin/tenants/:id/rotate-key` issues a new one and invalidates the old.

### 2. Set the billing posture

```bash
curl -sX PATCH .../admin/tenants/<id> -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"billingStatus":"trialing","quotaEnforcement":"soft"}'
```

`billingStatus`: `trialing` | `active` | `past_due` | `suspended`.
`quotaEnforcement`: `off` | `soft` | `hard` — **stored but not yet enforced** (blocker 4).

Changing `planCode` later works and is audited, but **does not reprice the open billing period** — the
response returns `openPeriodStillPricedAs` when that matters. Quote the customer accordingly.

### 3. Assign the phone number

```bash
node scripts/provision-number.mjs --number +972XXXXXXXXX --tenant <id> --label "Acme main"
node scripts/provision-number.mjs --list         # numbers, owners, and trunk drift
node scripts/provision-number.mjs --sync-trunk   # repair drift, touching no rows
```

This writes the `phone_numbers` row **and** puts the number on the LiveKit inbound trunk, in both
the `+972…` and `972…` spellings, because Zadarma is inconsistent about the leading `+`. Then point
the number's forwarding at the SIP URI in the Zadarma portal.

If the row is written but the trunk update fails, the script says so loudly and exits non-zero. That
state — the number routes in our code but is refused at the SIP layer — produces **no log line
anywhere** and reads to the customer as "your agent never answers". Re-run `--sync-trunk` until
clean.

> **⚠️ This script needs a direct Postgres connection**, unlike every other step here. The Railway
> TCP proxy (`switchback.proxy.rlwy.net:14655`) is blocked outbound on some networks — it was on the
> dev machine on 2026-08-26 while HTTPS worked fine. If it hangs, run it from a network that allows
> that port rather than assuming the database is down.

An unassigned or inactive number answers "not in service" and creates no data — deliberately. A call
that cannot be attributed to a tenant is never allowed to fall through to the platform tenant.

### 4. The customer connects their own calendar

They log into the dashboard → **Integrations → Google Calendar → Connect**, and grant consent on
their own Google account. Verify:

```bash
curl -s .../integrations/google-calendar/status -H "Authorization: Bearer <TENANT_KEY>"
# {"connected":true,"accountEmail":"…","usesPlatformCredentials":false,"needsReconnect":false}
```

**`usesPlatformCredentials` must be `false`.** `true` means this tenant is booking into ClickScales'
calendar — only correct for `PLATFORM_TENANT_ID`.

### 5. Turn the agent on for this tenant

Operator-only settings, so they go through the admin PATCH (namespace-merged, not overwritten):

```bash
curl -sX PATCH .../admin/tenants/<id> -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"settings":{"voice_engine":"livekit","functions_enabled":true}}'
```

`functions_enabled` is a strict `=== true` with no default and no env fallback — the tools write to
the customer's calendar and tables, so its absence means no.

### 6. Name the agent

**Mandatory.** Without it the tenant inherits `DEFAULT_PERSONA` — ClickScales' own script, including
a founder FAQ naming Koren.

The tenant sets the content half themselves, through a typed route:

```bash
curl -sX PUT .../settings/agent-persona \
  -H "Authorization: Bearer <TENANT_KEY>" \
  -H 'Content-Type: application/json' \
  -d '{"agentName":"מאיה","agentGender":"female","companyName":"Acme Dental","companyDescription":"מרפאת שיניים בתל אביב","handoffPerson":"דנה"}'
```

`agentName`, `agentGender` and `companyName` are required and non-empty. `agentGender` drives Hebrew
first-person inflection in both the prompt and the greeting verb from one field. Leave `greeting`
empty unless the customer wants specific words — empty means "generate it from name + company +
gender", which stays correct when those change.

**The TTS voice is deliberately NOT settable here.** The schema is `.strict()` and has no `tts`
field, because a bad voice id makes Cartesia and ElevenLabs return a *silent stream* rather than an
error — the first anyone would know is a lead listening to nothing. Voice selection is operator-only,
through the settings escape hatch on `PATCH /admin/tenants/:id`.

⛔ Then **hear it on a real call** before handing over (blocker 3).

### 7. Verify before handing over

```bash
railway run --service AI-sales-agent node scripts/verify-tenant.mjs <slug>
```

Checks plan, billing posture, calendar ownership, tenant isolation, and that the tenant cannot change
its own plan. What it cannot check is a real call — that needs the phone.

---

## What "done" looks like

| Check | How |
|---|---|
| Plan assigned and readable | `GET /admin/tenants/:id` → `planCode` is not `internal`/null |
| Their calendar, not ours | `usesPlatformCredentials: false` |
| Isolation holds | Their key reading another tenant by id → 403 |
| They cannot self-upgrade | `PATCH /tenants/me` with `planCode` → 400 |
| Inbound routes to them | A real call; agent logs `call_identity` with `source: "did_lookup"` and their tenant id |
| Metering runs | One lead and one call produce exactly one `usage_events` row each |

The agent sleeps between calls and has no persistent logs, so **`lk agent logs` must be running
before you dial** to catch `call_identity`. That single line is the difference between "routing
worked" and "it fell back to the platform tenant", and last time not having it cost six days.

---

## Housekeeping

- The `default` tenant is an empty leftover from before accounts existed — no numbers, no calendar,
  no data. Suspend it so it stops appearing in the operator console as a live workspace.
- Two checkouts of this repo exist on the dev machine. `C:\keren-main` is `main` and current;
  `C:\AI Sales agent` sits on a merged branch ~92 commits behind and holds only the `.env` files.
  Reading the stale one is how you conclude that `phone_numbers` and the billing schema do not exist.
