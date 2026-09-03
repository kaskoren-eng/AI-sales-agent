# VOICE — `schedule_callback` (F1.4) + the cancellation hooks (F1.6)

**Branch:** `feature/voice-callback-tool` (off `origin/main` @ `d41cc18`)
**Date:** 2026-09-03 · **Status:** on the branch, unmerged, **flag OFF**, never run on a live call.

Builds on the three commits already on `main`: the `callbacks` table + migration 0019, the pure
resolver `callback-time.ts`, the settings resolver `callback-settings.ts`, the queue, and the
worker. **No migration was needed and none was written.**

---

## 1. What shipped

### `tools/schedule-callback.tool.ts` — the 8th tool

The schema is §3 of `docs/phase-8-callback-and-followup-model.md` verbatim: `when_kind`,
`in_minutes`, `day`, `time_hhmm`, `quote`, `reason` — plain `z.object`, every optional field
`.nullable().optional()`, no `.refine()`. It takes **no timestamp**: the model states an intent,
`callback-time.ts` turns it into an instant.

Effects, in order: resolve the lead → resolve + clamp the time → supersede any other pending
callback for that lead → insert the row and point `leads.next_callback_at` at it → enqueue the
delayed dial and write the job id back → record on the `CallReport` → return the truth.

### `tools/callback-store.ts` — closing a callback

One function, `closePendingCallbacks`, used by all four events (supersede, booking, opt-out,
handoff), plus the thin `cancelCallbacksForLead` wrapper the three hooks call. **It never throws.**

### The hooks (F1.6)

| where | note written on the row |
|---|---|
| `book-meeting.tool.ts`, after both invariants pass | `cancelled:meeting_booked` |
| `end-call.tool.ts :: markLeadOptedOut` | `cancelled:opted_out` |
| `request-human-handoff.tool.ts`, after the durable flag | `cancelled:handoff_requested` |
| `schedule-callback.tool.ts` (the supersede) | `superseded_by_schedule_callback` |

### Plumbing

- `VOICE_CALLBACK_TOOL` (`envBool(false)`) in `env.ts`, `.env.example`, `src/test/helpers.ts`,
  `src/plugins/auth.test.ts`. **OFF means the tool is not in the array `buildAgentTools` returns.**
- `ToolRuntimeContext.callbacksQueue` (`Queue | null`) — new, wired through `defaultMakeQueues`.
  The brief did not mention it; there was no callbacks queue handle on the runtime at all.
- `ToolRuntimeContext.callbackScheduled?: boolean` — optional, so the hand-built fixtures compile.
- `CallReport`: `callbackScheduled`, `callbackResolvedIso`, `callbackMoved`.

**Nothing was added to the system prompt. No new Hebrew a lead can hear.**

---

## 2. Where I departed from the brief, and why

### a. `requestedByLead` is DERIVED, not hard-coded `true` — this one matters

The brief said to call `planCallbackTime` with `requestedByLead: true, attempt: 0`. That is wrong,
and it is wrong in the direction that rings strangers late at night.

`requestedByLead: true` selects the **honored** window — the hard floor, 07:00–23:00 — instead of
the **proactive** one (Sun–Thu 09:00–20:00). That wide window exists for exactly one case (Koren,
2026-09-01: *"אם הוא מבקש שיחה בשעה 22:00 אז יקבל"*): **a time the lead named.** A soft defer names
no time. A lead who says "לא עכשיו" at 19:30 lands on rung 1 of the soft-defer ladder, +3h = 22:30,
and with `requestedByLead: true` that would be dialled — at half past ten at night, on an hour
nobody chose. `CALLBACK_LADDER_SOFT_DEFER` rung 1 is marked `proactive` precisely to forbid this.

So the tool derives it from the resolver's **basis**, not from `when_kind`: `ladder_default` →
`soft_defer` / proactive; anything else → `explicit` / honored. Basis rather than `when_kind`
because they can disagree — `at_time` with neither a day nor an hour falls back to the ladder, and
an instant nobody named is not an instant anybody asked for, whatever the model labelled it.

The same boolean goes into `callbacks.requested_by_lead`, so the worker's re-clamp at fire time
reaches the same verdict this call did. Both directions are pinned by tests (M9 and M10 below).

Consequence: `planCallbackTime` is **not** used, because its signature takes the window context up
front. `resolveCallbackDueAt` + `clampToWindow` are called directly — the two functions
`planCallbackTime` itself composes, in the same order. No window arithmetic was reimplemented.

### b. `schedule_callback` is NOT in `TOOL_NAMES` — it could not have been

`system-prompt.test.ts` asserts every entry in `TOOL_NAMES` appears in `TOOLS_PROMPT`. The brief
required both "register it beside the seven" and "do not touch the prompt"; those two are only
compatible if the name stays out of that list. `TOOL_NAMES` is documented as "the names the LLM
sees **and the prompt describes**", and the tool is registered from `buildAgentTools` regardless.
`CALLBACK_TOOL_NAME` is exported for it; `activeToolNames(rt)` returns what will actually attach.
**F1.7 moves the name into `TOOL_NAMES` in the same commit that teaches the prompt about it.**

### c. The cancellation hooks are NOT behind `VOICE_CALLBACK_TOOL`

`disconnect.ts` writes `callbacks` rows under `VOICE_DISCONNECT_TRACKING`, and the worker dials
them under `VOICE_CALLBACK_WORKER`. Neither knows about the tool's flag, so a tenant that has never
seen `schedule_callback` can have a live pending callback. Hooks behind the tool's flag would leave
that dial queued against a lead who had just opted out.

### d. Two refusals the brief did not ask for, both truthfulness

- **`callbacks.enabled: false`** → `ToolError`. The worker *skips* a disabled tenant's row and
  leaves it `pending` forever; from the lead's side that is a call that simply never comes. She
  must not promise it.
- **The insert failing** → `ToolError`. Unlike the disconnect path (which runs at shutdown and can
  only log), she is about to say a time out loud. A promise with no row behind it is the original
  defect, one level up.

An enqueue failure is *not* a refusal: the row is durable and `scripts/callbacks-reconcile.mjs`
rescues it, so the result says the time and adds that the dial is not yet automatic.

### e. A second call RESCHEDULES; it does not refuse

§3 says "set the `rt.callbackScheduled` latch (idempotency, same pattern as `bookingCompleted` /
`handoffRequested`)". Those two latches refuse a repeat. Refusing here is wrong: a lead who says
"עוד שעה" and then "רגע, עדיף מחר בבוקר" is correcting himself, and a refusal would leave him with
a phone ringing at the time he just withdrew. The supersede makes a repeat correct by construction
(at most one pending row survives), so the field is a report/guard flag, not a gate.

### f. Reuse of `resolveDisconnectLead`

The tool imports the identity ladder from `disconnect.ts` rather than copying it. Same semantics —
find or create, meter the new row, **do not** stamp `handoff_requested_at`. The name is now wrong
for its second caller; it wants moving to `lead-store.ts` and renaming (`resolveCallbackLead`), but
that is churn in three files for no behaviour change and I left it.

---

## 3. Mutation table

Every mutation applied alone, the three callback test files run, then reverted. **17/17 red.**

| # | mutation | result | the test that went red |
|---|---|---|---|
| M1 | supersede removed | RED | closes the previous pending callback and unqueues its dial before writing the new one |
| M2 | clamp-moved truthfulness branch disabled | RED | says the time MOVED, names both, and forbids reading back the one he asked for |
| M3 | flag gate forced ON | RED | OFF: the tool is NOT REGISTERED — the model cannot see a name it cannot call |
| M4 | flag gate forced OFF | RED | ON: it joins the seven, and only it |
| M5 | `book_meeting` hook removed | RED | a lead who just booked is not rung back |
| M6 | opt-out hook removed | RED | a known lead who says "take me off your list" loses his queued dial |
| M7 | handoff hook removed | RED | a lead handed to a human is not also rung by the machine |
| M8 | identity ladder bypassed (`rt.leadId` only) | RED | creates a minimal lead for an unknown caller, exactly as the disconnect path does |
| M9 | `requestedByLead` hard-coded **true** (the brief's spec) | RED | REFUSES 22:30 for a soft defer — nobody chose that hour |
| M10 | `requestedByLead` hard-coded **false** | RED | HONORS 22:00 when he asked for 22:00 |
| M11 | job id not written back to the row | RED | stores the job id on the row so the cancellation hooks have something to remove |
| M12 | enqueue uses `attempt: 1` instead of `0` | RED | writes the row, points the lead at it, queues the dial, and tells the model the time |
| M13 | tenant `enabled:false` no longer refuses | RED | refuses when the tenant has switched callbacks off, and writes nothing |
| M14 | insert failure no longer refuses | RED | refuses when the row could not be written |
| M15 | store: `exceptId` ignored | RED | never touches the row the caller asked it to skip |
| M16 | store: throws instead of swallowing | RED | swallows a failed lookup / swallows a failed update |
| M17 | store: lead pointer never cleared | RED | cancels (never supersedes) and clears the lead pointer |

M3 and M4 are run by **executing** `buildAgentTools` and reading the returned array, never by
reading `index.ts`.

---

## 4. Gate

```
npm run typecheck                                                  exit 0
npm run test:ci                    139 files · 2094 passed          exit 0
npm run build                                                       exit 0
scripts/ci/territory-check.sh feature/voice-callback-tool origin/main   exit 0
scripts/ci/migration-claims-check.sh   (highest 0019, next free 0020)   exit 0
```

---

## 5. What only a real call can settle

1. **Does gpt-5.4 actually emit the structured intent correctly?** Every test here supplies args by
   hand. Whether she maps "תתקשר אליי אחרי שש" onto `at_time`/`time_hhmm:'18:00'` rather than
   inventing `in_minutes` is a prompt question, and the prompt does not mention the tool yet (F1.7).
2. **Does she read back the CLAMPED time when it moved?** The tool result says so in capitals; a
   model that reads back the time the lead said anyway is the failure mode that matters, and no
   test can see it. This needs a call where the lead deliberately asks for an impossible hour.
3. **Punctuality.** The dial is a BullMQ delayed job; how late it fires under real load is unknown.
4. **Whether the supersede reads right to a lead who corrects himself mid-call.**

## 6. Before this can be turned on

- **F1.7 — the prompt section**, with a listening round. Until it exists the flag does nothing
  useful: the tool is registered but she is never told it is there.
- **F1.5 — the confirmation message.** Today the tool explicitly forbids her promising one.
- `VOICE_CALLBACK_WORKER=true` **and** `LIVEKIT_SIP_OUTBOUND_TRUNK_ID`. Turning the tool on without
  the worker writes durable rows that nothing dials — the exact state the table was in before.
- A per-tenant `callbacks` settings decision. Defaults are used; nobody has set one.

## 7. Questions for the architect

1. **Is the proactive window right at 20:00?** `callback-settings.ts` already flags that it
   disagrees with the shared `operating_hours` default of 23:00. Every soft defer after ~17:00 now
   slides to the next morning because of it. Koren's ear, not mine.
2. **`disconnect.ts` uses `CALLBACK_DEFAULTS.maxAttempts`, not the tenant's.** The tool uses
   `resolveCallbackSettings(...).maxAttempts`. A tenant who sets `maxAttempts: 1` gets 1 from the
   tool and 3 from a disconnect. One-line fix in `disconnect.ts`; left alone as out of scope.
3. **`resolveDisconnectLead` wants renaming/moving** now that it has two callers — see §2f.
4. **Should `disconnect.ts` enqueue its own rows?** Still not wired (per the brief). Its rows are
   durable and the reconcile script finds them, but nothing queues a job at write time.
