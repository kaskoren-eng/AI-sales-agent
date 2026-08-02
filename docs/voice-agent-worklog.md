# Keren Voice Agent — Work Log

A running log of updates, investigations, and conclusions for the Keren voice agent
(self-built LiveKit pipeline). Newest work at the top. Maintained by the voice session.

- **Branch:** `feature/crm-automation` (unmerged — see "Merge gate" below)
- **Cloud agent:** `CA_azGQ9uaLxpot` (LiveKit Cloud, eu-central)
- **Pipeline:** Zadarma SIP → LiveKit → Soniox STT → gpt-5.4 → Cartesia sonic-3 TTS → 8 kHz phone
- **Number:** +972 55-507-0922

---

## Deployment & config state (as of 2026-08-02)

| Item | Value | Notes |
|---|---|---|
| TTS | Cartesia `sonic-3`, direct route, 24 kHz | `VOICE_TTS_ROUTE=cartesia` (the good path, not the degraded gateway) |
| TTS speed / volume | `0.9` / `1.4` | Tuned by ear for the phone line |
| STT | Soniox `stt-rt-v5` | |
| Turn detection | `vad` (Silero), min-silence 200 ms | Koren's tuning territory |
| Preemptive TTS | `VOICE_PREEMPTIVE_TTS=true` | Kept ON for latency (Koren's call) |
| State machine | `VOICE_STATE_MACHINE_ENABLED` | Kill-switch, default ON |
| Niqqud strip | Active (always) | Speech-path only |
| Recording notice | OFF | |
| **Min replicas** | **0 (scale-to-zero)** | ⚠️ Root cause of "doesn't answer" — see below |

---

## Log

### 2026-08-02 — Kill-switch + A/B test (state machine ON vs OFF)
**What:** Added `VOICE_STATE_MACHINE_ENABLED` (default ON) to disable the entire advisory
layer — reflexes, stage/working-memory tracking, and the objection prompt section — in one flag,
so we could A/B whether the state machine affects call behaviour.
**Result of the A/B:**
- **Repeat ("last two words twice") persists with the state machine OFF** → **the state machine is
  NOT the cause of the repeat.** It's the preemptive-TTS pipeline.
- Flow felt "pretty much the same, a bit of an improvement" with it off.
- Latency felt high (~2 s) on Call B — but Call B was the first call after a restart + prompt change,
  so a **prompt-cache miss** is a likely confound. Being re-tested with a clean warm ON call.
**Conclusion:** The advisory layer is exonerated for the repeat/gibberish. Unit tests already showed
zero logic regressions from the state machine; the A/B confirms it on a live call.
**Status:** Shipped, committed. A/B ongoing.

### 2026-08-02 — Niqqud strip before TTS
**What:** If the model ever emits vowel-pointed Hebrew (niqqud), `guardSpeech()` now strips it
(U+0591–U+05C7) right before Cartesia — speech-path only, never touching transcripts.
**Why:** Cartesia mispronounces pointed Hebrew (Koren previously confirmed), a suspected "gibberish"
contributor.
**Conclusion:** Defensive win. On the calls observed so far the model wasn't emitting niqqud
(0 strips logged), so it wasn't the gibberish source *those* times — but it's now impossible for
niqqud to reach the TTS.
**Status:** Shipped (always on).

### 2026-08-02 — Voice-quality root-cause investigation
Traced the three reported symptoms to their real causes:
| Symptom | Root cause | Fix / lever |
|---|---|---|
| "Repeats last few words" | `VOICE_PREEMPTIVE_TTS=true` — she starts speaking a draft before the turn is confirmed; a fragmented follow-on turn invalidates the draft → she **restarts the sentence** | Turning preemptive TTS off removes it (~466 ms latency cost). **Koren chose to keep it ON for latency.** Alternative: cut the turn-fragmentation upstream |
| "Gibberish" | (a) STT **fragmentation** chopping turns → she answers half-thoughts; (b) suspected **echo/diarization** — her own TTS transcribed as the caller | Niqqud strip shipped; echo/AEC still to investigate |
| "Low quality voice" | Cartesia sonic-3 Hebrew over an 8 kHz phone line — a **voice-model ceiling**, not a bug | **DeepDub** (Koren's 6:1 blind-A/B winner) is the lever, not yet pulled |
**Conclusion:** The quality problems live in the STT/TTS pipeline, not the agent logic or state machine.

### 2026-08-02 — Silence reflex hang-up fix
**What:** Real-call test caught the silence reflex ending a call: on a normal thinking-pause it
escalated to strike 2 and **hung up** (`no_answer`). Fixed so the silence reflex **never tears down** —
strike 1 gentle check-in, strike 2 "I'm here, no rush", then it holds the line quietly. A genuinely
disconnected caller is handled by the SDK's `participant_disconnected`, not this reflex.
**Conclusion:** Confirmed fixed on the next live call (`reflex_silence strike:1, teardown:false`, no
hang-up). The real-call gate did its job.
**Status:** Shipped, committed.

### 2026-08-02 — "Agent doesn't answer" root cause (cold start)
**What:** Inbound calls weren't being answered. Traced to **scale-to-zero + heavy cold start**: the
agent sleeps when idle; waking it for a call takes up to ~60 s (heavy import graph), but a phone rings
for only ~30 s — so the call drops before she joins. Affects **both** builds; not a code bug.
**Fix:** Keep one **warm replica (Min replicas = 1)** in the LiveKit Cloud dashboard. **Pending — this
is a dashboard setting only Koren can flip.** Until then, each test needs a redeploy/restart to warm her.
**Conclusion:** Not a regression from any recent work; a deployment-scaling setting.

### 2026-08-02 — Deploy-script fix (assets/)
**What:** `Dockerfile.agent` COPYs `assets/` (the compliance recording-notice WAV) but the deploy
staging script omitted it → `lk agent deploy` failed at "COPY assets ./assets: not found". Added
`assets` to the staged context.
**Status:** Shipped, committed.

### 2026-07-31 — Conversation state machine + reflexes (C1–C5)
**What:** An **advisory** awareness layer around the prompt (prompt stays intact; nothing mutates
instructions/chatCtx/tools mid-call, so preemptive generation is untouched):
- Coarse monotonic **stage** (opening → discovery → qualifying → scheduling → closing → terminal)
- **Working memory** — a compact mirror of captured facts (name, business, pain, budget, qualification)
- **Situational reflexes** — silence, barge-in, voicemail (AMD, outbound-only + flag-off)
- **Guardrails** — one booking per call, no booking during the greeting
- **Objection playbook** in the prompt (tools variant)
- Persistence into `call_learnings.analysis` (final_stage, stage_history, situations, working_memory)
**Conclusion:** Working memory captured well on real calls (e.g. name / business / pain / hot-lead read).
Unit tests: all green. A/B (above) confirms it does not cause the voice-quality issues.
**Status:** Built, committed, unmerged.

### 2026-07-30 — CRM automation (Workstream B1 + B2)
**What:** On call end, map outcome → lead status and push status + GPT summary to the tenant's CRM
(Monday + Airtable), per-tenant, circuit-breakered, graceful (never throws).
**Status:** Built, committed, unmerged. Not yet deployed (backend worker, Railway — separate from the
LiveKit agent).

---

## Conclusions so far

1. **The recent state-machine / context work did NOT break Keren's behaviour.** Full test suite is
   green except 2 unrelated pre-existing dashboard/lead failures; the live A/B shows the repeat/gibberish
   persist with the state machine OFF. The culprits are in the STT/TTS pipeline.
2. **The repeat** = preemptive TTS restarting invalidated drafts (kept ON for latency by choice).
3. **The gibberish** = STT fragmentation + suspected echo; niqqud ruled out as a *current* cause.
4. **The low voice quality** = Cartesia sonic-3 over 8 kHz. The real lever is **DeepDub**.
5. **"Doesn't answer"** = cold-start vs SIP ring timeout; fix is a warm replica (dashboard).

## Open items / decisions pending

- [ ] **Min replicas = 1** in LiveKit dashboard — stops "doesn't answer" and cold-start audio artifacts. *(Koren)*
- [ ] **DeepDub A/B on the real phone line** — the highest-leverage voice-quality lever. *(decision pending)*
- [ ] **Echo / acoustic-echo-cancellation** — confirm whether Keren's TTS is bleeding into the STT (her
      lines transcribed as the caller). *(investigate)*
- [ ] **Turn fragmentation** — VAD/endpointing tuning to stop chopping turns (also reduces the repeat). *(Koren's tuning)*
- [ ] **Merge gate** for `feature/crm-automation` — a clean real call landing outcomes in a connected
      CRM + reflexes verified. CRM backend still to deploy (Railway).

## Test status
Full suite: **567 passing**, 2 failing (pre-existing `lead.service`/`lead.routes` list tests — a
`count()` mock issue in dashboard/lead code, untouched by this branch), 5 todo.
