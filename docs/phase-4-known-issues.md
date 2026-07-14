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
any with a >500ms internal silence gap). **NOT mitigated on the live path.** Worth measuring: log
TTS output duration per turn against character count and see how often the ratio is absurd.

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

## Realistic latency budget for Hebrew

| Stage | Measured | English guides assume |
|---|---|---|
| End-of-turn | ~950ms | 300ms |
| LLM first token | ~1100ms | 300ms |
| TTS first audio | ~450ms | 100ms |
| **Total** | **~2.5s** | ~800ms |

**MVP target: ~1.5s** (Koren, 2026-07-13). Sub-second is likely unreachable for Hebrew on a
cascade pipeline with today's vendors.

The one genuinely novel fix — a **custom Hebrew end-of-turn predictor**, running a small model over
the live transcript to judge "has he finished?" instead of waiting on silence — is **deferred**.
Build it only if 5+ real leads report the conversation feels off. Not optimising prematurely.
