# Voice (LiveKit) — known issues and dead ends

**Tribal knowledge.** Everything here was learned by burning a day on it. Each item is a lever
that looks obviously worth pulling and is not. Read this before "optimising" the voice agent.

Written 2026-07-13, after Phase 1–3 and the Phase 2 latency work.

---

## The one-line summary

**Hebrew is a second-class citizen in every off-the-shelf voice component.** Every latency lever
the vendors sell either excludes Hebrew or doesn't work on it. The realistic floor for a Hebrew
cascade pipeline (STT → LLM → TTS) is **~1.5s per turn**, not the ~800ms the industry guides quote
for English. Plan the product around that.

---

## 1. `gpt-realtime-whisper` does not support `semantic_vad`

**What it looks like:** you pass `turnDetection: { type: 'semantic_vad', eagerness: 'high' }` to
`openai.STT`. It typechecks. The worker boots clean. Nothing errors.

**What actually happens:** the plugin logs, once, at INFO:

```
Turn detection is not supported for gpt-realtime-whisper; ignoring the provided
turnDetection and using plugin-side VAD commits instead.
```

and silently ignores it. Measured end-of-utterance delay was **identical with and without it**.

**Why:** `gpt-realtime-whisper` is a *transcription-only* model. Semantic VAD — where the model
decides you've finished talking based on what you *said*, not on silence — is a feature of the
full realtime *conversation* models. Transcription-only endpoints don't do turn-taking.

**Consequence:** the only Hebrew-capable end-of-turn signal we have is a **silence timer**, which
is why end-of-turn costs ~1s (see §5).

**Related trap:** the same model also rejects the `prompt` parameter ("The 'prompt' parameter is
not supported for this model") and *does* hard-error on it, killing the session with an
`stt_error`. So STT keyword biasing requires switching to `whisper-1` — see §6.

---

## 2. `sonic-turbo` cannot stream Hebrew

**What it looks like:** Cartesia's low-latency model. Obvious win — it should shave ~300ms off TTS.
It even sounds fine if you synthesize a whole sentence to a WAV file.

**What actually happens:**

- With `language: 'he'` it returns **zero audio** — a 44-byte WAV header, no samples. Cartesia
  reports `"Invalid language for model: The language is not supported by this model"` but only as a
  **DEBUG** line; the plugin surfaces it as an empty stream, no throw, no warning.
- Without the language parameter it *does* produce audio, and a one-shot WAV sounds acceptable.
- **On a live call it is garbage** — unintelligible, not recognisably any language. The agent
  streams text to Cartesia token-by-token as the LLM produces it, and with no declared language
  Cartesia has to guess per fragment. On tiny Hebrew fragments it guesses wrong.

**Consequence:** `sonic-3` is the ONLY Cartesia model that speaks Hebrew. Its ~450ms
time-to-first-byte is a **floor**, not a tuning target.

**The lesson that generalises:** an empty response is evidence of a bug in YOUR request, not proof
of a limitation in THEIR model. Turn the log level up and read the provider's own error before
concluding anything. Verify with `npm run voice:ab -- <model>`.

---

## 3. There is no faster LLM

Measured, same prompt, full completion:

| Model | Time |
|---|---|
| gpt-5.4 + `reasoning_effort: none` | 1679ms |
| gpt-5-mini | 1762ms |
| gpt-5-mini + `reasoning_effort: low` | 1462ms |
| **gpt-5-nano** | **2227ms — SLOWER than 5.4** |

**~1s to first token is a floor across the whole family.** It is not reasoning overhead and it is
not model size — it is fixed network + queueing latency. Downgrading the model buys nothing and
costs quality.

**Trap:** `reasoning_effort: 'none'` is **accepted by gpt-5.4** and **rejected by gpt-5-mini** with
a 400. A rejected combination makes the agent go **completely silent mid-call** — the LLM returns
zero tokens, no audio is produced, and the caller sits there saying "hello? is anyone there?"
There is no error until you look for it. If you change the model, re-check the effort value.

**Also measured and rejected:** trimming the chat history does NOT reduce time-to-first-token
(3836 → 3055 input tokens changed ttft by 2ms). It is a **cost** lever only. See
`VOICE_MAX_HISTORY_ITEMS`.

---

## 4. LiveKit's turn detector has Arabic. It does not have Hebrew.

Both of LiveKit's end-of-turn models were checked by reading their shipped language lists:

- `@livekit/agents-plugin-livekit` — `MultilingualModel`, `languages.json`:
  `de, en, es, fr, hi, id, it, ja, ko, nl, pt, ru, tr, zh` — **no `he`**
- LiveKit Inference `turn-detector-v1` — `languages.js`:
  `ar, de, en, es, fr, hi, id, it, ja, ko, nl, pt, tr, zh` — **no `he`** (it has Arabic!)

**Worth requesting from LiveKit.** Hebrew is a small addition to a model that already covers
Arabic, and it is the single biggest thing standing between us and a sub-second agent. If they
add it, ~700ms comes off every turn for free.

---

## 5. End-of-turn is ~1s, and the test harness lied about it

**The trap that cost the most time.** Our synthetic caller (`npm run voice:test`) measured
end-of-turn at **258ms**. Real phone calls measured **~950ms**. Same config.

**Why:** the synthetic caller sends **digital silence** between utterances. A phone line never
does — there is always hiss and comfort noise. Silero's VAD decides "still speaking" from audio
*energy*, so on a real line it keeps hearing "speech" and the silence timer never fires. Every
endpointing number the harness produced was measured in a world that does not exist on a telephone.

**Treat the synthetic caller as an A/B instrument only.** Never quote its absolute numbers, and
never validate an audio-path change with it.

**Mitigations tried:**
- Tightening the silence timer (550→250ms): worked in the harness, **no effect on a real phone**.
- Raising Silero's activation threshold (0.5→0.7): **no material gain**.
- Krisp on the SIP trunk (`krispEnabled`): **was already on**, and did not fix it — that is
  server-side.
- **Agent-side `TelephonyBackgroundVoiceCancellation()`**: the current bet. Cleans the caller's
  audio before the VAD sees it. If it works, the 250/200ms endpointing finally takes effect.

---

## 6. Hebrew STT mishears names, phones and emails — and Phase 4 depends on them

On real calls the streaming STT produced:

| Said | Heard |
|---|---|
| קורן | **קורנטיטרי** |
| השארתי פרטים | **הייתי פרטימה** |
| (line noise) | **"you"** (phantom English) |

A booking agent that mishears the customer's email is worse than no agent.

**Measured fix** (same scripted call — name, phone, email):

| | `gpt-realtime-whisper` | `whisper-1` + biasing |
|---|---|---|
| Phone | `05 0255 784` ✗ | `050-255-784` ✓ |
| Email | `המל … קליקס כ-.קום` ✗ | `המייל … קליקסקיילס` ✓ |
| End-of-turn | ~950ms | **~2000ms** |

**Decision: HYBRID.** Keep the fast streaming STT for conversation; switch to `whisper-1` +
biasing **only** while capturing name/phone/email/date, where a mistake is fatal and a second is
not. Both mechanisms are verified to exist:

- `stt.updateOptions({ model: 'whisper-1', prompt })` — swap in place
- `voice.Agent` takes its own `stt`, so a dedicated capture sub-agent can differ from the main one

**This is Phase 4 work**, because the booking tools are what know when we're capturing details.

---

## 7. The agent will invent your business if you don't tell it

The prompt named ClickScales and never said what it *does*. The model inferred it from the name:
**"ClickScales" → "scales" → מאזניים.** Three of five probes had it telling real callers we sell
**weighing equipment**.

An LLM given no facts will always invent plausible ones. State the facts, and forbid the inference
by name. There is a regression test for this (`system-prompt.test.ts`).

**Phase 4** replaces the hardcoded facts with `SettingsService.getBusinessProfile()`, which is
where they belong per tenant.

---

## 8. Hebrew has three grammatical persons and the agent got all three wrong

The voice is female. Hebrew inflects by gender, so unlike English there is no neutral option — and
each of these takes a *different* gender:

| | Correct | It said |
|---|---|---|
| Herself (אני) | feminine — *אני יכולה* | *אני יכול* (masculine) |
| The company (אנחנו) | **masculine plural** — *אנחנו מספקים* | *אנחנו מספקות* (feminine) |
| The caller | the CALLER's gender | applied her own |

"Speak about yourself in the feminine" leaks into the first-person plural. The company is not a
woman. Say all three explicitly, and test against the live model, not just the prompt text.

---

## 9. Cartesia's Hebrew TTS is NOT deterministic, and sometimes stutters

**Found while building the STT corpus. This is a live-call risk, not a test-only curiosity.**

The same sentence, synthesized four times through `sonic-3`, came back:

```
2.9s   4.1s   4.5s   7.1s
```

The long takes contain the phrase spoken **more than once**, separated by silence. One take of a
3-second sentence came back at **15.3 seconds** — five separate speech bursts.

**What this means on a live call:** the agent may occasionally stutter, repeat itself, or pause
mid-sentence at a real caller. It is a plausible explanation for replies that "ran 3–5 seconds"
when the prompt caps her at two sentences.

**Mitigated in the corpus** (`scripts/generate-stt-test-corpus.ts` validates every take and rejects
any with a >500ms internal silence gap). **NOT mitigated on the live path.**

### ⚠️ RE-MEASURED 2026-09-02 ON `sonic-3.5`, AND IT DOES NOT REPRODUCE

The measurement this section asked for ("log TTS output duration per turn against character
count") now exists, as `speechPace` in the call report. Before wiring it, the same probe was run
directly against Cartesia at the **production** settings (`sonic-3.5`, speed 0.9, volume 1.4, over
the **websocket streaming path** the agent actually uses), six takes per line:

| line | chars | min ms/char | max ms/char | spread |
|---|---|---|---|---|
| `אנחנו דואגים שכל פנייה שנכנסת אליך תקבל שיחה תוך דקה.` | 53 | 75.5 | 84.5 | **1.12×** |
| `רגע, אני בודקת את היומן.` | 24 | 80.0 | 86.7 | **1.08×** |

**1.1×, not 2.4×.** No take contained a repeat, and none produced a burst pattern. So the figure
above is either specific to `sonic-3` (this was `sonic-3.5`), to the one-shot `/tts/bytes` route
(this was the stream), or to speed 1.0 — and whichever it is, **it is not the risk the current
production path runs.** The old numbers stay on the page because the corpus mitigation was built
against them and because nobody has isolated which of the three variables it was.

**Do not quote 2.4× as a reason a pacing feature cannot be measured.** It was the reason given in
the first draft of the voice-modes plan, and it was wrong by a factor of twenty.

### And the lever itself works — measured the same day

`speed` genuinely moves Hebrew duration on `sonic-3.5`, and `TTS.updateOptions({ speed })` between
syntheses is honoured. Same line, four takes per setting, median:

| speed | median | vs 0.90 | take-to-take noise |
|---|---|---|---|
| 1.00 | 4000ms | −3.8% | 1.04× |
| **0.90** (production) | 4160ms | — | 1.08× |
| 0.84 | 4720ms | **+13.5%** | 1.11× |
| 0.75 | 5360ms | **+28.8%** | 1.19× |

Two things to carry from this table:

- **It is not linear at the top.** 1.00 and 0.90 differ by under 4% — less than the noise. There is
  nothing to win by speeding her up from 0.90, and the 8kHz intelligibility argument says do not.
- **A hesitant mode needs to go below ~0.80 to be heard.** 0.84 buys 13.5%, which sits barely
  above a 1.11× noise band on one utterance. 0.75 buys 28.8% and is unambiguous. Pick the setting
  from this table, not from taste, and then check it by ear.

---

## 10. STT: Soniox beats gpt-realtime-whisper decisively on Hebrew

Measured 2026-07-13, `npm run stt:ab`, 10 Hebrew utterances x 3 channel conditions x 2 engines.
On the **noisy** condition (band-limited + line noise — the closest thing to a phone call):

| | gpt-realtime-whisper | Soniox stt-rt-v4 |
|---|---|---|
| Semantic WER | 34.9% | **4.3%** |
| Greetings | 72.2% | **0.0%** |
| End-of-turn (clean/phone) | ~1270ms | **~780ms** |
| Cost | $0.017/min | **$0.002/min** (8.5x cheaper) |

**The one that matters for Phase 4** — a phone number spoken aloud in Hebrew:

- OpenAI heard **"עסק"** (business) where the caller said **"אפס"** (zero). *The leading zero of the
  mobile number is gone.* The number is unusable.
- Soniox returned **`052-345-6789`**. Perfect.

**Soniox also solves §1 and §6:** it accepts biasing terms (`context.terms`) on a STREAMING
connection. The whole "hybrid STT" workaround — swap to REST `whisper-1` while capturing a
name/phone/email and eat ~1s per turn — exists ONLY because `gpt-realtime-whisper` rejects `prompt`.
With Soniox, **that workaround is deleted rather than built.**

### Two traps that nearly produced a confident, completely wrong answer

**(a) Raw WER said the OPPOSITE of the truth.** Soniox does inverse text normalisation — it writes
spoken numbers as digits. Raw WER scored its *perfect* `052-345-6789` as **76.9% wrong** for not
writing ten Hebrew words, and scored OpenAI's mangled version as 15.4%. Judging engines on
*formatting* rather than *meaning* would have made us reject the better engine because of a feature
we actively want. Score with `semanticErrorRates()`, which canonicalises numbers on both sides.

**(b) Sliced audio silently zeroed the OpenAI arm.** `pcm.subarray()` returns a VIEW whose `.buffer`
is the whole file; LiveKit's OpenAI plugin reads `item.data.buffer` **without honoring
byteOffset/byteLength**, so it transmits the entire audio file on every 20ms frame. OpenAI receives
nonsense, never detects speech, and returns **nothing** — no error, no log. That reads as 100% WER
and hands Soniox a landslide that is purely a harness bug. **Always copy frames** (`new
Int16Array(view)`) before handing audio to a LiveKit STT plugin. The Soniox plugin gets this right;
the OpenAI one does not.

**(c) `VADStream.endInput()` always throws** — it closes a writable while a writer holds the lock
(`ERR_INVALID_STATE: WritableStream is locked`). A live call never hits it because the caller's
audio never ends; every finite test buffer does. Measure end-of-turn by appending trailing silence
**matched to the channel** and letting the engine decide, which is what happens on a real call.

### Not yet settled

- **End-of-turn under noise.** Soniox wins by ~500ms on clean and phone-band audio, but on the
  *noisy* condition it measured 1218ms vs OpenAI's 1139ms — it got *worse* with noise. That may be
  an artefact of synthetic white noise rather than real line noise. **Shadow mode on real callers
  settles this**, and it is the one number that decides whether `turnDetection: 'stt'` is worth it.
- **Soniox transliterates the brand.** It returned "ClickScale" (English) for "קליקסקיילס", because
  `VOICE_STT_PROMPT` lists both spellings and `languageHintsStrict` is false. Drop the English
  variants from the biasing terms.
- **n is small** (10 utterances/condition) and both engines are non-deterministic; category cells
  moved several points between two runs of identical config. Treat the direction as solid and the
  decimals as noise.

---

## 11. `turnDetection: 'stt'` with Soniox CUTS CALLERS OFF. Do not use it.

**Tested on a real call, 2026-07-14. It failed, and it failed in the worst possible way.**

Soniox emits an `<end>` token, which the LiveKit plugin turns into `END_OF_SPEECH`, which means
`turnHandling.turnDetection: 'stt'` can replace the Silero silence timer. That looked like the first
credible answer to the ~1.1s Hebrew end-of-turn wall (§4, §5). **It is not.**

On a real call the log said, **ten times**:

```
WARN  stt end of speech received while vad is still in a speech segment, flushing vad
```

Soniox declared the caller finished **while he was still speaking**. The same call on
`turnDetection: 'vad'`: **zero** such warnings.

**What the caller experienced** (Koren, unprompted — he diagnosed it from the phone):

- *"Three times it just disappeared and stopped talking."* The agent heard **16 turns and spoke only
  12**. Four turns were chopped mid-sentence, committed as fragments, and abandoned.
- *"When I talk more than five or six words the delay got very high; three or four words, not bad."*
  Exactly right, and it is the tell. A short utterance has no internal pause, so nothing fires early.
  A long one does — so it gets chopped, re-committed and re-generated.
- *"It didn't get the phone number when I said it in one go."* A long digit string with micro-pauses
  between groups. Cut in half.

**Why.** Soniox's endpoint is a SILENCE detector with a 500ms floor (`maxEndpointDelayMs` is clamped
to 500–3000 by the plugin), not a linguistic one. It cannot tell "he paused to think" from "he
finished". Hebrew speakers pause mid-clause constantly. Being language-agnostic about *silence* is
not the same as understanding *sentence completion*, and that second thing is what nobody sells for
Hebrew.

**The metrics LIE about this.** End-of-turn measured a median of ~259ms in this mode — the best
number we have ever recorded — because a turn cut in half finalises fast. The instrument said we had
won while the caller was being talked over. **Never accept an end-of-turn number without checking the
turns-heard vs turns-answered count, and the `flushing vad` warnings.**

**Keep `VOICE_TURN_DETECTION=vad`.** Soniox on the VAD timer measured ~690ms end-of-turn (down from
1113ms with OpenAI) with zero cut-offs — it commits its final transcript faster, so the win arrives
anyway, safely.

---

## 12. NEVER mutate the chat context in `onUserTurnCompleted` — it kills preemptive generation

**This was live for days before anyone noticed, and it was costing latency the whole time.**

`ClickScalesAgent.onUserTurnCompleted()` called `chatCtx.truncate()` to stop the whole call being
re-sent to the LLM every turn. Every single turn, the log said:

```
WARN  preemptive generation enabled but chat context or tools have changed after
      `onUserTurnCompleted`
```

**15 times in one 4-minute call.** Preemptive generation drafts the reply DURING the end-of-turn
wait, so the LLM's ~1.1s hides behind it instead of adding to it. The draft is built from the
context as it was; mutating the context afterwards invalidates it, so **LiveKit discarded every
draft and regenerated from scratch.** Preemptive generation was dead from the moment the truncate
landed (217ff07), while the config said `enabled: true` and we believed it was working.

And trimming had already been measured to save **zero** latency (3836 → 3055 input tokens moved ttft
by 2ms). So it was buying nothing and costing the single biggest latency mechanism in the pipeline.

**If you need to trim a long call**, summarise older turns into the system prompt BETWEEN turns.
Do not touch the context inside that hook.

---

## 13. FULL niqqud makes Cartesia WORSE — but ONE mark on ONE letter is the shipped fix (2026-08-26)

> **⚠️ 2026-08-26 amendment — read before citing this section.** The headline below is about
> **blanket** diacritization (pointing every word), and it stands: do not send fully-pointed
> Hebrew. But the later rounds this section originally didn't cover (July round 2, D/E/F —
> then round 3 on sonic-3.5, `round3.py` / `index-round3.html`) tested **minimal niqqud** — a
> single vowel mark on only the ambiguous letter, rest of the sentence plain — and it **won the
> listening A/B against both plain text and the שלכה respelling**. It now ships:
> `speech-guard.ts` sends שלךָ (one kamatz), לוודֵא (one tsere), and a per-word feminine table.
> One mark answers exactly the question the TTS was guessing at; full pointing pushes the whole
> sentence out of the model's training distribution. Both facts are true at once — that is why
> `guardSpeech` STRIPS model-emitted niqqud first, then injects only these verified marks.

The idea keeps coming back because it sounds obviously right: Hebrew doesn't write vowels, so the
gender bug (שלך = shel-KHA vs shel-AKH) is a missing-vowel problem — so *add the vowels* with niqqud
and the TTS can't guess wrong. We tested it properly instead of guessing.

**The experiment** (`tests/hebrew-tts-niqqud-ab/`): 10 sentences from the Keren prompt (names,
spoken-digit phone numbers, embedded English), each synthesized by sonic-3 three ways —

- **A** plain text (what we send today)
- **B** full **Phonikud** output (`add_diacritics()` — niqqud + its TTS stress marks)
- **C** standard niqqud only (B with the OLE `U+05AB` and METEG `U+05BD` accents stripped)

Phonikud itself is excellent: it produced correct masculine forms (שֶׁלְּךָ, אֵלֶיךָ) and even
disambiguated the names by vowel (קֶרֶן KEren vs קוֹרֶן KOren). The diacritization was not the problem.

**The result: both B and C sound BAD.** Koren, listening: "נשמע רע מאוד עם הניקוד"… then on the
clean C variant: "נשמע רע עדין." Distorted, and measurably **longer** — B/C clips ran 1.3–2.4× the
plain duration. sonic-3 was trained on **un-diacritized** Hebrew; every niqqud character it sees is
noise it tries to pronounce. (The METEG accent literally means "lengthen the vowel", which is part of
why the audio dragged — but stripping it in variant C did not save the approach.)

This is the SECOND time niqqud has been rejected on real audio — the first was manual niqqud in the
system prompt ("אין משהו אחיד"). Two independent attempts, same verdict.

**What to do instead — surgical, not blanket. This evolved; the current answer is minimal niqqud.**
The first shipped fix respelled with ordinary letters (שלך → שלכה) — it worked because it kept the
rest of the sentence plain. Round 3 (2026-08-26, sonic-3.5) put that respelling head-to-head against
**minimal niqqud** (one mark on the ambiguous letter only: שלך → שלךָ) and minimal niqqud won by
Koren's ear on every masculine word and most feminine ones — `speech-guard.ts::forceAddressGender`
now ships the per-word winners, plus a gender-neutral dictionary (לוודא → לוודֵא). Every entry is
double-verified: listening-page pick + round-trip (TTS → 8kHz line → Soniox → the intended plain
word — `roundtrip.ts`, 27 clips). What remains true: never diacritize the whole utterance, and
`guardSpeech` strips any niqqud the LLM emits before injecting the verified marks.

The harnesses and audio for all three rounds are kept under `tests/hebrew-tts-niqqud-ab/` as the
evidence, so this does not get re-litigated in either direction. The 293MB ONNX model is gitignored
(re-fetch instructions in that folder's README).

---

## 14. Preemptive generation cannot work against Soniox. Stop trying.

Three sessions went into making LiveKit draft the reply during the end-of-turn wait. It does not
work here, the reason is structural, and the point of this entry is that the next person does not
spend a fourth.

A draft is only used if it passes this, in `agent_activity.js:1711`:

```js
preemptive.info.newTranscript === userMessage.textContent && preemptive.chatCtx.isEquivalent(chatCtx) && ...
```

**Strict string equality against the committed transcript.** And the Soniox plugin builds an
INTERIM as `finalTokens + nonFinalTokens` but the FINAL as `finalTokens` alone
(`_internal.js:211`), so any draft taken from an interim carries text Soniox has not committed to
and will still rewrite. What actually happened, across four real calls:

| date | drafts started | used |
|---|---|---|
| 2026-08-16 (pause trigger @200ms) | 6 | 0 |
| 2026-08-16 (endpoint delay 1000ms) | 3 | 1 |
| 2026-08-16 (same config, next call) | 0 | 0 |

The one that survived produced **248ms** of dead air; its neighbours on the same call produced
2222ms and 2958ms. So the mechanism is real — it is the *trigger* that cannot be made reliable.
The two that died on that call differed from the commit by **one character** of trailing
punctuation, which is why `withPreflightSurvival` in `stt/soniox.stt.ts` exists. It was not enough:
the next call produced no preflights at all.

Left in the tree, off: `VOICE_PREEMPTIVE_PAUSE_MS=0`. The code and its tests are sound against an
STT with stable interims. It is the premise Soniox violates.

**Two instruments were wrong while this was being chased, which is why it took three sessions:**

- `summary.worstCaseMs` sums three medians that never co-occurred on one turn and is blind to
  overlap by construction. It read 1466ms on a call the caller experienced as 2535ms. Use
  `summary.deadAir` — caller stopped → agent audio out.
- `llmTtftMedianMs` averaged in LiveKit's `-1` sentinel for cancelled drafts, so six discarded
  drafts pulled the median to 314ms on a call whose real time-to-first-token was 820–950ms. That
  was reported as the fix working. Cancelled drafts are now excluded and counted as
  `draftsDiscarded`.

## 15. The speech guard is NOT the latency cost. Measure before blaming it.

`npm run bench:path` runs the live model on the real prompt through the REAL `guardStream`:

```
ttft 974ms   firstSentence 999ms   fullReply 2387ms
```

**The guard releases the opener 25ms after the first token.** Its per-sentence flush works; the
pipeline already streams correctly. Two deploys were spent on the theory that it buffered the whole
reply, on the strength of a per-turn correlation between dead air and full generation time that
turned out to be coincidence on short replies.

Run the bench before touching the guard. It costs cents and no phone call.

## 16. Punctuation DOES pause sonic-3.5 — but a comma is the weakest mark you have, and streaming eats it

**Measured 2026-08-30**, after Koren's note on the two production calls that morning: *"השימוש
בפסיקים ונקודות כדי לעצור באמצע משפט לא עובד כמו שצריך, הזרימה של הדיבור לא מספיק טובה במיוחד
בתחילת השיחה."*

The tempting conclusion is "sonic-3.5 ignores Hebrew punctuation". It does not. What it does is
realise a comma so weakly that the streaming path can lose it altogether. `pause_probe.py`
(10ms RMS frames, silence at 4% of the clip's own peak, gaps ≥90ms) on the real greeting, at the
production speed/volume:

| greeting variant | one-shot `/tts/bytes` | the agent's own websocket stream |
|---|---|---|
| `שלום,` (today) | 180ms | 180ms |
| `שלום —` | 270ms | **470ms** |
| `שלום.` (split) | 210ms | **260ms** |
| `שלום...` | 330ms | **560ms** |
| `שלום <break time="0.35s"/>` | 650ms | **780ms** |

And on the long comma-chained value proposition, the streaming path **dropped three of its five
pauses** (the 90ms and 140ms ones vanished entirely), while the same sentence split into real
sentences kept five of seven. So:

- **A comma buys ~0.18s and is the first thing to disappear.** If a beat matters, end the sentence
  or use `—` / `...`.
- **This is a TEXT lever, not a request lever.** `max_buffer_delay_ms: 0` is hardcoded in
  `@livekit/agents-plugin-cartesia` (`dist/tts.js:567`) and the plugin re-splits our text with
  LiveKit's `basic.SentenceTokenizer` (min 8 CHARACTERS, `.!?` only — `…` is not a terminator), so
  short clauses are glued to the next one before Cartesia ever sees them. Neither is configurable
  from our side without forking the plugin.
- **`<break time="…"/>` appears to be honoured, and is NOT read aloud.** The Soniox round-trip of
  that clip comes back as clean Hebrew with no stray token, in both paths, while producing the
  longest pause of any variant. That is a real, previously-unknown lever for Hebrew — **unverified
  by ear, and undocumented by Cartesia**, so it is recorded here and not shipped. If it is ever
  adopted, note that a silently-ignored tag would be READ OUT to a caller, which is the worst
  possible failure mode; verify on a live call first.

Evidence and reproduction: `tests/hebrew-tts-niqqud-ab/round6.py` (`ps` cards),
`pause-stream-probe.ts`, `pause_probe.py`, `index-round6.html`.

The prompt now states the comma finding with its numbers, so the model stops leaning on the mark
that does nothing.

---

## Realistic latency budget for Hebrew

Re-measured 2026-08-16 on the live stack (Soniox `stt-rt-v5` → gpt-5.4 `priority`/`effort=none`
→ Cartesia `sonic-3.5`), with `SONIOX_MAX_ENDPOINT_DELAY_MS=1000`:

| Stage | 2026-07 | 2026-08-16 | Note |
|---|---|---|---|
| End-of-turn | ~950ms | **~400ms** | the endpoint delay is what fixed this |
| LLM first token | ~1100ms | **~974ms** | not tunable; see §3 and §14 |
| TTS first audio | ~450ms | **~217ms** | sonic-3.5 |
| **First audio, real answer** | ~2.5s | **~1.6s** | |

**THE FLOOR ON A REAL ANSWER IS ~1.6s AND NO PIPELINE WORK GETS UNDER IT.** End-of-turn is already
near the useful limit, TTS is 217ms, and the LLM's ~974ms is simply how long gpt-5.4 takes to
start. That is the arithmetic §14 was trying to beat and could not.

**Under 1s is reached by speaking sooner, not by answering sooner.** `VOICE_INSTANT_ACK` emits a
short receipt ("אוקיי.") from `llmNode` before the model has written a word, so first audio lands at
end-of-turn + TTS ≈ **620ms** and the real answer follows behind it. Koren's framing, 2026-08-16:
*"the reply time is not the problem here, the problem is the time until the agent starts speaking."*

It must be injected in `llmNode`, never `session.say()` — see the note in `agent.ts`. The speech
queue is `[priority, insertion-time]`, `say()` takes no priority, and the reply's handle is
scheduled *before* the `thinking` event fires, so anything armed from that event plays AFTER her
reply. That bug shipped once already.

**MVP target: ~1.5s** (Koren, 2026-07-13); superseded by the <1s first-audio target (2026-08-16).

The one genuinely novel fix — a **custom Hebrew end-of-turn predictor**, running a small model over
the live transcript to judge "has he finished?" instead of waiting on silence — is **deferred**.
Build it only if 5+ real leads report the conversation feels off. Not optimising prematurely.
