import { z } from 'zod';
import { config } from 'dotenv';

// Always load .env with override=true so .env values win over inherited shell env vars
config({ override: true });

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
  // Agent spoken language (ISO 639-1) — drives both STT and TTS
  VOICE_LANGUAGE: z.string().default('he'),
  // End-of-turn tuning — THE latency lever for Hebrew, since no Hebrew EOT model exists.
  // The two delays stack: end-of-turn ≈ max(Silero silence, minDelay).
  // Was 550/500 (measured 1200-1443ms end-of-turn). Now 250/200, which measured 955-1569ms
  // with ZERO cut-offs across baseline / short-answer / hesitation scenarios.
  // Caveat: those were SYNTHETIC pauses, which are shorter than a real person's. If the agent
  // starts talking over live callers, raise these first. Sweep with `npm run voice:test`.
  VOICE_VAD_MIN_SILENCE_MS: z.coerce.number().int().positive().default(250),
  VOICE_ENDPOINTING_MIN_DELAY_MS: z.coerce.number().int().positive().default(200),
  VOICE_ENDPOINTING_MAX_DELAY_MS: z.coerce.number().int().positive().default(2000),
  // Run TTS on the draft reply before the turn is confirmed, so Cartesia's ~390ms doesn't land
  // on top of the endpointing wait. Costs Cartesia characters on drafts we discard.
  VOICE_PREEMPTIVE_TTS: z.coerce.boolean().default(false),
  // Default engine for tenants with no explicit tenants.settings.voice_engine override
  VOICE_ENGINE_DEFAULT: z.enum(['retell', 'livekit']).default('retell'),
  // LiveKit SIP outbound trunk (dials leads through Zadarma). Created with `lk sip outbound
  // create`; the Zadarma SIP username/password live inside the trunk on LiveKit's side, not here.
  LIVEKIT_SIP_OUTBOUND_TRUNK_ID: z.string().min(1).optional(),

  // Scheduling (Google Calendar) — uses a service account; share the target calendar with the service account email
  GOOGLE_CALENDAR_ID: z.string().min(1).optional(),
  GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL: z.string().email().optional(),
  // PEM private key — store with literal \n, the provider will unescape them
  GOOGLE_CALENDAR_PRIVATE_KEY: z.string().min(1).optional(),
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
