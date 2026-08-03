# Code-review findings — 2026-07-25 (for the VOICE / architect session)

**Context:** a `/code-review` pass over the 93-commit `feature/dashboard-d1-i18n` branch (which spans
both workstreams' history since master) surfaced 5 backend correctness bugs. **All 5 are in VOICE-workstream
territory** (`spend-guard`, `flow-executor`, `meeting-reminders`, `whatsapp-window`, and the voice-added
`settings.service` save methods). Per the CLAUDE.md TERRITORY RULES, the dashboard session did **not** touch
them — flagging here for the owning session. Ranked by impact.

Separately, the dashboard's own D1 diff is being self-reviewed (the /code-review explicitly skipped the
React/i18n changes); any dashboard fixes land on the D1 branch, not here.

---

### 1. 🔴 Daily call-count cap enforced at HALF its value (double INCR) — `src/queues/workers/flow-executor.worker.ts:212`

`checkDailySpendLimit` is called twice per outbound call — once in the flow-executor `make_call` step, then
again inside the dialer (`voice.service.ts:103` / `voice-livekit.service.ts:78`) — and each call
unconditionally `redis.incr`s the same `spend:calls:<tenant>:<day>` counter. Every flow-driven call counts
as 2, so `dailyCallLimit=100` blocks the tenant after ~50 real calls. At the boundary the flow-level
pre-check can pass (100 > 100 false) while the in-service check INCRs to 101 and throws `AppError` 429 — so
`make_call` **throws instead of skipping**, sending the job through retries into the DLQ.
**This directly halves the primary outbound capacity — fix first.** Likely fix: increment once (dialer only),
or make the flow-level check read-only (peek, not INCR).

### 2. 🟠 Custom reminder offsets mislabelled — `src/queues/workers/meeting-reminders.worker.ts:201`

`kind = offsetMins >= 720 ? 't24' : 't1'`. Any offset below 720 min gets the **t1** template, whose body is
hardcoded "נפגשים בעוד שעה" ("we meet in an hour"). A tenant configuring `offsetsMinutes:[180]` (T-3h, which
`resolveReminderSettings` accepts, range 5–20160) tells the lead the meeting is in an hour when it's actually
three hours away.

### 3. 🟠 Dollar cap can silently die with no operator alert — `src/modules/calls/spend-guard.ts:166`

`recordSuccess()` fires when **either** subsystem succeeds. With Postgres down but Redis up, each call:
DB query throws → `recordFailure()` (streak→1), Redis INCR succeeds → `if (dbOk || redisOk) recordSuccess()`
resets streak→0. The 3-strike "fail-open LOUDLY" email never fires, `spentUsd` stays 0 forever → the
daily-**spend** brake is fully disabled and the operator is never told. Only the call-count cap remains.
Likely fix: track failures per-subsystem, or only `recordSuccess()` when the DB path (the one backing
`spentUsd`) succeeds.

### 4. 🟡 Settings save = read-modify-write whole JSON, no lock — `src/modules/settings/settings.service.ts:96`

`saveTollFraudSettings` / `saveWhatsappTemplates` / `saveBusinessProfile` each read the full `settings` JSON,
mutate one key, and write the whole column back. Two near-simultaneous saves for the same tenant → last write
wins the entire object, silently dropping the other's key. **Note:** the dashboard Settings page also writes
tenant settings, so this is a shared-risk path — worth a jsonb-merge (`settings || '{...}'`) or optimistic
lock. Dashboard is willing to coordinate on the fix since it's cross-cutting.

### 5. 🟡 WhatsApp window stamp hits all leads sharing a 9-digit suffix — `src/modules/channels/whatsapp/whatsapp-window.ts:105`

`touchWhatsappWindow` does an unbounded `UPDATE … WHERE phone LIKE %<9-digit-suffix>` with no `LIMIT`/exact
match. Two leads whose last 9 digits coincide (country-code vs not, or a dupe) → an inbound from one stamps
`last_inbound_whatsapp_at` on **both**, opening a freeform 24h window (bypassing template/consent gating in
`resolveWhatsappSendMode`) for a lead who never messaged in. Likely fix: match on the exact normalized E.164,
not a suffix LIKE.

---

_Filed by the dashboard session; not acted on (territory). The double-counted spend guard (#1) is the one
that actively throttles agent capability today._
