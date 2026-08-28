# Sprint 2 Spec — CallDetail v2: Surface the Agent's Self-Analysis

> **Owner:** Koren · **Implement in:** Cursor (Claude) · **Est:** 2–4 focused sessions
> **Prerequisite reading:** none — this spec is self-contained. All file paths are relative to repo root.

---

## 1. Goal & Why

Every LiveKit call already writes a rich `call_learnings` row: tool invocations with timing,
end reason, compliance evidence (recording notice + AI disclosure), and — after the
`call-analysis` worker runs — a full GPT sales analysis (pain points, objections,
effectiveness score, recommendations).

**None of it reaches the dashboard.** `GET /api/v1/calls/:id` only fetches analysis live from
the retired engine's legacy path. The LiveKit path — our future — renders as an empty "AI Analysis" card.

This sprint closes that gap. Outcome: opening a call page shows *everything the agent knew,
did, and learned* — turning the agent from a black box into an evaluable product
(the stated Phase 5 goal in `docs/phase-5-dashboard-development.md`).

**Read-only sprint.** No new writes, no schema changes. We render data that already exists.

---

## 2. Data linkage (critical to understand first)

| Path | Conversation link | Analysis source |
|---|---|---|
| Retired engine (historical rows) | `conversations.channelRef` = the old vendor's `call_id` | Rendered from the DB (`messages`, content_type='transcript'). The live API fetch was deleted 2026-08-05 |
| LiveKit (current) | `conversations.channelRef` = LiveKit room name (`call-out-<uuid>` / `web-call-<uuid>`) | `call_learnings` row where `conferenceName` = room name |

`call_learnings` columns of interest (see `src/db/schema/call-learnings.ts`):

- `transcript: TranscriptSegment[]` — `{ speaker, text, start?, end? }`
- `analysis: SalesCallAnalysis` — the JSONB goldmine:
  - `tool_calls[]: { atMs, name, durationMs, ok, error? }` (written by agent at teardown)
  - `end_reason?: string` — `meeting_booked | not_qualified | opt_out | ...`
  - `recording_notice_played?: boolean`, `recording_notice_at?: string`
  - `ai_disclosure?: 'during_call' | 'at_end' | 'missed'`
  - After worker analysis: `pain_points_uncovered[]`, `objections[] { objection, response, handled_well }`,
    `what_worked[]`, `what_didnt_work[]`, `key_questions_asked[]`, `overall_effectiveness_score` (0–10),
    `recommendations[]`, `opening_technique`, `closing_technique`, `rapport_building`
- `outcome: 'won' | 'lost' | 'neutral' | null`
- `status: 'pending' | 'transcribing' | 'analyzed' | 'failed'`
- `durationSecs`, `recordingUrl`, `label` (`'livekit'` for agent-written rows)

⚠️ **Verify before building:** confirm the LiveKit outbound/web-call path actually creates a
`conversations` row with `channelRef` = room name. `voice-livekit.service.ts` line ~46 documents
the intent; if the row isn't created yet, add that to Task 0 (small backend fix) — otherwise the
join has nothing to join on.

---

## 3. Backend changes

### 3.1 `src/modules/calls/calls.service.ts`

Extend `getCall()`:

```ts
// After loading the conversation row, look up the learnings row:
const [learnings] = await this.db
  .select()
  .from(callLearnings)
  .where(and(
    eq(callLearnings.tenantId, tenantId),
    eq(callLearnings.conferenceName, row.channelRef ?? ''),
  ))
  .limit(1);
```

Rules:
- Only attempt when `row.channelRef` is set. Missing row → `learnings: null` (never 500).
- If `learnings.transcript` is non-empty and the existing transcript (`messages` fallback)
  is empty, map `TranscriptSegment[]` → `CallTranscriptTurn[]`
  (`speaker` → `role` (map `'agent'|'assistant'` → `'agent'`, else `'user'`), `text` → `message`,
  `start` → `time_in_call_secs`).
- Import `callLearnings` from `../../db/schema/index.js`.

### 3.2 Response shape — extend `CallDetail` (backend type + `dashboard/src/lib/types.ts`)

```ts
export interface CallLearnings {
  status: 'pending' | 'transcribing' | 'analyzed' | 'failed'
  outcome: 'won' | 'lost' | 'neutral' | null
  end_reason: string | null
  tool_calls: Array<{ atMs: number; name: string; durationMs: number; ok: boolean; error?: string }>
  compliance: {
    recording_notice_played: boolean | null
    recording_notice_at: string | null
    ai_disclosure: 'during_call' | 'at_end' | 'missed' | null
  }
  sales_analysis: {
    overall_effectiveness_score: number | null
    opening_technique: string | null
    closing_technique: string | null
    rapport_building: string | null
    pain_points_uncovered: string[]
    objections: Array<{ objection: string; response: string; handled_well: boolean }>
    key_questions_asked: string[]
    what_worked: string[]
    what_didnt_work: string[]
    recommendations: string[]
  } | null   // null while status is 'pending'/'transcribing' — UI shows "analysis in progress"
}

// CallDetail gains:
learnings: CallLearnings | null
```

Build this mapping in the service (one pure function `mapLearnings(row): CallLearnings` — unit-testable).

### 3.3 Tests (`src/modules/calls/`)

- `getCall` returns `learnings: null` when no `call_learnings` row matches.
- `getCall` maps a full row correctly (fixture with tool_calls + compliance + sales analysis).
- Tenant isolation: learnings row from another tenant is never returned (insert two rows,
  same conferenceName, different tenantId).
- `sales_analysis` is `null` when analysis JSONB has only agent-written keys (tool_calls etc.).

---

## 4. Frontend changes — `dashboard/src/pages/CallDetail.tsx`

Keep the existing 2-column layout. Add the following, in order:

### 4.1 Header strip (above the grid) — call verdict at a glance

A horizontal row of chips/badges (reuse `Badge`):
- **Outcome** — `won` → success, `lost` → error, `neutral` → default. Hide if null.
- **End reason** — e.g. `meeting_booked` → violet badge "Meeting booked"; humanize snake_case.
- **Effectiveness score** — `7/10` style; ≥7 success color, 4–6 warning, <4 error. Hide if null.
- **Compliance chips** — two small chips:
  - Recording notice: ✓ played / ✗ not played (error color — this is an audit finding)
  - AI disclosure: ✓ during call / ⚠ at end (warning) / ✗ missed (error)
- **Analysis status** — if `learnings.status` is `pending`/`transcribing`, show a subtle
  "Analysis in progress…" chip instead of the sales-analysis sections.

### 4.2 Tool-call timeline (left column, between header and transcript)

A compact horizontal strip: one pill per tool call, ordered by `atMs`.

```
[00:42 check_calendar_availability ✓ 320ms] [01:15 book_meeting ✓ 480ms] [02:03 end_call ✓]
```

- Format `atMs` as `mm:ss` (reuse `formatDuration(atMs / 1000)`).
- `ok: false` → error-tinted pill + `title` tooltip with the `error` string.
- `durationMs > 500` → warning tint (the agent has a <500ms latency budget — the spec source
  is `docs/voice-agent-development-methodology.md`).
- Empty array → don't render the strip at all.

### 4.3 Right rail — new cards (below existing AI Analysis card)

**Card: "Sales Analysis"** (only when `sales_analysis` is non-null)
- Score displayed prominently (large number + `/10`).
- `pain_points_uncovered` — bulleted list.
- `objections` — each rendered as: objection text, agent's response (muted), and a ✓/✗ icon for
  `handled_well`.
- Collapsible `<details>`: `what_worked`, `what_didnt_work`, `key_questions_asked`,
  `recommendations` (each a small list; skip empty ones).
- `opening_technique` / `closing_technique` / `rapport_building` as `MetaRow`s if present.

**Hebrew content warning:** all analysis strings may be Hebrew. Every text element rendering
them MUST set `dir="auto"` — same pattern used in `LeadDetail.tsx` message bodies.

### 4.4 Transcript fallback

If `call.transcript` is empty but learnings provided one (backend already merged it — nothing
to do in UI), the existing bubbles just work. Add `dir="auto"` on the bubble `<p>` — Hebrew
transcripts currently render misaligned.

---

## 5. Acceptance criteria

1. Open a LiveKit call (`label='livekit'` learnings row exists) → header chips, tool-call strip,
   and Sales Analysis card all render with real data.
2. Open a historical call from the retired engine (no learnings row) → transcript and summary still render from the DB.
3. A learnings row with `status='pending'` → "Analysis in progress…" chip; no empty cards.
4. `ai_disclosure: 'missed'` renders as a red/error chip (it's an audit finding, not a formality).
5. Hebrew analysis text renders right-aligned inside its blocks (`dir="auto"` everywhere).
6. `npx tsc --noEmit` clean in both root and `dashboard/`.
7. Backend tests from §3.3 pass (`npm test`).

---

## 6. Suggested Cursor prompts (in order)

1. *"Read docs/sprint-2-call-detail-v2-spec.md. Start with §3: extend getCall in
   src/modules/calls/calls.service.ts to join call_learnings and return the learnings field per
   the spec. Write the mapLearnings pure function + tests from §3.3. Don't touch the frontend yet."*
2. *"Now §4.1–4.2: add the header verdict strip and tool-call timeline to
   dashboard/src/pages/CallDetail.tsx. Follow the existing inline-style + CSS-var conventions
   in that file. Reuse Badge and formatDuration."*
3. *"Now §4.3–4.4: the Sales Analysis card and dir='auto' on all analysis/transcript text."*
4. *"Run tsc on both projects and npm test; fix anything that breaks. Then walk me through §5
   acceptance criteria one by one."*

---

## 7. Out of scope (do not build now)

- Writing/editing outcome labels from the UI (that's a later slice — needs a PATCH endpoint).
- Latency-per-turn charts (data not yet written per turn).
- Kanban board, Calendar view (Sprints 3–4).
- Any enrichment from the retired vendor — removed from the repo 2026-08-05.
