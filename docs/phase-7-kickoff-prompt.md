# Kickoff prompt — paste this into a fresh Claude Code session in this repo

---

You are starting a new workstream in this repo: **ONBOARDING — the call-corpus ingestion feature.**

The full spec is `docs/phase-7-onboarding-call-corpus.md`. Read it completely before you plan
anything, and read `CLAUDE.md` (especially the ⚠️ TERRITORY RULES) first.

**Session start, non-negotiable, before your first edit:**
1. `git fetch origin && git status` — confirm the worktree is clean. There is a known uncommitted
   change to `src/modules/channels/voice-livekit/prompts/system-prompt.he.ts` belonging to another
   session: do not revert, stash, or commit it.
2. Branch from an up-to-date `origin/main`: `feature/onboarding-corpus-p0`.
3. Read the newest file in `docs/handoffs/` for **every** workstream, not just this one.
4. Confirm migration **0018** is still free on `origin/main`. If another session took it, take the
   next free number and update the claims line in `CLAUDE.md`.

**Scope for this session: P0 only** (spec §11). Ingest, not extraction:
migration 0018 (`onboarding_samples`, `onboarding_insights` — create both tables now, only the
first is used in P0) · object storage + presigned upload · consent gate · transcription worker
(Soniox batch, Hebrew, diarized — not Whisper, see §7.0) · speaker-role confirmation (§7.2) ·
transcript viewer in the dashboard · retention purge job. **Do not build extraction or the apply
path in this session.**

**Before you write code, produce a plan** covering: the exact table DDL, the storage env keys, the
queue/worker wiring, the route list, and the dashboard page — and stop for my review. Flag anything
in the spec you think is wrong; it is a spec, not scripture, and I would rather argue before the
migration than after it.

**Hard constraints you must not violate:**
- Never edit files in another lane. Adding `src/modules/onboarding/**` to `CODEOWNERS` and
  `scripts/ci/territory-check.sh` happens in the same commit as the module.
- Shared files (`env.ts`, `.env.example`, `package.json`, `server.ts`) — additive only, rebase first.
- New env keys are **optional** in the Zod schema; unset must 503 the feature, never break boot.
- `npm run db:drift` after the migration. Non-negotiable — drift is invisible to the tests.
- Never log transcript content or any PII from these recordings.
- Announce any new npm dependency clearly in the commit message (`deps: add X for Y`).
- End the session by writing `docs/handoffs/YYYY-MM-DD-onboarding.md`: what shipped (commits),
  what is blocked, and any decisions you need from me under a "Questions for architect" heading.
