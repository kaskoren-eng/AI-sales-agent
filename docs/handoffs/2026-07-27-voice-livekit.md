# Handoff — voice-livekit session — 2026-07-27

Branch `feature/meeting-reminders` (pushed to origin, upstream set). 82 commits ahead of `master`;
`git merge-tree` reports a **clean merge, zero conflicts**. Full suite green except the 2
pre-existing `lead.service` failures (Koren's open work — this session touched zero leads files).

## What shipped this session (4 new commits on top of the reminders + notice work)

1. **`06c9e42` — Keren speaks from per-tenant `businessProfile`** (answer to item #2).
   businessProfile reached the agent in metadata (it's in the sanitize whitelist) but
   `buildSystemPrompt` never consumed it, so every tenant ran the hard-coded ClickScales copy. Now
   the gate-open path injects a labelled **Business Context** block from the tenant's own
   settings.businessProfile (company/description/product/audience/pricing/objections/tone).
   - Technical wiring only. The block does NOT override the CRITICAL SECURITY RULES; the sales prose
     stays Koren's. No profile / all-blank → the prompt is byte-for-byte the previous one.
   - `language` is deliberately omitted (Hebrew-first is a hard rule; a per-tenant language switch is
     a content decision — **flagged for Koren**).
   - 14 tests; existing 38 lockstep prompt tests unaffected.

2. **`21a406c` — Task 0: LiveKit calls appear in the dashboard calls list.**
   The calls list inner-joins conversations(channel='voice') to leads; nothing created that row for a
   self-built call. Now the dispatcher creates it at call init — outbound → real lead; web-call → one
   reusable per-tenant placeholder lead ("Web simulator"). Best-effort (never blocks a call). The new
   conversationId is threaded to the agent in metadata.
   - **Inbound SIP still creates no row** (no dispatcher) — follow-up.

3. **`b790300` — Analyze LiveKit calls: GPT summary + finalize the conversation** (item #3).
   The agent left call_learnings at status='pending' with no summary and the conversation 'active'.
   Now the agent enqueues a call-analysis job at shutdown; the existing worker gains a `source:'livekit'`
   branch that reads the transcript already on the row (no Whisper), runs the GPT analysis MERGED over
   the agent's own fields (tool_calls/end_reason/compliance preserved), sets status='analyzed', and
   finalizes the conversation → status='ended' + summary.
   - 5 tests. `SalesCallAnalysis` gained an optional prose `summary` (Retell path fills it too).

4. **`8f9af10` — Fix the "same short word twice" duplication.**
   Root cause (pinned by a repro harness over the real pipeline): the armed thinking filler ends in
   "..." (a sentence terminator) so guardStream flushes it as its own TTS chunk; when the reply's
   SHORT opener starts with the same word (filler "רגע..." + prompt opener example "רגע, בודקת."),
   the caller hears it twice. `withFiller` now peeks the reply's first word and drops the filler on
   collision. 7-test regression suite; existing 24 speech-guard tests unaffected.

## Open questions / for Koren

- **The exact word Koren cited ("מעולה") is NOT a filler**, so commit 4 does not explain that precise
  instance — it's most likely model-level restatement (the LLM literally repeats the reaction),
  which the pipeline voices faithfully and no guard strips. Confirming this needs a **live call**;
  can't be settled offline (`call-reports/` is empty).
- **Master merge is HELD for your go.** The branch is merge-ready and clean, but it now carries these
  4 commits you haven't reviewed, and merging 82 commits to master is a milestone, not a routine
  push. Say the word and I'll merge `feature/meeting-reminders → master` (the agreed order: this
  BEFORE dashboard-sprint-2).
- **businessProfile `language` field** — left un-wired on purpose (see #1). Your call whether Keren
  should ever switch primary language per tenant.
- **Verification gate**: the duplication fix and the businessProfile personalization both want a live
  simulator/phone call to confirm audibly before flipping the flag on the real ClickScales tenant.

## Still pending from the prior plan (unchanged)

- Recording-notice frame-size fix (100ms → ~20ms) + verify on a real phone before re-enabling.
- Twilio Content SIDs (WhatsApp templates); warm-replica decision.
- Flip `functions_enabled`/`voice_engine` on the ClickScales tenant + run the 10 real calls — only
  after the above verifications.
