/**
 * Generator for the static system-announcement WAVs the agent plays.
 *
 * WHY STATIC FILES AND NOT session.say(): product decision (2026-07-17). These are system
 * announcements, not Keren speaking — they use a DIFFERENT, flat, broadcast-style voice ("Noam -
 * Broadcaster") so they read as the system talking and the agent's own voice stays warm and
 * untouched. Static assets also mean zero TTS latency and zero variation: provably the same
 * sentence every time.
 *
 * `not-in-service` matters more than it looks. It plays when an inbound call reaches a number we
 * cannot attribute to a tenant. The alternative to having it is answering that call as SOMEBODY
 * ELSE'S agent, which is the cross-tenant leak the DID routing work exists to close — so the audio
 * is the polite half of a refusal that happens whether or not the file exists.
 *
 * Re-run only when the wording or voice changes. Needs CARTESIA_API_KEY in .env:
 *   node scripts/generate-system-announcements.mjs            # all of them
 *   node scripts/generate-system-announcements.mjs not-in-service
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Cartesia "Noam - Broadcaster" — clear, authoritative, unmistakably not the agent. */
const SYSTEM_VOICE_ID = '3e32f3c5-9ac0-4192-9994-87fdb277120f';

const ANNOUNCEMENTS = {
  /** Israeli Wiretapping Law (1979) §2 — every party must be told the call is recorded. */
  'recording-notice': 'שיחה זו מוקלטת לצורכי בקרת איכות.',
  /**
   * Played to a caller who dialled a number that is not assigned to an active customer.
   *
   * Deliberately says nothing about who we are or why: the caller is not our customer's lead, the
   * number may be in the unassigned pool, and naming a company to a stranger who dialled a number
   * we cannot place is exactly the confusion this is meant to avoid.
   */
  'not-in-service': 'המספר שחייגתם אינו פעיל כרגע. אנא בדקו את המספר ונסו שוב. תודה.',
};

function env(name) {
  const line = readFileSync(join(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} missing from .env`);
  return line.slice(name.length + 1).trim();
}

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(ANNOUNCEMENTS);

for (const name of names) {
  const text = ANNOUNCEMENTS[name];
  if (!text) {
    throw new Error(`unknown announcement "${name}" — known: ${Object.keys(ANNOUNCEMENTS).join(', ')}`);
  }

  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': env('CARTESIA_API_KEY'),
      'Cartesia-Version': '2025-04-16',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: 'sonic-3',
      transcript: text,
      voice: { mode: 'id', id: SYSTEM_VOICE_ID },
      language: 'he',
      // Mono pcm_s16le — `compliance/recording-notice.ts` parses RIFF by hand and rejects stereo.
      output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 },
    }),
  });
  if (!res.ok) throw new Error(`cartesia ${res.status}: ${await res.text()}`);

  const wav = Buffer.from(await res.arrayBuffer());
  mkdirSync(join(ROOT, 'assets'), { recursive: true });
  const out = join(ROOT, 'assets', `${name}.wav`);
  writeFileSync(out, wav);
  console.log(`wrote ${out} (${wav.length} bytes) — "${text}"`);
}
