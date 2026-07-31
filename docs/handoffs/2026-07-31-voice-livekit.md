# Handoff — voice-livekit — 2026-07-31 (conversation state machine + reflexes)

Branch **`feature/crm-automation`** (continues the voice line). **Not merged/pushed** — the reflexes
need a real-call check first (below). Full build clean; suite **563 passing**, the only 2 failures are
the pre-existing `lead.service`/`lead.routes` `list` tests (untouched). Plan file:
`~/.claude/plans/read-voice-migration-plan-md-claude-md-a-quizzical-scone.md`.

## What shipped — 5 commits (C1–C5)

An **advisory** awareness layer around the existing prompt (prompt stays intact). The LLM still
speaks 100% naturally; nothing mutates instructions/chatCtx/tools mid-call, so preemptive generation
(and her speed) is untouched.

- **C1 (0e8ee16)** — pure engine: `call-state.ts` `CallStateMachine` (coarse monotonic stage
  opening→…→terminal, a `knownFacts` working-memory mirror, a situations log, clock-injected
  `serialize()`), `call-reflexes.ts` (pure `decideSilenceAction`/`decideVoicemailAction`),
  `call-state-lines.he.ts` (**Koren's content**: per-stage silence nudges, wrap, voicemail msg,
  objection playbook). 18 tests. No wiring.
- **C2 (698d491)** — split end-call reasons: `LLM_END_REASONS` (model-pickable) vs
  `SYSTEM_END_REASONS` (`no_answer`,`voicemail` — reflex-only, kept out of the tool's enum). Extracted
  `runEndCallTeardown()` from end_call so reflexes hang up the same clean way. CRM maps both new
  reasons to no-status-change.
- **C3 (d49a2f2)** — threaded the machine through the agent (one per call, before the runtime so it
  exists even gate-closed; advanced on turns in ConversationItemAdded + on tool success). Guardrails
  in book_meeting: refuse a 2nd booking (security rule #4, now code-enforced) and refuse booking out
  of the greeting (stage=opening). Tool advancement is optional-chained so unrelated test fakes are
  unaffected.
- **C4 (383a920)** — the three reflexes in agent.ts, all fixed `session.say()` lines:
  - **Silence** (`UserStateChanged→'away'`, not terminal, agent not speaking/thinking): strike 1
    stage-scoped nudge; strike 2 wrap + hang-up (`no_answer`).
  - **Barge-in** (`OverlappingSpeech`/`AgentFalseInterruption`): analytics only (SDK already yields).
  - **Voicemail** (`voice.AMD`, **outbound-only + `VOICE_AMD_ENABLED` default OFF**): on `isMachine`,
    leave the message + hang up (`voicemail`). Wrapped so it can never fail a call.
  - Persistence: `callState.serialize()` (final_stage, stage_history, situations, working_memory)
    spread into the teardown `analysis` literal; `SalesCallAnalysis` gained the 4 optional fields.
    Merge-safe, invisible to the CRM sync.
- **C5 (2ab94be)** — objection playbook rendered into a new `## Objection Handling` prompt section
  (tools variant only; legacy prompt byte-stable). Objection *typing* is semantic → prompt-side (no
  silent tool, per the chosen architecture).

## Needs a real call before merge (the reflexes are the only unverified part)
1. `UserStateChanged→'away'` actually fires (~15s) on a live PSTN line with telephony noise-cancel on.
2. `OverlappingSpeech` emits in this cascade config (else barge-in falls back to
   `AgentFalseInterruption` only).
3. With `VOICE_AMD_ENABLED=true` on an OUTBOUND call: `amd_prediction` fires on a real voicemail and
   leaves inbound untouched.
4. A `say()` nudge lands cleanly mid-call without clipping the caller.
Report latency after any test call (standing rule). Everything else (engine, guardrails, working
memory, persistence, objection prompt) is fully unit-tested and needs no call.

## Content to refine (Koren's)
`call-state-lines.he.ts` — the silence nudges/wrap/voicemail wording and `OBJECTION_PLAYBOOK_HE` are
starter values; edit freely without touching the engine.

## Follow-ups (not built)
- A dashboard panel rendering `analysis.working_memory` + `stage_history` (dashboard territory).
- AMD tuning (interruptOnMachine, message-by-category) once #3 above is verified.
