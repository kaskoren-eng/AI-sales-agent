/**
 * Round 24 appendix — DeepDub's generation-duration noise floor on the probe sentence.
 *
 * probe24's tag variants came back with negative deltas up to -768ms; before "inert" is written
 * anywhere as a verdict, the same text has to be synthesized a few times so the spread of the
 * engine itself is known. (Cartesia's floor was 320-480ms — probe21_onset.py; DeepDub's has never
 * been measured here.)
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/dd_floor24.ts
 */
import { initializeLogger, tts as ttsBase } from '@livekit/agents';
import { loadEnv } from '../../src/config/env.js';
import { DeepdubTTS, deepdubOptions } from '../../src/modules/channels/voice-livekit/tts/deepdub.tts.js';

const PLAIN = 'המחיר נקבע לפי כמה שיחות הסוכן מנהל בשבילךָ. כמה פניות נכנסות אליךָ בחודש?';

async function main(): Promise<void> {
  initializeLogger({ pretty: false, level: 'warn' });
  const env = loadEnv();
  const engine = new DeepdubTTS(deepdubOptions(env));
  // THE ENGINE THE PROBE BUILT IS THE ENGINE THE FILE NAMES — asserted, not assumed. Three
  // broken instruments returned the comfortable answer today (a Buffer fed as Int16Array, an
  // EngineOverride key that silently vanished, a bench row nobody knew was the gateway); this
  // line makes the fourth impossible: a probe that is not actually on DeepDub refuses to run.
  if (!engine.model.startsWith('dd-')) {
    throw new Error(`probe built ${engine.model} — not the DeepDub engine this file names`);
  }


  async function synth(text: string): Promise<number> {
    const stream = engine.stream();
    let sr = engine.sampleRate;
    let bytes = 0;
    stream.pushText(text);
    stream.flush();
    stream.endInput();
    for await (const ev of stream) {
      if (ev === ttsBase.SynthesizeStream.END_OF_STREAM) break;
      sr = ev.frame.sampleRate;
      bytes += ev.frame.data.byteLength;
    }
    return Math.round((bytes / 2 / sr) * 1000);
  }

  await synth('חימום.');
  const reps: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const ms = await synth(PLAIN);
    reps.push(ms);
    console.log(`baseline rep${i}: ${ms}ms`);
  }
  console.log(`spread: ${Math.min(...reps)}-${Math.max(...reps)}ms (${Math.max(...reps) - Math.min(...reps)}ms) — probe24's A was 5802ms`);
  await engine.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
