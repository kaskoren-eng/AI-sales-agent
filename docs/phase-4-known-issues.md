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
