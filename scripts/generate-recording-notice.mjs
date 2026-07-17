/**
 * One-time generator for assets/recording-notice.wav — the recorded-call notice pre-roll.
 *
 * WHY A STATIC FILE AND NOT session.say(): product decision (2026-07-17). The legal notice is
 * deliberately spoken by a DIFFERENT, flat, broadcast-style voice — Cartesia's "Noam -
 * Broadcaster" — so it reads as a system announcement, and Keren's human greeting stays warm and
 * untouched. A static asset also means zero TTS latency and zero variation: the exact same
 * compliant sentence on every call, provably.
 *
 * Re-run only if the wording or voice changes:
 *   node scripts/generate-recording-notice.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Israeli Wiretapping Law (1979) §2 — every party must be told the call is recorded. */
const NOTICE_TEXT = 'שיחה זו מוקלטת לצורכי בקרת איכות.';

/** Cartesia "Noam - Broadcaster" — clear, authoritative, unmistakably not Keren. */
const NOTICE_VOICE_ID = '3e32f3c5-9ac0-4192-9994-87fdb277120f';

function env(name) {
  const line = readFileSync(join(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} missing from .env`);
  return line.slice(name.length + 1).trim();
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
    transcript: NOTICE_TEXT,
    voice: { mode: 'id', id: NOTICE_VOICE_ID },
    language: 'he',
    output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 },
  }),
});
if (!res.ok) throw new Error(`cartesia ${res.status}: ${await res.text()}`);

const wav = Buffer.from(await res.arrayBuffer());
mkdirSync(join(ROOT, 'assets'), { recursive: true });
const out = join(ROOT, 'assets', 'recording-notice.wav');
writeFileSync(out, wav);
console.log(`wrote ${out} (${wav.length} bytes) — "${NOTICE_TEXT}" voice=Noam/Broadcaster`);
