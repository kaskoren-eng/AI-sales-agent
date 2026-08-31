# VOICE — 2026-08-31 — the spoken tool call, the eager silence nudge, and the filler round

Two branches. The first is **already on `main`**; the second is open.

| branch | commit | state |
|---|---|---|
| `feature/voice-toolcall-leak` | `1fb7a33` | merged to `main` as `a1b71bf` by the supervisor |
| `feature/voice-filler-sound` | `3e3cc02` | pushed to origin, awaiting review |

Everything below was judged **by exit code**, never by reading a summary line.

---

## 1. P0 — she read a tool call out loud, to a real caller, for nineteen seconds

### What happened

2026-08-31 13:52 UTC, production build `d7da334`, at 196s of a 219s call. The final assistant
turn, verbatim from `call-reports/2026-08-31T13-52-55-528Z.json`:

```
בסדר. to=functions.capture_lead_info 彩神争霸大发快json content={"name":"קורן","email":null,
"phone":null,"business_type":"סוכנות לבניית אתרים","pain_point":"עונה בעצמו לכל השיחות בטלפון",
"budget":null,"timeline":null,"qualification":"warm","notes":"...","is_correction":false}
אני מבינה.. . זה שואב המון זמן. כמה פניות בערך נכנסות אליךָ ביום?
```

`spokeAtMs` 177392 → `spokeUntilMs` 196489. Cartesia read all of it: the routing header, the
Chinese, and the caller's own business type, pain point and qualification. `toolCalls` in that
report has **one** entry, at 62s — so the 196s capture never executed, and the facts he had just
given her were spoken back at him instead of being saved.

### The guard — `src/modules/channels/voice-livekit/toolcall-leak.ts`

Nothing shaped like a tool call may reach the TTS, whatever the model does.

- **Where.** `guardSpeech` calls it **first**, ahead of the booking rewrite, the number speller and
  the niqqud strip — none of which should ever be handed a payload. `guardSpeech` runs inside
  `guardStream`, which runs inside `ttsNode`, and **`ttsNode` is the one place every path
  converges**: normal replies, preemptive drafts, and the fixed reflex lines, because the SDK routes
  `session.say()` through `agent.ttsNode` too (`agent_activity.js` `ttsTask` →
  `performTTSInference((...args) => this.agent.ttsNode(...args))`). I read that in the SDK source
  rather than assuming it.
- **What it catches.** `to=functions.<name>` and bare `functions.<name>`; OpenAI harmony control
  tokens (`<|channel|>`, `<|message|>`, …) matched as a *shape*, not a list; any JSON object; a
  bare `"tool_arg":` fragment whose opening brace was lost upstream; and CJK/Hangul runs, which a
  Hebrew voice cannot pronounce under any circumstances.
- **It salvages.** The 196s turn had a good sentence behind the payload and that is what is spoken.
  Only when nothing human is left is the sentence reported `silent`, and the existing
  `notifyIfSilent` → `onSilentReply` path then speaks `HOLD_CHECKBACK_HE`. **A scrubbed reply never
  becomes dead air.**
- **`guardStream` now HOLDS** from the first sign of a payload to the end of the reply.
  `sentenceEnd` treats the end of the buffer as a terminator, and OpenAI puts a token boundary right
  after the dot in `to=functions.capture_lead_info` — so a naive split flushed the header alone and
  would then have spoken the entire payload behind it with no marker left to catch it. The test
  pins four chunkings including one character at a time.
- **Counted:** `CallReport.toolCallLeaks` + `toolCallLeakReasons`, rendered by
  `npm run call:report` as `SPOKE A TOOL CALL`. Reports written before the guard render `-`, not
  `0` — an old report cannot speak about a metric that did not exist.
- **Kill-switch:** `VOICE_TOOLCALL_LEAK_GUARD_ENABLED`, default ON.

Test: `src/modules/channels/voice-livekit/toolcall-leak.test.ts`, 26 cases, built around the exact
196s string as a byte-for-byte constant. It includes a **false-positive gate** of nine sentences she
really says — that gate caught a real bug during development (`functions\s*\.\s*ident` matched the
English "…walk through the functions. Then we book a demo", and the pattern was tightened).

### Why it happened — **I could not establish it, and I am not going to guess**

What I checked and what it says:

| hypothesis | evidence | verdict |
|---|---|---|
| prompt growth pushed the model over some edge | input tokens per completed request: **11,204** (13:52) vs **10,467** (08:37 same day). Within 7%. | does not explain it |
| history trimming orphaned a tool message | `VOICE_MAX_HISTORY_ITEMS=0` on that call — no trimming at all | ruled out |
| a config change between builds | diffed `pipeline.configured` across both calls: **2 keys differ**, and both are new *code* in `d7da334`, not changed settings | ruled out |
| our prompt contains tool-call-shaped text the model imitated | grepped `system-prompt.he.ts` and the fixtures for `functions.`, `to=`, `{"` — nothing | ruled out |
| prompt-cache churn | hit rate 81% (13:52) vs 90% (08:37), but the short call amortises its always-uncached first request over 14 requests instead of 54 | inconclusive; expected on a short call |

The **one structural oddity** I found is the coach note (`injectCoachNote`, `agent.ts`): it appends
a `system` item at the **tail** of the conversation, after the user/assistant turns, and it grew in
`d7da334` (the email and engagement notes were added). A system message in that position is unusual
for a harmony-format model. **I have no evidence tying it to this failure and I am not claiming it
is the cause.** If someone wants to chase it, the note's content at 196s would be in the deployed
agent's logs.

I did not run `npm run agent:logs` — it streams live rather than replaying history, and I did not
want to touch the deployed agent.

### The `"name": "ק…"` question — it was **the report writer**, and it is now fixed

`redactArgs` (`tools/tool-context.ts`) cut names to their first character and threw the length away.
The capture itself was **fine**: `redactArgs` runs *only* on the copy that goes into
`ToolCallLog.args` — the console line and the `CallReport`, which lands in
`call_learnings.analysis`. What the tool hands the database has never been touched by it.

But the redaction destroyed the very diagnostic it was being read for: `ק…` for "קורן" and `ק…` for
a one-letter garbage capture render identically. It now keeps the length — `ק…(4)` vs `ק…(1)` —
without making a name readable. The rule is deliberately **not** loosened.

While there: the email branch used `value.slice(value.indexOf('@'))`, which on an address with no
`@` in it (a real case — a dictated address can lose its "שטרודל") returns `slice(-1)`, i.e. the
**last character of the address, rendered as if it were a domain**. It now says `…(14 chars, no @)`.

---

## 2. P1 — the filler round he has now asked for twice

**The page: `tests/hebrew-tts-niqqud-ab/index-round10.html`** — open it in a browser, or serve the
folder and open it there. 29 clips, 10 cards, sonic-3.5 at production speed/volume (0.9 / 1.4).

He asked for this on **2026-08-30** (*"צריך שתיצור לי מבחן קולי ואבחר אופציות נכונות"*). Round 6 was
built for it the same day and he could not play a single clip — every WAV in rounds 1–8 carried the
`0xFFFFFFFF` streaming placeholder. So the spelling was never chosen, and on **2026-08-31** he said
it again: *"היא אומרת 'או-ה' במקום 'אהההה' אחיד"*.

### The distinction this round is built around

**Transcribing correctly is not the same as being pronounced correctly, and every previous round
only ever tested the first one.** Soniox writes `אהה` back whether Cartesia produced one continuous
vowel or "או-ה" with a break in the middle, because they are the same word. That is how `אהה`
reached production with nothing but a transcription-shaped argument behind it. The page says this
in a box at the top, and `roundtrip10.ts` says it in its header.

### What is currently unscreened for SOUND — the honest list

| entry | ever listened to? | note |
|---|---|---|
| `אהה.` `אוקיי.` `בסדר.` | **no** | `ACKNOWLEDGEMENTS_HE` — spoken on nearly every turn of every production call |
| `הבנתי אותך.` `טוב, הבנתי.` | **no** | judged on *frequency* on 2026-08-31, never on sound |
| `אממ...` `רגע...` `שנייה...` `אה...` | **no** | `THINKING_FILLERS_HE` — never screened at all, in any round |
| `אה אה.` | **no** | `DICTATION_NOD` — round 6 offered five spellings, none judged |
| `שלךָ` `לךָ` `אותךָ` `אליךָ` `איתכה` … | yes | rounds 3 / 3b / 3c, by ear **and** round trip |
| `לוודֵא` `רוצֶה` `רוצָה` | yes | round 3, re-tested round 6 |

In other words: **the entire filler and acknowledgement vocabulary is unscreened.** Only the
pronunciation dictionary has ever been through a listening test.

### What the machine already settled, before he listens

The round trip can say exactly two things about an interjection, and both turned out to matter:

- **`אההה` never came back at all** (cards `f1_B` and `f2_C`). The carrier sentence transcribed
  perfectly and the interjection was simply absent. This is round 4b's `אוו` failure repeating.
- **`אמ` never came back** (card `f3_B`), same shape.
- **`אהההה` — the spelling Koren proposed himself — came back as `חח`**, which in Hebrew reads as
  laughter. Not a single shared letter with what was sent.

Those four are flagged in a box at the top of the page and marked red on their own cards. They are
**left selectable** — he may still prefer one by ear — but he will know what he is choosing.

Finding them at all required a change to the instrument: a raw transcript of `f1_B` reads
`"כמה פניות נכנסות אליך ביום?"`, which looks like an ordinary line. Only by subtracting the carrier
does it read as *the word did not survive*. `split_off_carrier` (round10.py) and
`candidateSurvived` (roundtrip10.ts) do that.

### **I changed no spelling in any bank.** The options are on the page; his ear picks.

### Verification of the page itself

Because "he could not play the clips" is the failure that wasted round 6 and round 7, I did not
assume this time:

- every clip passes `wavcheck.assert_playable` — 29 clips, 0 unplayable;
- every `<audio src=>` on the page resolves to a file that exists;
- **and I loaded the page in a real Chrome via Playwright and decoded all 29 through
  `AudioContext.decodeAudioData`.** All 29 decode, at 48kHz, with durations matching their headers
  (0.56s–3.52s). Intermittent `Failed to fetch` errors in that run were the throwaway Python static
  server I had started, not the files — each one succeeded on retry, and each file also decodes
  offline through Python's `wave` module.

**What that does NOT prove: how any of them sounds.** That is the entire point of the round and it
is Koren's alone.

---

## 3. P2 — the silence nudge fired into a man who was thinking

Merged with the P0 work. `VOICE_SILENCE_AWAY_MS=7000` fired **twice inside the first minute** of the
3.5-minute call — 7287ms at 27s and 7345ms at 46s — both immediately after she had asked an open
discovery question.

**I did not just pick another number.** Read off the metric stream: in both windows *nothing ran* —
no STT final, no end-of-turn, no LLM request, no preemptive draft, no tool. So the obvious rule the
brief suggested (*suppress while the caller has speech in flight or a turn is mid-processing*)
**would not have caught either of these**, and `silenceNudgeWaitMs` says so in its own comment
rather than pretending otherwise. He was simply thinking, in silence, with nothing on the line.

Across the only two production calls carrying this instrumentation (08:37 and 13:52 the same day),
**every single `away` event was a caller thinking; none was a dead line**, and in every case he
spoke on his own 2–5s after the nudge and 11–20s after she stopped.

The change: a new `VOICE_SILENCE_NUDGE_MS` (default **20000**) decides when she may *say* something
about a silence, kept apart from the SDK's away timeout, which still decides when the caller is
"away" and still drives `endedBy` attribution in the report. `0` restores the 2026-08-31 behaviour
exactly. Her going quiet — the failure a caller really experiences as a dropped line — remains
`VOICE_HOLD_CHECKBACK_MS` at 7s, which is a different timer answering a different question.

---

## Definition of done

| gate | result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run test:ci` | exit 0 — judged by exit code, not by the summary line |
| `npm run build` | exit 0 |
| `bash scripts/ci/territory-check.sh feature/voice-filler-sound` | OK |
| test reproducing the 196s string | `toolcall-leak.test.ts`, 26 cases |
| branch pushed | `feature/voice-filler-sound` → origin, `3e3cc02` |

---

## What is UNPROVEN — read this part

1. **No call has been made on the guard.** Everything above is text-mode and unit tests. The guard
   has never run on a real PSTN call, because the leak is a model-side event nobody can trigger on
   demand. What *is* proven is that the exact 196s string cannot reach the TTS through any of four
   chunkings, and that nine ordinary sentences pass through untouched.
2. **The cause of the leak is unknown.** See the table in §1. Do not let anyone quote the coach-note
   observation as a finding.
3. **`VOICE_SILENCE_NUDGE_MS=20000` is grounded in two calls, one of them 3.5 minutes long.** It is
   a better-evidenced number than the 7000 it replaces, not a settled one. It needs a real call.
4. **The filler round is unheard.** I cannot judge how any clip sounds; I can only report that they
   decode and that four candidates are objectively compromised. Everything else waits on his ear.
5. **The `אהההה` → `חח` result is one clip, one synthesis.** It is strong enough to warn about and
   not strong enough to call a property of the spelling.
6. **LLM first-token latency: 1124ms median vs 782ms on the 08:37 call.** I could not establish
   whether that is real. Tokens per request are within 7%; cache hit is 81% vs 90%, which is what a
   short call does to the metric anyway. **Two calls is not a trend** and nobody should act on it.
7. **`fragmentedTurns: 4` over 11 turns is untouched** — she decided he was finished mid-sentence at
   12s, 39s, 73s and 96s. Out of scope here; still open.
8. **At 27s she said *"אהה. אמרתי את זה קצת רובוטי."*** — she volunteered a critique of her own
   delivery to the caller. Not investigated. **Do not paper over it with a prompt line** until
   somebody establishes what produces it.

## Questions for the architect

- **Is the coach note's tail placement worth changing on suspicion alone?** It is our only
  structural deviation from ordinary message ordering, it grew in the build that leaked, and the
  cost of moving it is a prompt-cache question rather than a behaviour one. I would not change it
  without evidence; someone with the deployed agent's logs from 13:52 could get that evidence.
- **The nod (`n1`) and the receipts (`a1`–`a4`) are single-variant cards** — "does this sound OK?"
  rather than "which is better". If Koren rejects one, we have no replacement screened and would
  need another round. Worth pre-empting?

## Not deployed

`npm run agent:deploy` is Koren's call through the supervisor session. Nothing here has been
deployed, and the live agent is still `d7da334` — **the build that leaks.** The guard is on `main`
but not in production.
