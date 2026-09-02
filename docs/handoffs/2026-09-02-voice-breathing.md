# VOICE — breathing: the tag route died in a day, the mix route is on the page

**Session:** voice-breathing (new workstream lane inside VOICE)
**Date:** 2026-09-02 · working tree: `C:\AI Sales agent` on `main` (nothing committed — see "Uncommitted" below)

---

## In plain language, for Koren

You asked for her to audibly breathe while she talks, and to try Cartesia's own tags first.
Tried, measured, settled — **Cartesia cannot breathe in Hebrew**, on either model snapshot:

- Every breath-shaped English tag — `[breath]`, `[inhales]`, `[breathing]`, `[sigh]`, `[sighs]`,
  `[breathes]`, `[exhales]`, `[laughs]`, `[coughs]`, `[clears throat]` — is **silently swallowed**
  on both sonic-3.5 (production) and sonic-3.6 (the snapshot the tags are marketed on). Duration
  deltas sit inside the 320–480ms generation-noise floor; onset anatomy shows no pre-speech audio;
  Soniox transcripts come back word-identical to the untagged baseline.
- `(breathes)` in parentheses is **read aloud** — "ברידס" — the worst failure mode.
- **The one exception: `[laughter]` renders a real laugh ("חח") on BOTH models.** The tag
  machinery works on Hebrew; Cartesia trained exactly one non-verbal, and it's the one you banned
  in round 4b. (Round 4's "tags do nothing" verdict is now re-dated: it was true of everything
  except `[laughter]`.)

So the breath has to be **audio we supply, spliced between her TTS frames** — which is what the
production code would do anyway. That's what's on the listening page:

**→ `tests/hebrew-tts-niqqud-ab/index-round21.html`** — 6 cards, self-contained, phone-band.
Card 0 auditions the two breath sources themselves (one harvested from a real DeepDub Hebrew
generation, one synthetic shaped noise) — veto a source there and its cards fall with it.
Cards 1–3: inhale before a long reply (volume ladder ‑18/‑24dB), breath in the empathy-pair seam,
breath inside a thinking gap. Cards 4–5 are negative controls (breath before a two-word
confirmation; ‑12dB "panting ceiling").

Measured: at phone band the ‑24dB breath peaks at 4.8% of clip peak, ‑18dB at 9.6%, ‑12dB at
19.1%, vs a 2.0% silent floor — audible, quiet, graded. Soniox does **not** transcribe any of the
mixed breaths as words.

**Nothing ships until your verdicts.** Implementation (kill-switched, flag-off) starts only after
the round-21 summary, and nothing reaches production before you hear the verification calls.

## ⚠️ Round-number collision, resolved — but we need a claims line

While this round was being built as "round 20", the other voice session created **its own
round 20** (מספר/דמו pronunciation) in the same untracked directory and overwrote `round20.py`,
`build_round20_page.py`, `round20.json` and `index-round20.html`. Per the territory rules I did
not touch their files: **the breath round is renumbered to 21** (`round21.py`,
`build_round21_page.py`, `round21.json`, `index-round21.html`, clips `r21_*`, `probe21_*.py/json`,
`roundtrip21.ts`, `breath_mix.py`, `breaths/`). Their round 20 is intact.

**Question for architect:** round numbers in `tests/hebrew-tts-niqqud-ab/` are now a shared
namespace with no claims table. Suggest adding a one-line claims list (like migration numbers) to
CLAUDE.md or a `ROUNDS.md` in the test dir. **Next free: 22.**

**CLAIMED by the voice-breathing session (this one), 2026-09-02:** round **21**, clip prefix
**`r21_`**, and the file names `probe21_*.py`, `probe21*.json`, `roundtrip21.ts`, `round21.py`,
`build_round21_page.py`, `index-round21.html`, `breath_mix.py`, `breaths/`, `dd_breath_src.wav`.
The 13:31 content-aware rename `r20_→r21_` / `probe20→probe21` / `roundtrip20→roundtrip21` was
this session's doing (folded into commit `8edd0ff` by session 3d — thanks).

**Correction (13:37, after session 3d's accounting):** my DeepDub generation had been written
OVER `dd_smoke.wav` — a tracked 93KB fixture that predates this work and is NOT mine. Session 3d
restored the fixture and moved the generation to `dd_breath_src.wav` (untracked), patching
`breath_mix.py`'s docstring accordingly (`128c430`). My earlier claim of `dd_smoke.wav` here was
wrong. Also: `8edd0ff`/`128c430` put the round-21 fixtures, probe scripts and a new
`phase-4-known-issues.md` §17 (the tag verdict) on `origin/main` — so "all untracked, nothing
committed" below is stale; test files are committed, and only the STAGE-2 product code remains
gated on Koren's verdicts.

## What exists (all untracked, nothing committed)

- `probe21_tags.py` + `probe21.json` + `probe21-heard.json` — the tag probe and its evidence
  (durations, onset anatomy via `probe21_onset.py`, Soniox transcripts via `roundtrip21.ts`).
- `breath_mix.py` — harvest/splice/RMS reference implementation; every constant stage 2's
  `breath-mixer.ts` will copy was heard, not invented.
- `breaths/` — 22 harvested DeepDub candidates (winner: `dd_19030ms_140ms.wav`, found after 440ms
  of silence before speech) + `synth_inhale_320ms.wav`.
- `dd_breath_src.wav` — the 21s DeepDub generation the candidates came from (warm TTFB 364ms, for
  the record). Originally written over the tracked `dd_smoke.wav` fixture by mistake; session 3d
  restored the fixture and moved the generation here (`128c430`).
- `round21.py` → `round21.json` → `build_round21_page.py` → `index-round21.html` (1.3MB).
- Plan file (two-stage, production gate): `C:\Users\kasko\.claude\plans\memoized-snuggling-pretzel.md`.

## Round-21 verdicts (Koren, 2026-09-02 14:07)

```
b0: sources ok = A        (the DeepDub-harvested breath is real; the synthetic one is vetoed)
b1: C                     (dd inhale at -24dB before a long reply — the quietest variant won)
b2-b5: (no answer)        "שאר המבחנים שלא עניתי היו פשוט לא טובים"
```

Reading: the splice route survives ONLY as "a barely-audible real breath before a long reply".
Seam-breaths, gap-breaths and everything louder are dead. And Koren's own conclusion from
listening: *"צריך לעבור כנראה לדיפדאב אני בוחן את זה כרגע"* — the breath that won is DeepDub's
own, which reframes the question from "splice breaths into Cartesia" to "switch the engine that
already breathes". **Stage 2 (breath-mixer.ts) is ON HOLD** — if the engine switches, the feature
is free and the mixer is dead code.

**CLAIMED: round 22 + clip prefix `r22_`** (this session) — Cartesia-vs-DeepDub head-to-head on
the live prompt's own sentences, to give the engine evaluation ears instead of vibes. Next free: 23.

## Round-22 verdicts (Koren, 2026-09-02 14:13) — THE ENGINE DECISION

```
pr: B   em: B   ca: B   bk: B   ng: B     (B = DeepDub dd-etts-3.2, every card)
```

A clean sweep, and the second decisive DeepDub win (6:1 blind, 2026-07, was the first). Koren's
ear has chosen the engine that breathes on its own. **The breathing feature is now delivered by
switching TTS provider, not by splicing** — breath-mixer.ts (stage 2) is dead, not just on hold.

**What the switch requires before the production flip** (the production gate stands — he hears
verification calls first):
1. Cost per minute vs the current ~₪0.29/min (TTS-dominated) — unverified.
2. Screening round on DeepDub for everything tuned by ear on Cartesia: minimal niqqud
   (שלךָ/לוודֵא), PRONUNCIATION_FIXES, thinking fillers (אֶממ...), number/time speech. Round 23.
3. `<break>` pause tags are Cartesia SSML — voice-modes must stay OFF on DeepDub, or the guard
   must strip approved tags too when provider != cartesia (else a tag reaches an engine that may
   SPEAK it).
4. No speed/volume knobs in the adapter — prod speaks 0.9/1.4 on Cartesia today; DeepDub is
   what-it-is. Koren approved that sound on the page, but flag it.
5. Latency: warm TTFB 336-502ms vs ~217ms — instant-ack first-audio moves from ~620ms toward
   ~770-900ms. Report per call, per the standing rule.
6. Local/web-call verification with VOICE_TTS_PROVIDER=deepdub, then Koren listens, THEN prod.

**CLAIMED: round 23 + clip prefix `r23_`** (this session) — DeepDub screening round (niqqud,
fixes, fillers, numbers).
**CLAIMED: round 24 + clip prefix `r24_`** (this session) — DeepDub non-verbal tag probe
(supervisor's ask: §17 is a Cartesia finding; does dd-etts honour [breath]/[laughter]/(breathes)?
If a breath tag works there, breathing becomes CONTROLLABLE, not only native).
**CLAIMED: round 25 + clip prefix `r25_`** (session 63) — the two questions round 23's A/B shape
cannot ask: unpointed מספר in both senses (does dd disambiguate from context → delete the
conditional rule), unpointed דמו (demo or damo). Runs only if round-23 verdicts leave them open.
**Round-24 result — FINAL (round 24 is SHARED with 3d: their break-markup half in probe24.json /
`39c453d`, this session's non-verbal half in `probe24_nonverbal.json`; the r24_ artifacts are
interleaved in that commit, which also swept my A–G clips — second sweep today, resolved without
renames):** DeepDub has NO working non-verbal tag, and its failure mode is WORSE than Cartesia's.
`[breath]`→"ברף", `[breathes]`→"ברית", `(breathes)`→"בריבס" — READ ALOUD (Soniox evidence);
3d measured the same for `<break>` ("break time 00:56", §18). `[sigh]`/`[laughter]`/`[breathing]`
swallowed silently — every delta inside the measured noise floor (dd_floor24.ts: 4 reps
5034–5458ms, spread 424ms, ~770ms total variance vs the probe baseline), and `[laughter]` does
NOT laugh on dd. Consequences: (1) breathing on dd is NATIVE-ONLY — what Koren approved 5/5;
(2) ⚠️ dd SPEAKS stray markup of both shapes, so the SQUARE_TAG net in speech-guard.ts is a
**PRE-FLIP requirement** (announced to both sessions; composes with 3d's `e70f356` angle-tag
gate); (3) no further tag-probing rounds — the question is answered for both engines.

**Fix-rows framing for the verdicts (63's, adopted):** every PRONUNCIATION_FIXES row is a patch
over a specific CARTESIA defect. On DeepDub the null hypothesis is DELETE; the burden of proof is
on KEEPING a row; "B (plain) sounds fine" is the strong result. Next free: 26.

## THE DECISION (Koren, 2026-09-02 14:20)

*"טוב אנחנו עוברים לעבוד עם דיפדאב במקום קרטסיה"* — the switch is decided. Koren asked this
session to notify the other two and have each update its side and docs per its domain. Done:
- **3d** (pauses/voice-mode): already shipped `e70f356` — the pause feature fails CLOSED on any
  engine but Cartesia (`pausesSupported()` gates guard + prompt, mutation-tested). Their doc task:
  env-comment + known-issues §16 wording.
- **63** (pronunciation rounds): notified; their מספר/דמו fixes are among the rows round 23
  re-screens; prescriptive docs in their lane to note the engine change.
- **Shared-source protocol agreed:** three sessions touched `agent.ts`/`speech-guard.ts` today —
  each announces on the message channel before editing either file.

**Round-23 mechanical evidence (before Koren's ear):** all 10 Soniox roundtrips CLEAN on DeepDub —
pointed forms (מִסְפָּר, נוֹחַ, לִידִים, דֶמוֹ, אֶממ, שלךָ) do not break any word; every transcript
word-identical to its plain twin. Ear verdicts pending (four outcomes per word: transfers /
unneeded / harmful / retune). Known dead-lookahead: the filler rows scoped to a following
`<break>` never fire on DeepDub (no tag will follow) — harmless, but part of the cleanup.

## Next steps

- **KOREN:** round-23 verdicts (`index-round23.html`); the prod env flip is done together after
  a verification call you hear. Also: DeepDub pricing is sales-quoted ("time-based packages",
  ~1,000 chars/min) — the cost check needs your account contact, mine found no public number.
- **ME:** on verdicts — provider-condition PRONUNCIATION_FIXES if needed (announcing first),
  local verification with `VOICE_TTS_PROVIDER=deepdub` + latency report (instant-ack budget moves
  ~620ms→~770-900ms), DeepDub circuit-breaker audit, then the flip checklist.
- **VOICE-BREATHING (me), after verdicts:** stage 2 per the plan — `breath-mixer.ts` frame-splice
  behind `VOICE_BREATH_MIX_ENABLED` (default false) + SWITCH_KEYS + call-report counters + breath
  ledger (max 4/call, 30s cooldown, fire only on already-slow turns), on a feature branch
  `feature/voice-breathing`. Deploy only after Koren hears the verification calls.
- **Also on the table from the probe:** `[laughter]` works. It stays banned; if Koren ever wants
  a controlled laugh, the machinery is proven and the guard (`SQUARE_TAG` net) should ship first
  regardless — today a stray `[laughter]` from the model would reach Cartesia unvalidated and
  actually laugh.

## Round-23 verdicts (Koren, 14:26 — via session 63) + unblocked state

```
sl (שלךָ+מִסְפָּר): both_ok   nh (נוֹחַ): a_only   ld (לִידִים): a_only   dm (דמו): a_only   fl: both_ok
```

Three of five pointing rows SURVIVE on DeepDub — the null hypothesis (delete everything) was
wrong; his ear says dd still needs נוֹחַ/לִידִים/דמו pointed. The two both_ok rows are deletion
CANDIDATES only (sl bundled two words; gender randomness needs round 25). Fix-table changes are
63's. Cloud DeepDub secrets uploaded 14:25 (VOICE_TTS_PROVIDER still unset — prod stays Cartesia
deliberately). Bracket net passed 63's gate on main @ 94f0593 (test:ci 127 files / 1857 passed).
Koren's new instruction (via 63): full Cartesia→DeepDub feature migration — 63 building the
inventory, my lane's parts incoming. Next from me: local latency A/B + verification call.

## TTS latency A/B — the fair one (scripts/tts-latency-ab.ts, 14:45)

Same machine, same LiveKit tts.TTS interface, back to back — the aggregate TTFB comparison the
flip checklist asked for. **CORRECTS my earlier framing**: "dd 336-502ms vs Cartesia ~217ms"
compared a local dd number against a production Cartesia bench — unfair. Apples to apples:

```
DeepDub realtime:TRUE   warm median TTFB  466ms   p95  696ms   cold  793ms    rtf 2.7x
DeepDub realtime:false  warm median TTFB  768ms   p95 1026ms   cold 1179ms   rtf 2.5x
Cartesia                warm median TTFB 1236ms   p95 1869ms   cold 1290ms   rtf 2.0x
```

**DeepDub realtime is ~770ms FASTER than Cartesia from this machine.** Absolute numbers carry
this machine's RTT (production runs from LiveKit Cloud eu-central and will be lower for both);
the RANKING and the cold/warm gap carry over. The adapter already sets realtime: true. Latency is
NOT a blocker for the flip — it may be an improvement; the verification call gives the production
absolutes.

## Local verification call — DONE (14:46, synthetic natural_flow, full pipeline)

Worker: keren-dev (explicit dispatch — verified in its own log; the 2026-08-30 fix means it CANNOT
take a real call). Provider flipped via VOICE_TEST_OVERLAY (the .env-wins dotenv trap — shell env
does nothing). Call report PROVES the path: ttsModel deepdub/dd-etts-3.2, ttsLabel deepdub.TTS,
VOICE_TTS_PROVIDER=deepdub source=env.

Numbers (report medians): **tts ttfb 403ms** (17 segments, 324-589) vs Cartesia production
baseline 223-259ms · EOU 321ms · model ttft 943ms · worst case 1667ms · dead-air median 779ms
p90 1614ms (harness figures run high — transport+jitter; comparison only). Quality: 8/8 turns
answered, 0 cut-offs, 0 toolCallLeaks, 0 falseBookingClaims, **bracketTagsDropped 0**,
pauseTagsDropped 0, prompt cache 89%. Preemptive TTS worked (6 drafts discarded cleanly).

Caveats for the FLIP decision: this is local-machine RTT (the cloud number needs a cloud call);
no speed/volume compensation exists on dd (the 8kHz intelligibility levers are Cartesia-only —
63s inventory) — Koren must listen for consonants on the verification page. Listening page:
index-dd-verification.html (artifact, phone-band, greeting + 8 exchanges + full call).

**Cloud-number mechanism (63, 14:51):** `VOICE_TTS_PROVIDER` is env-read at worker boot and
`lk agent update-secrets` restarts the agent — so the cloud TTFB needs one merged secret, one
real call, one revert; no deploy. The window exposes real inbound leads to dd, so it is short,
announced, and Koren's call. **The cloud secret set — including this switch — is 63's alone;
this session does not touch it** (agreed 14:51).

## The waits Koren heard — decomposed (natural_flow, same machine, both engines, 14:46+14:55)

| metric | DeepDub | Cartesia (same harness) |
|---|---|---|
| tts ttfb median | **403ms** | 522ms |
| deadAir median / p90 | **779 / 1614ms** | 1155 / 5877ms |
| agentGap median (mid-reply) | **1279ms** | 2576ms |
| model ttft median | 943ms | 1252ms |
| worst case | **1667ms** | 2002ms |

**The long waits are NOT a DeepDub regression — Cartesia shows them worse on the identical
instrument.** Anatomy: (a) harness inflation ~1-1.5s (documented, both engines); (b) model TTFT
~1s — the known LLM floor, engine-agnostic; (c) mid-reply agent gaps exist on BOTH engines and
are LLM-re-generation-bound, not TTS-bound. The engine switch IMPROVES every latency number.

Two levers if Koren wants the waits treated (his call): (1) the dd-adapter sentence seam —
generate() awaits sequentially, so each sentence of a long reply pays ~400ms TTFB; a bounded
prefetch (depth 1; SOCKET_POOL_SIZE=2 already supports concurrent generates on separate sockets)
hides it entirely. (2) the production-feel answer is the CLOUD call — local harness numbers
never were the product latency.

**Probe-integrity asserts (15:25, `3516bc7`):** all four of this session's dd probes now refuse
to run if the engine they built is not DeepDub — complementary to `02f2192` which covered the
other two (probe24_break, probe26_laughter). Fourth broken-instrument class of the day, closed
before an instance. Note: **round/probe 26 is taken** (probe26_laughter_deepdub.ts on main) —
**next free: 27.** Also on main since: the harness follows VOICE_TTS_PROVIDER (`f963c61`),
synth.py has a dd backend via tts_worker.ts (`5cd1aa9`). bench:tts on f963c61 verified by 3d
(dd realtime 590ms · cartesia LIVE direct 1239ms — matches this session's 1236ms bench).
