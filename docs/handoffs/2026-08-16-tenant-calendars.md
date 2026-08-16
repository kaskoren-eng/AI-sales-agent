# 2026-08-16 — Phase 4 (part 2): per-tenant Google Calendar

Workstream: VOICE + DASHBOARD. Branch: `main`.

## The bug this closes

Bookings were made with ONE set of credentials read from `GOOGLE_CALENDAR_*` env, for every tenant.
So customer #2's agent would qualify a lead, agree a time, call `book_meeting` — and write the
meeting into **ClickScales' calendar**.

Nothing errors in that path. The tool returns success, the agent tells the lead it is booked,
`scheduled_calls` gets a row, a reminder is scheduled. The only symptom is that the customer's
salesperson never sees the meeting and ClickScales sees a stranger's. It is invisible from every
side except the customer's diary.

## The rule

A tenant's OWN connection, or the platform service account for ClickScales alone, or **nothing**.

There is deliberately no fallback from "not connected" to the platform credentials — that fallback
*is* the bug. A tenant with no calendar gets no booking tools, which is the same fail-closed
behaviour as every other gate in `tool-context.ts`.

`GOOGLE_CALENDAR_*` env now means "ClickScales' own credentials", keyed on `PLATFORM_TENANT_ID`.
They only ever were one tenant's; they were just being treated as a default.

## What shipped

- **Migration 0012 — `oauth_connections`**: encrypted refresh + access tokens, `accountEmail`,
  `calendarId`, `revokedAt`, unique on (tenant, provider).
- **`GoogleCalendarAuth` union** on the provider: `service_account` | `oauth`, with an
  `onTokensRefreshed` write-back. The legacy constructor fields still work, so the bench scripts
  and scheduling module did not all have to change in the same commit.
- **`GoogleCalendarConnectionService`** — connect, status, disconnect, revoke, token persist.
- **`resolveCalendarAuth()`** in `tool-context.ts` — the decision above, timeboxed and fail-closed.
- **Routes**: `GET/POST/DELETE /api/v1/integrations/google-calendar/*` (authenticated) plus
  `GET /webhooks/google-calendar/callback` (public — see below).
- **Integrations page**: Google Calendar moved out of "Run by ClickScales" (where it had a
  permanent green tick that was a lie for anyone who had not connected) into self-service, with a
  consent popup, the connected account's email, and an explicit "needs reconnect" state.
- **New env**: `GOOGLE_CALENDAR_OAUTH_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI`, and
  `PLATFORM_TENANT_ID` now actually used.
- 14 new tests (772 total).

## Decisions worth knowing

- **The callback cannot be authenticated.** It is a top-level browser redirect from Google, so
  there is no `Authorization` header. The tenant id therefore travels through Google and back — and
  as a plain value, anyone could pass `?state=<someone-else's-tenant>&code=<their own>` and attach
  a calendar THEY control to another customer's workspace, then read every meeting booked into it.
  So `state` is `tenantId.timestamp.hmac`, signed with the app secret, domain-separated, verified
  in constant time, and expiring after 30 minutes.
- **`prompt=consent` is not optional.** Google returns a refresh token only on the *first* consent
  for a client/user pair. Without forcing the consent screen, a tenant who reconnects gets a grant
  with no refresh token and their calendar breaks an hour later when the access token expires.
  `completeConnection` refuses a tokenless grant rather than storing one that dies quietly.
- **Tokens live in a table, not `tenants.settings`.** A refresh cycle is a read-modify-write of the
  whole jsonb blob, done by the agent process mid-call from a different machine, possibly while the
  dashboard writes the same column. Last write wins: either the business profile silently reverts
  or the fresh token is overwritten with the stale one and the next booking 401s.
- **A decrypt failure throws rather than returning "not connected".** Otherwise a rotated
  `ENCRYPTION_KEY` tells every tenant to reconnect a calendar that is perfectly fine, while the
  real fault goes unnoticed across every integration at once.
- **`calendar.events` scope, not full `calendar`.** We create, read and delete events; we never
  create calendars or change sharing. Asking for more shows the customer a scarier consent screen
  for capability we do not use.

## 🔴 Before this works in production

1. **Create the OAuth client** in Google Cloud Console (Web application), authorised redirect URI
   exactly `https://<api-host>/webhooks/google-calendar/callback`. Set the three
   `GOOGLE_CALENDAR_OAUTH_*` vars.
2. **Set `PLATFORM_TENANT_ID=613d826c-...`** — ClickScales' tenant id. **If this is unset, the
   ClickScales tenant loses its calendar tools**, because the service-account branch only fires for
   the platform tenant. This is the one that can break the live customer.
3. `npm run db:migrate` (0012).

Note this compounds with the DID-routing handoff: both migrations and both config steps want doing
before the next agent deploy.

## Hardening pass — because the calendar is mandatory, not optional

A sales agent that cannot book a meeting has not done its job, so the two SILENT failure modes were
closed:

**1. A connection that was never really valid.** Storing tokens proves only that Google accepted an
authorisation code. It does not prove we can read a calendar — the consent screen lets a user untick
individual permissions, and the account may have no accessible calendar. Both produce a dashboard
saying "Connected" and a booking that fails mid-call in front of a lead.

`completeConnection` now makes one real API call (`calendarList.get`) **before** storing anything,
and refuses the connection if it fails. Storing before verifying would be worse than not connecting
at all, because it silences the "connect your calendar" prompt. Refusing is cheap: `prompt=consent`
means every reconnect issues a fresh refresh token, so it costs one more click, not a lost grant.

**2. A connection that stopped being valid.** `isInvalidGrant()` now recognises the four shapes
googleapis throws it in, and `timedTool` — the seam EVERY calendar tool passes through — marks the
connection revoked when it sees one. Whichever tool trips over the dead grant first, the dashboard
learns about it and flips to "Needs reconnect". It is fire-and-forget: bookkeeping must never turn a
failed booking into a failed call.

Deliberately narrow: a rate limit or a backend error must NOT mark a connection revoked. Telling a
customer to reconnect a healthy calendar teaches them the warning is noise, so the real one gets
ignored too. Tested both ways.

A revoked connection then reads as no connection (`get()` filters on `revokedAt IS NULL`), so the
tenant fails closed to a tool-less call rather than to somebody else's calendar.

9 more tests (781 total).

## Still open

- **No real booking has been made through an OAuth connection**, and the OAuth path has still never
  touched Google — no client exists yet. The code is written against the googleapis contract and
  covered by unit tests with the network stubbed. Verify-on-connect means the FIRST customer to
  click Connect will find out immediately rather than on their first call, which is the point, but
  it is not the same as having worked once.
- **`calendarId` defaults to `primary`** and there is no picker. A tenant who books into a secondary
  calendar needs `PUT /integrations/google-calendar/calendar` by hand for now.
- **Nobody is alerted when a live tenant's calendar dies.** Revocation logs loudly and shows in that
  tenant's dashboard, but for a mandatory dependency an operator email is probably warranted — the
  `sendAlert` machinery in `spend-guard.ts` is the obvious model. Left undone because who gets
  emailed, and whether the customer is emailed too, is Koren's call.
- **No operator-side view of which tenants lack a calendar.** The admin console shows tenant stats;
  calendar status is not among them.
