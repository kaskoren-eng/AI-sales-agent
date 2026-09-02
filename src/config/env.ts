import { z } from 'zod';
import { config } from 'dotenv';

// Always load .env with override=true so .env values win over inherited shell env vars
config({ override: true });

/**
 * A boolean from an env var. NEVER use `z.coerce.boolean()` for this.
 *
 * `z.coerce.boolean()` is `Boolean(value)`, and in JavaScript every non-empty string is truthy. So:
 *
 *   FEATURE=false  ->  true
 *   FEATURE=0      ->  true
 *   FEATURE=no     ->  true
 *
 * A flag you can only turn ON. It is impossible to switch anything off, and nothing warns you —
 * the config reads exactly as intended and does the opposite.
 *
 * This bit us for real, twice over. VOICE_PREEMPTIVE_TTS=false ran as TRUE for weeks: a Phase 2
 * "measurement" concluded the feature was slow and "turned it off", and it was never off, so the
 * measurement described something else entirely and the fix did nothing. SHADOW_STT_ENABLED=false
 * likewise kept a second STT engine running on every live call, quietly billing for it.
 *
 * Explicit truthy strings only. Anything else is false.
 */
function envBool(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((v) =>
      typeof v === 'boolean' ? v : ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase()),
    );
}

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().url(),

  // Encryption
  ENCRYPTION_KEY: z.string().min(32),

  // JWT
  JWT_SECRET: z.string().min(16),

  // Super-admin (operator console). Optional: when unset, every /api/v1/admin/* route replies 503
  // "admin not configured" — the console is opt-in and cannot be reached without this secret. Min 24
  // chars so a weak value can't gate cross-tenant powers. Rotate by changing the env and redeploying.
  ADMIN_API_KEY: z.string().min(24).optional(),

  /**
   * Who may create a workspace: `invite_only` (default) or `open`.
   *
   * `POST /auth/register` creates a TENANT plus an owner account, and it sits outside the
   * authenticate hook because obtaining a credential cannot itself require one. Left open, anyone
   * who finds the API gets a workspace on a paid product — and since Phase 5a, a `usage_period`
   * with it.
   *
   * That contradicts how this product is actually sold: provisioning is HYBRID (CLAUDE.md) —
   * ClickScales buys the DID, assigns it, and onboards the customer. Nobody self-serves into a
   * working agent, because a workspace with no number and no calendar cannot do anything.
   *
   * DEFAULTS CLOSED, and closed locks nobody out: existing owners invite their colleagues
   * (`/auth/accept-invite`), and the first human on a new workspace comes from
   * `scripts/bootstrap-user.mjs`, which needs database access. That is the right property — the
   * power to mint a workspace should require the thing only an operator has.
   *
   * Flip to `open` the day self-serve trials become the plan; it is one env var, no code change.
   */
  SIGNUP_MODE: z.enum(['invite_only', 'open']).default('invite_only'),

  // Lead intake webhooks
  META_APP_SECRET: z.string().min(1).optional(),
  LEAD_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Tenant that receives generic (non-Meta) webhook leads — prevents body spoofing
  LEAD_WEBHOOK_TENANT_ID: z.string().uuid().optional(),
  // Shared secret for Netlify Forms' outgoing webhook (signature_secret on the site's `url` hook).
  // The clickscales.com demo form posts to Netlify Forms, and Netlify relays it here signed.
  NETLIFY_FORMS_WEBHOOK_SECRET: z.string().min(1).optional(),

  // App base URL (for callback URLs)
  BASE_URL: z.string().url().optional(),
  /**
   * Dashboard base URL. Originally cosmetic — "view this call" back-links in CRM notes (Workstream
   * B), omitted when unset rather than rendered broken.
   *
   * It is NOT cosmetic any more. Since accounts shipped it is also the origin of every emailed
   * password-reset and invite link, so an unset value means a locked-out user has no self-service
   * recovery at all. Still optional rather than required-in-production, because refusing to boot
   * over a password-reset link is a worse outage than the one it prevents — but loadEnv() warns
   * loudly in production, and the reset route logs each link it could not send.
   */
  DASHBOARD_BASE_URL: z.string().url().optional(),

  /**
   * ClickScales' OWN tenant — the one whose credentials the global `*_API_KEY` env vars actually
   * are.
   *
   * Several integrations fall back to process-wide credentials when a tenant has configured none
   * of its own. That was correct while ClickScales was the only tenant and those env vars were
   * simply "our config". With more than one tenant it means a customer who runs an Airtable step
   * without connecting Airtable silently writes their leads into OUR base — a cross-tenant data
   * leak that looks like a working feature from both ends.
   *
   * Setting this makes the fallback explicit and narrow: it applies to this tenant and nobody
   * else. Every other tenant must configure its own credentials or the step fails loudly.
   */
  PLATFORM_TENANT_ID: z.string().uuid().optional(),

  // Channels - WhatsApp (UChat)
  UCHAT_WEBHOOK_SECRET: z.string().min(1).optional(),
  UCHAT_API_TOKEN: z.string().min(1).optional(),
  // UUID of the tenant that receives inbound WhatsApp messages (server-side only — prevents body spoofing)
  UCHAT_WEBHOOK_TENANT_ID: z.string().uuid().optional(),

  // Channels - Email (Resend)
  RESEND_API_KEY: z.string().startsWith('re_').optional(),
  RESEND_FROM_EMAIL: z.string().email().optional(),
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
  RESEND_INBOUND_TENANT_ID: z.string().uuid().optional(),

  // Channels - WhatsApp (Twilio)
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_WHATSAPP_NUMBER: z.string().min(1).optional(),
  TWILIO_WHATSAPP_TENANT_ID: z.string().uuid().optional(),

  // Channels - Voice (Zadarma SIP telephony into the LiveKit agent)
  ZADARMA_API_KEY: z.string().min(1).optional(),
  ZADARMA_API_SECRET: z.string().min(1).optional(),
  ZADARMA_PHONE_NUMBER: z.string().min(1).optional(),
  // UUID of the tenant that receives inbound voice calls (enables learning injection)
  VOICE_WEBHOOK_TENANT_ID: z.string().uuid().optional(),

  // OpenAI service tier for the VOICE LLM only ('priority' = faster TTFT at ~2x token cost —
  // pennies on ~50-token voice turns, and TTFT is the voice pipeline's biggest visible block).
  // Verified eligible 2026-07-20. Empty = provider default.
  VOICE_LLM_SERVICE_TIER: z.enum(['auto', 'default', 'flex', 'priority']).optional(),

  // Channels - Voice (LiveKit self-built pipeline) — the replacement engine
  LIVEKIT_URL: z.string().url().optional(),
  LIVEKIT_API_KEY: z.string().min(1).optional(),
  LIVEKIT_API_SECRET: z.string().min(1).optional(),
  // Cartesia — Hebrew TTS. sonic-3 is the ONLY model that speaks Hebrew: sonic, sonic-2,
  // sonic-lite and sonic-turbo all return zero audio for `he` (silently — no error).
  // So the low-latency sonic-turbo is NOT an option for us. Verify: npm run voice:ab -- <model>
  CARTESIA_API_KEY: z.string().min(1).optional(),
  CARTESIA_MODEL: z.string().default('sonic-3'),
  CARTESIA_VOICE_ID_PRIMARY: z.string().min(1).optional(),
  // Backup voices — A/B candidates for the Phase 2 voice selection
  CARTESIA_VOICE_ID_SECONDARY: z.string().min(1).optional(),
  CARTESIA_VOICE_ID_TERTIARY: z.string().min(1).optional(),
  // OpenAI streaming STT — reuses OPENAI_API_KEY below
  OPENAI_REALTIME_MODEL: z.string().default('gpt-realtime-whisper'),

  // --- Which STT engine transcribes the caller. SONIOX. This is settled, on real Hebrew calls. ---
  //
  // MEASURED, not assumed. `npm run stt:ab` on 10 Hebrew utterances x 3 channel conditions, then
  // three real phone calls with the loser running in shadow on the same audio:
  //
  //                          gpt-realtime-whisper      Soniox stt-rt-v5
  //   semantic WER (noisy)            34.9%                    4.3%
  //   greetings                       72.2%                    0.0%
  //   end-of-turn (real call)        ~1113ms                  ~572ms
  //   cost                        $0.017/min              $0.002/min      (8.5x cheaper)
  //
  // On a real call, OpenAI heard the caller's name קורן as כהן (Cohen — a different person), the
  // "@" of his email as סטודנט ("student"), and turned the last three digits of his mobile into the
  // Hebrew word for "sun". Soniox got all three exactly right and returned the phone number as
  // digits. For an agent whose ONE JOB is to capture a name, a phone number and an email and book a
  // meeting, that is not a close call.
  //
  // It also DELETES the Phase 4 "hybrid STT" workaround: that plan existed only because
  // gpt-realtime-whisper hard-rejects the `prompt` parameter, forcing a swap to REST whisper-1
  // (~1s slower) whenever we needed accurate capture. Soniox takes biasing terms (`context.terms`)
  // on a STREAMING connection. No workaround needed.
  //
  // 'openai' is kept as a switchable fallback, and is what shadow mode runs when Soniox is live.
  STT_PROVIDER: z.enum(['openai', 'soniox']).default('soniox'),
  SONIOX_API_KEY: z.string().min(1).optional(),
  // Name the real model. The plugin defaults to 'stt-rt-v4', which Soniox now ALIASES to
  // stt-rt-v5 — so pinning the alias lets a silent upstream swap change our transcription overnight.
  SONIOX_MODEL: z.string().default('stt-rt-v5'),
  // How long Soniox waits after speech stops before declaring an endpoint. Only used when
  // VOICE_TURN_DETECTION=stt, which you should not turn on — see below.
  // RAISED FROM THE 500ms FLOOR ON PURPOSE — it is not the latency lever it looks like.
  //
  // The intuition says shorter = faster, and that is why it sat at the floor. What it actually
  // controls is how long Soniox waits after speech stops before declaring the endpoint, and that
  // window is the ONLY place preemptive generation can happen: the plugin emits its own PREFLIGHT
  // exactly when every token is final and the endpoint has not fired yet (_internal.js:211), and
  // a draft built from THAT text is the only kind that survives the SDK's equality check against
  // the committed transcript (agent_activity.js:1711). At 500ms Soniox finalises and endpoints
  // almost simultaneously, the window is ~0, and no draft is ever started — so the LLM's ~900ms
  // lands on top of the wait instead of inside it.
  //
  // Trading ~500ms of endpoint delay for ~900ms of hidden LLM is the deal. It also stops Hebrew
  // mid-clause pauses being read as end-of-turn, which shredded one caller sentence into three.
  SONIOX_MAX_ENDPOINT_DELAY_MS: z.coerce.number().int().min(500).max(3000).default(1000),
  // How the turn ends. LEAVE THIS ON 'vad'.
  //
  // 'stt' drives end-of-turn from Soniox's own endpoint instead of the Silero silence timer. It
  // looked like the answer to the ~1.1s Hebrew end-of-turn wall (nobody ships a Hebrew end-of-turn
  // model — LiveKit's has Arabic and not Hebrew). IT IS NOT. Tested on a real call: it declared the
  // caller finished WHILE HE WAS STILL TALKING ten times, and the agent went silent on him three
  // times mid-conversation. Soniox's endpoint is a SILENCE detector with a 500ms floor, not a
  // linguistic one — it cannot tell "paused to think" from "finished", and Hebrew speakers pause
  // mid-clause constantly.
  //
  // The trap: that call recorded our BEST-EVER end-of-turn median (259ms), because a turn chopped
  // in half finalises fast. The metrics reported a triumph while the caller was being talked over.
  // See docs/phase-4-known-issues.md §11.
  //
  // Soniox on the plain VAD timer gets the win anyway — ~572ms, down from ~1113ms — because it
  // commits its final transcript faster. Safely.
  VOICE_TURN_DETECTION: z.enum(['vad', 'stt']).default('vad'),
  // Run the OTHER engine silently alongside the live one on real calls, and log what it heard.
  //
  // The corpus A/B is synthesized speech — perfectly articulated, no disfluencies, no accent. Real
  // Hebrew callers mumble, trail off and run words together, so the corpus can RANK the engines but
  // cannot tell us what either does to an actual lead on a mobile. This is how we find out, using
  // real audio, without betting a real call on the answer.
  //
  // Costs a second STT stream per call (~$0.002/min for Soniox). Its output never reaches the
  // caller and cannot affect the live path — see stt/shadow-stt.ts.
  SHADOW_STT_ENABLED: envBool(false),

  // How we reach Cartesia: straight to them with our own key, or through LiveKit's inference gateway.
  //
  // SAME MODEL, SAME VOICE, SAME QUALITY — only the route differs. The gateway holds a warm pooled
  // websocket, which is the whole point: our direct plugin appears to pay connection setup more
  // often, and Cartesia's time-to-first-audio is ~455ms on live calls against ~300ms through the
  // gateway on the bench (`npm run bench:tts`).
  //
  // The cost of 'inference' is that LiveKit becomes the middleman and bills for it — the exact
  // vendor lock-in this whole migration was meant to escape. It is here because ~150ms of the
  // caller's silence is worth more than architectural purity, and because it is one env var to
  // revert. If it does not actually win on a real call, go back to 'cartesia'.
  VOICE_TTS_ROUTE: z.enum(['cartesia', 'inference']).default('cartesia'),

  // Which TTS engine speaks. 'cartesia' is the shipped default and does not move without a decision.
  // 'deepdub' selects the self-built DeepDub adapter (tts/deepdub.tts.ts) — added because DeepDub
  // won a blind A/B on Hebrew quality and native gender at cost parity, with a realtime model that
  // the dashboard reports at ~125ms TTFB (faster than Cartesia's ~250ms). Strangler-fig: both live
  // side by side behind this flag, exactly like STT_PROVIDER, so a bad call is one env var to revert.
  // 'elevenlabs' selects the official @livekit/agents-plugin-elevenlabs (eleven_flash_v2_5) — added
  // for a real-call A/B against Cartesia on Hebrew voice quality. Same strangler-fig rule: opt-in
  // behind this flag, one env var to revert, Cartesia stays the shipped default until a decision.
  VOICE_TTS_PROVIDER: z.enum(['cartesia', 'deepdub', 'elevenlabs']).default('cartesia'),
  // DeepDub (only read when VOICE_TTS_PROVIDER=deepdub). All optional so the app boots without it.
  DEEPDUB_API_KEY: z.string().min(1).optional(),
  DEEPDUB_VOICE_PROMPT_ID: z.string().min(1).optional(),
  // The REALTIME model is the point — it is the ~125ms path. Keep realtime on; the streaming socket
  // (asyncStreamText -> asyncStreamRecvAudio) is what delivers first audio fast.
  DEEPDUB_MODEL: z.string().default('dd-etts-3.2'),
  DEEPDUB_REALTIME: envBool(true),
  DEEPDUB_LOCALE: z.string().default('he-IL'),
  // EU endpoint: the agent deploys to eu-central, so the EU region is both correct and lower-latency.
  DEEPDUB_EU: envBool(true),
  // Raw PCM out of DeepDub (s16le) feeds LiveKit's AudioByteStream directly — no per-chunk WAV header
  // to strip. 24kHz to match the Cartesia path before the 8kHz phone downsample (see buildTTS notes).
  DEEPDUB_SAMPLE_RATE: z.coerce.number().int().positive().default(24_000),
  // Accent control: 0..1 how strongly to pull toward the target locale accent. 0.75 per the sample.
  DEEPDUB_ACCENT_RATIO: z.coerce.number().min(0).max(1).default(0.75),

  // ElevenLabs (only read when VOICE_TTS_PROVIDER=elevenlabs). All optional so the app boots without
  // it — buildTTS throws loudly if the flag is set but key/voice are missing (missing voiceId returns
  // a SILENT empty stream from ElevenLabs, not an error, so we fail fast instead).
  ELEVENLABS_API_KEY: z.string().min(1).optional(),
  ELEVENLABS_VOICE_ID: z.string().min(1).optional(),
  ELEVENLABS_MODEL: z.string().default('eleven_flash_v2_5'),
  // Force a language on the ws stream. Empty → omit (flash/turbo v2.5 REJECT language_code=he with a
  // 1008 close → set empty for those). 'he' → clean Hebrew on models that accept it (multilingual_v2).
  ELEVENLABS_LANGUAGE: z.string().optional(),
  // The two ws-handshake levers. The plugin appends auto_mode / sync_alignment to the multi-stream-input
  // URL; multilingual_v2 & v3 403 the HANDSHAKE when those are requested (flash/turbo accept them). Both
  // default OFF so the quality models can connect over the websocket. See docs/voice-agent-worklog.md.
  ELEVENLABS_AUTO_MODE: envBool(false),
  ELEVENLABS_SYNC_ALIGNMENT: envBool(false),
  // Route via ElevenLabs' HTTP endpoint instead of the websocket. Required for eleven_v3 and other
  // Voice-Design "generated" voices (KEREN CLICKSCALES is one): they 403 the ws multi-stream-input and
  // only render correctly on v3, which is HTTP-only. true → wrap the plugin in a LiveKit StreamAdapter
  // so the session calls synthesize() (HTTP /stream, sentence-tokenized). Higher TTFB than the ws.
  ELEVENLABS_USE_HTTP: envBool(false),
  // optimize_streaming_latency (0-4) on the HTTP path — trades a little quality for lower TTS TTFB.
  // v3 over HTTP measured ~783ms TTFB; 3 pulls that down. Omit to leave it unset. HTTP path only.
  ELEVENLABS_STREAMING_LATENCY: z.coerce.number().int().min(0).max(4).optional(),

  // How long she may think in SILENCE before making the noise a person makes while thinking.
  //
  // Koren, on a real call: "סיימת? אני פשוט לא מדבר, אני מחכה שתסיימי." He could not tell whether
  // she was thinking or had simply stopped. Dead air is the problem, not the delay itself — a human
  // fills it with "אממ..." and nobody minds the pause at all.
  //
  // THE THRESHOLD IS THE ENTIRE DESIGN. Median LLM first-token is ~767ms, so anything below ~1000ms
  // would make her hum on EVERY turn, which is far worse than silence — it would sound like a tic.
  // 1200ms fires only on the genuinely slow turns (the ~1600-1800ms outliers), which is exactly when
  // a person would actually hesitate.
  //
  // Costs a little: once the filler starts, the real reply queues behind it. That is the trade —
  // it makes the wait feel HUMAN, not shorter. Set to 0 to switch it off entirely.
  VOICE_THINKING_FILLER_MS: z.coerce.number().int().nonnegative().default(2500),
  // Say "אוקיי" the instant the turn ends, before the model has written a word.
  //
  // THE ONLY THING THAT PUTS FIRST AUDIO UNDER A SECOND. Measured budget: end-of-turn ~400ms +
  // LLM time-to-first-token ~974ms + TTS first byte ~217ms (`npm run bench:path`). The middle term
  // is not tunable — the speech guard releases the opener 25ms after the first token, so the
  // pipeline already streams correctly and the wait is simply how long gpt-5.4 takes to start.
  // A real answer cannot arrive before ~1.6s; an acknowledgement arrives at ~620ms.
  //
  // This changes how she sounds on EVERY turn, so it is one env var to switch off. If it reads as
  // a tic rather than as listening, that is the knob — do not start editing the phrase list first.
  VOICE_INSTANT_ACK: envBool(true),
  // How long she may stay deliberately silent before checking back in.
  //
  // The caller asking her to hold makes the model emit NO_RESPONSE_NEEDED, the guard strips it,
  // and she says nothing — correct, and with no exit of its own. On 2026-08-16 that ran for
  // twenty seconds of a live call before the caller asked whether anyone was still there. Nothing
  // downstream can tell deliberate quiet from a dead agent, so this is the timer that ends it.
  //
  // Long enough that a caller who genuinely said "רגע" is not nagged; short enough that the call
  // never feels dropped. 0 disables the watchdog and restores the indefinite silence.
  VOICE_HOLD_CHECKBACK_MS: z.coerce.number().int().nonnegative().default(7000),

  // How long the CALLER may sit in silence before she checks he is still there.
  //
  // THE 15-SECOND DEAD LINE, and it was never ours to begin with. The silence reflex fires off the
  // SDK's `user_state_changed -> 'away'` event, and that event is driven by LiveKit's own
  // `userAwayTimeout`, whose default is 15 SECONDS (`agent_session.js`: `userAwayTimeout: 15`, armed
  // the moment her audio stops and the caller is not speaking). Nothing in this repo ever set it, so
  // "how long a caller hears nothing at all" was a framework default nobody had chosen.
  //
  // Measured on the 2026-08-31 production call: two silences of 15294ms and 15363ms, at 117s and
  // 301s. NOTHING ran inside either window — no STT final, no end-of-turn, no LLM request, no
  // preemptive draft, no tool: the only pipeline event in the whole 15s was the TTS first byte of
  // the nudge itself (236ms / 275ms), and 15000 + that is the gap to the millisecond. The dead-air
  // metric cannot see it — its stopwatch runs from the CALLER's turn ending, and there was no
  // caller turn — which is why it read a healthy max of 3977ms on the same call.
  //
  // 7000 matches VOICE_HOLD_CHECKBACK_MS on purpose: those two timers answer the same question from
  // the two sides of the call (she is quiet / he is quiet) and there is no reason for a caller to
  // wait longer for one than the other. Set 15000 to restore the SDK default behaviour exactly;
  // 0 disables the away timer altogether (no silence reflex at all — the pre-2026-07 behaviour).
  VOICE_SILENCE_AWAY_MS: z.coerce.number().int().nonnegative().default(7000),

  // Agent spoken language (ISO 639-1) — drives both STT and TTS
  VOICE_LANGUAGE: z.string().default('he'),
  // Biasing prompt for the STT. Hebrew transcription invents words it half-hears — it turned
  // "קורן" into "קורנטיטרי" and "השארתי פרטים" into "הייתי פרטימה" on a real call. Whisper-family
  // models take a prompt of EXPECTED vocabulary and bias towards it. This is the cheapest fix for
  // the thing that would otherwise break Phase 4, which has to capture a name, phone and email.
  // Keep it to genuinely expected words; a long prompt biases towards nonsense.
  VOICE_STT_PROMPT: z
    .string()
    .default('קורן, קרן, קליקסקיילס, ClickScales, פגישה, שיחת היכרות, אימייל, טלפון, שיווק, תקציב'),
  // End-of-turn tuning — THE latency lever for Hebrew, since no Hebrew EOT model exists.
  // The two delays stack: end-of-turn ≈ max(Silero silence, minDelay).
  // Was 550/500 (measured 1200-1443ms end-of-turn). Now 250/200, which measured 955-1569ms
  // with ZERO cut-offs across baseline / short-answer / hesitation scenarios.
  // Caveat: those were SYNTHETIC pauses, which are shorter than a real person's. If the agent
  // starts talking over live callers, raise these first. Sweep with `npm run voice:test`.
  // Silero's OWN default is 550ms. Ours is deliberately lower — deleting these settings does not
  // remove a delay, it restores a bigger one. Floor is 0: a hard zero is legal and means "the
  // instant the VAD stops hearing speech, the turn is over".
  VOICE_VAD_MIN_SILENCE_MS: z.coerce.number().int().nonnegative().default(250),
  VOICE_ENDPOINTING_MIN_DELAY_MS: z.coerce.number().int().nonnegative().default(200),
  VOICE_ENDPOINTING_MAX_DELAY_MS: z.coerce.number().int().positive().default(2000),
  // Run TTS on the draft reply before the turn is confirmed, so Cartesia's ~390ms doesn't land
  // on top of the endpointing wait. Costs Cartesia characters on drafts we discard.
  VOICE_PREEMPTIVE_TTS: envBool(false),
  // How long the caller must stop producing new words before we draft a reply from what they have
  // said so far. VOICE_TURN_DETECTION=stt only — see stt/soniox.stt.ts withPausePreflight.
  //
  // DEFAULT 0 = OFF, because against Soniox this cannot win, and the reason is worth knowing
  // before anyone turns it back on.
  //
  // A preemptive draft survives only if `preemptive.info.newTranscript === userMessage.textContent`
  // — a strict string equality against the committed transcript (agent_activity.js:1711). The
  // Soniox plugin builds an INTERIM as `finalTokens + nonFinalTokens` and the FINAL as
  // `finalTokens` alone (_internal.js:211). So a draft started from an interim is, by definition,
  // built on tokens Soniox has not committed to and will still rewrite — most visibly by adding
  // the closing punctuation. Measured on a real call at 200ms: 6 drafts started, 6 discarded,
  // 0 used, ~6 LLM calls paid for and nothing heard by the caller.
  //
  // This is structural, not a tuning problem: no pause length makes non-final tokens final. The
  // route that CAN work is Soniox's own PREFLIGHT, which it emits when every token is finalised
  // and the endpoint has not fired yet — see SONIOX_MAX_ENDPOINT_DELAY_MS, which is what opens
  // that window.
  //
  // Kept, not deleted: the mechanism is sound against an STT whose interims are stable, and it is
  // covered by tests. It is the trigger's premise that Soniox violates.
  VOICE_PREEMPTIVE_PAUSE_MS: z.coerce.number().int().nonnegative().default(0),
  // How loud a sound must be before Silero calls it speech. THE lever for phone lines: a phone
  // is never digitally silent (hiss, comfort noise), so at the default 0.5 the VAD keeps hearing
  // "speech" and the end-of-turn silence timer never fires — measured 1030ms on a real call even
  // with a 250ms timer, vs 258ms in tests that fed it true digital silence. Raise to ignore the
  // noise floor. Too high and it will miss a softly-spoken caller.
  VOICE_VAD_ACTIVATION_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
  // LLM for the live voice turn only (everything else keeps AI_MODEL).
  //
  // MEASURED: there is no faster model. Same prompt, full completion:
  //   gpt-5.4 + effort=none  1679ms
  //   gpt-5-mini             1762ms
  //   gpt-5-mini + low       1462ms
  //   gpt-5-nano             2227ms   (SLOWER than 5.4)
  // ~1s to first token is a floor across the family — it is not reasoning and not model size.
  // Do not "optimise" the voice LLM again without re-measuring; this was a dead end.
  //
  // TRAP: `reasoning_effort: 'none'` is REJECTED by gpt-5-mini (400) but ACCEPTED by gpt-5.4.
  // A rejected combination makes the agent go completely silent mid-call. If you change the
  // model, re-check the effort value.
  VOICE_LLM_MODEL: z.string().optional(),
  // How many chat items (user + agent messages) to send the LLM. The system prompt is always kept.
  //
  // This is a COST lever, NOT a latency one — measured, and the latency premise was wrong:
  //   untrimmed:  3836 input tokens, LLM ttft 1094ms
  //   16 items:   3055 input tokens, LLM ttft 1092ms   (-20% tokens, 2ms faster = noise)
  // gpt-5.4's ~1.1s to first token is fixed overhead (network + queueing), not a function of
  // input size at these volumes. Do not expect trimming to make the agent feel faster.
  //
  // It still earns its keep: without it the whole call is re-sent every turn, so input tokens grow
  // QUADRATICALLY with call length (a 4-minute call already hit 10,249). Trade-off: she forgets
  // anything older than ~8 exchanges. Raise this if a caller back-references something and she has
  // lost it.
  // How many chat items to send the LLM. 0 = NO TRIMMING, and 0 is now the default.
  //
  // TRIMMING DESTROYS OPENAI'S PROMPT CACHE, which is worth far more than the trimming ever saved.
  //
  // OpenAI caches the longest common PREFIX of a prompt, minimum 1024 tokens, at a large discount
  // and with faster prefill. A sliding window is the one thing guaranteed to defeat it: truncate()
  // keeps the system prompt and the LAST N items, so as the call grows the messages immediately
  // after the system prompt CHANGE ON EVERY TURN. The prefix never stabilises, and our system prompt
  // alone (~882 tokens) sits BELOW the 1024 threshold — so there is nothing left to cache at all.
  //
  // MEASURED on a simulated call:
  //   after 5 exchanges   1397 input tokens   1280 CACHED (92%)   <- with the history intact
  //   with a 16-item window                      0 cached (0%)    <- the prefix moves every turn
  //
  // So the trimmer I wrote to save money was throwing away a 90% discount on almost the entire
  // prompt. Cached input is cheap enough that keeping the FULL history is cheaper than trimming it.
  // Trimming was also separately measured to save NO latency (3836 -> 3055 tokens moved ttft by 2ms).
  //
  // It bought nothing and cost the cache. Off by default. Set a positive number to re-enable it if a
  // call ever runs long enough to threaten the context window — but know what you are giving up.
  VOICE_MAX_HISTORY_ITEMS: z.coerce.number().int().nonnegative().default(0),
  // Cartesia speech rate. THE lever for phone intelligibility: a phone line is 8kHz, which
  // destroys the high frequencies that carry consonants, so a fast delivery turns to mush.
  // Slowing down gives the listener's ear time to reconstruct them.
  // Cartesia's actual range is 0.6 (slowest) .. 1.5 (fastest); 1.0 is normal. Out-of-range values
  // are rejected and Cartesia returns an EMPTY audio stream with only a DEBUG log — no error, no
  // throw. The agent simply goes silent. Do not guess this range.
  VOICE_TTS_SPEED: z.coerce.number().min(0.6).max(1.5).default(1),
  // Cartesia output volume (sonic-3 accepts 0.5 .. 2.0). A phone line has a low dynamic range;
  // a quiet voice sits too close to the line noise and gets lost. Louder = more intelligible,
  // up to the point of clipping.
  VOICE_TTS_VOLUME: z.coerce.number().min(0.5).max(2).default(1),
  // Reasoning budget for the voice LLM. gpt-5.4 accepts: none | low | medium | high | xhigh.
  // NOT 'minimal' — that is a different model family's value, and sending it kills the call with
  // a 400 (the agent goes silent mid-conversation). 'none' is what we want: a voice reply is two
  // sentences of small talk, and reasoning was costing ~1030ms to first token.
  // ('xhigh' is valid at the API but absent from the plugin's ReasoningEffort type — omitted.)
  VOICE_LLM_REASONING_EFFORT: z.enum(['none', 'low', 'medium', 'high']).optional(),
  // Recorded-call legal pre-roll (Wiretapping Law 1979 §2). DISABLED for now (Koren, 2026-07-27):
  // the choppy playback on the PSTN leg is worse than no notice for the interim test phase, and it
  // is not legally required while calls are pre-launch. The playback code (compliance/recording-
  // notice.ts) stays intact — flip this to 'true' to re-enable once the frame-size fix is verified
  // on a real phone call. When off, compliance is recorded as played:false reason:disabled.
  VOICE_RECORDING_NOTICE_ENABLED: z.enum(['true', 'false', '1', '0']).optional(),
  // Answering-machine detection (voicemail reflex), OUTBOUND ONLY. Default off — experimental until
  // verified on a real voicemail call that it fires and leaves inbound untouched. When on, an
  // outbound call that hits a machine gets a short message + hang-up instead of a discovery attempt.
  VOICE_AMD_ENABLED: envBool(false),
  // Kill-switch for the whole advisory conversation-state layer: situational reflexes (silence /
  // barge-in / voicemail), stage/working-memory tracking, and the objection-handling prompt section.
  // Default ON. Set false to run Keren exactly as she was before the state machine — used to A/B
  // whether the advisory layer affects call behaviour. Tools and the gate are unaffected either way.
  VOICE_STATE_MACHINE_ENABLED: envBool(true),
  // Kill-switch for the Hebrew number/time SPEECH normalizer (speech-numbers.he.ts): clock times
  // ("16:30" → "ארבע וחצי"), phone digits and round prices are spoken as colloquial Hebrew words.
  // Speech-only — transcripts/chatCtx keep the digits, same contract as the gender tables.
  // Default ON (Koren, 2026-08-27). Set false to restore raw digit read-out.
  VOICE_SPEECH_NUMBERS_ENABLED: envBool(true),
  // Kill-switch for the anti-repetition phrase ledger (phrase-ledger.ts): tracks 4-grams she has
  // already said this call and appends a per-turn "do not reuse these phrasings" system note at
  // turn boundaries (tail-appended — never churns the prompt-cache prefix, never touches an
  // in-flight preemptive draft). Default ON (Koren, 2026-08-27). Set false to remove the note
  // entirely; the repeatedPhraseCount metric in CallReport keeps reporting either way.
  VOICE_PHRASE_LEDGER_ENABLED: envBool(true),
  // Kill-switch for the call's identity memory (fact-memory.ts): remembers which facts the lead has
  // already given and which questions she has already asked, appends a turn-boundary reminder, and
  // stops capture_lead_info REPLACING an established name/phone/email without an explicit
  // correction from the lead. Default ON. Set false to restore the 2026-08-29 behaviour, where a
  // garbled turn ("טל, אוזן") could rename a lead who had already introduced himself.
  VOICE_FACT_MEMORY_ENABLED: envBool(true),
  // Kill-switch for counting her discovery questions BY INTENT rather than by literal phrasing
  // (fact-memory.ts, 2026-09-02). On the 14:56 call of 2026-09-01 she asked what his business is
  // five times and the counter saw three, and she asked who answers his enquiries four times and
  // the counter saw zero — there was no such field. ON: the four remaining mandatory discovery
  // questions (process / frustration / closing / volume) get an ask memory, her improvised
  // phrasings are matched by keyword co-occurrence over QUESTION SENTENCES ONLY, and a question
  // asked after the lead has actually answered is treated as going deeper rather than as a
  // re-ask. Default ON: OFF is the state that produced the defect, and OFF restores it exactly.
  // Inert when VOICE_FACT_MEMORY_ENABLED is false (there is no memory to count into).
  VOICE_ASK_INTENT_ENABLED: envBool(true),
  // Kill-switch for the spoken-register nudge (register-tracker.ts, 2026-08-30). The Spoken
  // Register section asks for an everyday word every second or third reply; on the 2026-08-29 call
  // it produced two in eight turns and Koren perceived none. ON appends a turn-boundary reminder
  // after two consecutive replies with no register word — the same guidance/enforcement split as the
  // phrase ledger. Inert when VOICE_SPOKEN_REGISTER_ENABLED is off (nothing to be reminded of).
  VOICE_REGISTER_NUDGE_ENABLED: envBool(true),
  // Kill-switch for the acknowledgement ledger (2026-08-30). ON spends a WIDER bank (5 words) like a
  // shuffled deck — every word used once before any is used twice — instead of picking at random
  // while avoiding only the previous one. Six of eight turns on the 2026-08-29 call opened with one
  // of three words, twice each, and three words cannot be spread more thinly than that. OFF restores
  // the original three-word bank and the random pick exactly, including in the prompt's own
  // illustration of what she will hear.
  VOICE_ACK_LEDGER_ENABLED: envBool(true),
  // Kill-switch for the negation-safety work (2026-08-30). On a real call she said
  // "ועוזרים לא לפספס לידים" and the lead heard "מה עוזרים לו לפספס?" — the unstressed
  // "לא" does not survive an 8kHz line, so the value proposition advertised its own opposite. ON adds
  // the "Say It So It Cannot Be Misheard" prompt section AND rewords the five fixed lines whose
  // meaning hung on one particle (opt-out, disqualification, bad-time apology, one name-ask
  // variant, the security decline). Set false to restore the previous wording exactly.
  VOICE_NEGATION_SAFETY: envBool(true),
  // Kill-switch for the Spoken Register prompt section (simple spoken Hebrew + the light-slang
  // bank — סבבה/אחלה level, no heavy street slang; Koren's explicit register choice 2026-08-27).
  // Default ON. Set false to drop the section and restore the previous register.
  VOICE_SPOKEN_REGISTER_ENABLED: envBool(true),
  // Kill-switch for the mid-dictation vocal nod (2026-08-30). On a real call the lead said "050-",
  // she answered "טוב, הבנתי." as a complete sentence, and he read the other seven digits into it.
  // ON: while the caller is reading out a number or an email, the turn opens with a short nod
  // ("אה אה") that means *got it, keep going* instead of a receipt that claims the floor. OFF
  // restores the receipt in that position exactly. See dictation.ts.
  VOICE_DICTATION_NOD_ENABLED: envBool(true),
  // Kill-switch for "introduce yourself once" (2026-08-30). She said "נעים מאוד" at 35s, correctly,
  // and again at 164s because a surname had just been captured — Koren: "זה מיותר ומוזר, זה משהו
  // שאומרים רק בתחילת השיחה". ON drops a second greeting from her speech (and tells the model why in
  // the Call Memory section); OFF restores the repeat.
  VOICE_INTRO_ONCE_ENABLED: envBool(true),
  // Kill-switch for the EARNED comprehension acknowledgement (2026-08-31). Koren, on a ten-minute
  // production call: "הסוכן אמר 'טוב, הבנתי' או 'הבנתי אותך' יותר מדי פעמים, וצריך באמת להגיע
  // בהקשר כשהלקוח משתף מידע שרלוונטי לשיחה". ON: those two words leave the every-turn deck and are
  // spoken only when the caller's turn actually carried something, and never twice running; the
  // other three ("אוקיי." / "אהה." / "בסדר.") are pure receipts and still fire every turn. OFF
  // restores the flat five-word deck of 2026-08-30 exactly. See engagement.ts.
  VOICE_ACK_EARNED_ENABLED: envBool(true),
  // Kill-switch for the filler PAIRING rule (2026-08-31, round-7 card `n4a`). We first read
  // Koren's "מילת מילוי צריכה להגיע באופן חד פעמי בכל משפט" as a hard cap of one opening sound per
  // breath and shipped that. He then listened to the three versions and picked the DOUBLE:
  // "אהה ורגע יכולים להתאים ביחד, אבל רגע ושניה או רגע וחכה זה מילים שלא יכולות ללכת ביחד". ON: a
  // receipt may be followed by a hesitation (two different acts), two sounds from the SAME bank
  // never stack, and an unscreened sound never pairs at all. OFF restores the hard cap exactly —
  // only a step that opens with nothing may carry an armed hesitation. See turn-opener.ts.
  VOICE_FILLER_PAIRING_ENABLED: envBool(true),
  // Kill-switch for the consecutive-opener rule (2026-08-31, round-7 card `n6b`). Koren: "צריך
  // לוודא שהסוכן לא חוזר על אותה מילה כל פעם בתחילת המשפט ('אוקיי')". The acknowledgement deck was
  // MEASURED innocent — 0 consecutive repeats over 20,000 simulated calls in each of its four
  // configurations — and the repeats come from the three producers it cannot see: the dictation
  // nod (a single constant), the thinking fillers, and the model's own word on a silent step. ON
  // remembers the head-word of the previous reply whichever mechanism said it, and refuses it for
  // the next one (a nod that would repeat becomes silence). OFF restores the 2026-08-31 behaviour.
  // See spoken-openers.ts.
  VOICE_OPENER_NO_REPEAT_ENABLED: envBool(true),
  // Kill-switch for the email WhatsApp hand-back (2026-08-31, round-8 card `e5`). Koren: "עדיף
  // שהיא תבקש ממנו לשלוח לה את הכתובת אימייל בוואטצאפ אם זה לא עובד אחרי פעמיים שלוש". ON lets her
  // offer, ONCE, after two failed read-backs, that he send the address to TWILIO_WHATSAPP_NUMBER —
  // and only when that var is actually set, because she must never name a channel that will not
  // reach us. The direction matters: an INBOUND WhatsApp opens the lead's 24h freeform window by
  // itself, so unlike our outbound confirmation it needs no approved template. OFF (or no number
  // configured) restores the 2026-08-31 wording, which promises no channel at all.
  VOICE_EMAIL_WHATSAPP_HANDBACK_ENABLED: envBool(true),
  // Kill-switch for the "No Preamble" prompt section (2026-08-31). Four of Koren's nine notes on
  // that morning's call were one habit: she acknowledged, mirrored his words, told him his topic
  // was important, and announced that she was about to confirm something — before every sentence.
  // ON adds the section that names the habit and forbids all four shapes (while explicitly
  // protecting the empathy beat and the opening slang, which he asked to KEEP). OFF restores the
  // 2026-08-30 prompt's silence on it. Prompt-only; nothing in code reads it but the builder.
  VOICE_NO_PREAMBLE_ENABLED: envBool(true),
  // Kill-switch for the caller-engagement note (2026-08-31). Koren: "אם הלקוח קצר מדי בשיחה ולא
  // משתף פעולה, הסוכן צריך להבין שהוא לא הולך לשאול הרבה שאלות, אלא רק מה שחשוב". ON measures how
  // many words the caller gives per turn and injects one advisory line at a turn boundary when the
  // level changes — mandatory discovery questions only for a terse caller, the optional ones
  // unlocked for an engaged one. It never changes her speech. OFF drops the note entirely; the
  // prompt's mandatory/optional split stays either way.
  VOICE_ENGAGEMENT_NOTE_ENABLED: envBool(true),
  // Kill-switch for email-dictation memory (2026-08-31). Two consecutive production calls captured
  // `koren@gmail.com` for a lead whose address is `kaskoren@gmail.com`, and the second one lost the
  // booking over it: he spelled the prefix twice, she read back the value he had just contradicted,
  // and the call ran out before it converged. ON: the letters he spells are stitched across his
  // fragmented turns and handed to the model in order, a value he rejected out loud is recorded so
  // it can never be read back or saved again, and the spoken domain ("ג'ימייל נקודה קום") is
  // resolved to `gmail.com`. OFF restores the previous behaviour exactly. See email-dictation.ts.
  VOICE_EMAIL_DICTATION_ENABLED: envBool(true),
  // Whether book_meeting may close a booking with NO email address (2026-08-31).
  //
  // The 2026-08-31 production call is the whole argument: the lead had agreed to a demo at 450s and
  // the call spent its last 54 seconds failing to transfer one email field. `book_meeting` was never
  // called. Its schema required a valid email, so there was no way for her to keep the meeting and
  // drop the field — the tool's own error text sent her back into the read-back loop that was
  // killing the call.
  //
  // ON: after two failed read-backs she may pass `email: null`. The calendar event is created with
  // no attendee (the provider already has that path for the service-account 403) and the lead row
  // is saved without an email. A booked meeting missing one field beats a lost meeting with a
  // complete form.
  //
  // NOTHING IS SENT TO THAT LEAD AUTOMATICALLY, and an earlier version of this comment wrongly
  // said the confirmation "goes to his phone over WhatsApp instead". It does not — no open 24h
  // window, no approved template, so the send is blocked and dropped. The prompt therefore promises
  // the TEAM, not a channel. See VOICE_EMAIL_WHATSAPP_HANDBACK_ENABLED for the one direction that
  // does work: a message HE sends us.
  //
  // OFF restores the previous behaviour exactly: a null email throws the same ToolError as before.
  // Note this is one of the few voice flags whose default is NOT "what we did yesterday" — the
  // previous behaviour is the defect. See book-meeting.tool.ts.
  VOICE_BOOK_WITHOUT_EMAIL: envBool(true),
  // Kill-switch for the tool-call leak guard (2026-08-31). On the 13:52 production call the model
  // emitted a tool call as plain assistant TEXT in the final channel and Cartesia read all of it
  // aloud for NINETEEN SECONDS — "to=functions.capture_lead_info", a run of Chinese glitch tokens,
  // and the caller's own business type, pain point and qualification as raw JSON. The capture never
  // executed. ON: nothing shaped like a tool call, a harmony control token, a JSON object or an
  // unspeakable CJK run may reach the TTS on ANY path (replies, preemptive drafts, reflex lines),
  // the human sentence behind the payload is salvaged and spoken, and each occurrence is counted in
  // the call report. OFF restores the 2026-08-31 behaviour, in which the payload is spoken — there
  // is no good reason to set it and it exists only so the mechanism has an off switch like every
  // other one here. See toolcall-leak.ts.
  VOICE_TOOLCALL_LEAK_GUARD_ENABLED: envBool(true),
  // ── The 2026-08-31 16:51 call: she promised a booking that did not exist, then hung up ────────
  //
  // Widens the speech guard's false-booking rewrite past first-person-singular. She said
  // "קבענו לאחת עשרה" — "WE booked for eleven" — with only check_calendar_availability behind her,
  // and the guard that exists for exactly this was armed, running, and blind to the plural. The
  // lead left the call expecting a call at 11:00 that nothing in any calendar knew about.
  //
  // ON: קבענו / סגרנו / שריינתי / נקבעה / רשמתי אותך / הפגישה מסודרת are rewritten too, until
  // book_meeting returns success. Deliberately excluded is the whole present/future family
  // (בוא נקבע, אני קובעת) — those are how she legitimately offers and narrates, and one of them is
  // book_meeting's own filler line. OFF restores the five original patterns exactly.
  //
  // Another flag whose default is NOT "what we did yesterday": telling a lead his meeting is booked
  // when it is not has no acceptable version. See FALSE_BOOKING_WIDE in speech-guard.ts.
  VOICE_BOOKING_CLAIM_GUARD_WIDE: envBool(true),
  // The code-truth booking note: "nothing has been booked yet, and here is what book_meeting still
  // needs". Fires only between the first availability check and a successful booking. The prompt
  // said all of this already and was 13,000 tokens behind her by the time it mattered — the phrase
  // ledger lesson, applied to the one claim on this call that reaches a person after it ends.
  // OFF: no note, exactly as before. See booking-note.ts.
  VOICE_BOOKING_NOTE_ENABLED: envBool(true),
  // The half of that note which reads the caller's own number back to him instead of asking him to
  // dictate it. On the 16:51 call she asked for the phone twice, got nothing, and ended the call
  // partly for want of a number that was sitting in the tool runtime the whole time. It is a
  // CONFIRMATION, never a substitution — a man may want the demo on a different number, and only he
  // knows that. Inbound calls only (there is no caller ID to offer otherwise).
  //
  // The one flag here that changes what she SAYS on every inbound call, which is why it is separate
  // from VOICE_BOOKING_NOTE_ENABLED: OFF keeps the booking note and drops only this paragraph.
  VOICE_CALLER_PHONE_KNOWN_ENABLED: envBool(true),
  // Hebrew letters spelled for a NAME, stitched across the turns the endpointer shreds. He spelled
  // ט · ר · י · ת across two turns on the 16:51 call and nothing joined them; she then concatenated
  // two separate mishearings into "שפיץ טריט" and read that back as his name. email-dictation.ts
  // does this for LATIN letters in an address and cannot see either. Advisory only — a note the
  // model may ignore; it can never change what she says by itself. OFF: no note.
  // See name-dictation.ts.
  VOICE_NAME_DICTATION_ENABLED: envBool(true),
  // Step 3 may not disqualify until all three mandatory discovery questions are answered, the
  // objection has been addressed once, and what is left maps onto a real disqualifier. On the 16:51
  // call she signed a lead off 79 seconds in, off ONE answer, on inquiry volume — which the
  // paragraph directly above the disqualifiers already said never disqualifies anybody. He talked
  // over the farewell and agreed to a demo five minutes later.
  // OFF restores the 2026-08-31 Step 3 exactly. See DISQUALIFY_GATE in system-prompt.he.ts.
  VOICE_LATE_DISQUALIFY_ENABLED: envBool(true),
  // How long the caller may think, in silence, before she asks whether he is still there.
  //
  // SEPARATE FROM VOICE_SILENCE_AWAY_MS ON PURPOSE. That one is the SDK's `userAwayTimeout` — when
  // LiveKit decides the caller is "away" — and it also drives `endedBy` attribution in the call
  // report. This one is when she is allowed to SAY something about it, and the 2026-08-31 13:52
  // call is why they had to come apart: with both at 7000 the reflex fired twice inside the first
  // minute of a 3.5-minute call (7287ms at 27s, 7345ms at 46s), both times into a pause the caller
  // was still thinking in, both times right after she had asked him an open discovery question.
  //
  // MEASURED, not guessed. Across the only two production calls carrying this instrumentation
  // (08:37 and 13:52 the same day) EVERY away event was a caller thinking — no STT final, no
  // end-of-turn, no VAD, nothing on the line — and in every case he answered on his own 2-5s after
  // the nudge and 11-20s after she stopped speaking. Not one was a dead line. 20000 sits above the
  // longest genuine pause we have measured (~18s on the 08:37 call). The failure a caller actually
  // experiences as a dropped line is HER going quiet, and that is VOICE_HOLD_CHECKBACK_MS's job,
  // still at 7s.
  //
  // 0 restores the 2026-08-31 behaviour exactly: the nudge fires the moment the SDK says 'away'.
  VOICE_SILENCE_NUDGE_MS: z.coerce.number().int().nonnegative().default(20000),
  // ── The 2026-08-31 19:54 call, Koren's eleven conclusions ────────────────────────────────────
  // A disqualifying end_call (not_qualified / not_interested) must rest on the LEAD's own words.
  // At 260s she was cut off mid-conditional ("אם זה עדיין מרגיש לךָ לא נכון"), the caller's next
  // half-second — spoken INSIDE her speech window — came back as "כן, מרגיש לך", and she read her
  // own echo, minus its negation, as a yes and hung up on a lead she had recorded as "hot" 96
  // seconds earlier. The gate refuses a hang-up built on an overlap, an echo, or an inference, and
  // makes her ask "אתה רוצה שנעצור כאן?" instead. opt_out is never delayed (legal), and the gate
  // stops refusing after two so a caller can always get off the phone.
  // OFF restores the ungated tool exactly. See end-call-gate.ts.
  VOICE_END_CALL_CONFIRM_ENABLED: envBool(true),
  // The earned-acknowledgement test reads the turn the model is ANSWERING (chatCtx) instead of the
  // last COMMITTED turn. With preemptive generation the committed field is one turn behind — which
  // is why "טוב, הבנתי" landed after four questions on that call, four times out of four.
  // OFF restores the stale source. See latestCallerText in engagement.ts.
  VOICE_ACK_EARNED_FROM_CONTEXT: envBool(true),
  // One question per reply, enforced rather than only instructed: the second question sentence in a
  // reply is dropped before it is spoken. *"שאלה כפולה באותו המשפט שווה מקור לבעיות."*
  // OFF: both questions are spoken, as on 2026-08-31. See guardStream's `reply` parameter.
  VOICE_ONE_QUESTION_ENABLED: envBool(true),
  // She must never narrate her own instructions, register or delivery to a caller. *"אני פשוט
  // מתארת את זה בשפה יומיומית"* and *"אני מדברת ככה כי זה טבעי לי בשיחה"* were both paraphrases of
  // the Spoken Register section, read back to a sales lead who asked why she talks that way. The
  // sentence is DROPPED, never rewritten — there is nothing to replace it with.
  // OFF: the sentence is spoken. See SELF_NARRATION in speech-guard.ts.
  VOICE_SELF_NARRATION_GUARD_ENABLED: envBool(true),
  // The prompt half of the same eleven: sentence SHAPE over comma chains, the meanings of the
  // screened slang bank, unambiguous positives for product claims, empathy-first on a stated
  // concern, discovery that establishes whether there IS a business before asking about it, and a
  // mandatory question that persists until it is answered.
  // OFF restores the 2026-08-31 prompt sections exactly. See system-prompt.he.ts.
  VOICE_CALL4_PROMPT_ENABLED: envBool(true),
  // THE SALES MODEL, 2026-09-01 — docs/gtm/keren-sales-model.md.
  //
  // The prompt ran a qualification form: open, three factual questions, classify, book. Five of
  // the eight moves of a sales conversation were absent. This turns on all of them at once — the
  // seven-stage flow, Gate A (no product talk before business + current process + pain), the five
  // mandatory questions Koren set and owns, pain deepening, the interest check before the ask, and
  // the summary close built from his words.
  //
  // ONE flag for the whole structure, deliberately: the gate is meaningless without somewhere for
  // the call to go once it opens, and the summary close has nothing to summarise if the pain was
  // never deepened. Half of this model is a prompt that describes half a conversation.
  //
  // Defaults FALSE — an unconfigured deploy renders the 2026-09-01 prompt byte for byte. Turn it
  // on per environment while it is being measured. The code half is sales-gate.ts and moves with
  // this same flag; a gate enforced without its prompt section is a note about a rule she was
  // never given.
  VOICE_SALES_MODEL_ENABLED: envBool(false),
  // KOREN'S TWELFTH CONCLUSION, 2026-09-01: *"make that rule weakened. Every turn can be a bit
  // problem.. but instead its better to instruct the agent to use it on every long thinking turn or
  // a complex answer."*
  //
  // The short opener at the head of every reply is a LATENCY device — her voice starts only once
  // the first sentence is complete, so a 2-4 word sentence covers the ~930ms gpt-5.4 spends
  // thinking. It buys nothing when the reply that follows is one short line, so on those turns it
  // was pure cost: a receipt the caller did not need, in front of the answer he did. This makes it
  // CONDITIONAL, in the code that speaks it and in the prompt that describes it, together.
  //
  // Replaying the 2026-08-31 19:54 call through the predicate turns 22 receipts into 11, and the
  // eleven it removes include all three of the stray one-word agent turns ("אוקי." after "אני—",
  // "בסדר." after a fragment, "בסדר." after his last "כן.").
  //
  // OFF restores the every-turn receipt exactly, in both halves. See callerTurnNeedsThinkingTime
  // in engagement.ts and the Speech Rhythm sections in system-prompt.he.ts.
  VOICE_ACK_ONLY_WHEN_NEEDED: envBool(true),
  // ── The 2026-09-01 09:29 call, seven defects in one batch ────────────────────────────────────
  // ONE SENTENCE, NOT TWICE. At 205/209/212s she began the same reply three times, each attempt
  // cut off by the caller's next interjection after 0.3-0.6s of audio; at 462/468s she apologised
  // for the same failed `book_meeting` twice, in two sentences whose second halves were
  // word-for-word identical. A sentence already sent to the TTS inside the last 30s is suppressed.
  // Questions are exempt (dropping the reply's only question would be dead air with extra steps —
  // the question she must not repeat is one she has the answer to, which is VOICE_SLOT_MEMORY's
  // job), and so is a repeat the caller ASKED for ("לא שמעתי", "תגידי שוב"). If suppression would
  // leave the whole reply empty, the sentence is spoken after all.
  // OFF restores the 2026-09-01 behaviour exactly. See repeat-guard.ts.
  VOICE_REPEAT_GUARD_ENABLED: envBool(true),
  // WHEN HE ALREADY TOLD YOU WHEN. She asked "בוקר, או אחר הצהריים?" at 161s, 174s, 186s and 293s
  // — the last two after he had answered — and he ended the call: *"אני לא יודע למה את שואלת על זה
  // סתם שאלות כמה פעמים."* FactMemory could not catch it because a time preference is not one of
  // its four fields, and the booking note could not because the slot is not one of `book_meeting`'s
  // required arguments. This is the missing field: day, part of day and hour, tracked from his own
  // words and put in front of the model at the turn boundary.
  // OFF and nothing is tracked. See slot-memory.ts.
  VOICE_SLOT_MEMORY_ENABLED: envBool(true),
  // SHE MAY NOT ANNOUNCE AN ENDING SHE IS NOT CARRYING OUT. At 320s: "אם זה מה שיושב עליך, עדיף
  // שנעצור כאן. תודה", and eleven seconds later she carried on selling. `end_call` was never
  // called and the gate never ran, so the model wrote both halves. A sentence that PROPOSES a stop
  // becomes "אתה רוצה שנעצור כאן?" — the gate's own confirmation question, Koren's round-14 c1=D.
  // A farewell is untouched, and the rule is skipped once `end_call` has actually been invoked.
  // OFF restores the 2026-09-01 behaviour. See STOP_ANNOUNCEMENT in speech-guard.ts.
  VOICE_STOP_ANNOUNCE_GUARD_ENABLED: envBool(true),
  // NO SLANG INSIDE A PRODUCT CLAIM — his round-13 `s2` verdict, enforced. "זה עובד אחלה" becomes
  // "זה עובד מעולה"; slang for rapport ("מחר בבוקר יכול לעבוד אחלה") is left alone. The rule was
  // already in the prompt and was still broken twice on 2026-09-01, because the Spoken Register
  // section three hundred lines above it offered "זה עובד אחלה בדיוק במקרים כמו שלך" as a worked
  // example. That example is fixed in the same commit; this is the half that survives the model
  // writing the sentence some other way.
  // OFF restores the 2026-09-01 behaviour. See PRODUCT_CLAIM_SLANG in speech-guard.ts.
  VOICE_PRODUCT_CLAIM_SLANG_GUARD: envBool(true),
  // SHE SOUNDS THE SAME AT MINUTE SIX AS SHE DID AT SECOND FOUR.
  //
  // Koren, 2026-09-02. The first version of this shipped a SPEED change — hesitant replies
  // synthesized at 0.78 instead of 0.90 — and round 16 killed it: he cannot hear 0.90 from 0.78,
  // and asked whether a rate change between turns sounds like a person slowing down he chose the
  // clip with no change at all. The duration table that justified it was correct and measured the
  // wrong thing. `VOICE_HESITANT_SPEED_FACTOR` was removed rather than set to 1, because a knob
  // that does nothing is worse than an absent one.
  //
  // What replaced it is `<break time="…"/>`, which round 17 settled at three lengths in three
  // positions. ONE FLAG, TWO HALVES: the prompt section that teaches where a pause belongs, and
  // the guard stage that validates what she wrote. They must move together in BOTH directions —
  // a prompt asking for tags whose validator is off would send unchecked tags to Cartesia, and a
  // validator without the prompt is a rule about something she was never asked to do.
  //
  // OFF does not merely skip the stage: it DELETES every tag. See voice-mode.ts.
  VOICE_VOICE_MODES_ENABLED: envBool(false),
  // LiveKit SIP outbound trunk (dials leads through Zadarma). Created with `lk sip outbound
  // create`; the Zadarma SIP username/password live inside the trunk on LiveKit's side, not here.
  LIVEKIT_SIP_OUTBOUND_TRUNK_ID: z.string().min(1).optional(),
  // Which INBOUND trunk to keep in step with `phone_numbers`. Optional: with exactly one inbound
  // trunk it is discovered, and it is only required once a second exists — at which point guessing
  // would mean editing the security boundary of the wrong one.
  LIVEKIT_SIP_INBOUND_TRUNK_ID: z.string().min(1).optional(),

  // Scheduling (Google Calendar) — ClickScales' OWN service account.
  //
  // ⚠️ These are ONE TENANT'S credentials, not the platform's. They apply only to the tenant named
  // by PLATFORM_TENANT_ID; every other tenant connects their own Google account via OAuth
  // (GOOGLE_CALENDAR_OAUTH_* below). Treating them as a global default is what had customer #2's
  // meetings landing in ClickScales' calendar.
  GOOGLE_CALENDAR_ID: z.string().min(1).optional(),
  GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL: z.string().email().optional(),
  // PEM private key — store with literal \n, the provider will unescape them
  GOOGLE_CALENDAR_PRIVATE_KEY: z.string().min(1).optional(),
  // Workspace user the service account impersonates (Domain-Wide Delegation must be granted to
  // the SA's client ID in admin.google.com with scope https://www.googleapis.com/auth/calendar).
  // With this set, calendar invites actually email out and events carry a Meet link; without it,
  // bookings fall back to attendee-less events (BookingResult.inviteSent=false).
  GOOGLE_CALENDAR_IMPERSONATE_USER: z.string().email().optional(),
  GOOGLE_CALENDAR_SLOT_MINUTES: z.coerce.number().int().positive().optional(),
  GOOGLE_CALENDAR_WORK_START: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  GOOGLE_CALENDAR_WORK_END: z.string().regex(/^\d{2}:\d{2}$/).optional(),

  // Per-tenant Google Calendar via OAuth — how a CUSTOMER connects their own calendar.
  //
  // A service account cannot be used for a customer: impersonating a user in their Workspace needs
  // Domain-Wide Delegation, which needs admin rights in their Google account. OAuth is what a
  // customer can actually grant. One Google Cloud OAuth client serves every tenant; the per-tenant
  // grants live in the `oauth_connections` table.
  //
  // The redirect URI must match the Google console entry EXACTLY, including scheme and trailing
  // path — Google compares it as a literal string and a mismatch fails at the callback, after the
  // customer has already consented.
  GOOGLE_CALENDAR_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: z.string().url().optional(),

  // AI (OpenAI)
  OPENAI_API_KEY: z.string().min(1).optional(),
  AI_MODEL: z.string().default('gpt-5.4'),

  // Integrations - Monday.com
  MONDAY_WEBHOOK_SECRET: z.string().min(1).optional(),

  // Integrations - Airtable
  AIRTABLE_API_KEY: z.string().min(1).optional(),
  AIRTABLE_BASE_ID: z.string().min(1).optional(),
  AIRTABLE_TABLE_ID: z.string().min(1).optional(),
  AIRTABLE_PHONE_FIELD: z.string().min(1).optional(),
  AIRTABLE_EMAIL_FIELD: z.string().min(1).optional(),

  // Integrations - Airtable: ClickScales' OWN sales lead board (a DIFFERENT base from the
  // AIRTABLE_* keys above, which are the per-tenant CRM sync target). New leads from the
  // website form and Meta Lead Ads are pushed onto it one-way. Scoped to PLATFORM_TENANT_ID —
  // there is deliberately no per-tenant equivalent, this is Koren's private pipeline board.
  // All three must be set or the push is skipped loudly; none of them is read back from.
  AIRTABLE_LEADS_PAT: z.string().min(1).optional(),
  AIRTABLE_LEADS_BASE_ID: z.string().min(1).optional(),
  AIRTABLE_LEADS_TABLE_ID: z.string().min(1).optional(),

  // Integrations - Google Sheets
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

  // Observability
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),

  // CORS
  CORS_ORIGINS: z.string().default('http://localhost:3001'),
});

/**
 * Models that accept `reasoning_effort`. Everything else REJECTS it with a 400.
 *
 * This is not a style preference — it is the difference between a working agent and a silent one.
 * agent.config.ts passes reasoningEffort whenever the env var is set, and the plugin forwards it
 * unconditionally. Send it to a non-reasoning model and OpenAI 400s the completion, which surfaces
 * as the agent simply never speaking again mid-call: no error the caller can hear, no error in the
 * report. We already burned a call on the mirror-image of this (`reasoning_effort: 'none'` is fine
 * on gpt-5.4 and rejected by gpt-5-mini — see VOICE_LLM_REASONING_EFFORT above).
 *
 * So the combination is refused at BOOT, where it is one line of output, rather than discovered
 * mid-conversation. Same reasoning as resolveTurnDetection() in agent.config.ts.
 */
const REASONING_MODEL_PREFIXES = ['gpt-5', 'o1', 'o3', 'o4'];

function supportsReasoningEffort(model: string): boolean {
  return REASONING_MODEL_PREFIXES.some((p) => model.startsWith(p));
}

export type Env = z.infer<typeof envSchema>;

/**
 * Every env var this app reads, by name.
 *
 * ADDITIVE, read-only, and derived from the schema so it can never drift from it. `.env.example`
 * is NOT this list — it documents ~110 of the keys and omits the rest, so anything that validates
 * "is this a real env key?" against the example file rejects perfectly good keys (measured:
 * `VOICE_TTS_SPEED` and `VOICE_TTS_VOLUME` are both absent from it). The voice A/B runner needs the
 * real answer, because a variant naming a key that does not exist applies cleanly to `process.env`
 * and then changes nothing — a silent no-op that produces two identical clips labelled A and B.
 */
export const ENV_KEYS: readonly string[] = Object.keys(envSchema.shape);

export function loadEnv(): Env {
  // Convert empty strings to undefined so optional fields don't fail validation
  const raw = Object.fromEntries(
    Object.entries(process.env).map(([k, v]) => [k, v === '' ? undefined : v]),
  );
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    for (const [key, errors] of Object.entries(result.error.flatten().fieldErrors)) {
      console.error(`  ${key}: ${errors?.join(', ')}`);
    }
    process.exit(1);
  }

  const env = result.data;

  /**
   * Warn, don't die. Without this, /auth/forgot-password creates a valid reset token and then
   * quietly declines to mail it — returning the same 204 it returns on success, because that
   * endpoint must not reveal whether an account exists. The result is a locked-out user with no
   * recovery path and no error anywhere. It stayed invisible in production until someone clicked
   * the button and waited for an email that was never attempted.
   */
  if (env.NODE_ENV === 'production' && !env.DASHBOARD_BASE_URL) {
    console.warn(
      '⚠️  DASHBOARD_BASE_URL is not set. Password-reset and invite emails cannot be sent: the ' +
        'tokens are created but no link is mailed, and forgot-password still answers 204. Users ' +
        'who forget their password will have no way back in.',
    );
  }

  // The voice LLM is whatever VOICE_LLM_MODEL says, falling back to AI_MODEL (agent.config.ts).
  const voiceModel = env.VOICE_LLM_MODEL ?? env.AI_MODEL;
  if (env.VOICE_LLM_REASONING_EFFORT && !supportsReasoningEffort(voiceModel)) {
    console.error('❌ Invalid environment variables:');
    console.error(
      `  VOICE_LLM_REASONING_EFFORT='${env.VOICE_LLM_REASONING_EFFORT}' is set, but the voice LLM ` +
        `is '${voiceModel}', which does not accept reasoning_effort.`,
    );
    console.error(
      '  OpenAI rejects that combination with a 400, and the agent goes SILENT mid-call with no ' +
        'audible error. Unset VOICE_LLM_REASONING_EFFORT, or use a gpt-5 / o-series model.',
    );
    process.exit(1);
  }

  return env;
}
