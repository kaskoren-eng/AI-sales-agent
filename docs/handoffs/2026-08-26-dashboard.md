# 2026-08-26 — DASHBOARD — Voice Ops supervision page (shipped to production)

Merged to `main` via PR #1 (`8d3435e` → merge `24694cb`) · **live on Railway**.

## What shipped

A manager-facing **Voice Ops** page at `/voice-ops` (Monitor nav group), backed by
`GET /api/v1/metrics/voice?range=today|d7|d30` in the dashboard-owned metrics module.

Surfaces: calls · voice minutes + avg duration · booking rate · estimated cost · failed calls;
a latency panel (end-of-turn / LLM TTFT / TTS TTFB / worst case, median + p95 against budget);
how-calls-ended bars; a daily calls/minutes trend; and a "needs attention" list (failed calls,
**missed AI disclosure**, fragmented turns, tool calls over 500 ms, cut-offs).

Bilingual EN/HE, light/dark, all strings under a new `voiceOps` i18n namespace.

## Where the numbers come from

- **Latency + health counters → `call_learnings.call_report`** (`call_report->'summary'->>'…'`),
  the column the VOICE session added in `f63f05d`. Nothing in the agent was touched: it already
  writes the full CallReport, and the deployed agent version (2026-08-25) postdates that commit,
  so **no agent redeploy was required**.
- **Outcomes + compliance → `analysis`** (`end_reason`, `ai_disclosure`, `tool_calls`).
- The two are deliberately not merged: the GPT call-analysis worker rewrites `analysis` and would
  wipe a report nested inside it. That reasoning is documented on `PersistedCallReport` and this
  page respects it.

## Decisions worth knowing

- **Booking rate is `analysis->>'end_reason'`, not `outcome`.** `outcome` is manual-only and almost
  always null; `end_reason` is written automatically by `end_call`. Calls that never reached a
  deliberate `end_call` form a visible `unknown` bucket, excluded from the denominator. The rate is
  **null (renders "—"), never 0%**, when nothing was measured.
- **Cost is `minutes × toll_fraud.perMinuteRateUsd`** (default $0.10), labeled *estimated* in the
  UI — it reuses an abuse-brake heuristic, not a billing source. The agent already persists the
  per-provider `usage` block inside `call_report`, so real cost is an additive change later.
- **Aggregates run on `call_learnings` directly** — a LiveKit call has no `conversations` row, and
  the endpoint never filters `status='analyzed'` (LiveKit rows stay `pending`). Either mistake
  silently reports zero.

## Bug fixed along the way (Overview was affected too)

The day-bucketing in `metrics.service.ts` grouped by **UTC** date in SQL but zero-filled buckets by
walking days in **local** time. East of Greenwich every key shifted one day earlier and **today's
calls fell off the end of the chart** — measured, the 7-day trend showed 1 of 4 calls. Both
`summary()` and `voice()` now build buckets through one `utcDayBuckets()` helper. Overview's trend
was silently wrong before this.

## Verification

`npm test` — 914 passed / 90 files. New `src/modules/metrics/metrics.service.test.ts` covers the
booking-rate denominator, the null-vs-0% rule, latency null-safety, cost, and a regression test
pinning the series to end on today.

Checked against the dev DB on the real `call_report` shape: booking rate 1/3 = 33.3%, latency
percentiles skipping the call with no report, 2 tool calls over the 500 ms budget, cost 325 s →
5.4 min → $0.54. Reviewed in EN/light and HE/dark plus the "awaiting latency data" state.

Post-deploy: `/health` reports commit `24694cb`, postgres + redis ok; `/voice-ops` serves 200;
`/api/v1/metrics/voice` correctly 401s without auth.

## Open / next

- **Not yet confirmed against production data.** The prod DB is only reachable inside Railway's
  network, so I could not check how many of the 30 production calls carry a `call_report`. Opening
  the page is the fastest answer: if the latency panel shows "awaiting data", the deployed agent
  is older than the persistence commit after all and needs `npm run agent:deploy`.
- **No design preview exists** for this page — `dashboard/design-previews/STATUS.md` expects one
  approved with Koren before production code. This went straight in.
- **Latency budgets are a proposal, not a signed contract**: worst case 1000 ms (the hard product
  requirement), split 500 / 300 / 200 across end-of-turn / TTFT / TTFB.
- **Dark-mode screenshot gate**: EN/light + HE/dark captured; the full EN/HE × light/dark set is
  outstanding per frontend spec §6.
