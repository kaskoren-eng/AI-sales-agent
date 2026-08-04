/**
 * Synthesize ONE Hebrew sentence and dump WAVs — A/B voices without booting the agent.
 *
 * Everything here already existed except the argument parsing: `synthesizeHebrew()` does the
 * websocket call the live agent makes, `toStudioWav`/`toPhoneWav` do the encoding, `isCleanTake`
 * catches Cartesia's Hebrew stutter. This wires them to a command line.
 *
 * WHY BOTH WAVS. The studio file is what the voice sounds like; the phone file is what the CALLER
 * hears. An 8kHz line strips the high frequencies that carry consonants, and Hebrew voices that
 * sound lovely at 24kHz can be unintelligible down a phone. Judge on `-phone.wav`. Always.
 *
 * Usage:
 *   npm run voice:sample -- --text "שלום, קבעתי לך פגישה ליום שלישי"
 *   npm run voice:sample -- --voice HE_VOICE_ID --emotion calm --speed 0.85 --volume 1.4
 *   npm run voice:sample -- --model sonic-3.5            # sonic-3 vs sonic-3.5 A/B
 *   npm run voice:sample -- --tenant <uuid>              # what will THIS tenant actually sound like?
 *
 * Invalid values fail HERE, before the first network call. That is the point: Cartesia answers a
 * bad parameter with an empty audio stream and a DEBUG log, so without this check the symptom is
 * a silent agent and no error anywhere.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { loadEnv } from '../../../../config/env.js';
import { createDatabase } from '../../../../db/client.js';
import { tenants } from '../../../../db/schema/index.js';
import {
  CARTESIA_EMOTIONS,
  assertAgentPersona,
  resolveAgentPersona,
  type TtsOverrides,
} from '../tts/tts-settings.js';
import { synthesizeHebrew } from './speech.js';
import { concatFrames, isCleanTake, toPhoneWav, toStudioWav } from './wav.js';

const OUT_DIR = 'voice-samples';

/** A booking confirmation: numbers, a time, sibilants — what a caller must get RIGHT. */
const DEFAULT_LINE = 'שלום, קבעתי לך פגישה ביום שלישי בשעה שתיים עשרה וחצי. אשלח אישור למייל שלך.';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function num(name: string): number | undefined {
  const raw = arg(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number, got '${raw}'`);
  return parsed;
}

const env = loadEnv();
const text = arg('text') ?? DEFAULT_LINE;
const model = arg('model') ?? env.CARTESIA_MODEL;
const tenantId = arg('tenant');

let overrides: TtsOverrides;
let label: string;

if (tenantId) {
  // The preflight: resolve through the EXACT code path a live call uses, so what you hear here is
  // what that tenant will actually hear — including which fields fell back to env and why.
  const { db, pool } = createDatabase(env.DATABASE_URL);
  const rows = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  await pool.end();
  if (rows.length === 0) throw new Error(`no tenant ${tenantId}`);

  const resolved = resolveAgentPersona(rows[0]!.settings, { ...env, CARTESIA_MODEL: model });
  overrides = resolved.overrides;
  label = `tenant-${tenantId.slice(0, 8)}`;
  console.log(`persona   name=${resolved.persona.name ?? '(unset)'} gender=${resolved.persona.gender ?? '(unset)'}`);
  console.log(`sources   ${JSON.stringify(resolved.sources)}`);
  for (const w of resolved.warnings) console.warn(`WARNING   ${w}`);
} else {
  // Validate exactly as the settings API would, so the CLI cannot smuggle in a value the write
  // path would reject — the harness and production must agree on what is legal.
  const persona = assertAgentPersona({
    tts: {
      ...(arg('voice') !== undefined ? { voiceId: arg('voice') } : {}),
      ...(arg('emotion') !== undefined ? { emotion: arg('emotion') } : {}),
      ...(num('speed') !== undefined ? { speed: num('speed') } : {}),
      ...(num('volume') !== undefined ? { volume: num('volume') } : {}),
    },
  });
  overrides = {
    ...(persona.tts.voiceId !== undefined ? { voice: persona.tts.voiceId } : {}),
    ...(persona.tts.emotion !== undefined ? { emotion: persona.tts.emotion } : {}),
    ...(persona.tts.speed !== undefined ? { speed: persona.tts.speed } : {}),
    ...(persona.tts.volume !== undefined ? { volume: persona.tts.volume } : {}),
  };
  label = 'sample';
}

const voice = overrides.voice ?? env.CARTESIA_VOICE_ID_PRIMARY;
if (!voice) {
  throw new Error('no voice: pass --voice <id> or set CARTESIA_VOICE_ID_PRIMARY (placeholder: HE_VOICE_ID)');
}
const speed = overrides.speed ?? env.VOICE_TTS_SPEED;
const volume = overrides.volume ?? env.VOICE_TTS_VOLUME;
const emotion = overrides.emotion;

console.log(`model=${model} voice=${voice.slice(0, 8)}… speed=${speed} volume=${volume} emotion=${emotion ?? '(none)'}`);
console.log(`text      ${text}\n`);

await mkdir(OUT_DIR, { recursive: true });

const startedAt = Date.now();
const frames = await synthesizeHebrew({ ...env, CARTESIA_MODEL: model }, text, {
  ...overrides,
  voice,
  speed,
  volume,
});
const synthMs = Date.now() - startedAt;

const { pcm, rate } = concatFrames(frames);
const durationSec = pcm.length / rate;

const slug = [label, model, voice.slice(0, 8), emotion ?? 'noemo', `s${speed}`, `v${volume}`]
  .join('-')
  .replace(/[^a-zA-Z0-9.-]/g, '_');
const studioPath = join(OUT_DIR, `${slug}-studio.wav`);
const phonePath = join(OUT_DIR, `${slug}-phone.wav`);
await writeFile(studioPath, toStudioWav(frames));
await writeFile(phonePath, toPhoneWav(frames));

console.log(`synth     ${synthMs}ms   audio ${durationSec.toFixed(2)}s @ ${rate}Hz`);
console.log(`studio    ${studioPath}`);
console.log(`phone     ${phonePath}   <- judge on this one`);

// Cartesia's Hebrew is NOT deterministic: the same sentence has come back at 2.9s / 4.1s / 4.5s /
// 7.1s, the long takes repeating the phrase with silence between. Without this check you would
// A/B two voices and actually be comparing one clean take against one stutter.
if (!isCleanTake(pcm, rate)) {
  console.warn('\nWARNING   long internal gap — likely a Cartesia stutter/repeat, not the voice. Re-run before judging.');
}

console.log(`\nemotions: ${CARTESIA_EMOTIONS.join(' | ')} (websocket generation_config accepts no others)`);
process.exit(0);
