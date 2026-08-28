# Voice Engine Migration — Retell → Self-Built LiveKit Pipeline

**Status (2026-08-05):** **Phases 1–5 complete. Phase 6 cutover is LIVE in production since 2026-07-29** on the ClickScales tenant (`613d826c`). **Retell was removed from the repo entirely on 2026-08-05 — see "Removal" near the end of this document.** Phase 6's own success criteria are **not yet met** — 4 production calls of the required 10, all internal verification calls, and per-minute cost is still unverified. Phase 7 (weekly iteration loop) not started.
**Owner:** Koren
**Goal:** Replace the Retell AI voice engine with a self-built voice pipeline using LiveKit + Soniox + Cartesia + OpenAI, keeping the rest of the AI Sales Agent codebase intact.

> ⚠️ **This document is the plan, kept current as a record of what was actually built.** Where the
> as-built stack diverged from the original design, the text below has been corrected in place and
> the divergence called out. The two biggest: **STT is Soniox, not OpenAI Realtime**, and **TTS is
> Cartesia `sonic-3`, not "Sonic-4"**. See "What postdates this plan" near the end for subsystems
> that were built but never appeared in the original 7 phases.

---

## Why we're doing this

Retell doesn't expose its advanced human-sounding features (audio tags, prosody control, emotion) for **Hebrew** — the primary language for our target market. We also want to own the voice IP and cut per-minute cost by ~65%.

By going direct to providers we get:
- Full Cartesia Hebrew voice quality (with expressiveness controls)
- Full control over turn-taking / barge-in tuning for Hebrew speech patterns
- Cost drop from ~$0.25/min to ~$0.08/min
- No vendor lock-in on our core product

---

## Current state of `channels/voice` (what we're replacing)

The existing module is a thin wrapper around Retell:

- `src/modules/channels/voice/voice.service.ts` (183 lines) — Retell REST client for `POST /v2/create-phone-call` and `GET /v1/call/:id`. Uses `RETELL_API_KEY`, `RETELL_AGENT_ID`, `ZADARMA_PHONE_NUMBER`.
- `src/modules/channels/voice/voice.routes.ts` (566 lines) — Webhook endpoints:
  - `POST /webhooks/voice/retell` — Retell call events
  - `POST /webhooks/voice/retell-tools` — Custom tool calls (calendar booking, etc.)
  - `GET|POST /webhooks/voice/zadarma` — Zadarma health check only
- `verifyRetellSignature()` in the routes file — HMAC signature verification for Retell webhooks.
- Circuit breaker: `retellCircuit` (5 failures → 30s cooldown).
- Dynamic variables injection: business profile + `call_learnings` → Retell agent prompt at call time.

**What we keep — the rest of the codebase is untouched:**
- All DB tables (`leads`, `conversations`, `scheduled_calls`, `call_learnings`, etc.)
- `channels/whatsapp`, `channels/email` — completely unrelated
- `scheduling/google-calendar.provider.ts` — reused as-is for booking
- `ai-engine/ai-engine.service.ts` — reused as-is for LLM generation
- Workers, queues, plugins, shared utilities — all reused

---

## Target architecture

```
Incoming call to Zadarma DID
      ↓ SIP (INVITE)
LiveKit SIP inbound trunk
      ↓
LiveKit Room (auto-created per call)
      ↓
Node.js Voice Agent (new: src/modules/channels/voice-livekit/agent.ts)
      │
      ├─→ Soniox stt-rt-v5 (STT, streaming)   [AS BUILT — default STT_PROVIDER=soniox]
      │        - Original design called for OpenAI gpt-realtime-whisper; replaced after a
      │          head-to-head on real Hebrew calls (semantic WER 4.3% vs 34.9%).
      │          OPENAI_REALTIME_MODEL is retained as a fallback via STT_PROVIDER.
      │
      ├─→ OpenAI LLM (streaming) — VOICE_LLM_MODEL ?? AI_MODEL, default gpt-5.4
      │        - System prompt built from tenant business profile + call_learnings 
      │          (same pattern as VoiceService.buildDynamicVariables())
      │        - Function tools: six shipped — see Phase 4
      │
      ├─→ Cartesia sonic-3 Hebrew (TTS, streaming)   [AS BUILT]
      │        - DeepDub is a fully built alternative behind VOICE_TTS_PROVIDER
      │          (voice-livekit/tts/deepdub.tts.ts). Koren prefers it 6:1 in blind A/B;
      │          not switched on by default.
      │
      └─→ On call end:
              - Persist transcript + recording URL to call_learnings table
              - Trigger call-analysis worker (existing)
              - If booking made: insert into scheduled_calls table
              - Send WhatsApp + Email confirmation via existing channels
```

**Key constraint:** LiveKit Agents SDK for Node.js (`@livekit/agents`) — we stay in one language (TypeScript), one repo, one deploy.

---

## Migration strategy — strangler fig pattern

We do NOT delete Retell code on day one. Instead:

1. ✅ **Build in parallel** at `src/modules/channels/voice-livekit/` — completely separate directory.
2. ✅ **Feature flag** per tenant: `settings.voice_engine = 'retell' | 'livekit'`, default `retell`.
   *(Removed 2026-08-05 along with the Retell code — there is only one engine now.)*
3. ✅ **Switch our own tenant to `livekit`** — done 2026-07-29 (tenant `613d826c`).
4. ⏳ **Migrate other tenants gradually** if there ever are any.
5. ✅ **Delete Retell code** — done 2026-08-05. The 30-day clock was overtaken by events: the vendor
   is no longer available to us, so keeping a dead path frozen bought nothing. See "Removal" below.

The flag no longer exists — it was removed with the Retell code. See "Rollback plan" and "Removal" at the bottom.

---

## Deliverables — the 7 phases

### Phase 1: Skeleton (day 1) — ✅ DONE (2026-07-13)
- Install `@livekit/agents`, `@livekit/agents-plugin-openai`, `@livekit/agents-plugin-cartesia`, `@livekit/rtc-node`
- Create `src/modules/channels/voice-livekit/` with:
  - `agent.ts` — the LiveKit Agent entrypoint (voice pipeline definition)
  - `agent.service.ts` — glue to app.db, app.env, existing services
  - `agent.routes.ts` — health check + agent dispatch webhook
  - `index.ts` — module registration
- Add all new env vars to `src/config/env.ts` with Zod validation:
  - `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
  - `CARTESIA_API_KEY`, `CARTESIA_MODEL`
  - `OPENAI_REALTIME_MODEL` (default: `gpt-realtime-whisper`) — now a fallback, see Phase 2
  - ~~`CARTESIA_VOICE_ID_HE`~~ → shipped as `CARTESIA_VOICE_ID_PRIMARY` / `_SECONDARY` / `_TERTIARY`
- Update `.env.example`

**Success criteria:** `npm run dev` boots without error, LiveKit agent can join a room in LiveKit Playground and say "שלום". — **met**; live Hebrew multi-turn agent in its own process via `npm run voice:dev`.

### Phase 2: Hebrew tuning + latency — ✅ DONE (targets partially met)
- Configure Cartesia with the best Hebrew voice (test 3, pick one) — shipped as three voice slots
- System prompt v1 in Hebrew, following the voice-prompt rules in `voice-agent-development-methodology.md` (short responses, no numbered lists, phonetic spelling for numbers, fillers, confirmation loops)
- LiveKit adaptive interruption enabled
- Latency instrumentation: log VAD, STT-first-token, LLM-first-token, TTS-first-audio per turn
- Target: P95 < 800ms, P50 < 500ms

**What actually shipped in this phase (beyond the original list):**
- **STT swapped to Soniox** (`stt-rt-v5`, `SONIOX_MAX_ENDPOINT_DELAY_MS=500`) after an A/B on a real
  Hebrew call corpus. This is the single largest divergence from the original design.
- Shadow-STT mode (`SHADOW_STT_ENABLED`) for running a second recognizer in parallel for comparison.
- Speech-guard (pronunciation + honesty), thinking-fillers during tool calls, niqqud stripping before TTS.
- DeepDub TTS adapter behind `VOICE_TTS_PROVIDER`.
- `CallReport` — per-call structured report written to `call-reports/`.

**Success criteria:** Blind test with 3 humans — they can't easily tell it's a bot. — **not formally run.**
Measured latency on the 2026-07-29 production calls: **median EOU 591ms · LLM 841ms · TTS 162ms · worst turn 1594ms · prompt cache 88%.** P50 is met; **the P95 < 800ms target is not demonstrated** — the known
blocker is that no Hebrew end-of-turn model exists, leaving EOU at roughly 0.9–1.4s.

### Phase 3: Zadarma → LiveKit SIP trunk — ✅ DONE
- Create LiveKit SIP inbound trunk using `lk sip` CLI, credentials from Zadarma dashboard
- Dispatch rule: incoming calls → dispatch agent instance
- Update `channels/voice-livekit/agent.service.ts` to extract caller phone from SIP metadata
- **Do not touch existing Retell webhook routes yet** — parallel operation

**Success criteria:** Real phone call from Koren's mobile → Zadarma → LiveKit → agent answers in Hebrew. Clean audio, no echo. — **met.** Trunk config lives at `infra/livekit-sip/inbound-trunk.json`.

### Phase 4: Business logic — Lead qualification + booking — ✅ DONE, and exceeded
Full flow described in `hebrew-voice-agent-dev-plan.md` Phase 4. Key integrations:
- Load tenant business profile via `SettingsService.getBusinessProfile()` (existing)
- Load learnings via same pattern as `VoiceService.buildDynamicVariables()` (existing)
- **Function tools — six shipped, gated per tenant behind `voice_engine` + `functions_enabled`:**
  - `check_calendar_availability(from, to)` → existing `google-calendar.provider.ts`
    *(planned name was `check_calendar_slots`)*
  - `book_meeting(name, phone, email, slot)` → insert into `scheduled_calls` + Google Calendar event.
    Guardrails added later: refuses a second booking, refuses booking straight from the greeting.
  - `end_call(reason)` → hang up gracefully. End reasons are split into `LLM_END_REASONS` vs
    `SYSTEM_END_REASONS` (`no_answer`, `voicemail`) so the model can't claim a system outcome.
  - `capture_lead_info(...)` → structured fact capture into the lead record
  - two `send_confirmation` tools → WhatsApp + Email confirmations
  - ❌ `transfer_to_human()` → **NOT BUILT.** No SIP REFER tool exists in `voice-livekit/tools/`.
- Prompt-injection defense: 20 dedicated tests; `opt_out` → DNC marking; recording-notice pre-roll and
  AI-disclosure tracking under `voice-livekit/compliance/`
- Dual daily spend caps (toll-fraud brake)
- Post-call: persist transcript + audio to `call_learnings`, trigger `call-analysis.worker.ts` (existing)
- Send confirmations via existing `channels/whatsapp` and `channels/email` outbound queues

**Success criteria:** Full end-to-end test: call → qualify → book → WhatsApp + Email arrive → event visible in Google Calendar. — **met on 2026-07-29** (Google Calendar Domain-Wide Delegation granted → real email invites + Meet links). WhatsApp confirmations are still blocked upstream on Twilio template approval (`whatsapp_send_blocked` is expected until then).

### Phase 5: Testing infrastructure (3 layers) — 🔄 MOSTLY DONE
- **Unit tests**: function tools, prompt parsing, extractor accuracy — done, ~563 tests passing
- **Scripted conversation tests**: FakeLLM scripted flow (check→book→end in order), synthetic-caller
  audio harness, browser Voice Simulator. Live under
  **`src/modules/channels/voice-livekit/testing/`**, plus `tests/hebrew-tts-niqqud-ab/`,
  `tests/hebrew-stt-corpus/` and `tests/stt-ab-test.ts`.
  *(The originally planned path `tests/voice-livekit/scenarios/*.json` was never used — do not look for it.)*
- ❌ **Conversation analysis pipeline** — the weekly cron that samples 20 real calls and LLM-scores them
  is **not built**. This is the open item in this phase.

**Success criteria:** unit + scripted layers green — **met**; weekly report file generated — **not met**.

### Phase 6: Production deploy — ✅ CUT OVER 2026-07-29, success criteria NOT yet met
- Feature flag: `voice_engine` — shipped as a **key in the `tenants.settings` JSON**, not a column
- Deploy agent to LiveKit Cloud — done (eu-central); `npm run agent:deploy` / `agent:logs`.
  Deploy gotcha found the hard way: `.dockerignore` silently broke the agent image build.
- Sentry integration — done (`src/plugins/sentry.ts`)
- Runbook — how to inspect a failed call: `call-reports/*.json` + `npm run call:report`

**Success criteria:** Koren's tenant switched to `livekit` ✅ (tenant `613d826c`), **10 real calls handled
without incident ❌ (4 so far, all Koren's own verification calls — no external inbound lead calls yet)**,
latency P95 < 800ms ❌ (see Phase 2), **cost verified < $0.12/min ❌ (never measured)**.

Three bugs were found and fixed during the cutover-day verification: the `capture_lead_info` null-loop
(gpt-5.4 sends `null`, the Zod schemas used `.optional()` → validation failed → silent retry loop, which
presented as the agent going silent for 20–44s), calendar offering one slot per day instead of a range,
and WhatsApp E.164 normalization (Twilio error 21211).

⚠️ **There is no rollback.** The Retell code was deleted on 2026-08-05 and the `voice_engine` setting
no longer exists. Fix forward.

### Phase 7: Weekly iteration loop — ⏳ NOT STARTED
- Monday morning script: pulls 20 recent calls, drops them into `weekly_review/YYYY-WW/`
- Human review file for Koren to annotate
- Claude Code prompt template for turning annotations into prompt/code improvements + regression tests

*(No `weekly_review/` directory exists yet. Note that raw material is already accumulating in
`call-reports/` — 25 real call JSONs as of 2026-08-02 — and `docs/risk/measured-findings-from-call-reports.md`
is a hand-rolled first pass at exactly this analysis.)*

---

## What postdates this plan

Subsystems that were built during the migration but were never part of the original 7 phases. They are
real, they are in the code, and an agent reading only the phase list above will not know they exist:

- **Conversation state machine (Workstream C, `feature/crm-automation`, unmerged)** — an *advisory* stage
  machine (`voice-livekit/call-state.ts`) with working memory and stage history, Hebrew stage lines
  (`call-state-lines.he.ts`), and three reflexes (`call-reflexes.ts`): silence (2-strike nudge → hang up),
  barge-in (analytics only), voicemail (behind `VOICE_AMD_ENABLED`, **default OFF**). Plus an
  objection-handling playbook in the prompt. The system prompt itself was left untouched — the layer is
  advisory by design. Four behaviours still need a live PSTN call to verify.
- **CRM automation (Workstream B, `feature/crm-automation`, unmerged)** — call outcome → lead status → push
  to Monday/Airtable, plus a GPT call summary, via one hook at the end of the LiveKit call-analysis worker.
  Per-tenant `tenants.settings.crm_sync`. `syncCallToCrm()` never throws.
- **Speech-guard, thinking-fillers, niqqud stripping** — TTS-side quality layers.
- **Compliance** — recording notice (currently **OFF**) + AI-disclosure tracking.
- **`CallReport`** — structured per-call report, the raw material for Phase 7.
- **Web-call path** — `voice-livekit/web-call.routes.ts` powers the dashboard Voice Simulator over a real
  LiveKit room, using a placeholder "Web simulator" lead.

---

## Development methodology (READ THIS BEFORE CODING)

Reference: `docs/voice-agent-development-methodology.md` (the 10 principles document).

**Non-negotiable rules for every Claude Code commit:**

1. **Never edit `system_prompt.md` without adding a regression test** proving the fix works and old behavior isn't broken.
2. **Every pipeline stage streams** — never buffer full responses between stages.
3. **Cascade architecture, not S2S** — we use LiveKit + **Soniox STT** + OpenAI LLM + **Cartesia TTS**. Don't propose speech-to-speech as an alternative, and don't "fix" the STT back to OpenAI Realtime — Soniox is the deliberate default (see Phase 2).
4. **Add latency instrumentation to any new code path.**
5. **All new code respects tenant isolation** (`tenant_id` on every query — see CLAUDE.md).
6. **Follow existing conventions** (imports use `.js` extensions, plugins use `fastify-plugin`, env validated in `src/config/env.ts`, errors use `AppError` subclasses).
7. **Test at 3 levels** — unit, scripted conversation, latency benchmark.
8. **Deploy behind feature flag** — never straight to main tenant.
9. **Voice prompt rules:** max 2 sentences per turn, no numbered lists, phonetic numbers, fillers during tool calls, confirmation loops for phone/email/date, anti-hallucination rules for prices and calendar slots.
10. **Reuse over rebuild** — use existing `google-calendar.provider.ts`, `ai-engine.service.ts`, `SettingsService`, `CallAnalysisService`. Custom code only for LiveKit-specific glue.

---

## Success Criteria (reference these in every phase completion)

### Business Success
- 70%+ of HOT leads book a meeting on first call
- 90%+ of calls end within 4 minutes
- 0 double-bookings in Google Calendar

### Technical Success
- Latency P95 < 800ms per turn
- Latency P50 < 500ms per turn
- 0 hallucinated dates or prices
- 100% of calls saved with transcript + recording

### Voice Quality Success
- Blind test: 3+ humans can't reliably identify it as a bot
- No dead air > 1.2 seconds
- Barge-in works in 95%+ of interruption attempts
- Agent never cuts off caller mid-sentence

---

## Environment variables — as built

All of these are set and in use. Full annotated list lives in `.env.example`; this is the voice subset.

```
# LiveKit
LIVEKIT_URL=wss://YOUR-PROJECT.livekit.cloud
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=

# TTS provider selection
VOICE_TTS_PROVIDER=cartesia          # cartesia | deepdub

# Cartesia (Hebrew TTS — default)
CARTESIA_API_KEY=
CARTESIA_MODEL=sonic-3
CARTESIA_VOICE_ID_PRIMARY=
CARTESIA_VOICE_ID_SECONDARY=
CARTESIA_VOICE_ID_TERTIARY=

# DeepDub (built, behind the flag above — preferred 6:1 in blind A/B, not default)
DEEPDUB_API_KEY=
DEEPDUB_VOICE_PROMPT_ID=
DEEPDUB_MODEL=dd-etts-3.2
DEEPDUB_REALTIME=true
DEEPDUB_LOCALE=he-IL
DEEPDUB_EU=true
DEEPDUB_SAMPLE_RATE=24000
DEEPDUB_ACCENT_RATIO=0.75

# STT provider selection
STT_PROVIDER=soniox                  # soniox (default) | openai
SONIOX_API_KEY=
SONIOX_MODEL=stt-rt-v5
SONIOX_MAX_ENDPOINT_DELAY_MS=500
SHADOW_STT_ENABLED=false             # run a second recognizer in parallel for comparison

# OpenAI Realtime (Hebrew STT — fallback path only)
# Uses existing OPENAI_API_KEY
OPENAI_REALTIME_MODEL=gpt-realtime-whisper

# Turn-taking
VOICE_TURN_DETECTION=vad             # no Hebrew end-of-turn model exists — VAD only
VOICE_VAD_MIN_SILENCE_MS=550
VOICE_ENDPOINTING_MIN_DELAY_MS=500
VOICE_ENDPOINTING_MAX_DELAY_MS=3000

# LLM — falls back to AI_MODEL (gpt-5.4) when unset
VOICE_LLM_MODEL=

VOICE_LANGUAGE=he
```

Zadarma and Google Calendar env vars were already present. One was added later:
`GOOGLE_CALENDAR_IMPERSONATE_USER` (Domain-Wide Delegation, needed for real invites + Meet links).

---

## Rollback plan — ⚠️ none exists

The original plan was a one-line SQL flip of `tenants.settings.voice_engine` back to `'retell'`.

**That is gone.** As of 2026-08-05 the Retell code is deleted, the `voice_engine` setting no longer
exists, and `VOICE_ENGINE_DEFAULT` was removed from the env schema. There is one engine. Fix forward.

## Removal (2026-08-05)

Retell was removed entirely — it is no longer available to us as a vendor, and the code was still
treating it as the DEFAULT engine while making live HTTP calls to a dead API.

What went: `src/modules/channels/voice/` (webhooks, HMAC verification, REST client, types), the
`voice_engine` setting and its env default, the dialer branch, the Retell live-fetch on call detail,
the audio proxy, and `RETELL_API_KEY` / `RETELL_AGENT_ID`.

What stayed: the **Zadarma recording webhooks**, which lived inside that module but are
engine-independent — extracted to `src/modules/channels/zadarma/`, still mounted at
`/webhooks/voice/zadarma` because that URL is configured in the Zadarma portal.

Two live bugs surfaced and were fixed: `POST /api/v1/calls/outbound` dialled via Retell
unconditionally (broken in production), and the call-detail page fetched the dead Retell API on
every view. Historical call transcripts were unaffected — they persist in `messages` and render
from the DB.

The sections above are kept as the record of WHY this migration happened. They describe a system
that no longer exists.

---

## References

External guides (see `docs/voice-ai-learning-resources.md` for full list):
- Vatsal Shah — Voice AI Agents 2026 Guide
- ElevenLabs — Building Voice Agents That Last (FDE workflow)
- Shekhar Gulati — Production-Ready Voice Agents (prompt lifecycle)
- LiveKit docs — https://docs.livekit.io/agents/
- LiveKit Node.js Agents — https://github.com/livekit/agents-js
