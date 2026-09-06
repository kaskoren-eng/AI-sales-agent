# 2026-09-05 — VOICE — the follow-up model becomes the tenant's, and learns when to stop

Branch: `feature/voice-followup-config`, off `origin/main` @ `6da76a8`. Unmerged. **Every flag is
still OFF** — `VOICE_CALLBACK_TOOL`, `VOICE_CALLBACK_WORKER`, `VOICE_DISCONNECT_TRACKING` — so
nothing here changes production behaviour until they are flipped.

Two asks from Koren on 2026-09-04, both built:

1. *"כל לקוח תהיה לו את האפשרות להחליט מה הפולואפים שהוא רוצה שהסוכן יעשה. זה חייב להיות גמיש
   לפי לקוח."*
2. *"a guardrail so the agent won't do extra follow-up if the lead already said — on the phone or in
   WhatsApp — that he doesn't want to talk anymore. A model so the agent knows when to STOP."*

---

## 1. The ladder is now data the tenant owns

Before: `CALLBACK_LADDERS` was a module constant, and `callback-settings.ts` said in its own header
that the ladder's shape is *"NOT A KNOB"*. A tenant could only shorten it.

Now: `tenants.settings.callbacks.ladders`, one array per kind, resolved by `resolveCallbackSettings`
and read by the worker AT FIRE TIME — so re-timing the follow-ups moves rows already in flight.

```jsonc
"callbacks": {
  "maxAttempts": 3,
  "dayParts": { "morning": "10:00", "afternoon": "16:00", "split": "13:00" },
  "ladders": {
    "not_reached": [
      { "after": { "hours": 3 } },
      { "after": { "businessDays": 1 }, "timeOfDay": "rotate" },
      { "after": { "businessDays": 3 }, "timeOfDay": "rotate" }
    ]
  }
}
```

Written through the new typed route **`PUT /settings/callbacks`** (`.strict()`, `GET` alongside it).
It returns the **resolved** config rather than the patch, because every boundary below is a silent
clamp and an operator who cannot see one fire will believe a ladder is live that is not.

### The default is exactly what Koren specified

`3 hours` → `1 business day, the other half of the day` → `3 business days, rotating again` → stop,
and mark the lead `unreachable`.

### `timeOfDay: 'rotate'` — the part that did not exist at all

`addIsraelBusinessDays` preserves the wall-clock hour by design, so a lead who could not answer at
11:00 was rung again at 11:00 the next business day and 11:00 the one after. Three dials at the one
hour he has demonstrably no availability in is one chance taken three times. `rotate` sends the next
attempt to the other half of the day: morning ⇄ afternoon, anchored on `dayParts`, and still clamped
by the calling window afterwards.

### What a tenant still cannot do, and why each one is a boundary

| Not settable | Because |
|---|---|
| a rung's `window` | `honored` is the wide 07:00–23:00 band and exists for ONE case: an hour the LEAD named. A tenant stamping it on rung 3 is cold-calling strangers at 22:30. Every tenant rung is forced to `proactive`. |
| a rung's `channel` | ⚠️ the worker STILL dials unconditionally (see §4). Accepting `whatsapp` would promise a message and place a call. |
| rung 1 of `explicit` | that is the time the lead himself named. The resolver prepends it; a tenant's `explicit` array describes the retries. |
| more than 5 rungs / dials | `MAX_ATTEMPTS_CEILING` raised **3 → 5** on Koren's decision. It stayed a ceiling: "keep dialling until he answers" is still refused. |
| the hard floor, Shabbat, holidays | not settings. |

One malformed rung discards **the whole tenant ladder** for that kind and the shipped default runs —
never a silently-shortened ladder, same failure philosophy as `resolveWindow`. `[]` is valid and
means "do not chase this kind".

---

## 2. The stop guardrail

**The gap, measured:** `opted_out` had exactly ONE writer in the entire repo — the voice agent's
`end_call(reason:'opt_out')`. A lead who typed "תפסיקו לשלוח לי" into WhatsApp was dialled by the
ladder the next morning. And `not_interested` on a call stopped nothing at all.

Enforcement was never missing (`callbacks.worker`, `flow-executor`, `meeting-reminders` all refuse an
opted-out lead). **Detection** was missing. Three tiers now, in `src/modules/leads/stop-signals.ts`:

| tier | example | effect |
|---|---|---|
| **HARD** | "אל תתקשרו אליי יותר", "הסר", bare "STOP" | `status='opted_out'`, permanent, cross-channel, callbacks cancelled |
| **SOFT** | "לא מעוניין", "כבר סגרתי עם מישהו אחר" | `leads.followup_stopped_at` (migration 0020), ladder ends, status untouched, lifted the moment he writes back |
| **CONTINUE** | "לא עכשיו", "תתקשר מחר" | timing, not refusal — the leads the ladder exists for |

Two layers, and the order is the design: a **deterministic phrase list** first (a legal obligation
must not depend on OpenAI being reachable) and an **LLM classifier** second. A hard phrase
short-circuits — the classifier is never asked and cannot soften a do-not-call.

**Correcting what I told Koren mid-build:** I said "fail-closed — classifier down or unsure → soft
stop". Only half of that shipped, and deliberately. *Unsure* (the classifier returns and hedges)
resolves to soft stop. *Unavailable* falls back to the phrase lists instead, because an outage that
soft-stopped every inbound message would end every live conversation in the system at once,
invisibly. The hard list — the part the law is about — is enforced either way.

Wired into `message-processor.worker.ts` for every inbound WhatsApp/email message, **before** the
terminal-status early return and **before** the lead-intake flow. Both of those orderings fix a real
bug: a `qualified` lead's do-not-call used to be dropped on the floor, and a brand-new lead whose
first message was "STOP" used to trigger the flow that calls him. On the voice side,
`end_call('not_interested')` now writes the soft stop.

**No AI reply is generated to a stopped lead** — answering someone who just asked us to stop is the
complaint we are avoiding. One fixed confirmation line IS sent, approved 2026-09-06; the copy and
its three rules are in §5.

---

## 3. `leads.status = 'unreachable'`

New status, written only by `callbacks.worker.ts` when the ladder ends with no answer, guarded by
`canTransition` so a `qualified` or `opted_out` lead is never walked backwards.

Not `disqualified`: that is a lead we spoke to and ruled out, this is a lead we never reached, and
collapsing them makes "how many leads did we fail to reach this month" — the number that says the
dialling hours are wrong — permanently unanswerable. Not terminal either: `unreachable → contacted`
is an allowed edge, because never answering is not an outcome.

---

## 4. ⚠️ The trap that is still open

Every rung carries a `channel` field. **`callbacks.worker.ts` still never reads it** and dials
unconditionally. Every rung says `'call'`, so it is correct by coincidence. The dispatch must be
fixed BEFORE any non-call rung exists — which is why the settings schema refuses `channel` outright
rather than accepting a field that does nothing. Same failure class as the migration-numbering trap:
a value that is set correctly, looks right, and is never read.

---

## 5. Decisions — ANSWERED by Koren, 2026-09-06

| # | Question | His answer | Built |
|---|---|---|---|
| 1 | Confirmation message on a stop? | **Ship it** | `STOP_CONFIRMATIONS` in `stop-signals.ts`, sent from `message-processor.worker.ts` |
| 2 | `disconnectedDelayMinutes: 15`? | **Three hours** — and if the lead asked for a specific time, his time | default 15 → **180**; `disconnect.ts` now writes NO row when one is already pending |
| 3 | The dashboard screen | *not a question* — it was a note for the DASHBOARD session | — |

### 1. The confirmation line

Two fixed strings, one per tier. **Sent only on the channel he just wrote on**, which is why no
WhatsApp template is needed — his own message opened the 24-hour window seconds earlier. There is
deliberately **no** confirmation for a stop heard on a VOICE call: the agent already says goodbye
out loud, and a text afterwards is a second contact, not an acknowledgement.

```
hard_stop:  קיבלנו. הסרנו אותך מרשימת הפניות ולא ניצור קשר שוב.
soft_stop:  תודה על העדכון, לא נטריד יותר. אם משהו ישתנה, אנחנו כאן.
```

Three rules the copy obeys, each pinned by a test: **gender-neutral** (Hebrew forces a second-person
choice and we do not know the lead's — the last message he ever gets from us is the worst place to
guess), **never sells** (no link, no offer, no question mark: a confirmation that sells is a contact,
and a contact is what he just forbade), **one sentence**. A confirmation that fails to send is logged
and swallowed — the stop is already recorded, and a throw here would be a BullMQ retry that re-runs
the whole stop path.

### 2. Three hours, and his own time wins

The 15-minute ring-back is gone. The argument for it was that a dropped line should be rung back
while he still remembers the call; the argument against — already admitted in the old comment — is
that a caller who hung up because he had had enough is indistinguishable from a dropped line at this
end. Koren judged it by ear.

The second half of his answer was not a number. `disconnect.ts` used to insert its row
**unconditionally**, so a lead who had said "תתקשר אליי ב-16:00" and then lost the line ended up with
**two** pending callbacks — breaking the one-live-callback invariant — and got rung at +3h, hours
before the hour he actually chose. It now checks for any pending callback first and writes nothing
when one exists. The owner ping still fires either way, and the alert no longer claims a ring-back
was scheduled when it was not. A FAILED lookup writes the row anyway: a duplicate is recoverable,
a lead nobody rings back is not.

Also fixed in passing: disconnect read `CALLBACK_DEFAULTS` directly and so ignored the tenant's own
`disconnectedDelayMinutes`. It now resolves tenant settings like every other caller.

### 3. Schema drift is off your laptop — and the check itself was broken

New `schema-drift` job in `guardrails.yml` — `ubuntu-latest` already has Docker, which was the
whole dependency.

**Its first run failed, and not on drift.** Exit 2, "could not run the check", `psql` unable to
find the unix socket. The official postgres image runs initdb against a TEMPORARY server on the
socket, then stops it and starts the real one; the script's single `pg_isready` answered 0 against
that bootstrap server and the migrations landed in the gap while it restarted. On a laptop the
1-second retries straddle the restart by luck — which is why nobody had ever seen it. A CI runner
is fast enough to lose the race every time.

Fixed by probing with the query the migrations are about to run, not a liveness ping, and requiring
three consecutive successes. So the honest summary of moving this into CI is: **the first thing it
found was that `npm run db:drift` had never been exercised anywhere but a slow laptop.**



**Advisory on its first pass** (`continue-on-error: true`), exactly as the territory
check was introduced and for the same reason: nobody has ever run this in CI, and if `main` already
carries drift a blocking job stops every open PR at once. **Flip it to blocking the first time it is
seen green on main**, then add it to branch protection.

---

## Verification

- `npm run typecheck` · `npm run build` — exit 0
- Full suite: **141 files, 2181 passing, 0 failing** (+66 new)
- `scripts/ci/migration-claims-check.sh` — OK (highest 0020, next free 0021)
- `scripts/ci/territory-check.sh` — OK, VOICE lane + shared files only
- ⚠️ **`npm run db:drift` still NOT RUN locally — Docker Desktop is installed on Koren's machine
  (29.7.2) but the daemon is not running.** Migration 0020 is hand-written and eye-verified against
  the schema (two columns + one index). The new CI job is exactly the fix for this and will run it
  on the PR.

Tests CHANGED rather than added, all asserting behaviour this branch deliberately reverses: two
"same hour" ladder assertions (now rotate), one `maxAttempts` ceiling of 3 (now 5),
`end_call('not_interested')` "never touches the lead" (now writes the soft stop), and the stop path's
"sends NO reply" (now sends one fixed line).

One test HARNESS was fixed, not just its assertions: `disconnect.test.ts`'s `fakeDb` answered every
`select` with the lead row regardless of table, so the new pending-callback lookup made every
disconnect look like it already had one. It is table-aware now.
