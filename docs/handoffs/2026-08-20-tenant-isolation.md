# 2026-08-20 — tenant isolation (dashboard + scheduling)

## Shipped

**`db2f92e` — fix(dashboard): wire the tenant switcher, which was hardcoded empty**

`AccountMenu.tsx` declared `const otherTenants: never[] = []` and rendered the switcher behind
`otherTenants.length > 0` — a condition that can never be true. The markup, the `Check` icon and
the `switchTenant` import were all present; the list feeding them was a literal empty array. A
user belonging to several workspaces saw only their email and Sign out.

The backend supported switching all along (`POST /auth/switch-tenant`, and `GET /auth/me` already
returns every membership). Now populated from `/auth/me`, fetched when the menu opens rather than
on mount. After switching it navigates to `/` rather than reloading, because the current URL may
be a detail route whose id belongs to the workspace being left.

New i18n key `auth.workspaces` in both `en.json` and `he.json`.

**`351359f` — fix(scheduling): book into the tenant's calendar, not ClickScales'**

The REST scheduling routes built their Google client from `GOOGLE_CALENDAR_*` env and passed
`serviceId: env.GOOGLE_CALENDAR_ID` on every call. Those env vars are ClickScales' own
credentials, so a customer booking through the API had their meeting created in ClickScales'
calendar while the `scheduled_calls` row carried the CUSTOMER's `tenant_id`. `/slots` offered
customers ClickScales' free time; `/cancel` used the wrong credentials.

The voice agent has resolved this per tenant since Phase 4 — which is why it was easy to miss.
The same product answered "whose calendar" differently depending on whether a booking arrived by
phone or over HTTP.

`resolveCalendarAuth` moved from `voice-livekit/tools/tool-context.ts` to
`integrations/google-calendar/resolve-calendar-auth.ts`, next to the connection it reads.
`tool-context` re-exports it, so the agent path is unchanged.

- ClickScales (`PLATFORM_TENANT_ID`) → service account, same calendar as always
- Connected tenant → own calendar, own OAuth credentials
- Neither → 503, and no `scheduled_calls` row. No fallback to the platform account.

New `scheduling.tenant-calendar.test.ts` (6 tests), negative-tested: 3 fail against the previous
behaviour. `scheduling.routes.test.ts` now mocks the resolver — its subject is reminder cleanup,
and it passed before only because the routes read env directly.

855 tests pass, typecheck clean. Production is running `351359f` (started 13:40:31Z), postgres
46ms, redis 2ms.

> **Note for the voice session:** `tool-context.ts` is your file. The change is an extraction plus
> a re-export with no behavioural change on the agent path; `calendar-isolation.test.ts` and
> `tool-context.test.ts` pass unmodified.

## Blocked — waiting on Koren

**The Phase 4 calendar gate is not closed.** *"A second tenant's OAuth calendar receives a booking
while ClickScales' does not."*

State: Koren is a member of both `clickscales` and `keren-gate-test` (owner on each). He connected
Google Calendar on `keren-gate-test` — but with `koren@clickscales.com`, the same account
`GOOGLE_CALENDAR_ID` points at, and a fresh connection defaults to `calendar_id = 'primary'`. Both
tenants therefore target one identical calendar, so a booking landing there proves nothing.

Fix in progress: he created a secondary calendar and supplied its id —
`c_fbe04a991ad87640eab493a00ee7252f2940b3e031dc8c346f55afa669bfd2ed@group.calendar.google.com`.

Remaining steps, in order:

1. `PUT /api/v1/integrations/google-calendar/calendar` on `keren-gate-test` with that id
2. `POST /api/v1/scheduling/book` as that tenant
3. Confirm the event appears in `Gate Test` and NOT in the primary calendar

**Needs a decision:** steps 1–2 require an API key for `keren-gate-test`. Keys are stored as
SHA-256 hashes, so the only way to obtain one is `POST /api/v1/admin/tenants/:id/rotate-key`.
Nothing currently uses that tenant, so the rotation is harmless — but it was asked and not yet
answered.

Note the connect-time check (`calendarList.get`) only proves READ access. A consent screen where
`calendar.events` was unticked would still show "Connected" today and fail on the first live
booking. Only step 3 settles it.

## Open, unchanged from previous sessions

- **Plans:** no tenant has a `plan_code` — all NONE/trialing. ClickScales should be `internal`.
- **DID:** `phone_numbers` is empty; `assets/not-in-service.wav` not generated.
- **Google app verification:** still External + Testing, so refresh tokens expire after 7 days.
  Blocking before any real customer connects a calendar.
- **Greeting:** the AI-disclosure change alters the first line every lead hears; Koren wanted to
  listen before `npm run agent:deploy`.
- **Playwright click-through** of the deployed dashboard under a separate test account — still the
  largest unverified surface.

## Environment notes

- **AVG is intercepting TLS on Koren's machine** (`SSLKEYLOGFILE=\\.\avgMonFltProxy\...`). It
  breaks `curl` against every host (SSL error 35) and blocks TCP to the Railway Postgres proxy on
  port 14655, so `railway run --service Postgres` cannot connect. Node's HTTPS stack is unaffected
  — use node for API calls. To restore DB access, exclude `switchback.proxy.rlwy.net` or
  `node.exe` in AVG's Web Shield rather than disabling protection.
- `auth_tokens.created_at` is `timestamp without time zone` while `expires_at`/`used_at` are
  `timestamptz`. TTLs compute correctly; only display shifts by the client's UTC offset, which
  makes a 60-minute token look like a 4-hour one. Worth a one-line migration eventually.
- Koren's calendar has "AI Sales agent Dem" blocks 09:00–15:00+ Sun–Fri. If that is the calendar
  the agent reads for availability, the slots query will skip most of the bookable day. Check
  before go-live.
