# Phase 5 (Partial): Dashboard Development

**Status:** Starting in parallel with Phase 4 (agent functions)
**Focus:** Extend the existing dashboard to support voice-livekit calls + real-time metrics + weekly review workflow
**Reference:** `docs/retell-ai-dashboard-reference.md` (Retell feature parity)

---

## Why We're Doing This Now (Parallel to Phase 4)

Phase 4 (agent tool calls) and dashboard work are **independent workstreams** — Phase 4 backends fill up `call_learnings`, `scheduled_calls`, `leads` tables; dashboard reads from those tables. Both can happen simultaneously without conflicts.

**The voice agent is live in production** — every call it handles is currently a black box. Dashboard turns that into observable behavior.

---

## Copy-Paste Prompt for Claude Code

Paste this into a fresh Claude Code session in `C:\AI Sales agent`:

```
NEW FOCUS: Dashboard development (parallel workstream to Phase 4).

CONTEXT — Where the project stands right now:
- Voice agent Keren is LIVE in production on LiveKit Cloud
- Handles inbound calls via Zadarma SIP trunk
- Stack: LiveKit + Soniox STT + OpenAI GPT-5.4 + Cartesia TTS
- Latency ~1500ms per turn (in acceptable range)
- Phase 4 (agent tool calls: calendar booking, lead capture, confirmations) 
  is happening in parallel — that work fills up DB tables

Existing docs to read FIRST (in this order):
1. CLAUDE.md — project conventions + current state
2. docs/retell-ai-dashboard-reference.md — feature parity target for our dashboard
3. docs/phase-5-dashboard-development.md — this document
4. VOICE_MIGRATION_PLAN.md — overall migration context

STEP 1 — EXPLORATION (do this before writing any code):
Explore the current dashboard state and report back to me:

a. List all files in `dashboard/` — package.json, framework (React? Next? Vue?), 
   routing, existing pages, styling approach (Tailwind? shadcn?)

b. For each existing page (overview, leads, calls, flows, call-detail):
   - What does it show today?
   - What data source does it read from?
   - Is it wired to the DB directly, or via API?
   - Does it support voice-livekit calls, or only Retell?

c. Run `npm run screenshot` (from CLAUDE.md commands) to capture the current UI. 
   Save screenshots so we can see the starting point.

d. Identify the API layer feeding the dashboard: where do dashboard requests hit 
   the Fastify backend? What endpoints exist under /api/v1/?

Report all of this back BEFORE proposing any changes. I want to see the starting 
point, not jump to solutions.

STEP 2 — PROPOSE PRIORITIES (after Step 1 is reported):
Based on what you found + the Retell reference doc + this document, propose a 
prioritized list of dashboard improvements. My focus areas (in rough order):

Priority A — MAKE VOICE-LIVEKIT VISIBLE
- Ensure the "Calls" page shows voice-livekit calls (not just legacy Retell)
- Add filter/tag for voice engine (retell | livekit)
- Add columns for latency (P50 per call), cost per call, engine used

Priority B — CALL DETAIL PAGE UPGRADE
- Show full transcript with timestamps
- Show audio waveform if possible (LiveKit egress provides recordings)
- Play/pause audio inline
- Show tool calls made during the call (once Phase 4 is live)
- Latency breakdown per turn (STT / LLM / TTS timings)
- Manual tag button: "good" / "bad" / "needs review"

Priority C — LIVE METRICS ON OVERVIEW PAGE
- Today's KPIs: calls handled, avg latency, avg cost, conversion (booked/answered)
- 7-day trend charts (line/bar): call volume, latency, cost, conversion
- Cost breakdown by provider (Cartesia, OpenAI, Soniox, Zadarma, LiveKit)
- Failed calls counter with drill-down

Priority D — WEEKLY REVIEW WIDGET
- New page: /weekly-review
- Lists 10-20 calls sampled from the last 7 days that need human review
- (For now, sampling can be random; later Phase 5 backend will provide flagged 
  calls from LLM-based analysis)
- Each call has: play button, transcript, quick tag buttons, "add to regression 
  test suite" button

Priority E — LEAD PAGE ENHANCEMENTS
- On the lead detail page, show all calls with that lead (voice + WhatsApp + email)
- Show qualification data extracted from voice (captured via Phase 4's 
  capture_lead_info tool)
- Timeline view: chronological events across all channels

For each priority, tell me:
- Estimated effort (hours or days)
- Any missing data — do we need new DB fields or API endpoints first?
- Dependency on Phase 4 (some priorities need tool call logs which are Phase 4 output)
- Recommended order

STEP 3 — EXECUTION (after I approve priorities):
Implement the top priority I approve. Follow these rules:

- Use the `frontend-design` plugin (per CLAUDE.md) for all UI work — it activates 
  automatically for UI tasks
- Follow the existing dashboard's tech stack (do NOT introduce React if it's Vue, 
  or vice versa — match what exists)
- Small commits per feature, on branch feature/dashboard-phase-5
- Do NOT modify the voice-livekit agent code — dashboard is read-only against 
  the DB (plus tag/annotation writes, which are new endpoints)
- If you need new API endpoints, add them under /api/v1/ following existing 
  auth patterns (API key OR JWT, per-tenant isolation)
- Take a screenshot after each feature is done (npm run screenshot) so I can 
  visually verify progress without running it myself

CONSTRAINTS:
- Do NOT touch src/modules/channels/voice/ (legacy Retell code)
- Do NOT touch src/modules/channels/voice-livekit/ (Phase 4 in progress by 
  another Claude Code session — merge conflict risk)
- All new dashboard queries respect tenant isolation (tenant_id filter on 
  every query — see CLAUDE.md security rules)
- Follow all conventions from CLAUDE.md
- Cost + latency data comes from call_learnings.analysis JSONB field — the 
  Phase 4 work adds those fields, so some dashboards may show "N/A" for old 
  calls until Phase 4 backfills

DELIVERABLE FORMAT:
- Step 1 completes → text report + screenshots
- Step 2 completes → prioritized list with effort estimates, wait for my approval
- Step 3 completes → for each priority: commit hash, screenshots of new UI, 
  brief demo of what's clickable, any known issues

Explain terminology as you go — I'm not a developer.
```

---

## What Success Looks Like at End of Phase 5 Dashboard

You wake up Monday morning, open the dashboard, and see:

**Overview page:**
```
Yesterday: 47 calls | 34% booked | Avg latency 1.4s | Cost $5.17
This week: 251 calls | 31% booked | 12 hot leads | 3 failed
```

**Calls page:**
- Filterable list of every call with instant search
- Click any call → full transcript, audio player, tool calls, latency graph
- Tag button to mark "needs review" for the weekly cycle

**Weekly Review page:**
- 10 flagged calls waiting for your ear
- Listen at 1.5x speed, tag, close — 30 min total time investment
- Every "bad" tag automatically becomes a regression test in the scripted 
  conversation suite (once we finish backend Phase 5)

**Result:** You go from "hoping the agent works" to **knowing exactly how it 
performs and where to improve**. This is the loop that turns Keren from a POC 
into a production sales machine that gets better every week.

---

## Coordination with Phase 4 Work

**Two Claude Code sessions running in parallel is fine** because:
1. They work on different directories (`src/modules/channels/voice-livekit/` vs 
   `dashboard/` + `src/routes/api/`)
2. Different git branches (`feature/voice-livekit-phase-4-tools` vs 
   `feature/dashboard-phase-5`)
3. Dashboard reads from DB tables that Phase 4 fills — asynchronous, not 
   conflicting

**One caveat:** if Phase 4 adds new fields to `call_learnings.analysis` (like 
tool call log, latency breakdown), the dashboard queries for those fields will 
show `N/A` for calls that predate Phase 4. **This is fine** — old calls stay 
readable, new calls get the richer view.

---

## Follow-up Prompts (After Dashboard Basics Are Done)

Once the exploration + priorities A-C are implemented, next prompts will focus on:
- Backfilling latency/cost data for historic calls where possible
- Building the backend LLM analysis pipeline (auto-flags calls for review)
- Multi-tenant dashboard views (when Koren onboards other agencies as clients)
- Public "customer share" links for showing a specific call to a lead 
  post-conversation

But those are all Phase 6+. **For now: exploration → priorities → priority A → 
priority B → …**
