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

  // Lead intake webhooks
  META_APP_SECRET: z.string().min(1).optional(),
  LEAD_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Tenant that receives generic (non-Meta) webhook leads — prevents body spoofing
  LEAD_WEBHOOK_TENANT_ID: z.string().uuid().optional(),

  // App base URL (for callback URLs)
  BASE_URL: z.string().url().optional(),
  // Dashboard base URL — used to build "view this call" back-links pushed into the CRM (Workstream
  // B). Optional: if unset, the link is simply omitted from CRM notes (never a broken URL).
  DASHBOARD_BASE_URL: z.string().url().optional(),

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

  // Channels - Voice (Zadarma + Retell AI) — legacy engine, being replaced. See VOICE_MIGRATION_PLAN.md
  RETELL_API_KEY: z.string().min(1).optional(),
  RETELL_AGENT_ID: z.string().min(1).optional(),
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
  SONIOX_MAX_ENDPOINT_DELAY_MS: z.coerce.number().int().min(500).max(3000).default(500),
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
  VOICE_TTS_PROVIDER: z.enum(['cartesia', 'deepdub']).default('cartesia'),
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
  // Default engine for tenants with no explicit tenants.settings.voice_engine override
  VOICE_ENGINE_DEFAULT: z.enum(['retell', 'livekit']).default('retell'),
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
  // LiveKit SIP outbound trunk (dials leads through Zadarma). Created with `lk sip outbound
  // create`; the Zadarma SIP username/password live inside the trunk on LiveKit's side, not here.
  LIVEKIT_SIP_OUTBOUND_TRUNK_ID: z.string().min(1).optional(),

  // Scheduling (Google Calendar) — uses a service account; share the target calendar with the service account email
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

  // Integrations - Google Sheets
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

  // Observability
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),

  // CORS
  CORS_ORIGINS: z.string().default('http://localhost:3001'),
});

export type Env = z.infer<typeof envSchema>;

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
  return result.data;
}
