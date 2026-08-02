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
| Turn detection | `vad` (Silero), min-silence **200 ms (sweep winner)** | Koren's territory — 200 ms beat 400 ms on worst-case latency, 0 cut-offs |
| Preemptive TTS | `VOICE_PREEMPTIVE_TTS=true` | Kept ON for latency (Koren's call) |
| State machine | `VOICE_STATE_MACHINE_ENABLED` | Kill-switch, default ON |
| Niqqud strip | Active (always) | Speech-path only |
| Recording notice | OFF | |
| **Warm vs cold** | **plan-tier, not a setting** | ⚠️ Free plan = scale-to-zero (cold start → "doesn't answer"); paid plan = always warm. No `min_replicas` knob exists — see below |

---

## Log

### 2026-08-02 — Persist every call's stats to the DB (call_learnings.call_report)
**What:** Per-call transcript + latency (EOU/LLM/TTS/worst-case, cutOffs, fragmentedTurns,
duplicateReplies, per-turn metrics, usage) used to live ONLY in ephemeral `lk agent logs` — lost
whenever a capture wasn't running. Now the agent writes the full `CallReport` verbatim to a new
**`call_report` jsonb column** on `call_learnings` at call end (migration **0006**, applied to the
prod Railway DB). Own column, NOT nested in `analysis` (the GPT-analysis worker overwrites `analysis`
and would wipe it). Read path: **`npm run call:stats`** (`scripts/call-stats.mjs`) — newest calls one
line each with the latency columns; `--full <id>` for transcript + per-turn metrics. Defaults to the
agent's prod DB.
**Verified end-to-end:** live call → row `442a489d` with report=true, read back from the DB (EOU 698 /
LLM 859 / TTS 945 / worst 2502 ms, 0 cut/frag/dup, transcript + per-turn metrics all present).
**Migration claim:** 0006 = `call_learnings.call_report` (VOICE, applied). Surfacing this on the
dashboard calls page is DASHBOARD territory — separate handoff.
**Status:** Shipped, committed, deployed.

### 2026-08-02 — ElevenLabs TTS integration (the full saga) → v3 voice great, but 2.2 s (fails <1 s)
**What:** Added ElevenLabs as a 3rd provider behind `VOICE_TTS_PROVIDER=elevenlabs` (official
`@livekit/agents-plugin-elevenlabs@1.5.1`). Debugged live over many calls. The matrix we learned:
- **Voice** `rvWcnzLKiWMjusauPtAj` "KEREN CLICKSCALES" is a Voice-Design **generated** voice → only
  renders right on **eleven_v3**. On flash/multilingual it's gibberish / wrong-language.
- **Websocket** (`multi-stream-input`) serves only **flash/turbo v2.5**. multilingual_v2 & v3 403 the
  handshake because the plugin sends `auto_mode`/`sync_alignment` — turning both OFF
  (`ELEVENLABS_AUTO_MODE=false`, `ELEVENLABS_SYNC_ALIGNMENT=false`) lets multilingual_v2 onto the ws.
  **v3 is HTTP-only** regardless (403 on ws).
- **HTTP path:** `ELEVENLABS_USE_HTTP=true` wraps the plugin in LiveKit `tts.StreamAdapter` →
  `synthesize()` over `POST /text-to-speech/{voice}/stream` (all models 200). This is how v3 runs.
- **language_code:** NO model on our path accepts forced `he` (flash/turbo & multilingual all reject
  it) → leave `ELEVENLABS_LANGUAGE` unset (auto-detect). `optimize_streaming_latency` is **rejected by
  v3** (silent call) → don't set `ELEVENLABS_STREAMING_LATENCY` for v3.
- **Choppiness** = ElevenLabs **3-concurrent limit** (payg tier) exceeded by preemptive TTS →
  `concurrent_limit_exceeded` → 2 s retry gaps. Fix: `VOICE_PREEMPTIVE_TTS=false` (0 errors after).
**Result:** v3-over-HTTP with the KEREN voice sounds great (Koren approved) and is smooth, but
**~2.2 s worst-case (TTS TTFB ~840 ms)** and CANNOT get under 1 s — v3 is heavy, HTTP-only, and rejects
the latency param. **Fails the <1 s requirement.** New env knobs:
`ELEVENLABS_{MODEL,LANGUAGE,AUTO_MODE,SYNC_ALIGNMENT,USE_HTTP,STREAMING_LATENCY}`.
**Next (Koren):** to hit <1 s with a Keren-like voice → **Instant Voice Clone** on multilingual_v2/turbo
over the **websocket** (~150 ms TTFB), or stay on Cartesia/DeepDub. Also: **rotate the EL API key**
(pasted in chat). Cartesia stays the shipped default; ElevenLabs is opt-in.
**Status:** Code shipped/committed/deployed; config currently on the v3-HTTP arm for evaluation.

### 2026-08-03 — Can v3 run on the TTS **websocket**? Probed it. No — and the reason is not what we thought
**Why:** ElevenLabs support told Koren "we support websockets on all our models", which contradicts
the entry above. Their docs exclude `eleven_v3` from the ws by name — but they never enumerate what
the ws *does* accept, and a second model exists that nobody here had tried:
**`eleven_v3_conversational`** ("ultra-low-latency version of Eleven v3, optimized for live
back-and-forth dialogue", added to the API Feb 2026, documented as ElevenAgents-only).
**How:** `scripts/elevenlabs-v3-ws-probe.ts` — raw `ws`, NOT the LiveKit plugin (the plugin appends
`auto_mode`/`sync_alignment`, which would confound a model-403 with a handshake-403). 24 cells:
{`stream-input`, `multi-stream-input`} × {v3_conversational, v3, flash_v2_5 control} × {KEREN
Voice-Design, Charlotte stock} × {bare, auto+sync}. Sequential — the 3-concurrent payg cap otherwise
masquerades as a model rejection.
**Result:** all 16 v3-family cells → **HTTP 403 at the upgrade, empty body**. Control passed
(flash_v2_5 ws TTFB 224–362 ms), so the harness is sound. Two things the probe settled that guessing
could not:
- **The 403 is a model-class gate, not an auth gate.** On this endpoint ElevenLabs authenticates
  *after* the upgrade: a deliberately bad API key **connects** and then returns JSON `invalid_api_key`,
  and an unknown model id also connects and returns JSON `model_not_found`. Only the v3 family is
  refused before the handshake completes. So the ws is closed to v3 by class.
- **`eleven_v3_conversational` is real and this account is not entitled to it.** Over HTTP it returns
  `401 model_access_denied` — "Your account is not authorized to access this model" — whereas a
  made-up model id returns `400 model_not_found`. It is also absent from our `GET /v1/models`
  (which does list `eleven_v3`, `tts=Y`, Hebrew ✓ — the only model in the list with Hebrew).
**Verdict:** no form of v3 renders over the standalone TTS websocket today. The residual unknown —
would the ws accept `eleven_v3_conversational` if the account were entitled — is **not testable from
here**; it needs ElevenLabs to enable the model on the key. The evidence above says probably not
(the ws refuses it at the same pre-auth gate as plain v3), but the ask is cheap and the same support
contact is the right person.
**Next (Koren):** ask support to enable `eleven_v3_conversational` on the account, then re-run
`npx tsx scripts/elevenlabs-v3-ws-probe.ts` — it will answer in ~2 minutes. Otherwise the only
websocket route to a v3 voice is the **Agents / Speech Engine** socket
(`wss://api.elevenlabs.io/v1/convai/conversation`), which also hands ElevenLabs the STT and
turn-taking — Soniox out. Koren's gate for even considering that: a recorded-call Hebrew STT A/B
against Soniox's 4.3 % semantic WER, using the `stt:ab` harness, before any live call.
**Status:** Probe committed. No shipped config touched; Cartesia still the default.

### 2026-08-02 — VAD silence-window sweep → **200 ms wins** (sweep closed)
**What:** Ran the planned real-call sweep of `VOICE_VAD_MIN_SILENCE_MS` /
`VOICE_ENDPOINTING_MIN_DELAY_MS` to kill turn fragmentation. Arms: 400/350 (A), 200/200 (baseline).
Held constant: state machine ON, niqqud strip, `VOICE_PREEMPTIVE_TTS=true`, Cartesia sonic-3, gpt-5.4.

| Arm | worstCaseMs | EOU med | LLM TTFT med | TTS TTFB med | cutOffs | dupReplies | fragTurns | preempt discards |
|---|---|---|---|---|---|---|---|---|
| **200/200 (baseline)** | **1083** | 225 | 700 | 158 | 0 | 0 | 6 | 0 |
| 400/350 (A) | 1440 | — | — | — | 0 | — | 24 | — |

**Winner: 200/200 — the tightest arm.** The 277 s / 17-turn 200 ms call is the best recorded to date:
worst-case **1083 ms** (the ~2 s the caller felt is gone), **0 cut-offs, 0 duplicate replies** (the
"repeats last words" did not occur), preemptive drafts survived (0 discards, 89% cache). Widening to
400 ms only *added* latency (1440 ms worst-case) without buying quality.
**Why the earlier "200 ms fragments" pain vanished:** it was **cold-start prompt-cache misses + echo**,
not the window — now that `TelephonyBackgroundVoiceCancellation` sits *before* the VAD, the niqqud strip
is in, and preemptive gen is surviving, 200 ms is clean. **No code change:** 200/200 is already the
deployed secret AND the `env.ts` default, so the sweep confirms the shipped config. Open item ① (turn
detection) is **closed by measurement** — the lever was echo/BVC ordering, not the VAD width.
**Residual behaviour note:** she re-drove the "who answers / how do leads reach you" qualifier a few
times — transcript shows the caller kept deflecting and never answered it, not a stage regression
(name captured cleanly, `stage_history` monotonic). `ai_disclosure: "missed"` logged — separate
compliance line to fix, not a voice defect.
**Status:** Sweep closed, config confirmed (no change needed). Arms B/700 not run — user's ear + the
200 ms numbers settled it.

### 2026-08-02 — Latency breakdown (where the ~2 s goes) + transport
**What:** Analysed the end-to-end response latency from the logged per-turn call-report metrics
(`eou`/`llm`/`tts`), consistent across calls.
| Component | Median | What it is |
|---|---|---|
| STT / turn-detection (EOU) | ~500–800 ms | VAD deciding the turn ended (endpointing, not transcription) |
| LLM time-to-first-token | ~880 ms | gpt-5.4; **meant to hide behind the EOU wait** via preemptive generation |
| TTS time-to-first-byte | ~155 ms | Cartesia — small, not the bottleneck |
| Network / SIP / server | ~150–300 ms | Zadarma ↔ LiveKit eu-central ↔ phone — minor |

**Conclusion:** The ~2 s the caller feels = **preemptive generation failing** (the LLM's 880 ms stacks on
top of the turn-detection wait instead of hiding behind it), because the **same turn-fragmentation**
that makes her re-ask invalidates the in-flight draft. It is **not** the TTS, SIP trunk, or server.
**Two levers (turn/VAD tuning — Koren's territory):** (1) `VOICE_TURN_DETECTION` `vad → stt` (Soniox
semantic endpointing, ~1113 ms → ~500 ms); (2) cut fragmentation (VAD min-silence 200 ms is very short)
→ restores preemptive generation (recovers ~880 ms) **and** fixes the re-asking flow bug. DeepDub helps
voice quality, **not** latency.
**Transport:** caller ↔ LiveKit = **WebRTC** (SIP/RTP bridged into the room); agent ↔ Soniox & Cartesia
= **WebSockets**; agent ↔ OpenAI = HTTP streaming.

### 2026-08-02 — A/B conclusion + the "re-asked my name" flow bug
**A/B (state machine ON vs OFF):** voice quality and the repeat were **the same** in both → the advisory
layer is **exonerated**; the problems are the STT/TTS pipeline. Confirmed on live calls + the full test
suite.
**"She jumped back and re-asked my name":** NOT a state-machine regression — `stage_history` was strictly
monotonic (opening → discovery → qualifying → terminal) and the name **was** captured (working memory:
קורן / website-building / warm). She re-asked because the **STT fragmented the caller's answers**, so she
mis-heard, looped on the "how many inquiries / who answers" questions, and tacked a name re-confirm onto
one loop. **Root cause = turn fragmentation**, same as the latency issue.
**Decision:** State machine stays; focus shifts to **voice quality + agent flow/speed.**

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
**Fix (corrected 2026-08-02):** There is **no `min_replicas` / "Min replicas = 1" setting** — not in
the LiveKit Cloud dashboard, not in `livekit.toml`, not in the `lk agent` CLI (verified: no scaling flag
on `create`/`deploy`/`config`, no scaling field in the toml). Warm-vs-cold is **determined by plan tier**:
per LiveKit docs, *"On certain plans, agents can be scaled down to zero replicas… the instance does a
cold start"* — **free/dev tier = scale-to-zero (cold start); paid tier = always warm.** So the real fix
is **being on a paid LiveKit plan**, or a keep-alive ping before call windows — not a toggle.
⚠️ `lk agent status` has shown Replicas `1/1/1 Running` right after a deploy, so some "doesn't answer"
incidents were actually the **`nan`-secret crash-loop + mid-flight deploy**, not scale-to-zero. Confirm
the plan tier (dashboard → Billing / Quotas & Limits) before blaming cold start again.
**Conclusion:** Not a code regression. Availability is a **plan-tier** matter, not a deploy setting.
Earlier "flip Min replicas in the dashboard" guidance was **wrong** and is retracted.

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

## Open items / decisions pending (priority order)

- [x] **① Turn detection + fragmentation** — **CLOSED by the VAD sweep (2026-08-02).** 200 ms won on a
      real call (worst-case **1083 ms** ≈ the ~1.1 s target, 0 cut-offs, 0 duplicate replies, preemptive
      surviving). Widening to 400 ms only added latency. The real lever was echo/BVC-before-VAD +
      niqqud + preemptive surviving, not the window. `stt` stays OFF (known-bad). Keep 200/200.
- [ ] **② DeepDub A/B on the real phone line** — the voice-*quality* lever (6:1 blind-A/B winner). Does
      NOT help latency. *(decision pending)*
- [ ] **③ Keep-warm = plan tier** (no `min_replicas` knob exists) — free tier scale-to-zero causes
      "doesn't answer" + cold-start artifacts; fix is a **paid LiveKit plan** or a keep-alive ping.
      Confirm current plan (dashboard → Billing / Quotas & Limits) first. *(Koren)*
- [ ] **④ Echo / acoustic-echo-cancellation** — confirm whether Keren's TTS bleeds into the STT (her
      lines transcribed as the caller). A second fragmentation/gibberish source. *(investigate)*
- [ ] **Merge gate** for `feature/crm-automation` — a clean real call landing outcomes in a connected
      CRM + reflexes verified. CRM backend still to deploy (Railway).

## Standing conclusion
The recent state-machine / context work is **sound and exonerated** — it doesn't break the voice or the
flow. The remaining problems (latency, re-asking, gibberish, voice quality) live in the **STT/TTS
pipeline**, and **turn fragmentation is the common root** of the latency and the re-asking. Fix that
first; DeepDub second for pure voice quality.

## Test status
Full suite: **567 passing**, 2 failing (pre-existing `lead.service`/`lead.routes` list tests — a
`count()` mock issue in dashboard/lead code, untouched by this branch), 5 todo.
