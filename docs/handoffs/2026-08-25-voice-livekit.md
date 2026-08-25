# 2026-08-25 — Voice/LiveKit session handoff (worktree C:/keren-rag, branch feature/voice-rag-r1)

## What shipped

- **Cloud production is fully live and gate-green.** Agent CA_azGQ9uaLxpot, version QMY7wxdVHGqf,
  eu-central (Frankfurt). The 15:59 call (472s) passed every launch-gate item end-to-end for the
  first time in the cloud: check_calendar_availability → capture_lead_info (name/email/phone) →
  book_meeting OK (real calendar event) → WhatsApp + email confirmations sent → clean end_call →
  call_learnings row in prod DB (id bfc42673) → call-analysis job enqueued.
- **Thinking filler works** (commit d6b904d): arm at 600ms into 'thinking' (was 1300 — it lost the
  race to the LLM's first token on 100% of turns; 4 armed / 0 spoken across two calls), and the
  3-per-call budget + 45s cooldown are now charged on SPOKEN fillers only (new
  Agent.onFillerSpoken hook, `thinking_filler {spoken:true}` log line). 15:59 call: 3 armed,
  3 spoken, different words each time.
- **Calendar secrets pushed to LiveKit Cloud** (GOOGLE_CALENDAR_ID / SERVICE_ACCOUNT_EMAIL /
  PRIVATE_KEY / IMPERSONATE_USER) — they had never left the laptop's .env; every prior cloud call
  ran tools_disabled reason=calendar_not_configured. Also re-pushed VOICE_LLM_SERVICE_TIER=priority
  + VOICE_LLM_REASONING_EFFORT=none for certainty (no pod restart resulted → values were already
  correct).

## TTFT research findings (why ~700-900ms)

- True floor ~520-600ms (morning clean turns) = Frankfurt→OpenAI + gpt-5.4 first token. Afternoon
  floor rises to ~670-680 (OpenAI load; priority tier already active, verified).
- **Post-abort tax ~150ms**: every new preemptive draft CANCELS the previous in-flight OpenAI
  request (SDK agent_activity.cjs onPreemptiveGeneration), killing the keep-alive socket. Turns
  right after an abort: median 914-928 vs clean 756-767 (consistent across two calls). Heavy call:
  59 draft starts / 25 aborts over 41 turns; 4 of the 5 worst turns (1.9-2.3s) were post-abort.
- NOT causes (verified): uncached prefill (no correlation, 98%-cache turn took 990ms), RAG (off in
  prod), reasoning tokens (22-47 output tokens/turn), our pre-request code.
- **Proposed next lever: HTTP/2 OpenAI client** — the plugin accepts a custom `client`; undici
  allowH2 would make a draft cancel close a stream, not the connection. Not built yet.

## Latency record book (checked all 75 call reports — user asked)

No call has EVER had a sub-1s median. Best ever: **1,280ms — today 13:21 cloud call**
(EOU 351 / TTFT 688 / TTS 241). Pre-RAG July calls were 1,395-1,800. Structural floor with the
current stack: 350 (our own VOICE_ENDPOINTING_MIN_DELAY_MS, raised for the fragment-merge fix) +
~700 (gpt-5.4) + ~200 (TTS) ≈ 1,250ms. Sub-1s requires: lower EOU floor (risks repetition
regression) and/or faster LLM (Koren's knob — he chose to stay) and/or h2 tails fix.

## Open items / decisions for Koren

- **LiveKit paid plan**: recommended for always-warm (fixes "agent wasn't available" cold starts —
  13:09 incident confirmed in Zadarma log as caller hangup during wake). Does NOT move per-turn
  latency (advised as reliability buy, Koren considering).
- **h2 client experiment** — say the word.
- **CRM merge gate**: the 15:59 call's outcome should be checkable in the CRM (call-analysis
  worker picks up learningId bfc42673) — verify, then Workstream B can merge.
- Gateway credits top-up (blocks Gemini/Grok bench rows). pgvector-on-Railway still unverified
  (prod RAG stays off).

## Gotchas rediscovered today

- `lk agent logs` tails ONE pod and dies quietly on pod restart — always restart the capture after
  update-secrets/deploy.
- Zadarma statistics/pbx API (HMAC auth, see logs/zadarma-check.mjs) is the authoritative "did a
  call even happen" source — it logs no-answer and failed attempts too. A 16:15 "call" left zero
  trace there → never reached the number (Koren later: "my mistake").
- LiveKit skips the pod restart when update-secrets values are identical — usable as a cheap
  "is the secret already X" probe.

Koren closed the phase satisfied: "ok thats good for now im satisfied for this phase."
