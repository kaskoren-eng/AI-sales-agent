/**
 * End-to-end smoke for the DeepDub TTS adapter.
 *
 * Drives the REAL `DeepdubTTS.stream()` exactly the way the LiveKit agent does — push text, iterate
 * AudioFrames — and writes the result to a WAV. Proves the whole adapter path: connect, s16le
 * streaming, framing into AudioFrames. Also prints TTFB (first frame) and realtime factor.
 *
 *   npx tsx --env-file=.env scripts/deepdub-tts-smoke.ts ["Hebrew sentence"]
 */
import { writeFileSync } from 'node:fs';
import { initializeLogger, tts as ttsBase } from '@livekit/agents';
import { loadEnv } from '../src/config/env.js';
import { DeepdubTTS, deepdubOptions } from '../src/modules/channels/voice-livekit/tts/deepdub.tts.js';

function wavHeader(dataLen: number, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLen, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); // byte rate
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits
  h.write('data', 36);
  h.writeUInt32LE(dataLen, 40);
  return h;
}

async function main() {
  initializeLogger({ pretty: false, level: 'warn' });
  const env = loadEnv();
  const text = process.argv[2] ?? 'שלום, מדברת קרן מ-ClickScales. מה מספר הטלפון שלך? אשלח לך אישור.';
  const engine = new DeepdubTTS(deepdubOptions(env));
  console.log(`model=${engine.model} sampleRate=${engine.sampleRate} eu=${env.DEEPDUB_EU}`);

  // One synthesis through the FULL LiveKit tts interface. Returns TTFB + the PCM.
  async function synth(sentence: string): Promise<{ ttfb: number; total: number; pcm: Buffer; sr: number }> {
    const stream = engine.stream();
    const t0 = performance.now();
    let ttfb = 0;
    let sr = engine.sampleRate;
    const pcm: Buffer[] = [];
    stream.pushText(sentence);
    stream.flush();
    stream.endInput();
    for await (const ev of stream) {
      if (ev === ttsBase.SynthesizeStream.END_OF_STREAM) break;
      if (ttfb === 0) ttfb = performance.now() - t0;
      sr = ev.frame.sampleRate;
      const d = ev.frame.data;
      pcm.push(Buffer.from(d.buffer, d.byteOffset, d.byteLength));
    }
    return { ttfb, total: performance.now() - t0, pcm: Buffer.concat(pcm), sr };
  }

  // Turn 1 (COLD — includes the connect). Turn 2 (WARM — reuses the socket, = what production sees).
  const cold = await synth(text);
  const warm = await synth('מעולה. רק לוודא — קורן שטרית, נכון?');

  const out = 'tests/hebrew-tts-niqqud-ab/dd_smoke.wav';
  writeFileSync(out, Buffer.concat([wavHeader(cold.pcm.length, cold.sr), cold.pcm]));
  await engine.close();

  const ms = (n: number) => `${n.toFixed(0)}ms`;
  const audioMs = (b: Buffer, sr: number) => (b.length / 2 / sr) * 1000;
  console.log(`turn 1 (COLD): TTFB=${ms(cold.ttfb)} total=${ms(cold.total)} audio=${ms(audioMs(cold.pcm, cold.sr))}`);
  console.log(`turn 2 (WARM): TTFB=${ms(warm.ttfb)} total=${ms(warm.total)} audio=${ms(audioMs(warm.pcm, warm.sr))}  <- production-representative`);
  console.log(`wrote ${out}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e?.message ?? e);
  process.exit(1);
});
