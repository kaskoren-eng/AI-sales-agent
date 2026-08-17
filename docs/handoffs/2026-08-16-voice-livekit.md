# 2026-08-16 — voice-livekit: Retell removal, then the latency hunt

Branch: `feature/crm-automation`. Agent deployed to LiveKit Cloud (`CA_azGQ9uaLxpot`).

## What shipped

**Retell is gone** (earlier in the session, see `docs/handoffs/` predecessors and the plan file).
Zadarma webhooks preserved at the same `/webhooks/voice` URL. Two live bugs fixed on the way:
`POST /api/v1/calls/outbound` was dialling a dead vendor, and the call-detail page was fetching a
dead API.

**Then: get time-to-first-audio under 1 second.** Six commits, `04e03ac` → `ce22c4d`.

| commit | what |
|---|---|
| `04e03ac` | pause-based preemptive trigger + the `deadAir` metric |
| `00f7945` | preemptive off (it cannot work); fixed the ttft median |
| `a5a6d43` | Hold Handling narrowed + mute watchdog; endpoint delay 500→1000ms |
| `ec937d3` | punctuation rescue for preemptive drafts |
| `ce22c4d` | **the instant acknowledgement** — the change that gets under 1s |

## The finding that matters

Dead air is `end-of-turn + LLM first token + TTS first byte`. Re-measured on the live stack:

```
end-of-turn ~400ms  +  LLM ttft ~974ms  +  TTS ttfb ~217ms  =  ~1.6s
```

**A real answer cannot beat ~1.6s and no pipeline work gets under it.** Confirmed three ways:

- `npm run bench:path` (new) — the speech guard releases the opener **25ms** after the first
  token. Our pipeline was already streaming correctly the whole time.
- `npm run bench:llm` — **gpt-5.4 is the fastest candidate at 808ms.** Gemini 3 Flash 825ms,
  gemini-3.5-flash 862ms, gpt-4.1-mini 954ms, gpt-5.4-mini 995ms, grok-4-1-fast-non-reasoning
  1060ms. There is no faster model to swap to.
- `npm run bench:tier` (new) — `VOICE_LLM_SERVICE_TIER=priority` is **194ms faster** than the
  default tier over 6 interleaved pairs (won 5 of 6). Keep it; the ~2x token price is pennies on
  50-token replies.

So: **under 1s is reached by speaking sooner, not answering sooner.** `VOICE_INSTANT_ACK` emits a
short receipt ("אוקיי.") from `llmNode` before the model has written a word → first audio ~620ms.

Koren's framing, which is the correct one: *"the reply time is not the problem here, the problem
is the time until the agent starts speaking."*

**It must be injected in `llmNode`, never `session.say()`.** The speech queue is
`[priority, insertion-time]` (`agent_activity.js:2926`), `say()` takes no priority parameter, and
the reply's handle is scheduled *before* `_updateAgentState('thinking')` fires — so anything armed
from that event plays AFTER her reply. That bug shipped here once already.

## Dead ends, recorded so nobody repeats them

Written up as `docs/phase-4-known-issues.md` §14 and §15.

**Preemptive generation cannot work against Soniox.** Drafts survive only on strict string
equality with the committed transcript (`agent_activity.js:1711`), and the Soniox plugin builds an
interim as `final + nonFinal` but the FINAL as `final` alone. Across four calls: 6 drafts/0 used,
then 3/1, then 0/0. The one that survived gave **248ms** of dead air — the mechanism is real, the
*trigger* cannot be made reliable. Left in the tree, off, at `VOICE_PREEMPTIVE_PAUSE_MS=0`.

**Two of our own instruments were lying while this was chased**, which is most of why it took three
sessions:

- `worstCaseMs` sums three medians that never co-occurred and is blind to overlap. Read 1466ms on
  a call experienced as 2535ms. Use `summary.deadAir`.
- `llmTtftMedianMs` averaged in LiveKit's `-1` sentinel for cancelled drafts — six discarded
  drafts pulled it to 314ms on a call whose real ttft was 820–950ms, and I reported that as the
  fix working. Now excluded and surfaced as `draftsDiscarded`.

## Also fixed

- **She could go mute indefinitely.** "רגע, מה..." matched the Hold Handling rule → model emitted
  `NO_RESPONSE_NEEDED` → guard stripped it to nothing → 20s of silence on a live call until the
  caller asked "הלו, מישהו שם?". Rule narrowed to whole-turn hold requests only, plus a
  deterministic watchdog (`VOICE_HOLD_CHECKBACK_MS=7000`) so deliberate silence always has an exit.
- **She talked over the caller.** The silence reflex checked whether *she* was busy but not whether
  *he* was speaking. Now guards on `session.userState !== 'speaking'`.
- **Hebrew TTS was gibberish** — `sonic-3.5` was missing from `MODELS_ACCEPTING_LANGUAGE`, so
  `language: 'he'` was never sent and Cartesia rendered Hebrew with English phonetics. Silent
  failure: the transcript reads as perfect Hebrew.
- **`npm run agent:deploy` never uploaded secrets.** It passed `--secrets-file` only on `create`,
  so new code shipped against stale config — the deployed agent spoke `sonic-3` for hours while
  `.env.agent` said `sonic-3.5`. Now always passes the full file.

## Open / needs Koren

1. **The verification call has not happened yet.** The acknowledgement is deployed and unproven by
   ear. Two things only he can judge: does "אוקיי." land BEFORE her answer (the ordering bug), and
   does it sound like listening or like a tic? One env var kills it: `VOICE_INSTANT_ACK=false`.
2. **Inbound calls resolve no tenant, so Keren has no tools on them** — she offered a demo on a
   call where `book_meeting` did not exist. The agent's `DATABASE_URL` is the literal placeholder
   `postgresql://unused:unused@localhost:5432/unused`, so this needs a real DB URL *and*
   `VOICE_WEBHOOK_TENANT_ID` in the agent secrets. Needs his decision on which tenant/DB.
3. **Pronunciation** — `לכה` / `אליכה` / `אותכה` from the speech-guard masculine fix are audible.
   He has deferred this ("later we will work on the talking precision").
4. **The agent sleeps to zero replicas.** No pre-warm switch exists (plan tier, not a setting), so
   the first call after idle carries a cold start and an empty prompt cache. Ignore turn 1 when
   reading any call report.
5. `OPENAI_API_KEY` rotation — deferred by Koren to the production phase.

## Merge note

`CLAUDE.md` on this branch predates the "Voice / ops scripts" list that exists on the trunk, so
the two new benches were **not** added to it — editing a diverged shared file additively is how
conflicts get made. When these branches meet, add to that list:

```
bench:path   where the reply is held before she speaks (guard vs downstream)
bench:tier   is VOICE_LLM_SERVICE_TIER=priority worth ~2x the token price
```

## Questions for architect

None blocking. One worth a decision when convenient: the acknowledgement changes how the agent
sounds on **every** turn, and it is the only route under 1s on a cascade pipeline with these
vendors. If it is judged unacceptable by ear, the honest position is that ~1.6s is the floor and
the <1s target needs a different pipeline (speech-to-speech), not more tuning.
