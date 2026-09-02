/**
 * Round 23 — DeepDub screening: does everything tuned by ear on CARTESIA survive the new engine?
 *
 * Every PRONUNCIATION_FIXES row and the gendered address pointing was a verdict on Cartesia
 * clips. DeepDub is a different model with different niqqud handling — a fix that saved a word
 * on Cartesia may do nothing here, or actively break it. Each card is the SAME sentence twice:
 *   A — pointed, exactly what the guard emits today (the fixes ON)
 *   B — plain, what the model writes before any fix (the fixes OFF)
 * If B is right on its own, the fix is dead weight on DeepDub. If A is wrong, the fix is HARMFUL
 * there and the guard needs a provider condition before any flip.
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/dd_synth23.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeLogger, tts as ttsBase } from '@livekit/agents';
import { loadEnv } from '../../src/config/env.js';
import { DeepdubTTS, deepdubOptions } from '../../src/modules/channels/voice-livekit/tts/deepdub.tts.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** [cardId, pointed (fixes ON — today's guard output), plain (fixes OFF)] */
const PAIRS: Array<{ id: string; a: string; b: string }> = [
  // Gendered address + מספר-the-noun (rounds 3/20 verdicts on Cartesia).
  { id: 'sl', a: 'מה מִסְפָּר הטלפון שלךָ?', b: 'מה מספר הטלפון שלך?' },
  // נוח — the word that closes every call (round 15 n1=B: holam + patach).
  { id: 'nh', a: 'נוֹחַ לךָ מחר בבוקר?', b: 'נוח לך מחר בבוקר?' },
  // לידים — the loanword Cartesia read as the preposition (round 15 l2=B).
  { id: 'ld', a: 'כמה לִידִים נכנסים אליךָ בשבוע?', b: 'כמה לידים נכנסים אליך בשבוע?' },
  // דמו — unpointed can be read "his blood" (round 20 d2=C on Cartesia).
  { id: 'dm', a: 'אפשר לקבוע דֶמוֹ קצר עם קורן.', b: 'אפשר לקבוע דמו קצר עם קורן.' },
  // The thinking filler (round 10 verdict was the pointed spelling, on Cartesia).
  { id: 'fl', a: 'אֶממ... זה תלוי בכמה שיחות.', b: 'אממ... זה תלוי בכמה שיחות.' },
];

function wavHeader(dataLen: number, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLen, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataLen, 40);
  return h;
}

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

  console.log(`model=${engine.model} sampleRate=${engine.sampleRate}`);

  async function synth(text: string): Promise<{ pcm: Buffer; sr: number }> {
    const stream = engine.stream();
    let sr = engine.sampleRate;
    const pcm: Buffer[] = [];
    stream.pushText(text);
    stream.flush();
    stream.endInput();
    for await (const ev of stream) {
      if (ev === ttsBase.SynthesizeStream.END_OF_STREAM) break;
      sr = ev.frame.sampleRate;
      const d = ev.frame.data;
      pcm.push(Buffer.from(d.buffer, d.byteOffset, d.byteLength));
    }
    return { pcm: Buffer.concat(pcm), sr };
  }

  await synth('חימום.'); // pays the connect
  for (const p of PAIRS) {
    for (const [key, text] of [['A', p.a], ['B', p.b]] as const) {
      const r = await synth(text);
      const out = join(HERE, `r23_${p.id}_${key}.wav`);
      writeFileSync(out, Buffer.concat([wavHeader(r.pcm.length, r.sr), r.pcm]));
      const audioMs = Math.round((r.pcm.length / 2 / r.sr) * 1000);
      console.log(`r23_${p.id}_${key}.wav  audio=${audioMs}ms`);
    }
  }
  await engine.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
