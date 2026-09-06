# Dashboard — per-call report page in the admin console (2026-09-06)

Branch `feature/dashboard-call-report`, worktree `C:/keren-dash-report`, PR open against `main`.
**Not merged, not deployed** — the integrating session merges.

The DASHBOARD lane had no owner (last `dashboard/**` commit was `975c496`, 2026-08-26). It is
claimed in `CLAUDE.md` in the first commit of this branch, as the spec asked.

## What shipped

`docs/spec-admin-call-report-page.md`, built. The report every LiveKit call has been writing to
`call_learnings.call_report` since the engine went live is now on a screen.

| commit | what |
|---|---|
| `f874cb4` | claim the dashboard lane in CLAUDE.md |
| `22b33b8` | `src/modules/metrics/call-report-view.ts` (pure) + `call-report.service.ts` + tests |
| `4603226` | `GET /api/v1/admin/calls` and `GET /api/v1/admin/calls/:id/report` |
| `89fceb4` | `/admin/calls` and `/admin/calls/:id` pages, bilingual, + language toggle in the console |
| `eb1a5cc` | the dead-air fallback — see "what the live review found" |

No schema change, no migration, no new dependency, no change to the voice agent. Gates green on
every commit: `npm run build`, `npm run test:ci` (2282 passing), `dashboard && npm run build`,
`scripts/ci/territory-check.sh`.

## Decisions Koren made this session

1. **Admin-only.** No tenant-facing route, so `src/modules/calls/**` is not touched at all — the
   split-ownership module needed no additive route in the end. The report names the vendor stack,
   the prompt-cache rate and the discarded drafts; that stays internal.
2. **A cross-tenant calls list** is the way in (the console had none).
3. **Bilingual**, against the console's English-only convention — so the existing
   `LanguageSwitcher` is now in the admin top bar. The two new pages are translated; the rest of
   the admin shell is still English.
4. **Verdicts are derived** from the report, each carrying the number behind it.

## Two things worth knowing before touching this

**The route keys on `call_learnings.id`, not `conversations.id`.** A LiveKit call has no
conversations row of its own — `metrics.service.ts:35` says so and `agent.ts:1654` makes
`conversationId` optional. A conversation-keyed route would silently miss a large share of the
reports and would look like it was working.

**What the live review found, and no unit test could.** Of the 61 real call reports captured up to
2026-09-02, **exactly one carries `first_audio_frame`** — the metric the spec names as *the*
per-turn number. Twenty-three carry `dead_air` instead. Built strictly to spec, the page's headline
figure would have read "not recorded" on essentially every call on record. `latency-anatomy.ts`
documents both as the same wait measured in two places, so the badge now falls back to the dead-air
clock and names which instrument produced the number. On a real production call that is 14 of 17
turns badged instead of 0.

VOICE may want to know that the audio-frame probe is landing on very few reports.

## Where the correctness lives

`src/modules/metrics/call-report-view.ts` is pure, has no db or fastify, and holds all of it:

- Latency is never recomputed here. `buildTurnAnatomy` / `summarizeLatency` are **imported** from
  voice-livekit and never edited, so the `-1` sentinel keeps one owner. `ttftMs` is not read at all
  — pairing it against `spokeAtMs` is the mistake the spec says has already been made twice.
- Transcript lines are placed by `spokeAtMs`, not `atMs`: the SDK commits an assistant message at
  the END of playout, so a long reply commits after the next end-of-turn and would otherwise be
  filed under the turn it answered next.
- One badge per turn, on the line that made the sound. A silent tool step cannot take it. Every
  other line renders **no badge at all** — not a dash, which would claim a measurement was tried.
- No end-of-turn events at all → badges suppressed page-wide with a stated reason, rather than
  printing the greeting's number against every reply. That is also the canary if VOICE renames the
  `eou_metrics` stage.
- `raw.summary` is passed through verbatim and dumped in a collapsed block, so a counter VOICE
  starts writing tomorrow appears with no dashboard change. **Do not add a fastify `response`
  schema to these routes** — the serializer would drop those ~35 keys silently. A test pins it.

## Verified

Against a local Postgres loaded with 8 real captures from `call-reports/` plus one row with no
report: English, Hebrew, light, dark, a call with a report and a call without. The no-report case
prints a sentence, never a grid of zeros.

Local review left Postgres and Redis up on the default ports (nothing was running when this session
started). No dev server of mine is still running; `:3000`/`:3001` were never touched.

## Questions for architect

1. **Does the tenant side ever get this?** Today it is operator-only by Koren's call. If tenants
   should see their own calls, it needs a redacted view — no `config` (vendor and model names), no
   `promptCacheHitPct`, no `draftsDiscarded` — and a route keyed on something a tenant can hold.
2. **`first_audio_frame` is on 1 of 61 reports.** Is the ttsNode probe meant to be running on every
   call? If it is, that is a VOICE bug this page happened to surface. If it is not, the dead-air
   clock is the real instrument and the spec's framing should be updated.
3. **Should the rest of the admin console be translated?** It is English-only by design, and this
   branch has made it half-and-half: two Hebrew pages inside an English shell.
