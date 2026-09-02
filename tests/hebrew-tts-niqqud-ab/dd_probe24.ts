/**
 * Round 24 — the DeepDub non-verbal tag matrix. §17 was a Cartesia finding; this is the same
 * question asked of the engine we are actually moving to.
 *
 * Every variant goes through the PRODUCTION adapter (deepdub.tts.ts), then straight into Soniox
 * over the phone band — one script, because the diagnosis needs both halves at once:
 *   duration delta vs baseline  -> did the tag ADD anything?
 *   Soniox transcript           -> was the tag SPOKEN (Latin or a stray word), or silent?
 * Plus the fact peculiar to DeepDub: it breathes NATIVELY, so even the baseline may carry breath
 * sound — the interesting outcome is a tag that adds a CONTROLLABLE non-verbal on top.
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/dd_probe24.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeLogger, tts as ttsBase } from '@livekit/agents';
import { loadEnv } from '../../src/config/env.js';
import { ensureLogger } from '../../src/modules/channels/voice-livekit/testing/speech.js';
import { toPhoneRate } from '../../src/modules/channels/voice-livekit/testing/wav.js';
import { measureStream } from '../../src/modules/channels/voice-livekit/stt/measure.js';
import { createSonioxSTT } from '../../src/modules/channels/voice-livekit/stt/soniox.stt.js';
import { DeepdubTTS, deepdubOptions } from '../../src/modules/channels/voice-livekit/tts/deepdub.tts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NIQQUD = /[֑-ׇ]/gu;

// The round-18 `pr` sentence — the same carrier probe21 used on Cartesia, for comparability.
const S1 = 'המחיר נקבע לפי כמה שיחות הסוכן מנהל בשבילךָ.';
const S2 = 'כמה פניות נכנסות אליךָ בחודש?';
const PLAIN = `${S1} ${S2}`;

const VARIANTS: Array<{ key: string; label: string; text: string }> = [
  { key: 'A', label: 'plain (baseline)', text: PLAIN },
  { key: 'B', label: '[breath] prefix', text: `[breath] ${PLAIN}` },
  { key: 'C', label: '[breathes] prefix', text: `[breathes] ${PLAIN}` },
  { key: 'D', label: '[sigh] prefix', text: `[sigh] ${PLAIN}` },
  { key: 'E', label: '[laughter] prefix', text: `[laughter] ${PLAIN}` },
  { key: 'F', label: '(breathes) prefix', text: `(breathes) ${PLAIN}` },
  { key: 'G', label: '[breathing] mid-reply', text: `${S1} [breathing] ${S2}` },
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
  ensureLogger();
  const env = loadEnv();
  const engine = new DeepdubTTS(deepdubOptions(env));
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

  await synth('חימום.');
  const results: Array<Record<string, unknown>> = [];
  let baseMs = 0;
  for (const v of VARIANTS) {
    const r = await synth(v.text);
    const out = join(HERE, `r24_${v.key}.wav`);
    writeFileSync(out, Buffer.concat([wavHeader(r.pcm.length, r.sr), r.pcm]));
    const ms = Math.round((r.pcm.length / 2 / r.sr) * 1000);
    if (v.key === 'A') baseMs = ms;

    // Soniox over the phone band, same path as every roundtrip.
    const pcm16 = new Int16Array(r.pcm.buffer, r.pcm.byteOffset, r.pcm.length / 2);
    const phone = toPhoneRate(pcm16, r.sr);
    const stt = createSonioxSTT(env);
    const m = await measureStream(stt, phone, 8000, { maxTrailingMs: 5000 });
    const heard = m.text.replace(NIQQUD, '');
    const latin = /[A-Za-z]/.test(heard);
    const delta = v.key === 'A' ? 0 : ms - baseMs;
    results.push({ key: v.key, label: v.label, text: v.text, file: `r24_${v.key}.wav`, ms,
                   delta_ms: delta, heard, latin });
    const flag = latin ? '  ⚠️ SPOKEN' : Math.abs(delta) >= 200 ? '  <-- rendered?' : '  inert?';
    console.log(`${v.key} ${v.label}: ${ms}ms (Δ${delta >= 0 ? '+' : ''}${delta})${v.key === 'A' ? '' : flag}`);
    console.log(`   heard="${heard}"`);
  }
  writeFileSync(join(HERE, 'probe24.json'),
    JSON.stringify({ sentence: PLAIN, results }, null, 2), 'utf-8');
  console.log('\nwrote probe24.json — durations + transcripts are evidence; anything rendered goes to an ear.');
  await engine.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
