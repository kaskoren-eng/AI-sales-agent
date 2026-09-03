# Handoff — Callback & Follow-Up model (VOICE)

**Session:** 2026-09-01, planning + docs only — **no code was written and no commit was made from
this session.** `main` was at `079dce4` throughout (2 unpushed website commits ahead of
`origin/main` at `e08ba1b`).

**What shipped:** `docs/phase-8-callback-and-followup-model.md` — the design. Read it first; this
handoff only records what was decided, what is open, and what the implementing session must not
collide with.

---

## The finding this exists to fix

**Keren has no memory beyond the call.** A lead who says *"תתקשר אליי עוד שעה"* produces, at most,
`end_call(reason: 'callback_requested')` — which maps to lead status `contacted`
(`crm-sync.settings.ts:48`) and nothing else. No time captured, no job queued, no message sent,
nobody calls back.

Grep confirms the gap exactly: `'callback_requested'` is an enum value (`end-call.tool.ts:39`) plus
a prompt line telling the model to note it *"so a follow-up task can be created"*
(`system-prompt.he.ts:1066`). **Nothing consumes either.** Separately, `follow_up_scheduled` is read
out of `conversations.metadata` by `calls.service.ts:30,136` and **has no writer anywhere in `src/`**.

Three things in the repo already assume this exists: the sales model's objection #4 (*"ואם הוא נותן
חלון, מסמנים"*), the marketing site's lead-journey step 7 (Koren-confirmed, promising exactly
"call me in an hour → callback at the requested time"), and the unbuilt 2026-08-27 no-answer-flow
spec.

**Every primitive already exists and none is connected:** `initiateOutboundCall` (the dialer,
spend-guarded), `meeting-reminders.queue.ts` (cancellable absolute-time delayed jobs with fire-time
DB authority), `operating-hours.ts` (Shabbat + holidays + next-active-slot), `israel-time.ts`
(DST-safe Israel arithmetic), `request-human-handoff.tool.ts` (the 7th-tool + settings-resolver
precedent), `resolveWhatsappSendMode` (window/consent/template policy).

---

## Decisions taken with Koren

| Question | His answer |
|---|---|
| Who performs the callback | **All three** — she sends a message saying she will be in touch, the intent is recorded durably, and **she dials at exactly the requested time** |
| Lead doesn't answer / gave no time | **Fixed ladder, then stop** |
| Calling hours | **Wide window AND what the lead asked for.** *"אם הוא מבקש שיחה בשעה 22:00 אז יקבל"* |
| Output of this session | **Planning document only** |

---

## The architecture, in one paragraph

Three situations — **explicit callback**, **soft defer**, **not reached** — write one `callbacks`
row and run through one worker. They differ only in which rung of a fixed 3-attempt ladder they
start on, and in which window guards the dial: an **honored** window (whatever the lead named, incl.
22:00) for attempt 1 of an explicit callback, a **proactive** window (Sun–Thu 09:00–20:00, Fri
09:00–13:00) for everything else, and a **hard floor** nothing overrides (never 23:00–07:00, never
Saturday, never a holiday). He asked for 22:00 once; he did not ask for 22:00 three nights running.

---

## Where each piece lands

| Piece | Code half | Reuse |
|---|---|---|
| The row | New `callbacks` table, **migration 0019** + `leads.next_callback_at` | `handoff_requested_at` (0017) is the precedent for a nullable timestamp + composite index |
| Time resolution | New `callback-time.ts`, pure | `israel-time.ts` — `nextIsraelClockTime` is already DST-safe with a midnight-wrap guard |
| Windows | Same module | `operating-hours.ts :: getDelayUntilNextActiveSlot`, as used at `flow-executor.worker.ts:97-115` |
| Firing | New `callbacks` queue + worker | `meeting-reminders.queue.ts` verbatim — deterministic job ids, fire-time DB authority, deferral with `-d<n>` |
| The tool | `schedule_callback`, the 8th | `request-human-handoff.tool.ts` — identity ladder, idempotency latch, settings resolver |
| Confirmation | New `callback_confirmation` template key | `resolveWhatsappSendMode` + `grantWhatsappConsentVerbal` |
| Prompt | 4 rules behind `VOICE_CALLBACK_TOOL`, default OFF | — |

**The tool schema takes a structured intent, never an ISO timestamp.** `book_meeting` never lets
the model do date arithmetic (it echoes `slot_datetime` verbatim); a callback has no availability
list, so the equivalent safety is `{ when_kind, in_minutes | day + time_hhmm }` that **code**
resolves. gpt-5.4 computing "מחר בארבע" across a DST boundary without reliably knowing "now" is a
bug whose only symptom is a phone ringing at the wrong hour, and no test we have would catch it.

---

## Build order

1. Migration 0019 + tables. 2. `callback-time.ts` (pure, both DST regimes). 3. Queue + worker +
cancellation + `callbacks:reconcile`. 4. The tool + settings. 5. Confirmation message.
6. Cancellation hooks in the four existing tools. 7. Prompt, **after the listening round**.
8. Timeline surface.

**Steps 1–3 are pure backend and touch none of the contested files** — they can be built and merged
while the persona / sales-model work proceeds. That ordering avoids the `agent.ts` collision.

---

## Three things that will ship broken if nobody reads this

1. **The confirmation message silently fails for ~70% of leads.** A lead who only phoned us has no
   open WhatsApp window and no consent; `resolveWhatsappSendMode` returns `blocked` and
   `outbound-sender.worker.ts:90-98` **returns rather than throws** — dropped with a log, job
   reports success. Needs all three of: a `callback_confirmation` template key,
   `grantWhatsappConsentVerbal`, and a **truthful return to the model** so she does not promise a
   message that is not going. This exact failure is already documented in
   `send-confirmation.tools.ts:115-135`: *"she promised a message that was never sent."*
   Do **not** send via the flow executor's `send_whatsapp` step — it bypasses the whole chokepoint
   (`flow-executor.worker.ts:142-176`).
2. **The read-back phrase collides with the false-booking guard.** The natural Hebrew
   *"סגרנו, אני מתקשרת אליך מחר ב-ארבע"* contains `סגרנו`, which is on the `FALSE_BOOKING_WIDE`
   list. Reword, then re-check the guard against the replacement.
3. **A truly unanswered ring lands nowhere today.** `no_answer` / `voicemail` are *reflexes*
   (`call-reflexes.ts`) set when a call connects and goes silent. A phone that never picks up
   surfaces only as a rejection from `createSipParticipant({ waitUntilAnswered: true })`, which
   nothing records. The design sidesteps this by having the callback worker own its own dial result
   — but that means "not reached" is detected only for calls the worker itself placed.

---

## Collision warnings for the implementing session

- **VOICE territory.** Branch `feature/voice-callback-model`. Fetch and rebase first — local `main`
  is 2 commits ahead of `origin/main` (website work committed directly to main).
- **A live session (pid 34048, worktree `agent-afff8fc6e8789e075`) is editing right now**,
  uncommitted: `speech-guard.ts`, `call-report.ts`, `src/config/env.ts`, `.env.example`, plus new
  `repeat-guard.ts` and `slot-memory.ts`. **Do not touch any of them.** Steps 1–3 avoid them
  entirely; step 7 needs `env.ts` + `.env.example` — additive-only, rebase first.
- **`slot-memory.ts` is directly adjacent** — that session's time/slot memory for bookings. Read it
  before writing `callback-time.ts`; if it already resolves spoken Hebrew times, extend it rather
  than growing a second resolver.
- **The sales-model plan** (`docs/handoffs/2026-09-01-voice-sales-model.md`) targets
  `system-prompt.he.ts`, `call-state.ts`, `fact-memory.ts`, `capture-lead-info.tool.ts`,
  `persona.ts`, `engagement.ts`. **Step 7 collides with it — sequence them, never parallel.**
- **Migration 0018 is claimed on paper** by the onboarding-corpus workstream
  (`docs/phase-7-onboarding-call-corpus.md` §5, `docs/phase-7-kickoff-prompt.md`). **Take 0019**,
  claim it in CLAUDE.md in the same commit, and run `npm run db:drift` after.
- **New settings key `tenants.settings.callbacks`** — claim it in CLAUDE.md, add it to
  `settings-policy.ts`'s tenant-writable allowlist **and** to `AGENT_SETTINGS_KEYS` in
  `voice-livekit.service.ts`, or the agent will not see it.

---

## Noted in passing, not fixed

`lead.schemas.ts:12` carries a **stale, different** lead-status enum — it contains `'booked'` (which
exists nowhere else) and omits `'opted_out'` — and `PATCH /leads/:id` writes it straight through
`LeadService.update()` **without** `canTransition`. `lead-status.ts` is the real source of truth.
Anyone adding a lead status must fix both files. Out of scope here; this design adds no status.

---

## Questions for architect / Koren

1. **The Hebrew wording** — every line in §9 of the design doc is a first draft awaiting his ear.
   Cards for listening round 15/16: the "מתי יתאים לך יותר?" ask, the read-back (reworded off
   `סגרנו`), the "I'll send you a message" line in both variants, the ladder's final WhatsApp.
2. **After the ladder is exhausted, does the lead become `disqualified`?** Recommendation: **no**,
   by default. Never picking up is not saying no.
3. **Confirm the proactive window** — Sun–Thu 09:00–20:00 / Fri 09:00–13:00. The shared
   `operating_hours` default is 09:00–23:00, too wide for a call nobody asked for.
4. **`callback_confirmation` needs a Twilio-approved template.** Operational task on Koren; it
   gates step 5.
5. **Should `leads.last_call_outcome` (the unbuilt 2026-08-27 spec, section A) be folded in**, so
   no-answer is detected for flow-executor calls too? Recommendation: defer to a follow-on.
