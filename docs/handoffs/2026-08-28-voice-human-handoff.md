# Handoff — VOICE: human handoff tool (2026-08-28)

Executing `docs/handoffs/2026-08-27-architect-human-handoff-prompt.md`. Branch
`feature/voice-human-handoff`, cut from `feature/crm-automation` (voice trunk), worktree
`C:/keren-handoff`. **Unmerged. Built and unit-tested; not yet verified on a live call.**

## Shipped

`bda5360 feat(voice): request_human_handoff — the seventh tool`

- **`tools/request-human-handoff.tool.ts`** — the tool. One argument (`reason`, ≤200 chars, redacted
  by `redactArgs`), no destination parameter. Flags the lead → pings the owner → ends the call via
  `runEndCallTeardown`, with `end_reason='handoff_requested'`. Idempotent through a new
  `rt.handoffRequested` latch (the `bookingCompleted` pattern).
- **`tools/handoff-settings.ts`** — `resolveHandoffSettings()` over `tenants.settings.handoff`,
  same never-throw resolver shape as `reminder-settings.ts`.
- **Migration 0017** `leads.handoff_requested_at` (nullable timestamptz) + `leads_handoff_idx`.
- **Prompt** — the "Human Handoff Request" section is now a slot: legacy (tools-off) render is
  byte-identical to before; the tools variant carries the escalation ladder.
- **`whatsapp-window.ts`** — new template key `handoff_alert`.
- **`outbound-sender.worker.ts`** — `metadata.notifyRole === 'owner'` → window lookup by recipient
  phone and consent implied. See "the one non-obvious edit" below.
- Tests: 21 new (tool + settings), 5 new prompt regressions, 4 new worker tests. `npm test`:
  **745 pass**, 2 failures (`lead.routes` / `lead.service` "list") which I confirmed fail identically
  at the base commit — pre-existing, unrelated, not mine to fix in this lane.

## The one non-obvious edit — please read before merging

The owner is **not a lead**. Without `notifyRole:'owner'`, `loadLeadForSend()` finds no row →
`consentGranted:false` → out-of-window → **every handoff alert silently `blocked`**. Precisely the
alert you cannot afford to lose. So owner jobs skip the `leadId` lookup (the job's `leadId` is
attribution only, and would otherwise resolve the LEAD's window for a message sent to the OWNER)
and pass `consentGranted:true` — the owner put their own number in tenant settings, that is the
consent. Everything else is unchanged: open window → freeform, closed → needs the `handoff_alert`
contentSid, else blocked and email carries it. Scoped strictly to `notifyRole:'owner'`; a test pins
that a lead job is unaffected.

## Corrections to the kickoff

1. **Migration is 0017, not 0006** (Koren approved, 2026-08-27). `main` has 0006–0016 applied in
   production; this branch's journal stops at 0005. `db:generate` here would emit a colliding 0006 —
   so 0017 is hand-written (precedent: main's 0014/0015) with a journal entry, and verified against
   a fresh local Postgres: column and index both land. Note `feature/crm-automation` still carries
   the orphaned `0006_black_randall.sql` (a `call_learnings.call_report` ALTER, never journaled);
   main regenerated it as `0006_volatile_microbe`. Someone should delete the orphan.
2. **This branch's `CLAUDE.md` predates the claims tables entirely** (82-line copy, no territory
   rules). I recorded both claims in a new "Claims made on this branch" section so the
   claim-in-the-same-commit rule is satisfied — **they must be folded into main's canonical tables
   at merge**: `0017 = leads.handoff_requested_at (VOICE)`, next free 0018; and `handoff` (VOICE)
   in the settings-key list.
3. **`docs/phase-6-verification-checklist.md` does not exist on this branch** (docs are split across
   branches). The Layer 6 item is written into `PROJECT_STATUS.md` here; the checklist itself needs
   the same one-liner from whoever holds that branch.
4. **No lead-serializer work was needed** — `lead.service.ts` uses bare `select()` (`SELECT *`) for
   list, detail and timeline, and there are no response Zod schemas, so `handoffRequestedAt` appears
   in all three automatically. The kickoff budgeted for work that the code already gives free.

## Not done — needs Koren (the merge gate)

- **Configure the tenant.** `tenants.settings.handoff` for ClickScales `613d826c`:
  `{ ownerName: "קורן", ownerPhone: "+972…", ownerEmail: "…", notify: ["whatsapp","email"] }`.
  There is no HTTP route for this key (deliberate — same as `reminders`/`crm_sync`); set it in the DB.
- **A `handoff_alert` Twilio template SID** in `settings.whatsapp_templates`. Without it, an alert
  sent outside Koren's own 24h window blocks and only the email arrives. For a first test, messaging
  the agent's WhatsApp shortly beforehand opens the window and freeform works.
- **Two calls:** Simulator (web-call) + one PSTN. Gate: owner gets the WhatsApp within 10s, the lead
  hears the handoff line, the call ends cleanly, the lead row shows `handoff_requested_at`.
  Latency numbers to be reported per the standing rule.

## For the architect — dashboard spec (one paragraph, DASHBOARD's job)

`GET /leads`, `GET /leads/:id` and `/:id/timeline` now return `handoffRequestedAt` (ISO string or
null) with no route change. The Leads list should show an urgency badge on any lead where it is
non-null, sorted/filterable by it — this is concretely the "needs attention" queue left undecided as
open decision #3 in `phase-5-dashboard-frontend-spec.md`, so it needs a tone assignment (open
decision #5, status colours, is still unsigned-off — do not improvise one). Lead Detail should show
"asked for a human · {relative time}" near the status chip, and the timeline already carries the
call whose `end_reason` is `handoff_requested`. Clearing the flag is deliberately NOT specified:
there is no "handled" action yet, and `updateLeadSchema` spreads straight into `.set()`, so if the
dashboard wants a clear-button, `handoffRequestedAt: null` via `PATCH /leads/:id` works the moment
the field is added to that schema — architect's call, since it is a write to a VOICE-owned column.

## Post-launch

Live transfer's natural hook is `runEndCallTeardown()` in `end-call.tool.ts`: it already owns the
"finish the sentence, then dispose of the room" sequence, and a warm transfer replaces exactly one
line — `jobCtx.deleteRoom()` becomes a SIP REFER to the owner's number, keeping the caller's leg up.
The tool's return value would then become "hold on, connecting you" instead of the goodbye line.
Nothing else in the flow changes, which is why it was worth composing with the teardown rather than
duplicating it.

## Questions for architect

- **Merge order.** This branch sits on `feature/crm-automation`, which is itself unmerged and
  ~33 commits from `main`, and the previous voice handoff records the deploy as blocked on a
  main↔trunk merge. This work is behind that same blocker; it does not add a new one.
- **`agent_persona` stays out of scope**, as instructed. The handoff line therefore uses the existing
  hard-coded feminine grammar (prompt-enforced) plus `ownerName` from settings. When `agent_persona`
  lands, `handoffInstruction()` is one of the places that needs the gender variant.
