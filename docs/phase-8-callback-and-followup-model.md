# Phase 8 — Callback & Follow-Up Model

Status: **PLAN, not implemented.** Written 2026-09-01 after Koren asked for a flexible, intelligent
follow-up model driven by what the lead actually says.

Read alongside `docs/gtm/keren-sales-model.md` (objection #4 is the sales half of this) and
`docs/handoffs/2026-08-27-architect-no-answer-flow-prompt.md` (the earlier, unbuilt spec whose
sections A–D this supersedes and narrows).

---

## The finding this exists to fix

**Keren has no memory beyond the call.** When a lead says *"תתקשר אליי עוד שעה"* or *"אני עסוק,
דבר איתי מחר בארבע"*, the only thing that happens today is that the model may pass
`end_call(reason: 'callback_requested')` — which maps to lead status `contacted` in
`crm-sync.settings.ts:48` and **nothing else**. No time is captured, no job is queued, no message
is sent, nobody calls back.

The lead who was closest to buying — he did not say no, he said *later* — is the one we drop.

Three things already in the repo agree that this should exist, and none of them has a mechanism:

1. **The sales model** (`docs/gtm/keren-sales-model.md`, objection #4) classifies *"אני עסוק / לא
   עכשיו"* as **timing, not an objection**: *"מתי יתאים לך יותר?" — ואם הוא נותן חלון, **מסמנים**.*
   The word "מסמנים" has nothing behind it.
2. **The marketing site already promises it.** `docs/handoffs/2026-08-31-website.md:25-27`, lead
   journey step 7, confirmed by Koren: *"in-call callback scheduling ('call me in an hour' →
   callback at the requested time) + adaptive follow-up pacing."* Sold, not built.
3. **A spec exists and was never built** — the 2026-08-27 no-answer-flow prompt,
   `docs/go-live-plan.md` Workstream C2, `docs/keren-product-capabilities.md` §2.4.

Grep confirms the gap precisely: `'callback_requested'` is an `end_call` enum value
(`end-call.tool.ts:39`) and a prompt line telling the model to *"note it for the post-call analysis
so a follow-up task can be created"* (`system-prompt.he.ts:1066`). **Nothing consumes either.**
There is no column, no queue, no job, no tool. Separately, `follow_up_scheduled` is read out of
`conversations.metadata` by `calls.service.ts:30,136` and **has no writer anywhere in `src/`**.

**What already exists and must be reused, not rebuilt:**

| Need | It already exists as |
|---|---|
| Place an outbound call | `LiveKitVoiceService.initiateOutboundCall` (`voice-livekit.service.ts:74`) — the only dialer, spend-guarded, circuit-broken |
| Fire a job at an absolute future instant, cancellably | `meeting-reminders.queue.ts` + worker — deterministic job ids, fire-time DB authority, quiet-hours deferral |
| "Don't call at 3am / on Shabbat" | `src/shared/operating-hours.ts` — `getDelayUntilNextActiveSlot`, Saturday + `ISRAEL_HOLIDAYS` |
| Israel-local time arithmetic, DST-safe | `voice-livekit/tools/israel-time.ts` — `nextIsraelClockTime`, `israelMinutesOfDay`, `formatSlotHe` |
| A 7th-tool + settings-resolver precedent | `tools/request-human-handoff.tool.ts` + `tools/handoff-settings.ts` |
| WhatsApp window / consent / template policy | `whatsapp-window.ts :: resolveWhatsappSendMode` |

Every part is present. **None of them is connected to any other.** That is the whole of this work.

---

## Decisions taken with Koren, 2026-09-01

| Question | His answer |
|---|---|
| Who performs the callback | **All three:** she sends a message saying she will be in touch, the intent is recorded durably after the call, and **she dials at exactly the requested time** |
| Lead doesn't answer, or gave no time | **Fixed ladder, then stop** |
| Calling hours | **A combination — a wide window AND what the lead asked for.** *"אם הוא מבקש שיחה בשעה 22:00 אז יקבל"* |

---

## 1. Three situations, one mechanism

The mistake to avoid is treating these as one thing. They differ in **who chose the time**, and
therefore in **which rules apply**:

| # | Situation | Trigger | Who chose the time | Window rule |
|---|---|---|---|---|
| **A** | **Explicit callback** — "תתקשר עוד שעה", "מחר ב-16:00" | `schedule_callback` tool | The lead | **His time is honored**, incl. 22:00 |
| **B** | **Soft defer** — "לא עכשיו", "אני באמצע משהו", no time given | `schedule_callback`, `when_kind:'unspecified'` | Nobody | Proactive window only |
| **C** | **Not reached** — ring-out, voicemail, silence-reflex hang-up | The callback worker's own dial result | Nobody | Proactive window only |

A is the feature Koren asked for. B and C are the ladder. **All three write the same row and run
through the same worker** — the only differences are which rung of the ladder they start on and
which window guards the dial.

---

## 2. Where a callback lives — a new table

**Recommendation: a new `callbacks` table (migration `0019`), not a reuse of `scheduled_calls`.**

Reusing `scheduled_calls` with `provider='callback'` is tempting — it already carries
`tenantId / leadId / conversationId / scheduledAt / status / notes / reminders.jobIds`, and
`GET /leads/:id/timeline` would surface it for free. Reject it, for three reasons:

- `GET /scheduling/bookings` lists `scheduled_calls` upcoming-first and feeds the dashboard
  **Bookings** page. Callbacks would appear there as booked meetings. Filtering that is a change
  to a route DASHBOARD owns.
- A callback carries state a booking does not: `attempt`, `max_attempts`, `requested_by_lead`,
  `last_outcome`, and the lead's own words. Pushing them into `notes`/`metadata` is exactly how
  three unreconciled Airtable write paths grew.
- `provider` / `provider_ref` mean "a calendar event exists". For a callback none does. That column
  has already drifted twice (repaired by migration 0015) *because* its meaning was unclear.

```
callbacks
  id                uuid pk
  tenant_id         uuid not null → tenants
  lead_id           uuid not null → leads          -- a callback with no lead is meaningless
  conversation_id   uuid → conversations           -- the call it was promised on
  due_at            timestamptz not null           -- the resolved absolute instant
  state             varchar(20) not null default 'pending'
                    -- pending | dialing | done | exhausted | cancelled | superseded
  kind              varchar(20) not null           -- explicit | soft_defer | not_reached
  requested_by_lead boolean not null default false -- did HE name this time? gates the wide window
  attempt           integer not null default 0
  max_attempts      integer not null default 3
  lead_quote        text                           -- his words — for the dashboard and the next call
  reason            text
  job_id            varchar(120)                   -- the live BullMQ job, for cancellation
  last_outcome      varchar(20)                    -- answered | no_answer | busy | voicemail | failed
  created_at        timestamptz not null default now()
  updated_at        timestamptz not null default now()

indexes
  callbacks_tenant_due_idx  on (tenant_id, state, due_at)   -- the reconcile sweeper's query
  callbacks_lead_idx        on (tenant_id, lead_id)
```

**Migration number `0019`, not 0018.** `0018` is reserved on paper by
`docs/phase-7-onboarding-call-corpus.md` §5 (`onboarding_samples`, `onboarding_insights`) and by the
ready-to-paste kickoff in `docs/phase-7-kickoff-prompt.md`. Claim `0019` in the CLAUDE.md claims
line **in the same commit**, and run `npm run db:drift` after — schema drift is invisible to both
the tests and `db:generate`.

**`leads` gains exactly one column**, following the `handoff_requested_at` precedent
(`leads.ts`: *"Deliberately NOT a status value — a lead can be both `qualified` and urgent"*):

```
leads.next_callback_at  timestamptz          -- mirror of the earliest pending callback
index leads_callback_idx on (tenant_id, next_callback_at)
```

A denormalized mirror so the dashboard can answer "who am I calling today" without a join.
**No new lead status** — `LEAD_STATUSES` in `lead-status.ts` stays as it is.

> ⚠️ Pre-existing defect, out of scope but worth knowing: `lead.schemas.ts:12` carries a **stale,
> different** status enum containing `'booked'` and missing `'opted_out'`, and `PATCH /leads/:id`
> writes it through `LeadService.update()` **without** `canTransition`. Anyone adding a lead status
> must fix both files.

---

## 3. The tool — `schedule_callback` (the 8th)

Registered in `tools/index.ts` beside the existing seven, built on the `request_human_handoff`
pattern — the closest analogue and the most recent precedent for a tool with a settings resolver,
an identity ladder and an idempotency latch.

### The schema deliberately does not ask the model for a timestamp

```ts
export const scheduleCallbackSchema = z.object({
  when_kind: z.enum(['in_minutes', 'at_time', 'unspecified']),
  in_minutes: z.number().int().min(5).max(20160).nullable().optional(),  // "עוד שעה" → 60
  day: z.enum(['today','tomorrow','day_after','sunday','monday','tuesday',
               'wednesday','thursday','friday']).nullable().optional(),
  time_hhmm: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),     // "22:00"
  quote: z.string().max(200),                                            // his words, verbatim
  reason: z.string().max(200).nullable().optional(),
});
```

**Why not a `when_iso` field.** `book_meeting` never lets the model do date arithmetic — it passes
`slot_datetime` **verbatim** from what `check_calendar_availability` printed. A callback has no
availability list, so the equivalent safety is a **structured intent that code resolves**. gpt-5.4
converting "מחר בארבע" into an `Asia/Jerusalem` instant across a DST boundary, without reliably
knowing what "now" is, is a class of bug whose symptom is a phone ringing at the wrong hour and
which is invisible to every test we have. The resolver is pure and unit-testable; the model is not.

**Every optional field is `.nullable().optional()`, both.** gpt-5.4 fills a tool call's unknown
fields with an explicit `null` rather than omitting them, and a bare `.optional()` **rejects** null
— which on a live call means Zod fails while the lead waits. This is documented in
`capture-lead-info.tool.ts` and `request-human-handoff.tool.ts`; copy it, do not rediscover it.
The schema must also stay a plain `z.object` — LiveKit rejects `ZodEffects`, so no `.refine()`.

### Resolution — `callback-time.ts`

A new pure module built entirely on existing `tools/israel-time.ts` helpers:

- `in_minutes` → `now + minutes`.
- `at_time` → the next Israel-local instant matching `day` + `time_hhmm`. With `day` absent this is
  exactly `nextIsraelClockTime(now, hhmm)`, which is already DST-safe with a midnight-wrap guard.
- `unspecified` → rung 1 of the soft-defer ladder (§7).
- The result is then **clamped by the window rules in §4**, and the clamped instant — not the raw
  request — is what she reads back to the lead.

### Tool effects, in order

The ordering discipline is the handoff tool's: **the durable write happens first and synchronously**,
because a shutdown race must never lose the request.

1. **Insert the `callbacks` row** + set `leads.next_callback_at`. Resolve the lead by the same
   identity ladder as `flagLeadHandoffRequested`: known `rt.leadId` → `phoneSuffix` match (≥7
   digits) → insert a minimal lead (`source:'voice-livekit'` + `void meterLead(...)`) → else log
   `callback_unattributable`.
2. **Supersede** any other `pending` callback for this lead — remove its BullMQ job, set
   `state='superseded'`. **One live callback per lead, always.**
3. **Enqueue** the delayed job (§5).
4. **Send the confirmation message** (§6) — best-effort, through the outbound queue.
5. **Return the truth to the model**: the resolved time in Hebrew via `formatSlotHe`, **and whether
   the message will actually be delivered**. This is the lesson already written into
   `send-confirmation.tools.ts:115-135`: *"Nothing failed loudly enough for the agent to know, so
   she promised a message that was never sent."*
6. Set the `rt.callbackScheduled` latch (idempotency, same pattern as `bookingCompleted` /
   `handoffRequested`) and record on the `CallReport`.

**The tool does not end the call.** She schedules, reads back, and the conversation continues — or
she calls `end_call('callback_requested')` herself. Same separation as `book_meeting`.

---

## 4. Calling windows — honored vs proactive

Koren: *"שילוב של חלון רחב וגם מה שהלקוח מבקש — אם הוא מבקש שיחה בשעה 22:00 אז יקבל."*

Two windows, and which one applies is decided by `requested_by_lead`:

| Window | Applies to | Rule |
|---|---|---|
| **Honored** | Attempt 1 of an `explicit` callback | Whatever the lead named — subject only to the hard floor |
| **Proactive** | Soft defers, not-reached, and **every retry** | Sun–Thu 09:00–20:00 · Fri 09:00–13:00 |
| **Hard floor** | Always. No setting overrides it. | Never 23:00–07:00 · never Saturday · never `ISRAEL_HOLIDAYS` |

The rule that keeps this humane: **he asked for 22:00 once — he did not ask for 22:00 three nights
running.** The honored window covers attempt 1 only; rungs 2 and 3 fall back to proactive.

**Reuse `src/shared/operating-hours.ts`.** It already has `resolveOperatingHours(settings)`,
`isActiveSlot` (blocks Saturday and a hard-coded 2026–2027 Israeli holiday list), and
`getDelayUntilNextActiveSlot(now, cfg)` returning ms, searching up to 14 days ahead. The flow
executor already uses it to re-enqueue `make_call` steps that fall outside hours
(`flow-executor.worker.ts:97-115`) — copy that shape verbatim.

Note its default is **09:00–23:00**, wider than the proactive window proposed here. The callback
worker passes its own narrowed config rather than editing the shared default, because
`operating_hours` is a tenant-writable namespace other code already depends on.

A dial landing outside its window is **deferred, never dropped**: re-enqueued at
`getDelayUntilNextActiveSlot`, `attempt` unchanged, counted as `callbackWindowDeferrals`.

---

## 5. Scheduling mechanism — BullMQ delay, DB is the authority

A new queue `callbacks`, producer `src/queues/callbacks.queue.ts`, worker
`src/queues/workers/callbacks.worker.ts`, registered in `src/plugins/queue.ts` and `src/server.ts`
exactly as `meeting-reminders` is.

Copy `meeting-reminders.queue.ts` wholesale. It is the house pattern and it is correct:

- **Deterministic job id** — `callback-<callbackId>-a<attempt>[-d<n>]`, `-d<n>` marking a window
  deferral (BullMQ refuses to reuse a completed job's id, so a deferred copy needs a fresh one).
  Determinism is the entire reason cancellation is possible.
- `delay: Math.max(0, dueAt - now)`, `attempts: 3`, exponential backoff.
- **Fire-time authority.** The job data is a booking-time snapshot; the DB is truth. Re-check, in
  this order, each authoritative over the snapshot:
  1. the row exists and `state === 'pending'` — else skip (the cancellation backstop);
  2. `lead.status === 'opted_out'` → **never dial**. Unconditional; no tenant setting overrides it.
     Same safety boundary the reminders worker and the flow executor both enforce;
  3. the lead has since booked a meeting → `state='cancelled'`, done;
  4. tenant `callbacks.enabled === false` → skip;
  5. window check (§4) → defer or proceed;
  6. spend guard — `evaluateSpend` already runs inside `initiateOutboundCall`, so a
     `429 SPEND_LIMIT_EXCEEDED` is a **deferral**, not a failure.
- **Cancellation** — `cancelCallbacks(queue, jobIds)`, a copy of `cancelMeetingReminders`: a job
  that already ran or does not exist is not an error, because the fire-time state check is the real
  backstop.

**Redis is not the source of truth.** Add `npm run callbacks:reconcile`, modelled on
`usage:reconcile` (dry run by default, `--apply` writes): find rows with `state='pending' AND
due_at < now()` that have no live job, and re-enqueue them. The ladder spans days; a Redis flush
must not silently drop every pending callback in the system.

---

## 6. The confirmation message — and the 24-hour wall

Koren asked for a message *"שהוא ייצור קשר עוד שעה"*. **This is the part most likely to ship
broken**, and it needs saying plainly.

A lead who only ever **phoned us** has no open WhatsApp window and no recorded consent. For that
lead `resolveWhatsappSendMode` returns `blocked`, and `outbound-sender.worker.ts:90-98` **returns
rather than throws** — the send is dropped with a `whatsapp_send_blocked` log and the job reports
success. Per `whatsapp-window.ts`'s own header, **roughly 70% of leads never open a window.**

So the confirmation needs all three of:

1. **A new template key `callback_confirmation`** in `WHATSAPP_TEMPLATE_KEYS` (`whatsapp-window.ts`)
   — a Twilio Content SID the tenant gets approved themselves. Without it, a business-initiated
   send to a closed window is blocked by design, not by accident.
2. **Verbal consent** — call `grantWhatsappConsentVerbal` (already used by `book_meeting`) when she
   states on the recorded call that she will send a message. Consent without a template still
   blocks; both halves are required.
3. **A truthful return to the model** — the tool reports whether the message is going, and the
   prompt forbids promising one that isn't. Two Hebrew shapes, one per case; both are listening-
   round cards.

**Fallback when WhatsApp is blocked:** send an email if the lead has one; otherwise say nothing
about a message at all and let the call carry it. **Never promise-and-drop.**

The message goes through `enqueueOutbound` with `template: { key: 'callback_confirmation', ... }`,
**never** a direct `whatsapp.sendMessage`. The flow executor's `send_whatsapp` step
(`flow-executor.worker.ts:142-176`) bypasses the entire window/consent chokepoint — that is a bug
to avoid replicating, not a pattern to follow.

---

## 7. The ladder — fixed, and it stops

Defaults live in code as `CALLBACK_DEFAULTS`, shaped like `REMINDER_DEFAULTS`, overridable per
tenant under a new `tenants.settings.callbacks` namespace. **The numbers below are the fixed
defaults Koren asked for; the namespace exists because this is a multi-tenant product, not because
the numbers are an open question.**

**A — explicit callback (he named a time):**

| Rung | When | Window | Channel |
|---|---|---|---|
| 1 | The instant he named | **Honored** (22:00 allowed) | Call |
| 2 | +45 min | Proactive | Call |
| 3 | +1 business day, same hour | Proactive | Call |
| — | after rung 3 | — | One WhatsApp, then **stop** |

**B — soft defer ("לא עכשיו", no time given):**

| Rung | When | Window | Channel |
|---|---|---|---|
| 1 | +3 hours | Proactive | Call |
| 2 | +1 business day | Proactive | Call |
| 3 | +3 business days | Proactive | Call |
| — | after rung 3 | — | One WhatsApp, then **stop** |

**C — not reached** (rang out, voicemail, or ended on the silence reflex): enters the soft-defer
ladder at rung 1.

**Stopping is a feature, not a limitation.** `max_attempts = 3` dials, then `state='exhausted'`, one
final WhatsApp, and the lead is left alone. Moving the lead to `disqualified` is **opt-in per
tenant, off by default** — a lead who never picked up is not a lead who said no. Open question #2.

**Hard stops, checked at every rung:** `opted_out` (absolute), a booked meeting, a human handoff
already raised, or the lead replying on any channel.

---

## 8. Cancellation hooks — where pending callbacks die

Five call sites, every one additive:

| Where | File | Action |
|---|---|---|
| Meeting booked | `tools/book-meeting.tool.ts`, after invariant 2 | cancel pending callbacks |
| Lead opts out | `end-call.tool.ts :: markLeadOptedOut` | cancel, `state='cancelled'` |
| Human handoff raised | `tools/request-human-handoff.tool.ts` | cancel — a human owns it now |
| A new callback is scheduled | the tool itself | supersede the previous one |
| Operator | `DELETE /api/v1/callbacks/:id` (new, tenant-scoped, audited) | cancel |

Each wrapped in its own try/catch. **A cancellation failure must never fail a booking** — the same
rule `scheduleReminders` is already held to.

---

## 9. The prompt half

Repo convention: **prompt = guidance, code = enforcement, both on one env flag.** A piece that ships
with only one half is a bug by this repo's own rules.

`VOICE_CALLBACK_TOOL`, default **OFF**, added additively to `src/config/env.ts` and `.env.example`.
Off → the tool is not registered and the prompt section is not rendered.

Prompt additions go in `prompts/system-prompt.he.ts` and are costed against the **±5% token-neutral
assertion** in `system-prompt.test.ts`. `docs/phase-7-persona-and-humanization-plan.md` W7 already
names what to delete to pay for it: the dead `SPEECH_RHYTHM_OWN_OPENER` branch, the duplicated
"write your own words" discipline across `EMOTIONAL_COLOR` and `buildSpokenRegister`, and the
duplicated `LINES_*` tables.

Four rules — **none of them is a script**:

1. **When he defers, ask for the window once** — *"מתי יתאים לך יותר?"* This is the sales model's
   objection #4, which explicitly says timing is not an objection and gets no three-step treatment.
2. **When he names a time, call the tool, then read the resolved time back — once, and stop.**
   The read-back is what catches a misheard hour, and it is the only defence against a phone
   ringing at 04:00.
3. **Never promise a message the tool did not confirm.**
4. **A second deferral in the same call is a signal, not an invitation to ask again.** This is
   decision rule 7 of the sales model ("she does not answer the same objection twice") applied to
   timing.

### ⚠️ Listening page before code — SUPERVISOR §8.1

Every Hebrew sentence above is a **draft card for listening round 15/16**, not a line of code. The
rule exists because ~600k tokens were spent building round-8 work Koren rejected on first listen.

Cards required:

- the *"מתי יתאים לך יותר?"* ask
- **the read-back.** ⚠️ The natural phrasing *"סגרנו, אני מתקשרת אליך מחר ב-ארבע"* contains
  **`סגרנו`, which is on the `FALSE_BOOKING_WIDE` list** and will trip the false-booking guard.
  It must be reworded, and the guard re-checked against whatever replaces it.
- the "I'll send you a message" line, in **both** variants (message going / message not going)
- the ladder's final WhatsApp text

**Negation safety applies to all of them.** The 19:54 call ended because a dropped `לא` inverted a
sentence. Write every line in the positive.

---

## 10. Metrics — or the feature is unfalsifiable

The repo's own lesson, from the sales-model handoff: *"this repo has now had three separate metrics
stay green through the exact defect they existed to catch."*

On the `CallReport`: `callbackScheduled`, `callbackResolvedIso`, `callbackReadBackSpoken` (did she
actually read the time back?), and `callbackMessagePromised` vs `callbackMessageDelivered`.

Off the worker, per tenant: `callbackDialAttempts`, `callbackReached`, `callbackWindowDeferrals`,
`callbackExhausted` — and the one that decides whether this works at all:

> **`callbackPunctuality`** — the delta between `due_at` and the actual dial instant. A callback
> that fires 40 minutes late is a worse experience than no callback, and every other counter here
> stays green through it.

---

## Build order

1. **Migration `0019`** + the `callbacks` table + `leads.next_callback_at`. Claim 0019 in CLAUDE.md's
   claims line in the same commit; `npm run db:drift` after.
2. **`callback-time.ts`** — the pure resolver plus both windows. Unit tests pinning exact instants in
   **IST and IDT**, the way `israel-time.test.ts` does. No I/O, everything depends on it, cheapest
   thing to get right first.
3. **Queue + worker + cancellation + reconcile script.** Fire-time authority chain, ladder, window
   deferral. Fully testable with no LLM and no phone.
4. **`schedule_callback` tool** + `callback-settings.ts` resolver + `tools/index.ts` registration +
   `AGENT_SETTINGS_KEYS` (`voice-livekit.service.ts`) + `settings-policy.ts` allowlist.
5. **Confirmation message** — the `callback_confirmation` template key, verbal consent, truthful
   return to the model.
6. **Cancellation hooks** in the four existing tools.
7. **Prompt section**, behind `VOICE_CALLBACK_TOOL` — **only after the listening round passes.**
8. **Timeline + dashboard surface** — `GET /leads/:id/timeline` gains `callbacks`, additively. A
   "Callbacks due today" view is DASHBOARD territory; scope it separately.

**Steps 1–3 are pure backend and touch none of the contested files.** They can be built and merged
while the persona / sales-model work proceeds. That is the ordering that avoids the `agent.ts`
collision entirely.

---

## Constraints — from the code's own headers, not negotiable

- **Token-neutral ±5%**, asserted in `system-prompt.test.ts`. Step 7 pays for itself from the W7 list.
- **Every new Hebrew sentence is a listening-round card before it ships** (SUPERVISOR §8.1).
- **Every new sentence passes negation safety** — write in the positive.
- **The block ships behind its own env flag, defaulting OFF** until the A/B passes.
- **`tenants.settings.callbacks` is a new key** — add it to the claims list in CLAUDE.md in the same
  commit, to `settings-policy.ts`'s tenant-writable allowlist, and to `AGENT_SETTINGS_KEYS` so it
  reaches the agent through call metadata rather than a cold cross-region DB read.
- **`opted_out` is absolute.** No rung, no setting, no tenant override ever dials an opted-out lead.

---

## Verification

**No PSTN call is the first test.** The ladder from `voice-livekit/testing/README.md`:

1. `npm test` — `callback-time.test.ts` (both DST regimes; the honored / proactive / hard-floor
   matrix; midnight wrap), `callbacks.worker.test.ts` (every fire-time authority branch, especially
   `opted_out` and the window deferral), tool schema tests, and the `system-prompt.test.ts` token
   delta.
2. **A dry-run harness** — schedule a callback for +2 minutes with the dialer stubbed; assert the
   worker fires inside the window and increments `attempt`. This is where `callbackPunctuality`
   gets its first number.
3. `npm run voice:test` — a scenario where the lead defers: assert `schedule_callback` fires, the
   resolved instant matches what he said, and she reads it back.
4. **Listening round 15/16** — every Hebrew line, A = today, B = the proposal. **Before** step 7.
5. **Two real PSTN calls, last:** one *"תתקשר אליי עוד עשר דקות"* end to end (message arrives, phone
   rings at the minute), and one deliberate no-answer to watch rung 2 fire and the ladder stop.

**Success is not "a callbacks table exists."** It is: a lead says "call me in an hour", his phone
rings sixty minutes later ±2, he got a message in between, and if he never picks up the system gives
up after three tries instead of hounding him.

---

## Open for Koren

1. **The Hebrew wording** — every line in §9 is a first draft awaiting his ear (round 15/16).
2. **After the ladder is exhausted, does the lead become `disqualified`?** Recommendation: **no**,
   by default. Never picking up is not the same as saying no. Confirm.
3. **The proactive window** — proposed Sun–Thu 09:00–20:00 / Fri 09:00–13:00. The shared
   `operating_hours` default is 09:00–23:00, which is too wide for a call nobody asked for.
   Confirm the narrowing.
4. **`callback_confirmation` needs a Twilio-approved template** before the message half works for
   the ~70% of leads with no open window. That is an operational task, and it gates step 5.
5. **A truly unanswered ring currently lands nowhere.** `no_answer` / `voicemail` are *reflexes*
   (`call-reflexes.ts`) set when a call connects and then goes silent. A phone that simply never
   picks up surfaces only as a rejection from `createSipParticipant({ waitUntilAnswered: true })`,
   and nothing records it. This design sidesteps the gap by having the callback worker own its own
   dial result — but that means situation **C** is detected only for calls the worker itself placed.
   Detecting no-answer on *flow-executor* calls needs the `leads.last_call_outcome` column from the
   unbuilt 2026-08-27 spec. Recommendation: defer to a follow-on.
