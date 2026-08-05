# sonic-3 vs sonic-3.5 — real-call A/B runbook

> ## DECIDED 2026-08-05: sonic-3.5, on quality.
>
> Koren, after a real PSTN call: *"the 3.5 sounds way better, much better than sonic 3."*
> `CARTESIA_MODEL` now defaults to `sonic-3.5` in `env.ts` and `.env.example`, and the deployed
> agent's secret is set to it.
>
> **It was NOT a latency decision** — see below: the interleaved A/B found no measurable
> difference, and the two voices disagreed about which model was faster. Anyone who reopens this
> with a bench will be re-deriving noise.
>
> sonic-3 remains fully supported and selectable, per tenant (`agent_persona.tts.model`) or via
> `CARTESIA_MODEL`. The rest of this document stands as the method for the next such comparison.

The offline bench cannot answer this. Real calls can. Here is how to run it.

## Why offline TTFB is not the instrument

`npm run voice:model-ab` interleaves the two models (A,B,B,A,…) so network drift hits both arms
equally. Run on 2026-08-05 from Koren's machine, 6 rounds per voice:

| voice | sonic-3 median | sonic-3.5 median | verdict |
|---|---|---|---|
| `94c2e193` | 1651ms (1433–2503) | 1917ms (1658–2081) | ranges overlap |
| `ff857c8e` | 1987ms (1472–2956) | 1738ms (1583–4361) | ranges overlap |

**The two voices disagree about which model is faster.** Voice A says sonic-3 by 266ms, voice B says
sonic-3.5 by 249ms. A real effect does not reverse when you change voice; noise does. And every
number is 3–5× the ~455ms this pipeline has historically measured, which says the bottleneck is the
laptop's path to Cartesia, not the models.

So: **there is no measurable latency difference between sonic-3 and sonic-3.5 from here.** Anyone
re-running this offline will get another pair of overlapping ranges. Decide it on real calls.

## The switch — one DB value, no redeploy

`agent_persona.tts.model` is allowlisted to `sonic-3 | sonic-3.5` (both proven to speak Hebrew;
every other Cartesia model returns zero audio for `he`, silently). The deployed cloud agent reads it
per call, so the arms can be alternated without a deploy between them.

```sql
-- arm B: sonic-3.5
update tenants
   set settings = jsonb_set(settings, '{agent_persona,tts,model}', '"sonic-3.5"', true)
 where id = '<tenant-uuid>';

-- back to arm A: sonic-3   (or drop the key entirely to fall back to the env default)
update tenants
   set settings = jsonb_set(settings, '{agent_persona,tts,model}', '"sonic-3"', true)
 where id = '<tenant-uuid>';
```

If `agent_persona` does not exist yet, seed it first — the voice IDs under A/B:

```sql
update tenants set settings = jsonb_set(settings, '{agent_persona}', '{
  "name": "קרן", "gender": "female",
  "tts": {"voiceId": "94c2e193-a498-44e4-b958-174478734c3f", "model": "sonic-3", "speed": 0.9, "volume": 1.4}
}'::jsonb, true) where id = '<tenant-uuid>';
```

⚠️ Raw SQL bypasses the validator. A bad value there degrades to the env default and is reported in
the call's `warnings` — check the `voice_tts_config` log line on the first call of each arm. The
safe path is `PUT /api/v1/settings/agent-persona`, which rejects bad values with a 400.

## ⚠️ `lk agent update-secrets --overwrite` REPLACES THE ENTIRE SECRET SET

It does not merge. This command:

```
lk agent update-secrets --secrets CARTESIA_MODEL=sonic-3.5 --overwrite     # DO NOT
```

left the deployed agent with exactly one secret and took production into CrashLoop —
`DATABASE_URL: Required / REDIS_URL: Required / ENCRYPTION_KEY: Required / JWT_SECRET: Required`.
The phone line was down until the full set was re-uploaded. Done 2026-08-05; recorded here so it
is done once.

**Always pass the whole file:**

```
sed 's/^CARTESIA_MODEL=.*/CARTESIA_MODEL=sonic-3.5/' .agent-secrets.env > /tmp/restore.env
lk agent update-secrets --secrets-file /tmp/restore.env --overwrite --ignore-empty-secrets
```

`.agent-secrets.env` is the recovery source of truth. **It is gitignored and lives on one laptop.**
Keys added on the server and never written back to it — the ELEVENLABS_* set and
VOICE_RECORDING_NOTICE_ENABLED, added 2026-08-02 — are not in it and were not restored. They are
unused while `VOICE_TTS_PROVIDER=cartesia`, but flipping to elevenlabs will now fail until they are
re-added. Anyone who changes a secret on the server should mirror it into that file the same day.

Related: `lk` **exits 0 on a failed deploy** (a stale agent id in `livekit.toml` prints
"failed to get agent" and returns success). `scripts/deploy-agent.mjs` now greps the output and
exits non-zero, but if you call `lk` directly, check `lk agent list` for the version afterwards.

## Procedure

1. Seed `agent_persona` with voice `94c2e193…` and `model: sonic-3`.
2. Place **5 calls**. Vary nothing else — same script, same time of day, same network.
3. Flip to `sonic-3.5`. Place **5 more**.
4. Compare: `node scripts/call-stats.mjs --limit 20 --by-model`
5. Repeat for voice `ff857c8e…` if the first voice is inconclusive.

Alternate arms across a session rather than doing all of A then all of B — the same interleaving
logic that made the offline bench trustworthy applies to time-of-day and network drift here.

## Reading the result

`--by-model` groups calls by the model that actually spoke and reports medians per arm:

- **TTS** is the column the swap moves. That is the model's time to first audio, on a real line.
- **EOU and LLM should be unchanged.** If they moved, something other than the model differed
  between the arms and the comparison is contaminated.
- **worst** is the number a caller actually complains about — a better median with a worse tail is
  not a win.
- Fewer than 5 calls per arm and the script says so. A median over three calls is a rumour.

## Judging quality, not just speed

Four phone-band samples are in `voice-samples/`, one per voice × model:

```
sample-sonic-3-94c2e193-noemo-s0.9-v1.4-phone.wav
sample-sonic-3.5-94c2e193-noemo-s0.9-v1.4-phone.wav
sample-sonic-3-ff857c8e-noemo-s0.9-v1.4-phone.wav
sample-sonic-3.5-ff857c8e-noemo-s0.9-v1.4-phone.wav
```

Judge the `-phone.wav` files, never the studio ones — 8kHz strips the consonants, and a voice that
is lovely at 24kHz can be unintelligible to a caller. Regenerate any of them with:

```
npm run voice:sample -- --voice <id> --model sonic-3.5 --text "…"
```

One observation worth checking rather than trusting: on this sentence **sonic-3 stuttered on both
voices and sonic-3.5 on neither** (Cartesia's Hebrew repeats phrases non-deterministically —
known-issues §9). That is one take each, so it is a hypothesis. If sonic-3.5 genuinely stutters less
that matters far more than 250ms, because a repeated sentence costs the caller a whole turn.

## What is NOT under test

`emotion` is accepted by both models on Hebrew and returns real audio, but a 3-emotion × 3-take
probe found no acoustic difference beyond take-to-take noise (durations differ by 0.18s between
emotions and by up to 2.57s within one). Leave it unset for the A/B — it would add variance without
adding signal.
