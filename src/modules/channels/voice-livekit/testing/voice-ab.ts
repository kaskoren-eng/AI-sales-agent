/**
 * Voice A/B for Hebrew, judged the way the caller actually hears it.
 *
 * Synthesizes the same Hebrew line with every configured voice and writes TWO files per voice:
 *   *-studio.wav — the raw engine output (what a browser demo sounds like)
 *   *-phone.wav  — the same audio band-limited and resampled to 8kHz (what a PHONE sounds like)
 *
 * Judge on the -phone files. A phone call is 8kHz narrowband end to end — the mobile leg is
 * already 8kHz before LiveKit sees it, so no codec change on our side can make it hi-fi. The only
 * question that matters is which voice stays INTELLIGIBLE once it's crushed to 8kHz, and voices
 * differ wildly on that. Choosing a voice on studio audio is how you end up with a call the
 * customer can't follow.
 *
 * THE ENGINE FOLLOWS `VOICE_TTS_PROVIDER`, and every filename carries it. Until 2026-09-02 this
 * script hard-coded Cartesia, which was invisible right up until the day production stopped being
 * Cartesia — at which point it would have gone on producing Cartesia clips for a DeepDub agent
 * with nothing on the file or the console to say so.
 *
 * Usage:
 *   npm run voice:ab                          the configured engine
 *   npm run voice:ab -- sonic-3.5             a different model on the configured engine
 *   npm run voice:ab -- --engine=deepdub      the other engine, to compare
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnv } from '../../../../config/env.js';
import { HarnessVoice, describeEngine, engineBanner, parseEngineFlags } from './tts-engine.js';
import { concatFrames, toPhoneWav, toStudioWav } from './wav.js';

const env = loadEnv();

// NOTE: loadEnv() runs dotenv with { override: true }, so .env WINS over the shell environment.
// `CARTESIA_MODEL=sonic-turbo npm run voice:ab` therefore does nothing. Take everything as an
// ARGUMENT instead: `npm run voice:ab -- sonic-turbo`, `npm run voice:ab -- --engine=deepdub`.
const argv = process.argv.slice(2);
const flags = parseEngineFlags(argv);
const positional = argv.filter((a) => !a.startsWith('--'));
const modelArg = positional[0];
const override = { ...flags, ...(modelArg ? { model: modelArg } : {}) };

/** Deliberately contains the sounds Hebrew narrowband mangles: sibilants, gutturals, numbers. */
const LINE =
  'שלום, הגעת ל-ClickScales. אשמח לקבוע לך שיחת היכרות ביום שלישי בשעה שתיים עשרה וחצי. מה שם המשפחה שלך?';

const OUT_DIR = 'voice-samples';

/**
 * The voices to compare.
 *
 * A LIST OF VOICE IDS IS A CARTESIA-SHAPED IDEA. `CARTESIA_VOICE_ID_{PRIMARY,SECONDARY,TERTIARY}`
 * exist because Cartesia's catalogue was the thing being shopped. DeepDub and ElevenLabs each
 * carry ONE configured voice here, so on those engines this script degrades to "render the
 * configured voice at 8kHz" — still the useful half — and says so rather than pretending to be a
 * comparison. To compare voices on those engines, pass `--voice=<id>` per run.
 */
const base = describeEngine(env, override);
const voices =
  base.provider === 'cartesia'
    ? ([
        { label: 'primary', id: env.CARTESIA_VOICE_ID_PRIMARY },
        { label: 'secondary', id: env.CARTESIA_VOICE_ID_SECONDARY },
        { label: 'tertiary', id: env.CARTESIA_VOICE_ID_TERTIARY },
      ] as Array<{ label: string; id: string | undefined }>).filter(
        (v): v is { label: string; id: string } => Boolean(v.id),
      )
    : base.voice
      ? [{ label: 'configured', id: base.voice }]
      : [];

if (voices.length === 0) {
  console.error(
    base.provider === 'cartesia'
      ? 'No CARTESIA_VOICE_ID_* set in .env'
      : `No voice configured for ${base.provider} — set ` +
          `${base.provider === 'deepdub' ? 'DEEPDUB_VOICE_PROMPT_ID' : 'ELEVENLABS_VOICE_ID'}, ` +
          `or pass --voice=<id>.`,
  );
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });
console.log(engineBanner(base));
console.log(`\nSynthesizing ${voices.length} voice(s)\n`);
if (voices.length === 1 && base.provider !== 'cartesia') {
  console.log(
    `  (one voice only — a voice LIST is a Cartesia concept. Re-run with --voice=<id> to compare\n` +
      `   another ${base.provider} voice against this one.)\n`,
  );
}

for (const v of voices) {
  const voice = new HarnessVoice(env, { ...override, voice: v.id });
  const t0 = Date.now();
  try {
    const frames = await voice.say(LINE);
    const { pcm, rate } = concatFrames(frames);

    // THE ENGINE IS IN THE FILENAME. A WAV that outlives its console output — and they all do,
    // they sit in voice-samples/ for weeks — has to say what made it, or a later listen credits
    // the wrong engine with what it hears.
    const stem = `${v.label}-${voice.engine.slug}`;
    const studioPath = join(OUT_DIR, `${stem}-studio.wav`);
    const phonePath = join(OUT_DIR, `${stem}-phone.wav`);
    await writeFile(studioPath, toStudioWav(frames));
    await writeFile(phonePath, toPhoneWav(frames));

    console.log(
      `${v.label.padEnd(10)} ${(pcm.length / rate).toFixed(1)}s audio @${rate}Hz, synth ${Date.now() - t0}ms` +
        `   [${voice.engine.label}]`,
    );
    console.log(`  phone (JUDGE THIS): ${phonePath}`);
    console.log(`  studio            : ${studioPath}`);
  } finally {
    await voice.close();
  }
}

console.log('\nListen to the -phone files. That is what the caller hears.');
if (base.leverNote) console.log(`⚠ ${base.leverNote}`);
process.exit(0);
