# SUPERVISOR — integration session, 2026-09-03

Five commits merged to `main` today, all by me, all gated by me before the push. `main` moved
`1966801 → 80e8332`.

| commit | what |
|---|---|
| `1966801` | docs: six design files that existed only in one working tree |
| `33ec70e` | the `callbacks` table (migration 0019) + `callback-time.ts`, the pure window resolver |
| `48b7f9c` | B12 — mid-call disconnect detection, owner alert, callback row |
| `8cab633` | B10 — she says the full date when offering slots |
| `d41cc18` | F1.3 — the callbacks queue + worker (the thing that dials) |
| `80e8332` | F1.4 + F1.6 — the `schedule_callback` tool and the four cancellation hooks |

## The gate I ran on every one of them

`npm run typecheck` · `npm run test:ci` **judged by exit code** · `npm run build` ·
`scripts/ci/territory-check.sh <branch> origin/main` · `scripts/ci/migration-claims-check.sh`.
All exit 0 on every branch, run by me in the branch's own worktree, not taken on report.

Plus `npm run db:drift` on the 0019 branch: **222 schema columns vs 222 database columns, no
drift.** The implementation agent could not run it (Docker daemon down); I started Docker and ran
it. That check exists because two `scheduled_calls` columns disagreed with production from
migration 0000 and surfaced only when a real customer's booking failed.

## Nothing is deployed

`main` is now **five commits ahead of what LiveKit Cloud is running**
(`vhwowVixcTHZ` = `f414b94`). Every new behaviour is behind an env flag that is **absent from the
47-key cloud secret set**, so even a deploy of this code changes nothing until a flag is set:

- `VOICE_DISCONNECT_TRACKING` — mid-call hangup detection
- `VOICE_CALLBACK_WORKER` — the dialer
- `VOICE_CALLBACK_TOOL` — the 8th agent tool

Deploying and flipping flags needs Koren's word in the conversation. It has not been given.

## What each implementation agent found wrong in MY brief

Recording these because the pattern is the point, not the individual errors.

1. **B12** — I asked it to confirm no other path leaves `endReason` null on a normal ending. It
   found one: the silence reflex tears down under `if (action.teardown)` but sets the reason only
   `if (action.endReason)`. Unreachable today (`decideSilenceAction` returns `teardown: false` on
   both branches) and one word from being live. It added the `terminal` half of the discriminator
   and pinned both halves.
2. **B10** — my diagnosis was half right. The bad example lives in **two** places, and I only
   named the system prompt. The `check_calendar_availability` tool result carries its own copy,
   and that one arrives *in the turn* while the prompt sits thousands of tokens back. It also
   corrected me on `speech-numbers.he.ts`: it has an explicit month guard, so `"3 בספטמבר"` passes
   through untouched. My stated mechanism for that risk was wrong; the real residual risk is that
   the bare digit reaches DeepDub and the voice decides — true today, unchanged by that commit.
3. **F1.3** — I specified a per-tenant settings key shaped like `CALLBACK_DEFAULTS` without
   noticing that `clampToWindow` reads those numbers from module scope. Built as specified, a
   tenant's configured calling hours would have been **parsed and silently ignored**. It threaded
   the config through as an optional 4th parameter and left the hard floor with no field to set.
4. **F1.4** — I specified `requestedByLead: true` on every callback. That boolean selects the
   *honored* window (07:00–23:00) over the *proactive* one (Sun–Thu 09:00–20:00). A soft defer at
   19:30 resolves through the ladder to 22:30, and my spec would have rung a stranger then, on an
   hour nobody chose. It derives the flag from the resolver's **basis** instead, and pins both
   directions with mutations.

Every one of those was reported unprompted, by an agent I had explicitly told to tell me what I
got wrong. That instruction earned its place four times out of four.

## Open decisions — Koren's, on the board, none blocking

- **Should a mid-call hangup dial the lead back automatically, or only flag and alert?** The
  F1.3 agent deliberately did not wire `disconnect.ts` to enqueue: it is a product decision, and
  it is four lines whenever the answer comes.
- **`disconnectedDelayMinutes = 15`** — nobody's number but ours. A dropped line and a caller who
  had had enough are indistinguishable from our end.
- **The proactive window ends 20:00 while the shared `operating_hours` default runs to 23:00.**
  Every soft defer after ~17:00 now slides to the next morning because of it, and the flow
  executor and this worker will disagree about 21:00.

## Requests to other lanes

- **DASHBOARD**: `dashboard/src/pages/VoiceOps.tsx` `REASON_ORDER` needs a `caller_hung_up`
  slice. Note that the booking rate **will drop** when `VOICE_DISCONNECT_TRACKING` goes on:
  `assembleVoiceMetrics` excludes a NULL end reason from the denominator, so hangups have been
  inflating it. That is the number becoming correct. Verified by reading
  `metrics.service.ts:167-185` myself.
- **INTEGRATIONS**: `caller_hung_up` is deliberately absent from `DEFAULT_OUTCOME_STATUS_MAP` in
  `crm-sync.settings.ts`, same reasoning that keeps `no_answer` out. The B12 agent wrote that
  comment, hit the lane check, and reverted it rather than argue that "it's only a comment". The
  exact text to paste is in `docs/handoffs/2026-09-03-voice-disconnect.md`.

## What remains before callbacks can be switched on

Nothing in this chain has run on a live PSTN call. In particular `RoomEvent.ParticipantDisconnected`
firing when a Zadarma SIP caller hangs up is an **assumption** — no local harness reproduces it,
and if it does not fire the feature is inert while all 30 tests stay green.

- F1.5 — the WhatsApp confirmation message (lead-facing Hebrew → listening round)
- F1.7 — the prompt section teaching her the tool exists (Hebrew → listening round); it also moves
  `schedule_callback` from `CALLBACK_TOOL_NAME` into `TOOL_NAMES`
- `disconnect_alert` WhatsApp template needs an approved Twilio Content SID (email works today)
- `tenants.settings.handoff` must be configured for the owner alert to reach anyone
- Scaling: N API replicas = N workers. Concurrency is 2, the lowest in the repo, but the
  replica question is unanswered and every job here places a phone call.
