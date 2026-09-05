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

**No reply is generated to a stopped lead.** Answering someone who just asked us to stop is the
complaint we are avoiding, and a confirmation message would be new outbound Hebrew that has not been
through a listening round. **Open question for Koren** — see §5.

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

## 5. Questions for architect / Koren

1. **A confirmation message on a stop?** Right now a lead who says "הסר" gets silence. A one-line
   "הוסרת, לא נפנה אליך יותר" is standard practice and is the proof we honoured it — but it is new
   outbound Hebrew and needs a listening round. Ship it, or leave the silence?
2. **`disconnectedDelayMinutes: 15`** is still the number nobody has judged by ear. A caller who hung
   up because he had had enough is indistinguishable from a dropped line, and he gets rung back in a
   quarter of an hour.
3. **The dashboard screen.** Koren chose "engine + API now, dashboard after". The DASHBOARD session
   needs `GET`/`PUT /api/v1/settings/callbacks` — the shape is in §1 and the response is already the
   resolved config, so the screen can render what is actually running.

---

## Verification

- `npm run typecheck` · `npm run build` — exit 0
- Full suite: **140 files, 2170 passing, 0 failing** (+55 new: 38 stop-signals, 8 stop-guard, 6
  message-processor, 8 worker, 9 settings, 7 callback-time)
- `scripts/ci/migration-claims-check.sh` — OK (highest 0020, next free 0021)
- `scripts/ci/territory-check.sh` — OK, VOICE lane + shared files only
- ⚠️ **`npm run db:drift` NOT RUN — Docker is not available on this machine.** Migration 0020 is
  hand-written and was verified against the schema by eye (two columns + one index, names and types
  match). It must be run before merge.

Three tests were CHANGED rather than added, all asserting behaviour this branch deliberately
reverses: two "at the same hour" ladder assertions (now rotate), one `maxAttempts` ceiling of 3 (now
5), and `end_call('not_interested')` "never touches the lead" (now writes the soft stop).
