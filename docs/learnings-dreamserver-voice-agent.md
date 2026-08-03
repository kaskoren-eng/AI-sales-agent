# Learnings from DreamServer's Voice-Agent Framework → applied to KEREN

**Source:** github.com/Light-Heart-Labs/DreamServer, branch `archive/voice-agent-framework`, path `resources/frameworks/voice-agent`
**Reviewed:** 2026-07-30 (architect/Cowork session)
**Context:** Their system ("Grace") is a production LiveKit multi-agent HVAC phone receptionist (Python SDK, local Whisper/Kokoro/LLM stack). Ours (KEREN) is a single-purpose Hebrew sales/booking agent (Node SDK, cloud cascade: OpenAI Realtime STT → GPT → Cartesia Sonic-4). Different domain and stack, same LiveKit Agents foundation — and they published honest postmortems, which is where the real value is.

---

## Bottom line

The most valuable part of this repo is not the code — it's the `research/` folder documenting **what failed and why**. They tried both extremes (9-agent handoff system, then a single agent that rebuilt its prompt every turn), both hurt them, and their final recommendation converges on exactly the architecture KEREN already planned: **one agent, static core prompt, tools that inject context**. This is independent production validation of our Phase 4 design. Below: 6 things to adopt, 3 to be warned by, 3 to ignore.

---

## Adopt

### 1. TTS filter layer between LLM and TTS (their `core/tts_filter.py`)
A wrapper around the TTS stage that regex-strips text before synthesis: leaked tool-call JSON (`<tool_call>`, `{"name": "route_to_..."}`), internal vocabulary ("agent", "system", "routing"), and error phrasing that should never be spoken. It also **normalizes numbers for speech**: phone numbers become digit-by-digit with pauses ("5 5 5, 1 2 3 4"), address numbers become words.

**Why this matters for us:** LLMs leak tool syntax into speech under load — it's not an "if". And for Hebrew this layer is *more* important than for English: Cartesia will read "14:30" and "052-1234567" poorly, and Hebrew numbers are gendered (שתיים/שניים), so we want a deterministic Hebrew number-and-time → words normalizer, not hope that the LLM phrases it right. This slots into Phase 2 and directly serves methodology rule #9 (phonetic numbers). Their file is a ready template — port the pattern, rewrite the regexes for Hebrew.

### 2. Production turn-detection values (from `hvac_agent.py`, tuned over real calls)
```
VAD min_silence_duration      = 0.5s
min_endpointing_delay         = 0.8s   (patience before declaring end-of-speech)
min_interruption_duration     = 0.6s   (600ms of speech required to count as barge-in)
false_interruption_timeout    = 2.5s   (recovery from false interrupts)
```
**Why:** these are hard-won defaults from production phone calls, not docs examples. They deliberately traded ~300ms of latency for fewer false endpointings and fewer false interruptions — the "agent cuts off caller mid-sentence" failure in our Voice Quality Success criteria. Use as the Phase 2 starting point, then tune for Hebrew speech rhythm (Hebrew speakers pause differently; measure, don't guess).

### 3. Layered prompt structure (their `prompts/shared.py` + `research/prompt-engineering.md`)
Four layers, assembled per call: **(1) core identity** (never changes) → **(2) call context** ("what you know so far" / "what's still needed") → **(3) domain knowledge** → **(4) pending actions**. Their shared identity block is worth copying structurally — concrete behavioral rules, not adjectives:
- One question at a time, never combined
- Brief acknowledgments ("Got it"), natural contractions
- Confirm-by-readback for critical data (phone digit-by-digit)
- Explicit NEVER list: internal terms, re-asking known info, promising prices/times
- Continuity rules: never re-introduce yourself, "anything else?" only once

**Why:** this maps 1:1 to our plan (business profile + call_learnings injection = layer 2/3), and gives KEREN's Hebrew system prompt a proven skeleton. Their finding: personality drifts when identity is restated differently in different prompt fragments — define it once, inject it everywhere.

### 4. Required-fields state validation before actions (their `core/state.py`)
Per-goal lists of required fields, validated in code — the agent cannot fire the "create ticket" tool until name + callback + site are captured.
**Why:** for KEREN, `book_meeting` must be gated the same way in code, not prompt: name + phone + confirmed slot present, else the tool returns an instructive error to the LLM ("missing phone — ask for it"). This is the cheap, deterministic guarantee behind our "0 double-bookings / 0 hallucinated bookings" criteria. Prompts ask; code enforces.

### 5. Dual-path extraction (their `core/extraction.py`)
Regex extraction of phones/names/urgency runs **alongside** the LLM during the call, plus one idempotent LLM extraction pass at call end that converts the transcript into a structured record.
**Why:** the live regex path catches data even when the LLM's attention is on conversation flow; the end-of-call pass matches exactly what our `call-analysis` worker already does. Adapt patterns to Israeli phone formats (05X-XXXXXXX, +972) and Hebrew names.

### 6. Deterministic fast paths for predictable turns (their latency research, `resources/research/voice-agent-latency-benchmarks.md`)
Their benchmark doc is solid: humans expect ~300ms turn gaps; production P50 across 4M+ calls is 1.4–1.7s; the LLM stage is the biggest variable cost (300–1000ms). Their answer: route trivially predictable turns through a deterministic path that skips the LLM entirely.
**Why for us:** the opening greeting is 100% predictable — **pre-synthesize Keren's greeting audio** and play it on room join (0ms LLM, 0ms TTS). Same candidate treatment for confirmation readbacks. Every deterministic turn also removes a hallucination opportunity. Their latency tier table (<500ms excellent / <800ms good / >1500ms broken) matches our P95<800ms target — good corroboration that the target is right.

---

## Warnings (their scars, our vaccine)

### A. The v2 postmortem: don't rebuild the prompt every turn
Their single-agent v2 rebuilt instructions on every user turn. Two consequences: (1) a **race condition** — the instruction update fired on the transcription event, *after* the LLM had already started generating, so responses used stale instructions; (2) they accumulated ~2,500 lines of loop-detection/flow-control code to patch the resulting weirdness.
**Rule for KEREN:** the core prompt is static per call. Mid-call context (learnings, captured fields) goes in via **tool results and hooks that run before LLM generation** (`on_user_turn_completed`-equivalent in the Node SDK), never via reactive per-turn prompt rewrites. If we ever feel the urge to add a "loop detector", the prompt architecture is wrong.

### B. The handoff analysis: hardcoded speech beats the LLM to the punch
Their specialists had hardcoded `on_enter()` greetings that fired before the LLM ever saw the "caller already told you X — don't re-ask" context. Result: callers repeated themselves and the carefully engineered prompt guidance was dead code.
**Rule for KEREN:** we have one agent so no handoffs — but the same bug class applies anywhere we mix scripted `.say()` calls with LLM turns (greeting, hold fillers during tool calls, closing). Any scripted line must either need zero context or check state first. Scripted speech and prompt instructions must never disagree.

### C. Multi-agent looks clean on a whiteboard, leaks at the seams
Nine agents, shared state, and still: context loss, personality fragmentation, audible seams. Their own final research doc recommends collapsing back to one agent with tool-injected knowledge.
**Rule for KEREN:** if we ever expand (objection-handling mode, human-transfer triage), expand via **tools and injected knowledge blocks, not agent swaps**. We keep full conversation history and one consistent Keren.

---

## Ignore

- **The multi-agent orchestration code itself** (`hvac_agent.py`'s 8-specialist routing, `intent_detection.py` keyword router) — built for a multi-department receptionist; KEREN is single-purpose. Their own research walks away from it.
- **The local stack** (Whisper/Kokoro/llama-server on localhost) — we're intentionally cloud cascade; their latency numbers for local components don't transfer, only the methodology does.
- **The code as a dependency** — it's Python (we're Node), it's on an archived branch, and quality is uneven (e.g. `prompt_builder.py` contains three redundant implementations of the same lookup). Treat as reference reading, never as something to vendor in.

Their `livekit-docs/` folder (15 condensed LiveKit Agents guides — turn detection, telephony/SIP, function tools, observability) is decent offline reference, but Python-flavored; our canonical source stays docs.livekit.io + agents-js.

---

## Concrete additions to our plan

1. **Phase 2:** add `tts-normalizer.ts` (Hebrew numbers/times/phones → speakable words) as an explicit deliverable; port the filter-wrapper pattern.
2. **Phase 2:** initialize turn-detection with their values (0.8 / 0.6 / 2.5) as the tuning baseline; log per-turn latency against their tier table.
3. **Phase 2/3:** pre-synthesized greeting audio on room join — first impression at ~0ms model latency.
4. **Phase 4:** code-level required-field gate inside `book_meeting` (and `transfer_to_human`) tool handlers.
5. **Phase 4:** live regex extraction for Israeli phone formats alongside the LLM.
6. **Prompt v1:** adopt the 4-layer skeleton + NEVER-list style from `shared.py`, written natively in Hebrew.
7. **Methodology doc:** add rule — static per-call prompt; context changes flow through tools/pre-generation hooks only (the v2 race-condition lesson).
