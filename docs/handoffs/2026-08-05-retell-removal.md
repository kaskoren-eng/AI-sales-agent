# 2026-08-05 — Retell AI removal

Retell is no longer available to us as a vendor. This session removed it from the codebase and
from every doc that presented it as configurable, available, or a fallback.

## Why it wasn't just a cleanup

Four things made this a behavioural change, not a find-and-replace:

1. **`VOICE_ENGINE_DEFAULT` defaulted to `'retell'`** in the Zod schema and was unset in `.env` —
   so every tenant without an explicit override resolved to a dead vendor.
2. **`RETELL_API_KEY` was set in the live `.env`**, so the Retell fetch paths were *active*. The
   call-detail page made a real HTTP call to `api.retellai.com` on every view (15s timeout), and
   the audio proxy did the same with **no timeout and no circuit breaker**.
3. **`POST /api/v1/calls/outbound` dialled via Retell unconditionally** — it never consulted
   `resolveVoiceEngine`. That endpoint was broken in production.
4. **`infra/livekit-sip/README.md` told operators to delete the Zadarma forwarding rule** so "the
   number rings Retell again" — which would have silently dropped live inbound calls.

## Branches

Two, because the code and most of the docs live on different branches.

| Branch | Base | Contents |
|---|---|---|
| `feature/retell-removal` | `feature/crm-automation` | all code + config, `CLAUDE.md`, `PROJECT_STATUS.md`, both READMEs |
| `feature/retell-removal-docs` | `feature/website-clickscales-v2` | `VOICE_MIGRATION_PLAN.md`, `THIRD_PARTY_REPORT.md`, `PRODUCT_ROADMAP.md`, `docs/**` |

Worktrees: `C:/keren-retell` and `C:/keren-retell-docs`. Neither touched `C:/keren-voice`, which
has uncommitted voice-session work.

**Merge note:** `infra/livekit-sip/README.md` and `src/modules/channels/voice-livekit/README.md`
were edited on both branches — the docs branch got a byte-identical copy of the code branch's
version, so they should merge cleanly. `CLAUDE.md` and `PROJECT_STATUS.md` differ between the two
branches for unrelated reasons (the website branch has the newer copies); both were edited to say
the same thing about Retell, so conflicts there should be trivial to resolve.

## What was deleted

`src/modules/channels/voice/` entirely (819 lines): the `/webhooks/voice/retell` and
`/retell-tools` handlers, `verifyRetellSignature`, `retellCallExists`, the REST client and the
`RetellCall` type family. Plus the `voice_engine` setting, `VOICE_ENGINE_DEFAULT`, the dialer
branch, the call-detail live-fetch shim, the audio proxy, `checkAudioAvailable`, the
`audio_available` API field, `RETELL_API_KEY` / `RETELL_AGENT_ID`, and a dead `retell:dynvars`
cache-bust that nothing ever wrote to.

## What was deliberately preserved

- **The Zadarma recording webhooks.** They lived inside the Retell module but are
  engine-independent — they feed `call_learnings` via the `monitor_call:<id>` Redis mapping.
  Extracted to `src/modules/channels/zadarma/`, **still mounted at `/webhooks/voice/zadarma`**
  because that URL is registered in the Zadarma portal. A new test file locks the URL and the
  enqueue behaviour down. If you ever move that prefix, recordings stop being analyzed and
  nothing reports an error.
- **`VOICE_WEBHOOK_TENANT_ID`** — shared with the LiveKit tool context, not Retell-specific.
- **`NO_RESPONSE_NEEDED` and `speech-guard.ts`.** The token is inherited from Retell, but the
  live Hebrew prompt still emits it for holds and the guard still strips it. Token + guard *is*
  the hold mechanism now. Comments were reworded; the mechanism and its tests were not touched.
  Removing it is a real behaviour change needing a live PSTN call — deliberately out of scope.
- **Migration rationale, market research, and cost baselines** in the docs, now marked historical:
  the +972 blocker and its citations, the `$0.112/min` / `1950–2450ms` measured baseline, the
  per-tool parity mapping in `phase-4-agent-functions.md`, and the feature→phase backlog table in
  `retell-ai-dashboard-reference.md` (retitled ARCHIVED).

## Verification

- `npm run build` (tsc) clean on the code branch.
- `npx vitest run` — **565 passing**, 5 todo. The **2 failures in `src/modules/leads/`
  are pre-existing**: they reproduce identically on the base commit (`6d3561f`) with the changes
  stashed. Not caused by this work, not fixed by it.
- `git grep -in retell -- ':!*.md'` → **zero hits**.
- New `zadarma.routes.test.ts` — 5 tests covering the echo challenge, the answered-call enqueue,
  the unanswered skip, and the no-mapping skip.

## Open items for Koren

1. **Rotate `OPENAI_API_KEY`.** `.playwright-cli/page-2026-07-08T15-26-58-094Z.yml` had captured a
   live `sk-proj…` key (plus the dead Retell keys) from a host env-var panel. The directory was
   **untracked but not gitignored** — a `git add -A` would have committed it. That file is now
   deleted and `.playwright-cli/` is gitignored, but the key was on disk in plaintext.
2. **Remove `RETELL_API_KEY`, `RETELL_AGENT_ID` and `RETELL_SKIP_SIG` from the production host
   env** (Railway/Render). `RETELL_SKIP_SIG` was never read by any code in `src/` — an orphan.
3. **Run the tenant check** before merging:
   ```sql
   SELECT id, name FROM tenants WHERE settings->>'voice_engine' = 'retell';
   ```
   Any such tenant now gets LiveKit instead of a dead vendor — correct, but worth knowing about.
   The stale key can be dropped from `settings` in the same pass.
4. **Call audio is now an open gap.** The dashboard player was removed because it pointed at the
   Retell proxy and 502'd. LiveKit recordings exist in `call_learnings` but nothing serves them.
5. **`POST /api/v1/calls/outbound` should get a real PSTN test** — it now reaches the LiveKit
   dialer for the first time. Report EOU/LLM/TTS latency when you run it.
