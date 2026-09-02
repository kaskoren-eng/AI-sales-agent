/**
 * Round 22 — DeepDub half of the engine head-to-head.
 *
 * Synthesizes the round-22 sentences through the REAL DeepdubTTS adapter (the exact path
 * production would use with VOICE_TTS_PROVIDER=deepdub): stream() per sentence, 48kHz headerless
 * PCM framed to AudioFrames, written here as proper WAVs (real RIFF headers — the round-7 lesson).
 * Prints warm TTFB per sentence, because the engine decision is latency as much as sound.
 *
 * The first synthesis is a throwaway warm-up: its TTFB carries the websocket connect, which
 * production pays once per session, not per turn.
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/dd_synth22.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeLogger, tts as ttsBase } from '@livekit/agents';
import { loadEnv } from '../../src/config/env.js';
import { DeepdubTTS, deepdubOptions } from '../../src/modules/channels/voice-livekit/tts/deepdub.tts.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Same sentences as the Cartesia side of round 22 — the live prompt's own lines. */
const SENTENCES: Array<{ id: string; text: string }> = [
  { id: 'pr', text: 'המחיר נקבע לפי כמה שיחות הסוכן מנהל בשבילךָ. כמה פניות נכנסות אליךָ בחודש?' },
  { id: 'em', text: 'אני מבינה. זה באמת מתסכל.' },
  { id: 'ca', text: 'רגע, אני בודקת את היומן.' },
  { id: 'bk', text: 'קבעתי לךָ פגישה ליום שלישי בשתיים וחצי.' },
  { id: 'ng', text: 'שלום, מדברת קרן, העוזרת הדיגיטלית של ClickScales.' },
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

  async function synth(text: string): Promise<{ ttfb: number; pcm: Buffer; sr: number }> {
    const stream = engine.stream();
    const t0 = performance.now();
    let ttfb = 0;
    let sr = engine.sampleRate;
    const pcm: Buffer[] = [];
    stream.pushText(text);
    stream.flush();
    stream.endInput();
    for await (const ev of stream) {
      if (ev === ttsBase.SynthesizeStream.END_OF_STREAM) break;
      if (ttfb === 0) ttfb = performance.now() - t0;
      sr = ev.frame.sampleRate;
      const d = ev.frame.data;
      pcm.push(Buffer.from(d.buffer, d.byteOffset, d.byteLength));
    }
    return { ttfb, pcm: Buffer.concat(pcm), sr };
  }

  await synth('חימום.'); // throwaway — pays the connect
  for (const s of SENTENCES) {
    const r = await synth(s.text);
    const out = join(HERE, `r22_${s.id}_dd.wav`);
    writeFileSync(out, Buffer.concat([wavHeader(r.pcm.length, r.sr), r.pcm]));
    const audioMs = Math.round((r.pcm.length / 2 / r.sr) * 1000);
    console.log(`r22_${s.id}_dd.wav  warm TTFB=${r.ttfb.toFixed(0)}ms  audio=${audioMs}ms`);
  }
  await engine.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
