# VOICE — talk to the local agent from a browser, and make the A/B page judgeable (2026-08-30)

Branch `feature/voice-local-session`, off `main@c731321`. **Testing/tooling only: no agent
behaviour changed, `prompts/system-prompt.he.ts` untouched, no schema, no migration, no deploy.**
The `keren-dev` explicit-dispatch safety fix from `main@c731321` is intact and is the thing this
branch builds on — a laptop still cannot be handed a real inbound call.

Triggered by Koren, after trying the first A/B page:

> "I've tested the variants but all of them weren't good. The first variant at the start of the page
> was broken, the voice was not clear at all. The other variants started in the middle of the script
> — wasn't good for a test either. Can I get a voice session to test the agent?"

All three complaints turned out to be real defects with measurable causes. See "What I measured".

---

## 1. Koren: how to talk to the agent on your own laptop

Two terminals, then a browser. No deploy, no phone call, no dashboard.

1. Open a terminal in the project folder and run **`npm run voice:dev`**. Leave it running. Wait for
   the line that says `registered worker`.
2. Open a **second** terminal and run **`npm run voice:session`**. A browser tab opens at
   `http://localhost:3010`.
3. Click **התחל שיחה** and allow the microphone when Chrome asks.
4. Look at the banner at the top of the page before you say anything:
   * **green — "✔ ענה הסוכן שעל המחשב שלך"** → you are talking to the code in terminal 1. Good.
   * **red** → an agent with no name answered, which means the **deployed cloud agent in
     production**, not your laptop. Nothing you hear tells you anything about your change. Stop,
     check that terminal 1 is still running, and start again.
5. Talk. Hang up with **נתק**.
6. Changed a prompt or a setting? Stop terminal 1 (Ctrl+C), run `npm run voice:dev` again, then
   click **התחל שיחה** again. That is the whole loop — seconds, not a deploy.

Notes:
* Nothing else needs to be running — not the API on `:3000`, not the dashboard on `:3001`. The page
  is served by the `voice:session` command itself on port `3010`.
* The session runs as the tenant in `VOICE_WEBHOOK_TENANT_ID` (ClickScales, `613d826c…`), so the
  persona, the voice and the tools are the real ones. `--tenant=<uuid>` to change it.
* `npm run voice:session -- --cloud` deliberately talks to the DEPLOYED agent instead. The banner
  goes red, and that is correct — it is telling you the truth about who answered.
* These calls hit the real database and the real vendors exactly like any web call. Cost is cents.

## 2. Koren: the regenerated A/B page

`npm run voice:ab:call -- <file.json>` as before, and the page it writes is different:

* **The whole call is now at the top of the page** and is the 8kHz "phone" version. Start there.
* Each turn card's main player is now **the exchange** — your line, the real silence, then her
  reply — instead of her reply alone with no run-up. Her reply on its own is one click away.
* Turn 1 of every run carries an orange "cold start, don't compare" label.
* The scenario `natural_flow` (8 turns: wanders, self-corrects, pushes back on a bad past chatbot,
  asks the price, closes) exists for exactly this. `hesitation` is two utterances and cannot show
  whether she repeats herself or greets twice.
* Cards, pick-a-winner radios, the note box and **צור סיכום** are unchanged.

---

## What shipped

### A. A browser session against the LOCAL worker (`npm run voice:session`)

`testing/local-session.ts` + `testing/local-session-page.ts`. A localhost-only HTTP server that
serves one self-contained page and mints one LiveKit token per click.

**Why it is a script and not an API route.** The token it mints is unauthenticated, which is fine
for a process bound to `127.0.0.1` that dies with the terminal, and would not be fine for a route
someone could leave switched on. There is no new production surface at all.

**Why the dashboard Simulator could not just be used.** `POST /web-call` mints a token with no
`RoomConfiguration`, i.e. auto-dispatch — and since `main@c731321` a laptop worker registers as
`keren-dev` and is deliberately **not** in the auto-dispatch pool. So `/simulator` against
`npm run voice:dev` is never answered. Fixing that inside `dashboard/**` would have crossed into the
DASHBOARD lane (`scripts/ci/territory-check.sh` fails a `feature/voice-*` branch that touches it),
so the browser session lives in VOICE territory instead. **No dashboard file was touched.**

`livekit-client` is fetched once from jsdelivr and cached under `node_modules/.cache/keren-voice/`,
so the second run works offline and `package-lock.json` is not touched.

### B. `/web-call` can dispatch the local worker — opt-in, two locks

`web-call.routes.ts` accepts an optional `{"agent":"local"}`. It is honoured only when
`VOICE_WEB_CALL_LOCAL_AGENT=1` is also set on the API process; otherwise it returns
`400 LOCAL_AGENT_NOT_ENABLED` with an explanation. **With no opt-in the minted token is byte-for-byte
what it was before**, so the production Simulator is unaffected. Every response now carries an
additive `dispatch` block (`mode`, `agentName`, `expectAgentName`, `note`) so a UI can say who is
expected to answer.

Both paths — the script and the route — resolve through one function, `resolveWebCallDispatch`
in `testing/dev-dispatch.ts`, and both build the token the way `synthetic-caller.ts` already did
(`RoomConfiguration.agents`, which also suppresses auto-dispatch for that room). One mechanism, not
two. Six new tests in `dev-dispatch.test.ts`.

New env key documented in `.env.example`: `VOICE_WEB_CALL_LOCAL_AGENT` (commented out). It is
deliberately NOT in `src/config/env.ts`, for the same reason `VOICE_TEST_OVERLAY` is not: a key
`.env` defines cannot be overridden from the shell (`dotenv.config({override:true})`).

### C. The two recording defects behind Koren's complaint

Both are in `testing/synthetic-caller.ts`, both are pinned by `testing/recording.test.ts`.

1. **The whole-call track was mixed one received frame at a time**, each placed at
   `arrivalTime − frameDuration`. Frames come out of the jitter buffer in bursts, so dozens landed
   on top of each other and were summed. It now places **one contiguous segment per agent turn**,
   anchored to when that turn's audio began. The gaps — the dead air being judged — still survive,
   because placement is still by wall clock; only the granularity changed.
2. **Every per-turn clip began with seconds of silence.** The agent publishes an audio track for the
   whole call, so the buffer collected for "turn N's reply" started filling the moment the caller
   opened their mouth. Clips are now trimmed to the speech (120ms pad, so the quiet fade-in of her
   first frames is kept) and the trim offset is what places them in the mix.

### D. The page (`testing/report-html.ts`)

Whole call first and in phone band; exchange clip as each card's primary player; reply-only and
studio versions behind a details toggle; cold-start label on turn 1. `buildExchange` is exported and
tested.

### E. Diagnostics that make a bad recording visible next time

`CallResult` now carries `agentJoinedMs`, `greetingStartedMs` and `mixStats`
(`segments / overlappingSegments / overlapMs`), and both runners print them. The mixer-overlap
number is what turned "the voice was not clear" from an opinion into a measurement.

### Files

New: `testing/local-session.ts`, `testing/local-session-page.ts`, `testing/recording.test.ts`.
Changed: `testing/dev-dispatch.ts`, `testing/dev-dispatch.test.ts`, `testing/synthetic-caller.ts`,
`testing/report-html.ts`, `testing/wav.ts`, `testing/scenarios.ts`, `testing/run-scenarios.ts`,
`testing/ab-runner.ts`, `testing/README.md`, `web-call.routes.ts`, and — additively —
`package.json` (adds `voice:session`) and `.env.example`.

---

## What I measured (2a: "the first variant was broken")

One instrumented `npm run voice:test -- hesitation` against a warm local worker, then analysis of
the WAVs it wrote. Numbers, not guesses:

| | Measured | Verdict |
|---|---|---|
| whole-call mix | **2734 segments, 1790 overlapping, 13.7s of summed audio, 882 clipped samples** in a 31s call | **This is the "not clear at all" bug.** Fixed. |
| turn clip 1 | 9.67s long, of which **6.34s leading silence** | Fixed (trim). |
| turn clip 2 | 8.80s long, of which **5.98s leading silence** | Fixed (trim). |
| cold start, warm worker | agent joined 3565ms after connect; greeting started 5113ms | Labelled on the page. |
| turn 1 vs turn 2 dead air | 2745ms vs 2144ms | ~600ms of turn-1 warm-up. Labelled, not spent on. |

**Cold start was NOT the main cause**, so I did not add a discarded warm-up turn — that would have
spent a paid turn per variant to fix the smaller half of the problem. Two further points against it:
`numIdleProcesses: 1` (added by the previous session) already pays the fork cost at worker boot, and
the A/B runner starts a fresh worker per variant, so cold start hits *every* variant equally and
cannot explain why the FIRST one sounded different. The 600ms is now labelled on turn 1 instead.

**Ruled out by reading the code, not by measurement:** the recorder's silence gate does not truncate
anything — `bucket.push(pcm)` happens *before* the `isSilent(frame)` check, so silent frames were
always captured. The silence gate only ever affected the dead-air stopwatch, exactly as the README
said.

---

## What is NOT proven

* **I am not Koren and I did not judge the audio by ear.** I drove the browser session with a fake
  microphone and verified the mechanism; whether she *sounds* better is his call and nobody else's.
* **The browser session was verified with Playwright + Chrome + a fake mic device, not a human
  mouth.** Real Chrome, real LiveKit room, real agent: the banner went green with
  `lk.agent.name = "keren-dev"`, an `<audio>` element played 28 seconds of her voice, and the live
  transcript filled with Hebrew. What that does NOT exercise is a real microphone's noise floor and
  echo path, which is exactly what barge-in and endpointing are sensitive to. **Koren pressing the
  button is still the first real proof.**
* **`POST /web-call` with `{"agent":"local"}` was not exercised against a running API server** — only
  its resolver and token construction, by unit test and by the identical code path the script uses.
  The default (no opt-in) path is unchanged code and is what production runs today.
* **Cross-platform:** everything was run on Windows only.
* **The synthetic caller is still too fluent.** `natural_flow` has ellipses and self-corrections, but
  Cartesia's pauses are shorter than a person's and it never talks over her. A clean run of it does
  not prove she won't cut off a real caller — tier 5 is the only thing that can.
* **Harness calls still write to the real database** (`call_learnings`, conversations, usage rows).
  Unchanged from before, but `voice:session` makes it easy to generate a lot more of them.

## Questions for architect

1. **Still open from the previous session:** should harness/simulator calls write to production?
   `voice:session` makes an all-day tuning session cheap, which makes the volume question sharper.
   Options unchanged: a `VOICE_TEST_TENANT_ID`, or a `usage-metering: exempt` marker.
2. **Should the dashboard Simulator get the local-agent toggle?** The backend half is built and
   inert (`{"agent":"local"}` + `VOICE_WEB_CALL_LOCAL_AGENT`), and the response already carries
   `dispatch`. Wiring a checkbox and an "answered by" badge into `dashboard/src/pages/Simulator.tsx`
   is ~30 lines — but it is DASHBOARD territory, so it needs their session or an explicit OK. Until
   then `npm run voice:session` covers the same need with no cross-lane edit.
3. **`VOICE_PROMPT_SUFFIX` for A/B-ing prompt wording** — still unbuilt, still worth a CLAIM in
   CLAUDE.md before anyone builds it, since it changes what the agent says in production if set.
