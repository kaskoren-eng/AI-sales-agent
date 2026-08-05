# 2026-08-05 — Per-tenant Cartesia TTS (voice)

Branch: `feature/voice-cartesia-tenant-tts`, cut from `feature/crm-automation` (the voice trunk).
Worktree: `C:/keren-cartesia-tts`. Nothing on `feature/crm-automation` or in `C:/keren-voice` was
touched.

## What shipped

Per-tenant voice, emotion, speed and volume via a new `tenants.settings.agent_persona` key. The env
vars (`CARTESIA_VOICE_ID_PRIMARY`, `VOICE_TTS_SPEED`, `VOICE_TTS_VOLUME`) are unchanged and remain
the defaults — a tenant that sets nothing sounds exactly as before.

- `voice-livekit/tts/tts-settings.ts` — the enum, the limits, and two validators: a tolerant
  `resolveAgentPersona()` for the live call and a throwing `assertAgentPersona()` for write paths.
- `voice-livekit/agent.config.ts` — `applyTenantTts()`, route-aware (cartesia / inference / other).
- `voice-livekit/agent.ts` — applies the tenant voice after the settings read, before the greeting.
- `settings.service.ts` / `settings.routes.ts` — `GET`/`PUT /api/v1/settings/agent-persona`.
- `npm run voice:sample` — synthesize one Hebrew sentence to studio + phone WAVs.

**Production voice is unchanged.** `CARTESIA_MODEL` is still `sonic-3` and no tenant has an
`agent_persona` row, so every call today resolves to exactly the env defaults.

## Three bugs found while building it — all fixed here

1. **`sonic-3.5` would have lost `language: 'he'`.** The language gate in `testing/speech.ts` was an
   exact-match Set that did not contain `sonic-3.5`. Selecting that model would have reproduced the
   sonic-turbo trap from known-issues §2 — fine in a one-shot WAV, mush on a live streamed call.
   Now a `startsWith('sonic-3')` predicate. Verified empirically: sonic-3.5 returns real audio with
   `language: 'he'` (a rejection would have come back as an empty stream).
2. **`AGENT_SETTINGS_KEYS` is a whitelist** and would have stripped `agent_persona` from call
   metadata, so every outbound and web call would have silently used the env voice while inbound
   worked. Added to the list.
3. **The settings blob was discarded on a closed tool gate.** A tenant with `functions_enabled:false`
   would have silently lost their voice. `functions_enabled` is a kill switch for tools that WRITE
   to a tenant's calendar — it should not decide which voice they are spoken to in. The blob now
   survives a closed gate and is `undefined` only when there genuinely is no blob.

## Requirements that could not be met

**`output_format` = raw / pcm_mulaw / 8000 is not achievable through the LiveKit plugin.** Cartesia
supports it; `@livekit/agents-plugin-cartesia@1.5.1` does not — `TTSEncoding` is typed `'pcm_s16le'`
and marked "encoding should not be parameterized", and the receive path decodes into an
`AudioByteStream` that reinterprets bytes as Int16, so µ-law would arrive as noise.

It is also the wrong layer: TTS feeds a LiveKit *room*, which carries PCM, and the Zadarma SIP trunk
does the µ-law/8kHz conversion at the edge. No workaround applied — staying on `pcm_s16le` @ 24kHz.
A non-LiveKit telephony path would need a custom WS adapter modeled on `tts/deepdub.tts.ts`.

Smaller gaps, all reported by `applyTenantTts`'s return value rather than failing silently: emotion
is dropped on the `inference` gateway route (no verified passthrough) and the whole override set is
`unsupported` on DeepDub/ElevenLabs (different vendors, no `updateOptions`, and a Cartesia voice id
means nothing to them).

## Requirements that needed no work

- **`max_buffer_delay_ms = 0`** is hardcoded by the plugin. Cartesia's own default is 3000ms; the
  plugin never uses it and does not expose the knob, so it cannot be set wrong either.
- **One TTS context per turn, cancelled on barge-in** is handled by the plugin and SDK: one
  `context_id` per `SynthesizeStream`, a fresh stream per turn from `ttsNode`, aborted on
  interruption. No logic duplicated.

## TTFB bench — read the caveat before acting on it

`npm run bench:tts`, 2026-08-05, from Koren's Windows machine (NOT the production region):

```
cartesia/sonic-3 (via inference)   292ms
cartesia/sonic-3.5 (direct)        489ms
cartesia/sonic-3   (direct, LIVE) 1351ms
```

**Do not read this as "sonic-3.5 is 860ms faster".** The live direct sonic-3 arm measured 1351ms
against a documented ~455ms — 3× its own recorded value — so this run's baseline is suspect, most
likely local network rather than anything about the models. The inference arm (292ms vs a documented
~300ms) and sonic-3.5 (489ms) both land where they should; only the baseline is off.

Re-run from an environment that resembles production before drawing a conclusion, and per
agent.config.ts's own warning: judge the `-phone.wav` samples by ear, never latency alone. Three
"fast" models have already turned out not to speak Hebrew.

## Questions for architect

1. **CLAUDE.md key claim.** `agent_persona` needs flipping from *proposed* to *claimed (VOICE)* in
   the key-claims list — but that list lives in the CLAUDE.md on `feature/website-clickscales-v2`;
   the copy on this trunk is the older 81-line version with no claims section. I did not edit a
   shared file across branches. Someone should apply the claim when these branches meet.
2. **sonic-3.5.** Safe to select now, not selected. Worth flipping `CARTESIA_MODEL` after a listen.

## Not verified

- `npm run voice:sample -- --tenant <uuid>` — the DB read path. Local Postgres and Docker were both
  down on this machine. The resolver it calls is covered by 51 unit tests and the query is the same
  four lines as `tool-context.ts`, but the script's DB branch has not been run live.
- No live PSTN or web call was placed. Cartesia parameter errors surface only as an empty stream and
  a DEBUG log, so the `voice_tts_config` log line and the `CallReport.config.tts` record should be
  eyeballed on the first real call.
