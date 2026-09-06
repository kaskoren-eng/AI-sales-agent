# SPEC — the per-call report page in the admin console

**Requested by Koren, 2026-09-06:** *"אני רוצה שבדאשבורד אדמין אני יראה בדיוק את הדוח הזה על כל
שיחה שמתבצעת."*

Reference design (built from logs, published as an artifact so it can be opened on any device):
**https://claude.ai/code/artifact/ce322b82-823d-413a-bca1-0ad9241ed307**

**This is a DASHBOARD-lane task and the VOICE/supervisor session did not build it.** Written as a
spec instead, per the territory rule in `CLAUDE.md`. Note for whoever picks it up: **there is no
active dashboard session** — the last commit touching `dashboard/**` is `975c496`, 2026-08-26, and
no `feature/dashboard-*` branch exists. Whoever takes this says so in `CLAUDE.md` first.

## The headline: none of this data needs to be collected

Every LiveKit call already writes its **entire** report to the database and has done since the
engine went live. Nothing is missing, nothing needs a new pipeline. It has been captured all along
and never shown.

- **Column:** `call_learnings.call_report` — `jsonb`, nullable, typed `PersistedCallReport` in
  `src/db/schema/call-learnings.ts:141`.
- **Written at:** `src/modules/channels/voice-livekit/agent.ts:1638`, once per call, in the agent's
  shutdown path. Deliberately isolated from `analysis` so the GPT-analysis worker can never
  overwrite it.
- **Read today by:** `src/modules/metrics/metrics.service.ts:368` — and only for the aggregate
  VoiceOps numbers. **No route exposes a single call's report.** That is the gap.

The database copy is *better* than what the reference design was built from: the artifact above was
assembled from `lk agent logs`, and the logs **drop** the report line entirely
(`scanner error: bufio.Scanner: token too long`). The stored copy is complete.

## What is in the report

| field | shape | what the reference page does with it |
|---|---|---|
| `summary` | object | the figure strip: `endOfTurnMedianMs`, `llmTtftMedianMs`, `ttsTtfbMedianMs`, `worstCaseMs`, `cutOffs`, `fragmentedTurns`, `duplicateReplies`, `promptCacheHitPct` |
| `transcript` | `TranscriptLine[]` — `atMs`, `role`, `text`, `spokeAtMs?`, `spokeUntilMs?` | the conversation thread, both sides, in order |
| `metrics` | `TurnMetric[]` — `atMs`, `stage`, `endOfUtteranceDelayMs?`, `ttftMs?`, `ttfbMs?`, `durationMs?`, `charactersCount?`, `cancelled?`, token counts | the per-turn latency badge (see below) |
| `toolCalls` | `ToolCallLog[]` | the inline tool rows — "בדקה יומן", "קבעה פגישה", "סיימה את השיחה" |
| `compliance` / `usage` / `shadow` | objects | not rendered by the reference page; available |

**The per-turn number on each of her turns** — the one thing that makes this a voice transcript
rather than a chat log — is the metric named **`first_audio_frame`**, field `durationMs`
(`agent.ts:1997`). It measures *caller stopped talking → first sound out of her mouth*.

⚠️ **`-1` is a sentinel, not a measurement.** It means the caller was not waiting — the greeting, a
barge-in, or a turn she started before he finished. Render it as "not measured", **never as 0 and
never averaged in.** `src/modules/channels/voice-livekit/latency-anatomy.ts` already holds the
classification logic and the reason it matters: the overall median mixes three different
populations and describes no real turn on the call. Reuse it rather than computing a fresh average.

## What to build

1. **A route returning one call's report.** `src/modules/calls/calls.routes.ts` is DASHBOARD-owned
   and extended additively — `GET /api/v1/calls/:id/report` returning the `call_report` jsonb,
   tenant-scoped. The admin console is cross-tenant and gated by `ADMIN_API_KEY`; mirror it under
   `src/modules/admin/**` if the page lives in the admin shell as Koren asked.
2. **The page.** Match the reference design: verdict strip → figures → verbatim evidence →
   transcript with per-turn latency badges. Bilingual per `CLAUDE.md` — all strings through
   `t('...')`, CSS logical properties, `dir="auto"` on transcript text, and reviewed in Hebrew
   before it is called done.

## Non-negotiables

**An absent report says so.** The column is nullable and only LiveKit calls write it, so every
historical row is empty. Render "no data for this call" — **never zeros.** A zero looks like a
measurement, and this repo has shipped six instruments in a week whose failure mode was returning
a comfortable number instead of nothing.

**An absent FIELD renders as nothing, not as 0.** Reports written before a counter existed cannot
answer a question that did not exist when they were written. `scripts/show-call-report.mjs` already
follows this convention — copy it exactly.

**Recordings are not audio here.** `call_learnings.recording_url` is written but nothing serves it
(the audio proxy went with the retired engine). Do not add a play button that 404s.

## Cross-lane note

The transcript and metric shapes above are VOICE-owned (`call-report.ts`). If the page needs a
field that is not in the report, that is a VOICE change — ask, do not compute it in the dashboard
from parts. Deriving *caller-stopped → first-sound* by pairing `ttftMs` against `spokeAtMs` is the
specific mistake already made twice on this project: that pairing structurally cannot see the
instant acknowledgement, so it reports a number that is wrong in the flattering direction.
