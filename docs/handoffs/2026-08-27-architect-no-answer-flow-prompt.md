# Kickoff prompt — VOICE workstream: no-answer follow-up flow + WhatsApp "call me back"

Written by the architect session (Cowork), 2026-08-27. **Run AFTER the human-handoff session has merged** (`docs/handoffs/2026-08-27-voice-human-handoff.md` exists) — both touch `end_call`, `leads`, `CLAUDE.md` claims. Paste the block below into a fresh Claude Code session.

---

You are the **VOICE agent** on this repo. Read `CLAUDE.md` first and obey the TERRITORY RULES. Branch `feature/no-answer-flow` from `feature/crm-automation` (the voice trunk — NOT `master`). Read `docs/voice-agent-development-methodology.md`, then `src/modules/flows/flow.schemas.ts`, `src/queues/workers/flow-executor.worker.ts`, `src/queues/workers/message-processor.worker.ts` (how `lead-intake` / `qualified` flows are started from `tenants.settings.flows[name]`), `src/modules/ai-engine/ai-engine.service.ts`.

## The problem

Most leads do not answer the first outbound call, and today nothing happens next. We need a follow-up sequence, **and** the lead must be able to reply on WhatsApp "call me now / call me at 5" and get called.

## Target behaviour (product decisions, final)

```
Event: outbound call ends with outcome ∈ {no_answer, busy, voicemail}   →  start flow `no-answer`

no-answer flow (tenants.settings.flows['no-answer'], config only):
  1. send_whatsapp   delay 2     skipUnless last_call_outcome=no_answer
       "היי {{name}}, זו קרן מ-{{tenantName}} — ניסיתי להתקשר לגבי הפנייה שלך. אנסה שוב בהמשך, ואם נוח לך אפשר פשוט לענות כאן מתי להתקשר."
  2. make_call       delay 270   skipUnless last_call_outcome=no_answer, skipIf lead_replied_since_step_1
  3. send_whatsapp   delay 15    skipUnless last_call_outcome=no_answer
       "לא הצלחנו להשיג אותך. אפשר לקבוע כאן: {{bookingLink}} — או לכתוב לי מתי נוח."
  → then stop. Lead status stays as-is; set `last_contact_result = 'unreached'`. No further automatic contact (Israeli spam law + goodwill).

Event: lead replies on WhatsApp with intent callback   →  start flow `callback-requested`
  1. make_call   delay = (callbackAt − now) or 1 min if "now"; operating hours already enforced by the executor.
  Also: cancel any pending `no-answer` steps for this lead (see "cancellation").
```

Timings (2 / 270 / 15 min) are **tenant config**, not code — ship these as the defaults seeded for the ClickScales tenant `613d826c` and documented in `.env.example`/docs.

## What to build — four pieces, in this order, each its own commit with tests

### A. Call outcome (the trigger)
- `leads.last_call_outcome varchar(20) NULL` + `leads.last_call_at timestamp NULL`. **Migration 0007** — claim in `CLAUDE.md` in the same commit. Values: `answered | no_answer | busy | voicemail | failed`.
- Source of truth: LiveKit SIP dial result (`voice-livekit.service.ts` dial path → SIP status codes: 486 busy, 480/408/no-answer timeout, 200 answered) and the LiveKit room `participant_left` / call-duration signal. Voicemail: treat any call that *connected* but where the agent never got a real user turn within N seconds (reuse the existing VAD/first-turn signal in `agent.ts`; propose N) as `voicemail`. Document exactly which signal maps to which outcome and where the ambiguity is — this is the piece most likely to be wrong, so instrument it (structured log event `call_outcome`, per methodology rule 4).
- Retell path (`voice.service.ts` / `voice.routes.ts` webhooks): map `call_analyzed` disconnection_reason the same way so the flow works on both engines behind the strangler-fig flag.
- When outcome ∈ {no_answer, busy, voicemail}: start flow `no-answer` exactly like `message-processor.worker.ts` starts `qualified` (same `enqueueFlowStep` shape). Guard: do not start it if the call was itself step ≥2 of the `no-answer` flow (read `ctx.flowName` in the executor) — otherwise it loops.

### B. Step conditions in the executor
- Add optional `skipUnless` / `skipIf` to `flowStepSchema` (all step types — put it on a shared base). Grammar, keep it tiny and enumerated, **no expression language**:
  `'last_call_outcome=no_answer'` (no_answer here means the set {no_answer, busy, voicemail}), `'lead_replied_since_flow_start'`, `'lead_booked'`, `'lead_opted_out'`.
- Evaluate in the executor before the step runs; on skip, log `flow_step_skipped_condition` and **still enqueue the next step** (skipping is not stopping). Add `stopIf` with the same grammar for hard stops (`lead_booked` → whole flow ends). Tests: each condition, true/false, plus "skip still advances".
- `lead_replied_since_flow_start`: needs a flow-start timestamp — pass `startedAt` in `FlowContext` (additive) and compare against the latest inbound message for the lead (`messages` table, direction inbound, tenant-scoped).

### C. WhatsApp intent: "call me"
- Extend `aiEngine.qualifyLead()` return type additively: `intent?: 'callback_now' | 'callback_at' | null`, `callbackAt?: string` (ISO, Asia/Jerusalem — reuse `israel-time.ts` helpers). Prompt the extractor with Hebrew examples: "תתקשרו עכשיו", "אפשר בחמש?", "מחר בבוקר", "עכשיו נוח". Regression test with ≥8 Hebrew phrasings incl. 3 negatives ("לא מעוניין", "תפסיקו").
- In `message-processor.worker.ts`: when intent is callback → start flow `callback-requested` with the computed delay, reply on WhatsApp with a one-line confirmation ("מעולה, אתקשר {{when}}"), and cancel pending `no-answer` jobs (below). If callbackAt is outside operating hours the executor already defers — tell the lead the real time it will happen, not the one they asked for.

### D. Cancellation
- Pending BullMQ jobs are addressable: jobId is `flow-{tenant}-{lead}-{flowName}-{step}-{ts}` (`flow-executor.queue.ts`). Add `cancelPendingFlow(queue, tenantId, leadId, flowName)` that removes delayed jobs by prefix. Call it from C, and from `book_meeting` (a booked lead must never get step 3). Test it.

## Out of scope
Dashboard UI for editing flows (DASHBOARD agent — write a spec paragraph in your handoff: flow editor needs a "condition" dropdown per step). Retry on `failed` outcome (carrier error) — log only. Anything beyond two calls + two messages.

## Definition of done
- `npm test` green, new tests for A–D.
- Real verification, both documented in the handoff: (1) call a phone that doesn't answer → WhatsApp arrives within ~2 min, second call fires after the configured delay, closing WhatsApp arrives; (2) reply "תתקשרו עכשיו" to the first WhatsApp → the call comes within ~1 min and step 2 of `no-answer` never fires (check the queue). (3) Book on the first call → no follow-ups at all.
- `PROJECT_STATUS.md` + `docs/phase-6-verification-checklist.md` updated. Handoff at `docs/handoffs/2026-08-27-voice-no-answer-flow.md`.

**Gate:** before writing code, post a plan covering exactly which signal in `voice-livekit.service.ts`/`agent.ts` you will use for each outcome in section A, and wait for approval. That mapping is the whole risk of this feature.
