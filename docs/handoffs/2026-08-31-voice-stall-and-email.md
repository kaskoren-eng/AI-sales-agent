# VOICE — the two defects from the 2026-08-31 call (branch `feature/voice-stall-and-email`)

Both defects come from Koren's 10-minute PSTN call this morning against deployed `7cfa526`
(`call-reports/2026-08-31T08-37-55-437Z.json`). The lead agreed to a demo, gave his name and phone,
and the call ended with no booking.

**The prompt file was not touched.** `prompts/system-prompt.he.ts` and `prompts/__fixtures__/**` are
untouched — a parallel session owns them. §5 below is the wording I am asking that session to apply.

---

## Defect A — the two 15-second silences

### What it was: LiveKit's `userAwayTimeout`, default 15 seconds, which nobody had ever set

Not a stall. Not the LLM. Not the preemptive-draft machinery. The caller went quiet, and the ONLY
thing in the entire agent that reacts to caller silence is the SDK's `user_state_changed → 'away'`
event — whose timer defaults to **15 seconds** and which we had never configured.

### How I established it — four independent lines, no guessing

**1. The gaps have the shape of an assistant→assistant pair with no caller turn between.**
`CallReport#agentGaps()` only counts that shape. So on both occasions the caller genuinely produced
no transcribed speech for 15 seconds.

**2. Nothing ran inside either window.** This is the decisive one. Filtering the report's `metrics`
array to each gap:

```
GAP 1: 117112ms → 132406ms   (15294ms)      GAP 2: 301090ms → 316453ms   (15363ms)
  {"atMs":132538,"stage":"tts_metrics",       {"atMs":317080,"stage":"tts_metrics",
   "ttfbMs":236,"durationMs":368}              "ttfbMs":275,"durationMs":903}
```

That is the complete list. No `stt_metrics`, no `eou_metrics`, no `model_ttft`, no `llm_metrics`, no
`dead_air`, no tool call, no preemptive-draft event. A retried or hung LLM request would have left a
`model_ttft` or an `llm_metrics`; a stalled draft would have shown in the preemptive counters. The
only pipeline event in either fifteen seconds is the TTS first byte of the line that ENDED it.

**3. The lines that ended both gaps are the fixed silence-reflex lines**, spoken through
`session.say` (no LLM at all): `רגע, אתה עוד על הקו?` = `SILENCE_NUDGE_HE`, and
`אני כאן, אין לחץ — קח את הזמן שאתה צריך ואני מחכה` = `SILENCE_WRAP_HE` (strike 2).

**4. The arithmetic closes to the millisecond.** `node_modules/@livekit/agents/dist/voice/agent_session.js`:

```js
defaultAgentSessionOptions = { ..., userAwayTimeout: 15, ... }   // seconds
_setUserAwayTimer() { ... setTimeout(() => this._updateUserState("away"), userAwayTimeout * 1e3) }
```

armed exactly when the agent goes `listening` while the user is `listening` — i.e. the moment her
audio stops. 15000 + 294 = 15294 with a 236ms TTS TTFB; 15000 + 363 = 15363 with a 275ms one.

**Why nobody had seen it:** `deadAir` runs its stopwatch from the CALLER's turn ending, and there was
no caller turn, so it never started. It read a healthy max of 3977ms on the same call. The `agentGap`
array *did* contain both gaps — but nothing printed them, and they carried `tools: []` / `toolMs: 0`,
i.e. fifteen seconds attributed to nothing.

### A second hole, found while reading the SDK

The away timer **never re-arms while the user is `away`** (`_updateUserState` only calls
`_setUserAwayTimer` when the user is `listening`). So a caller who stayed silent through the nudge was
never checked on again, for the rest of the call. Strike 2 was unreachable inside one silence episode
— on the real call the two nudges are 182 seconds apart because he spoke in between.

### What changed

- **`VOICE_SILENCE_AWAY_MS`, default 7000** (`env.ts`), passed to `AgentSession` as
  `userAwayTimeout` (`agent.config.ts`). 7000 matches `VOICE_HOLD_CHECKBACK_MS` on purpose: the same
  question from the two sides of the call. `15000` restores the old behaviour exactly; `0` disables
  the away timer (and with it the silence reflex).
- **The reflex re-arms** after its own line (`armSilenceRecheck` in `agent.ts`), so strike 2 is
  reachable within one silence. Bounded by the existing `MAX_SILENCE_NUDGES` — `decideSilenceAction`
  returns `null` past 2, so a call can still never be nudged more than twice, and silence still never
  hangs up.
- **Attribution.** The reflex records a `silence_reflex` metric (the mute watchdog records
  `mute_checkback`), and `AgentGap` gained `endedBy`, set when one of those lands inside the gap. A
  timer can no longer read as a hung request.
- **`scripts/show-call-report.mjs` prints it**: a new `SILENCE WITH NOBODY TALKING` block, listing
  every gap ≥5s with what ended it — or `NOTHING — no tool, no reflex, unattributed`. Run against
  this morning's report it prints both 15s gaps, which the old renderer never showed.
- **`pipeline-observer.ts`** reads `userAwayTimeoutSec` back off the live session, so the number is
  in every future call report rather than being an invisible framework default.

---

## Defect B — the email

Real address `kaskoren@gmail.com`; she converged on `koren@gmail.com` and ran out of call. Four
separate things went wrong; here is what I did about each.

### B1 — she spoke over him while he was spelling. **Already fixed on `main`, just not deployed.**

`dictation.ts` (merged `93a9f92`) IS in `main` and is NOT in the deployed `7cfa526`
(`git merge-base --is-ancestor 93a9f92 7cfa526` → false). I checked whether its `SPELLED_OUT` pattern
covers a **Latin** letter run and not only digits and Hebrew email words: it does. Replaying the real
turns through `isDictationTurn`, every one of the spelling turns returns `true` —
`זה בהתחלה. K. A-F.`, `K-A. F.`, `K-O-R-E-N.`, and the `שטרודל / ג'ימייל` turns. Confirmed live on the
local run: `[44s] AGENT אה אה. …` — the nod, not a receipt.

**So: do not rebuild this. It needs a deploy, not code.**

### B2 — the letters were never stitched. NEW: `email-dictation.ts`

`K-A.` / `S.` / `K-O-R-E-N.` are three turns and one address. Nothing joined them, and the model said
so out loud: *"שמעתי גם k a f וגם k o r e n"*. `EmailDictation` now accumulates every spelled letter
in order across turns while she is collecting the email, resolves the spoken domain
(`ג'ימייל נקודה קום` → `gmail.com`, deterministic), and hands the model the **evidence** — never a
guess: it deliberately does NOT transliterate a Hebrew-spoken local part, because a confident wrong
guess is the defect.

### B3 — a rejected value came back. NEW: a rejection ledger in `fact-memory.ts`

`FactMemory` only ever grew, so a value the caller had explicitly killed looked to every later turn
like a value nobody had established. Added:

- `FactMemory.reject(field, value)` — records it, and CLEARS it if we were holding it.
- `guardIdentity` refuses a rejected value **before everything else, including `is_correction`** —
  that flag exists so the LEAD can change a value, and the lead is exactly who ruled this one out.
- `capture_lead_info` returns a distinct `NOT SAVED: …` result telling the model why.
- The fact-memory note names the ruled-out values.

`email-dictation.ts` is what NOTICES the rejection (her read-back + his `לא נכון`); `fact-memory.ts`
is what ENFORCES it. Enforcement lives there because that is where "what may overwrite what" already
lives, and `capture_lead_info` already reads that object — no new plumbing through `tool-context`.

### B4 — she read it back in English. **Prompt-side; see §5.** The runtime note asks for a Hebrew
word-first read-back as an interim measure, but the durable wording belongs in the prompt.

### Kill-switch

`VOICE_EMAIL_DICTATION_ENABLED`, default `true`, per the module convention. Off restores the previous
behaviour exactly (the class is never constructed and every reader is `?.`).

---

## What I actually ran

`npm run typecheck` **0** · `npm run test:ci` **0** (112 files, 1398 passed, judged by exit code)
· `npm run build` **0** · `bash scripts/ci/territory-check.sh feature/voice-stall-and-email` **OK**.
44 new unit tests across `email-dictation.test.ts`, `fact-memory.test.ts`,
`capture-lead-info.tool.test.ts`, `call-report.test.ts`.

**Two local end-to-end calls** (`npm run voice:dev` + `npm run voice:test -- email_spelling`, worker
under `VOICE_DEV_AGENT_NAME=keren-stall-email` so it could not collide with another session's
`keren-dev` and could not be handed a real call). New scenario `email_spelling` replays the exchange.

Run 1 (before two fixes it exposed) ended with her proposing *"את הכתובת כמילה קורן"* — still wrong.
Run 2, after the fixes, ended:

```
[46s] CALLER  K-A-S.
[52s] AGENT   אהה. המייל הוא k-a-s-koren@gmail.com?          <- stitched, first time ever
[55s] CALLER  לא נכון.
[84s] AGENT   אז החלק לפני השטרודל הוא קייס. הדומיין הוא gmail.com — נכון?
[90s] CALLER  K-O-R-E-N שטרודל gmail נקודה com.
[99s] AGENT   לפני השטרודל — קאסקורן. ואחר כך gmail.com. זה נכון?   <- kaskoren@gmail.com, in Hebrew
```

That is the correct address, read back as a Hebrew word. The production call never got there.

The two fixes run 1 exposed, both now covered by tests:

1. a **lone letter turn** (`S.` on its own) was not stitched — `LETTER_RUN` needs two letters. A turn
   that is nothing but a single Latin letter is now taken, but only while collecting.
2. `readbackCandidate` now **requires a domain**. Without it, her progress report
   *"רשמתי K-A-S. תמשיך…"* counted as an address proposal, and the scripted `לא נכון` recorded
   `«kas»` as rejected — a value he had in fact just given her.

---

## §5 — the prompt wording I am asking the OTHER session to apply

I did not touch the file. This is the collection script for the email; the current one produces the
English spelled read-back. Place it wherever Step 4's contact-collection script lives.

> ### איסוף כתובת מייל
>
> כתובת מייל היא הפרט הכי קשה להעביר בטלפון. אל תקריאי אותה באותיות באנגלית — `"k o r e n at gmail
> dot com"` הוא בדיוק מה שהלקוח לא מצליח לאמת בקו טלפון, וזה מה שהכשיל שיחה שלמה.
>
> 1. בקשי את החלק **שלפני השטרודל** בלבד, כמילה אחת: *"תגיד לי רק את החלק שלפני השטרודל, כמילה
>    אחת."* את הדומיין תשאלי בנפרד ורק אם הוא לא נאמר.
> 2. **הקריאה חוזרת בעברית, כמילה** — *"אז לפני השטרודל זה קאסקורן, ואחריו ג'ימייל נקודה קום. נכון?"*
>    רק אם הוא אומר שהמילה לא נכונה, אייתי אות-אות **בשמות האותיות בעברית** (קיי, איי, אס), לא
>    באנגלית.
> 3. **אותיות שהגיעו בכמה תורות הן כתובת אחת, לא כמה גרסאות.** אם שמעת `K-A` ואז `S` ואז `K-O-R-E-N`
>    — זה `kaskoren`, ברצף, לפי הסדר שנאמר. לעולם אל תציגי אותן ללקוח כאפשרויות מתחרות ("שמעתי גם
>    ... וגם ..."); זה מעביר אליו את העבודה שלך.
> 4. **ערך שהלקוח פסל לא חוזר.** אם אמר "לא נכון" על קריאה חוזרת — אותה כתובת בדיוק לא נאמרת שוב
>    ולא נשמרת. הכתובת הנכונה **שונה** ממנה, ולכן קריאה שיוצאת אותו דבר היא קריאה שגויה. בקשי רק את
>    החלק שאת לא בטוחה בו.
> 5. אחרי שתי קריאות חוזרות שלא הצליחו — אל תישארי בלולאה. קחי את מה שיש, אמרי שתשלחי אישור
>    בוואטסאפ לנייד, וסגרי את הפגישה. פגישה שנקבעה עם מייל חסר שווה אינסוף מהתעקשות על המייל.

Point 5 matters as much as the rest: the production call spent its last 54 seconds on this field and
died there. The booking was already agreed at 450s.

---

## What is NOT proven

- **No PSTN call.** Everything here was verified locally against the synthetic caller. Defect A's fix
  in particular has never been heard by a person: I have not confirmed that a 7s check-back feels
  right rather than nagging. That is an ear question and it is Koren's.
- **The local runs had no database** (`agent_db_unreachable`), so `runtime` was null and **no tool ran**
  on either call. The `capture_lead_info` rejection guard is proven by unit tests only, never end to
  end. Defect B's other half — the coach note — did run, and the transcript above is its effect.
- **The `email_spelling` scenario's caller is not adaptive.** Its `לא נכון` fires on a fixed schedule,
  so in run 2 it landed on a read-back that was partially right. That makes the run a behaviour probe,
  not a pass/fail gate.
- **The 7000ms default is a judgement, not a measurement.** I chose it to match
  `VOICE_HOLD_CHECKBACK_MS`. Nobody has A/B'd 5s vs 7s vs 10s on a real caller.
- **Nothing was deployed** (explicitly out of scope). B1 in particular is a fix that already exists on
  `main` and will only reach callers on the next deploy — which is separately blocked by the
  `agent:deploy` secrets hazard.

## Questions for architect

1. **Deploy gating for B1.** The mid-dictation nod has been sitting on `main` since `93a9f92`,
   unreachable by any caller, and it is half of a defect that has now cost two bookings. What unblocks
   the `agent:deploy` secrets hazard?
2. **Should the silence reflex ever hang up?** Today it never does, by design. After two nudges she
   holds the line indefinitely and the call is only ended by `participant_disconnected`. On a metered
   trunk an abandoned handset bills until the network drops it.
