# 2026-09-03 — VOICE — F1.3, the callback scheduling engine

Branch: `feature/voice-callback-worker`, off `origin/main` @ `48b7f9c`. One commit. Not merged, not
deployed, nothing touched in LiveKit Cloud.

Design: `docs/phase-8-callback-and-followup-model.md` §4, §5, §7.

---

## What shipped

| File | What it is |
|---|---|
| `src/queues/callbacks.queue.ts` | queue producer, deterministic job ids, `cancelCallbacks` |
| `src/queues/workers/callbacks.worker.ts` | `processCallback` (the fire-time authority chain) + `startCallbacksWorker` (the flag gate) |
| `src/modules/channels/voice-livekit/tools/callback-settings.ts` | `tenants.settings.callbacks` resolver, shaped like `reminder-settings.ts` |
| `src/modules/channels/voice-livekit/tools/callback-time.ts` | **extended additively**: `dialOrdinal`, `addIsraelBusinessDays`, `nextRung`, and an optional per-tenant window config on `clampToWindow` |
| `scripts/callbacks-reconcile.mjs` + `npm run callbacks:reconcile` | dry-run-by-default sweeper for pending rows whose BullMQ job has vanished |
| `src/plugins/queue.ts`, `src/server.ts`, `src/config/env.ts`, `.env.example` | additive wiring, `VOICE_CALLBACK_WORKER` default **false** |
| `CLAUDE.md`, `settings-policy.ts`, `AGENT_SETTINGS_KEYS` | the `callbacks` settings key, claimed in all three, same commit |

Tests: 89 new (28 worker, 3 gate, 9 queue, 12 settings, 37 added to `callback-time.test.ts`).
Full suite 2048 passing, exit 0. `typecheck`, `build`, `territory-check.sh`,
`migration-claims-check.sh` all exit 0. **No migration** — the table already exists (0019);
`db:generate` was never run.

### The design decisions worth arguing with

- **`attempt` counts dials made, and the ordinal of the dial being *scheduled* is `attempt + 1`.**
  `clampToWindow`'s `windowFor` treats 0 and 1 alike, so reading the raw `attempt` when scheduling
  rung 2 of an explicit callback silently puts it back in the honored window. `dialOrdinal()` exists
  to name that, and the regression has its own test in `callback-time.test.ts`.
- **An outage does not burn a rung.** Spend cap (429), open circuit breaker → deferral, `attempt`
  unchanged, state back to `pending`. Only a rejection from the SIP dial itself counts.
- **A missing trunk writes `state='failed'`, `last_outcome='no_trunk'` to the ROW.** `no_trunk`
  extends the column's documented value set; the schema comment now says so. A config gap that reads
  as "nothing happened" is the exact failure this repo already paid weeks for.
- **`clampToWindow` gained an optional 4th parameter** rather than the settings key silently
  ignoring the window fields it advertises. Every existing caller (`disconnect.ts`) is byte-identical
  in behaviour, and there is a test asserting the no-config path equals the explicit-default path.
- **`state='dialing'` is written before the await.** A crash mid-dial is then visible as exactly
  that, and the reconcile script rescues it (`--stale`, default 30 min) without touching `attempt` —
  we do not know whether the phone rang, and counting a dial we cannot prove shortens the ladder.
- **`MAX_DEFERRALS = 5`.** `clampToWindow` always returns an instant inside the window, so a second
  deferral already means the job fired hours late. The cap exists so "never drop it" cannot become
  an infinite re-enqueue loop; past it the row fails rather than moving again.

---

## Mutation table

The suite passed on its first run, which by this repo's recent history is a warning rather than a
result. 18 mutations, applied one at a time, suite re-run, reverted. **18/18 killed.** The five the
brief named, with the tests that actually went red:

| # | Mutation | Result |
|---|---|---|
| 1 | window clamp disabled (`if (false && clamped.dueAt > now)`) | **KILLED** — 4 tests: `23:30 … deferred to 09:00 the next morning`, `22:00 on the SECOND dial`, `Saturday is never dialled`, `after MAX_DEFERRALS the row FAILS` |
| 2 | `dialOrdinal` returns `attemptsMade` (no increment) | **KILLED** — 9 tests, incl. `THE REGRESSION: rung 2 must fall OUT of the honored window`, `THE NEVER-ANSWERED RING`, `STOPPING IS A FEATURE` |
| 3 | `opted_out` comparison never matches | **KILLED** — 2 tests: `OPTED-OUT LEAD IS NEVER DIALLED`, `opt-out is checked BEFORE the window` |
| 4 | job id gets `Math.random()` | **KILLED** — 8 tests across `callbacks.queue.test.ts` and the worker's deferral assertions |
| 5 | flag gate removed (`if (!deps.enabled && false)`) | **KILLED** — `OFF: returns null, constructs no Worker, opens no Redis connection` |

And the other thirteen, each killed:

| # | Mutation |
|---|---|
| 6 | the ladder wraps instead of ending (`ladder[n % len]`) |
| 7 | `attemptsMade > maxAttempts` — a fourth dial |
| 8 | business-day arithmetic stops skipping Saturday and holidays |
| 9 | the hard floor reads the tenant config instead of `CALLBACK_DEFAULTS` |
| 10 | a lead with a booked meeting is chased anyway |
| 11 | a spend limit burns a rung instead of deferring |
| 12 | a missing trunk leaves the row `pending` |
| 13 | a tenant can raise `maxAttempts` above 3 |
| 14 | a malformed calling window resolves to `00:00–23:59` instead of the default |
| 15 | a superseded row is dialled anyway |
| 16 | an open circuit breaker burns a rung |
| 17 | the deferral cap is removed |
| 18 | every dial failure is recorded as `failed`, never `no_answer` |

The flag OFF path was proved by **running** it, not by reading server.ts: the gate lives inside
`startCallbacksWorker`, and the test watches the BullMQ constructor and `redis.duplicate()`.

---

## What only a real call can settle

1. **Nothing has ever dialled from this queue.** Every test stubs `initiateOutboundCall`. The whole
   chain — job fires → row re-read → clamp → `createSipParticipant` → the agent joins the room — has
   not run once end to end.
2. **What a ring-out actually looks like.** `classifyDialFailure` defaults an unrecognised rejection
   to `no_answer` because with `waitUntilAnswered: true` that is overwhelmingly what it is. I could
   not find the SIP status in the LiveKit SDK error shape without a real rejected dial. **Please
   capture the raw error text from the first deliberate no-answer** — the worker appends it verbatim
   to `callbacks.reason`, so `SELECT reason FROM callbacks WHERE last_outcome='no_answer'` will show
   it. If the status code is in there, the classifier can be made honest in ten minutes.
3. **`callbackPunctuality`.** The worker logs `lateBySeconds` on `callback_dialed`. Nobody has a
   number yet. §10 is right that every other counter stays green through a callback that fires 40
   minutes late.
4. **Does the agent behave sensibly on a call it placed itself?** The dial goes through the ordinary
   `initiateOutboundCall`, so the agent gets the ordinary outbound greeting — it does not know this
   is a callback, or what the lead said last time. `callbacks.lead_quote` is written and read by
   nobody. That is F1.7's problem, but it will be obvious on the first live callback.

---

## Ops blockers

- **`LIVEKIT_SIP_OUTBOUND_TRUNK_ID` must be set wherever this runs.** Without it every callback fails
  immediately with `last_outcome='no_trunk'`. It is set in production today; a staging environment
  that lacks it will fail every row rather than queue them.
- **`VOICE_CALLBACK_WORKER` is not set anywhere.** Turning it on is a deliberate act per environment.
  Suggest: local first, with one hand-inserted row and a phone you own.
- **Only one process should run the worker.** BullMQ handles the locking, but if the API is scaled to
  N replicas each one starts a worker and the concurrency is N×2 simultaneous outbound dials. Worth a
  decision before this goes on in production.
- **Nothing enqueues a job yet.** `disconnect.ts` writes rows and does not enqueue (it predates this
  queue), and the `schedule_callback` tool is F1.4. Until one of those two exists, the worker is
  correct and idle. **`npm run callbacks:reconcile --apply` is the interim bridge** — it will pick up
  every `disconnected` row and arm it. That is a real decision, not a detail: running it turns on
  automatic callbacks for every mid-call hangup already recorded.

### Requests into other lanes

- **DASHBOARD**: `GET /leads/:id/timeline` should carry `callbacks` (phase-8 build order step 8), and
  `leads.next_callback_at` is now written and cleared by this worker, so a "callbacks due today" view
  has a column to sort on. Not touched from here.
- **INTEGRATIONS**: unchanged from the disconnect handoff — `no_answer` still has no CRM status map,
  and should not get one by default.

---

## What I think the brief got wrong

Three things, none fatal.

1. **"A `CALLBACK_DEFAULTS`-shaped override" could not be built as specified without touching
   `clampToWindow`.** `clampToWindow` reads `CALLBACK_DEFAULTS` directly from module scope, so a
   settings key advertising `proactiveWeekday` / `proactiveFriday` would have parsed those fields and
   then silently ignored them — a knob that does nothing, which is precisely the class of defect the
   brief's own instrument warning is about. I added an **optional fourth parameter** to
   `clampToWindow` (defaulting to `CALLBACK_DEFAULTS`, existing callers unchanged) rather than either
   reimplementing the window logic or shipping a decorative setting. The hard floor is deliberately
   NOT in that config type, so it stays unreachable from tenant settings by construction. If you
   would rather the settings key were `enabled` + `maxAttempts` only, that is a smaller diff and I
   will take it — but the half-honoured version is the one option I would refuse.

2. **"Mark the row `failed` with a `last_outcome` that says so" collides with the column's documented
   enum.** `callbacks.last_outcome` is documented as `answered | no_answer | busy | voicemail |
   failed`; none of those says "the trunk is unconfigured". I added `no_trunk` and updated the schema
   comment to admit it (comment only — no migration, the column has no check constraint). The
   alternative, `failed` plus a note in `reason`, loses the distinction exactly where an operator
   would look for it.

3. **The brief says the job carries "`{ tenantId, callbackId }` and NOTHING time-related", but the
   job id grammar it also specifies needs `attempt` and the deferral count.** Those two have to be
   known at enqueue time to name the job, and BullMQ has no way to derive a job id at fire time. So
   the job data is `{ tenantId, callbackId, attempt, deferrals }`, with both counters documented in
   the file as *naming the job and nothing else* — every decision reads `callbacks.attempt` back from
   the database. The spirit (no `dueAt` in the job, nothing to reconcile a snapshot against) is
   intact; the letter was unbuildable.

Two smaller notes:

- **The 20:00 vs 23:00 window conflict is untouched, as instructed.** `CALLBACK_DEFAULTS` still ends
  the proactive window at 20:00 while the shared `operating_hours` default runs to 23:00. Two
  different pieces of code will therefore disagree about whether 21:00 is a decent hour to ring
  somebody: the flow executor will place a `make_call` step at 21:00 and this worker will not. Koren's
  by ear.
- **`CALLBACK_DEFAULTS.disconnectedDelayMinutes` is 15 and is now tenant-overridable.** It is the
  one number in this feature that nobody has judged. A caller who hung up because he'd had enough
  gets rung back in a quarter of an hour, and that is indistinguishable from a dropped line at this
  end.

## Questions for architect

1. **Should `callbacks:reconcile --apply` be the bridge that arms the existing `disconnected` rows,
   or should `disconnect.ts` be taught to enqueue directly?** Enqueueing from `disconnect.ts` is a
   four-line change in VOICE territory and makes the feature work without a cron. I did not do it
   because the brief scoped this task to the queue and worker, and because it flips mid-call-hangup
   callbacks from "recorded" to "we will ring him back" — a product decision, not a wiring one.
2. **One worker or N?** See ops blockers.
3. **Confirm phase-8 open question 2:** after `exhausted`, the lead is left alone and is NOT moved to
   `disqualified`. That is what this worker does. Never picking up is not the same as saying no.
