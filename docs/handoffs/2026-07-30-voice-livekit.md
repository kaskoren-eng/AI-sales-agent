# Handoff — voice-livekit — 2026-07-30 (Workstream B — CRM automation)

Branch **`feature/crm-automation`** off `origin/master` (= the deployed line). **Not merged, not
pushed** — the merge gate is a real test call by Koren (go-live-plan rule). Full build clean; suite
**535 passing**, the only 2 failures are the pre-existing `lead.service` / `lead.routes` `list`
tests (Koren's lead-detail work — a `count()` mock issue; voice never touched those files).

## What shipped (2 commits, B1 + B2)

Both hang off ONE hook at the end of the LiveKit `call-analysis` worker — the durable place for
post-call side effects (the call process itself is a throwaway fork). New
`src/modules/integrations/crm-sync.service.ts` `syncCallToCrm()` does the work; it **never throws**,
so a CRM failure can never fail call analysis.

- **B1 (18979f9) — lead status auto-update.** Outcome (`analysis.end_reason`) → canonical status →
  pushed to the tenant's connected CRM (Monday + Airtable). Defaults: meeting_booked→qualified,
  not_qualified/not_interested→disqualified (+reason on metadata), callback_requested→contacted,
  opt_out→opted_out. Extracted the status-transition guard into shared
  `src/modules/leads/lead-status.ts` (strict SUPERSET of the old chat map — message-processor's four
  edges unchanged, verified; adds direct-to-terminal for voice + opt-out-from-anywhere).
- **B2 (8bc3824) — call summary into the CRM.** GPT recap + captured facts
  (business/pain/budget/timeline/qualification from `lead.metadata.qualification`) + outcome +
  dashboard back-link, as a Monday `create_update` note or an Airtable long-text field. One pass
  per CRM (item/record resolved once; status + summary written together — Airtable in a single PATCH).

## Per-tenant everything (`tenants.settings.crm_sync`)
`{ enabled, pushSummary, statusMap (outcome→status override, null="no change"),
monday.statusLabels (our status → their column label), airtable.{statusFieldName, summaryFieldName,
statusValues} }`. Resolver `resolveCrmSyncSettings` fills code defaults; `SettingsService`
get/saveCrmSyncSettings added. Connection creds stay where they were (`settings.monday`,
`settings.airtable`). New optional env `DASHBOARD_BASE_URL` (link omitted if unset).

## Guarantees
Reuses the existing Monday/Airtable clients (and their circuit breakers). Tenant isolation on every
query. Graceful degradation: no CRM connected → skip with a log; one CRM down → the other still
syncs; `canTransition` respected (an opted_out lead is never force-moved). 31 new tests.

## Open questions / not done (deliberately)
- **NOT B3 (Fireberry)** — out of scope this session, as instructed.
- **No config UI.** The `crm_sync` behavior is settable via `SettingsService`/raw settings + tested,
  but the dashboard form to edit outcome→status maps and CRM label maps is **dashboard territory** —
  flag for that session when it's wanted.
- **"callback_requested → follow-up task"**: currently sets status `contacted` + records the outcome
  on metadata/summary. A real task ENTITY (Monday task item / reminder) is Workstream C — not built.
- **Merge gate:** needs a real call whose outcome lands in a connected CRM before merging to master.
  ClickScales' Monday/Airtable connection + `crm_sync` label maps must be configured on the tenant
  first (otherwise it correctly no-ops with a `no_crm` log).

## Also answered for Koren this session (verified, not from memory)
- **Recording notice: OFF.** Deployed agent gates it behind `VOICE_RECORDING_NOTICE_ENABLED`, and
  the agent secret is explicitly `=false` → no notice plays. Fine now (no audio recorded, only
  transcript); the Wiretapping-Law question only re-opens when audio egress is turned on.
- **Prod calls since 29-Jul go-live: 4**, all cutover-day verification calls Koren placed (3
  analyzed + 1 failed early). No external/inbound lead calls yet.
