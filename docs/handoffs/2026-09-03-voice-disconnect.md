# VOICE — mid-call disconnect (2026-09-03)

Branch: `feature/voice-disconnect` (off `origin/main` @ `33ec70e`, in the worktree
`C:/keren-cb-disconnect`). Not merged, not deployed — supervisor's lane.

## The problem, in one line

A caller hung up in the middle of the conversation and **nothing in the system saw it**. `end_reason`
stayed NULL, no lead was flagged, no callback existed, nobody was told. Koren:
*"אסור שהוא ייפול בין הכיסאות"*.

The metrics were worse than silent about it. `metrics.service.ts` puts a NULL end reason in an
`unknown` bucket and **excludes it from the booking-rate denominator** — so every hangup made the
booking rate look *better*. I verified this by reading `assembleVoiceMetrics` (lines 165–185):
`withEndReason` only counts non-null reasons, and `bookingRatePct = booked / withEndReason`. Since
`caller_hung_up` is a non-null reason, these calls now join the denominator with no query change,
and **the reported booking rate will go DOWN once this ships**. That is the number becoming
correct, not the agent getting worse. Say so before anyone reads the dashboard.

## What shipped

**1. Detection.** `registerDisconnectListener` subscribes to `RoomEvent.ParticipantDisconnected`.
The discriminator: *the participant who left is the caller, AND `runtime.endReason` is still null,
AND the state machine is not `terminal`*.

I verified the endReason half by reading every call site of `runEndCallTeardown` — the only path to
`deleteRoom()`, which is what actually drops the SIP caller:

| path | sets the reason first? |
|---|---|
| `end-call.tool.ts:256` | yes — `rt.endReason = reason` |
| `request-human-handoff.tool.ts:396` | yes — `'handoff_requested'` |
| `agent.ts` voicemail reflex | yes — `decideVoicemailAction` always returns `endReason: 'voicemail'` |
| `agent.ts` silence reflex | **conditional** — see below |

**⚠️ I found the hole the brief asked me to look for.** The silence reflex tears down under
`if (action.teardown)` but only sets the reason `if (action.endReason)`. `decideSilenceAction`
returns `teardown: false` on *both* of its branches, so the block is unreachable today and the hole
is theoretical — but it is one word away from being real, and a false `caller_hung_up` would ring
back a lead who had already been dealt with. **Adjusted rather than shipped as-is**: the check also
refuses when `callState.isTerminal()` is true, which every code-driven ending sets. Pinned by a test
that fails if either half of the check is removed.

**2. `SYSTEM_END_REASONS` gained `'caller_hung_up'`** — code-only, never in the LLM enum.

**3. `caller_hung_up` is deliberately NOT mapped** in `DEFAULT_OUTCOME_STATUS_MAP`. A hangup tells
us nothing about the deal — lost signal, an interruption and a bad call are indistinguishable from
our end; 'disqualified' would bury a live lead and 'contacted' would overwrite what a human set.
Same reasoning that already keeps `no_answer` and `voicemail` out of that map. **See the INTEGRATIONS
request below** — the reasoning is in `disconnect.ts`, not in the CRM file, and there is a reason.

**4. Stage-aware severity.** `opening` (the AI-disclosure greeting) is a wrong number: recorded on
the report, nothing else. `discovery` onward raises the callback and the alert. The gate is enforced
in **two** places — agent.ts skips the call entirely, and `handleCallerDisconnect` refuses again,
because that function creates a lead row and pings a business owner.

**5. Callback row.** `callbacks` gets `kind='disconnected'`, `requested_by_lead=false`,
`lead_quote` = the caller's last transcript line, `due_at` = now + a new
`CALLBACK_DEFAULTS.disconnectedDelayMinutes`, clamped through the existing `clampToWindow` with
`requestedByLead: false` so the proactive window and the hard floor both apply. `leads.next_callback_at`
is set. **No worker exists yet — the row is a durable marker, intended.**

**6. Owner alert.** `notifyOwner` was **extracted verbatim** from `request-human-handoff.tool.ts`
into `tools/owner-notify.ts`; the handoff tool imports it back. New `disconnect_alert`
`WHATSAPP_TEMPLATE_KEYS` slot. Email leg via the same Resend/outbound path. Every failure is a log
line and blocks nothing.

**7. `VOICE_DISCONNECT_TRACKING`, default `false`.** OFF does not register the listener at all — not
"the handler returns early", which still changes the event loop.

**8. CallReport** gained `callerHungUp`, `hungUpAtStage`, `disconnectAlertSent`,
`disconnectCallbackId`, rendered in the `show-call-report` HEALTH block as
`CALLER HUNG UP mid-<stage>` plus the callback id and whether the owner was reached.

## Files

- `src/modules/channels/voice-livekit/disconnect.ts` (new — detection, stage rules, wiring, writes, alert)
- `src/modules/channels/voice-livekit/disconnect.test.ts` (new — 30 tests)
- `src/modules/channels/voice-livekit/tools/owner-notify.ts` (new — the extraction)
- `src/modules/channels/voice-livekit/tools/owner-notify.test.ts` (new — 11 tests)
- `agent.ts`, `call-report.ts`, `tools/end-call.tool.ts`, `tools/callback-time.ts`,
  `tools/request-human-handoff.tool.ts`, `whatsapp/whatsapp-window.ts`, `config/env.ts`, `.env.example`,
  `scripts/show-call-report.mjs`, plus `VOICE_DISCONNECT_TRACKING: false` in the two env test
  fixtures (`src/test/helpers.ts`, `src/plugins/auth.test.ts` — additive, one line each).

**No migration.** The `callbacks` table already landed on `main` in `33ec70e`. Nothing was claimed;
next free migration number is unchanged.

## Gates — what I actually ran

| gate | exit |
|---|---|
| `npm run typecheck` | 0 |
| `npm run test:ci` | **0** (judged by exit code; 132 files, 1979 passed, 6 todo, no `Errors` line) |
| `npm run build` | 0 |
| `npm run db:drift` | 0 — 222 schema columns vs 222 database columns, no drift |
| `bash scripts/ci/territory-check.sh feature/voice-disconnect origin/main` | 0 — after backing out one cross-lane edit, see INTEGRATIONS below |

**I did not take the green suite at face value.** A 30-test file that passes on its first run is a
suspect. I ran 12 mutations against the code under test and confirmed each one turned the suite red:
removing the `endReason` guard (4 failures), removing the `isTerminal` guard, removing the
`isCaller` guard, making the flag inert, making every stage alertable, removing the in-function
stage gate, flipping `requestedByLead` to true, removing `clampToWindow`, dropping
`notifyRole: 'owner'`, dropping the enqueue timebox, breaking the `<br>` email body, and ignoring
`cfg.notify` on each channel separately. All 12 were killed. Two of them survived the first attempt
and I strengthened the tests until they didn't.

**The proof the extraction was clean is that `request-human-handoff.tool.test.ts` was not touched
and stayed green** — those 27 tests assert the queued jobs field by field.

## For INTEGRATIONS (a request — I backed my own edit out)

**This is the one place the brief and the lane rules disagreed, and I chose the lane rules.**

The brief asked me to put the "deliberately unmapped" reasoning as a comment in
`src/modules/integrations/crm-sync.settings.ts`. I wrote it, then
`scripts/ci/territory-check.sh` flagged it: `src/modules/integrations/*` is INTEGRATIONS
territory, and CLAUDE.md rule 1 is "NEVER edit files in the other agent's territory". The change was
comment-only and the CI job is `continue-on-error: true`, so it would not have blocked anything —
but "it is only a comment" is how a lane boundary stops meaning anything. **I reverted it and the
territory check now exits 0.** The reasoning lives in `voice-livekit/disconnect.ts` instead.

Requested, verbatim, above `DEFAULT_OUTCOME_STATUS_MAP`:

> `caller_hung_up` IS DELIBERATELY UNMAPPED, for the same reason as `no_answer` / `voicemail`, one
> step further on. A caller who put the phone down mid-conversation has told us nothing about the
> deal — he may have lost signal, been interrupted, or hated the call, and the three are
> indistinguishable from this end. 'disqualified' would bury a lead who was still live;
> 'contacted' would overwrite whatever a human had already set. The disconnect path instead raises
> a `callbacks` row and pings the owner (see voice-livekit/disconnect.ts), which is a TODO for a
> person rather than a verdict about the lead. A tenant who wants a status move can add one
> through `statusMap`.

**Nothing breaks without it.** The behaviour is correct today by absence; the comment only stops
somebody "fixing" the gap later.

## For DASHBOARD (a request, not an edit — I did not touch your files)

`dashboard/src/pages/VoiceOps.tsx` needs `caller_hung_up` added to `REASON_ORDER`, otherwise the new
slice will fall into whatever the fallback bucket is. Nothing else is needed: `metrics.service.ts`
groups by `analysis->>'end_reason'` with no enum, so the value flows through untouched.

Worth considering at the same time, but yours to decide: a hangup slice is the one end reason that
is *bad news*, and it will sit next to `meeting_booked` in the same list.

## What only a real call can prove

**Nothing here has run on a live PSTN call.** Everything below is unverified:

1. **That `RoomEvent.ParticipantDisconnected` actually fires when a Zadarma SIP caller hangs up**,
   and fires *before* the shutdown callback runs. This is the load-bearing assumption of the whole
   feature and I could not test it — the SDK's behaviour on a SIP participant hang-up is not
   something the local harness reproduces. If it does not fire, this feature is inert and the tests
   will still all be green. **First live check: hang up mid-sentence and grep the logs for
   `caller_hung_up`.**
2. **That a graceful `end_call` does not produce a false positive.** The reasoning is sound and
   pinned by tests, but the ordering of `endReason = reason` against the real event is a race I
   verified by reading code, not by observing it. **Second live check: complete a normal call and
   confirm `caller_hung_up` does NOT appear.**
3. **That the WhatsApp `disconnect_alert` template exists.** It needs a Twilio-approved Content SID
   in `tenants.settings.whatsapp_templates.disconnect_alert` with four variables (name, phone,
   summary, link) — the same shape as `handoff_alert`. **Until that SID exists the WhatsApp leg
   will downgrade or fail; the email leg works today.** This is a Koren/ops task, not a code task.
4. **That `tenants.settings.handoff` is configured** for the tenant. It is shared with the handoff
   tool deliberately (same person, same channels). An unconfigured tenant gets a callback row and
   `disconnect_owner_not_notified` in the log.
5. **Whether 15 minutes is the right delay.** `CALLBACK_DEFAULTS.disconnectedDelayMinutes = 15` is
   my number, not Koren's. The case for it: a live conversation that stopped without an ending is
   most often a dropped line, and the honest move is to ring back while he still remembers the call.
   The case against: a caller who hung up because he had had enough is indistinguishable from a
   dropped line at this end, and he gets rung back in a quarter of an hour. **That is a judgement
   about how it feels to the person on the other end, so it is Koren's, by ear.** One edit to change.

## Questions for architect

1. **Should a disconnect create a lead row?** An inbound caller with no `leads` row gets a minimal
   one, because `callbacks.lead_id` is NOT NULL and a callback with nobody to dial is meaningless.
   It meters, matching the handoff and opt-out paths. If a hangup should not be billable, it is a
   one-line change to an `usage-metering: exempt` marker.
2. **The callback worker.** These rows accumulate with nothing dialling them. That is intended for
   now, but somebody should own the moment it stops being intended.
