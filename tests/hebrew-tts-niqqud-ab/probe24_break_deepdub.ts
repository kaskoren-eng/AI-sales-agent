/**
 * Probe 24 — does DeepDub honour `<break time="…"/>`, ignore it, or SPEAK it?
 *
 * Koren moved TTS from Cartesia to DeepDub on 2026-09-02. The pause feature
 * (`voice-mode.ts`) is Cartesia SSML: verified on Hebrew sonic-3.5 and nowhere else.
 * `pausesSupported()` now gates it off on any other engine, and the comment I shipped with that
 * gate says it "assumes the worst because the worst is a live-call defect". THIS FILE EXISTS TO
 * TURN THAT ASSUMPTION INTO A MEASUREMENT. A gate resting on a guess is a gate nobody can reason
 * about later.
 *
 * THREE OUTCOMES, AND THEY NEED TWO INSTRUMENTS TO TELL APART:
 *   honoured — clip grows by about the requested time, transcript unchanged. The lever survives
 *              the flip and rounds 17-18's three lengths need re-hearing, not re-inventing.
 *   ignored  — clip does not grow, transcript unchanged. The feature is inert on DeepDub: the
 *              gate costs nothing and loses nothing.
 *   SPOKEN   — transcript carries Latin or extra tokens. The gate is load-bearing and the flip
 *              would have put "break time zero point two five s" in front of a lead.
 * Duration alone cannot separate `honoured` from `spoken` — both lengthen the clip — so every
 * tagged variant is also read back through Soniox. That is the same pairing that settled the
 * Cartesia tag matrix in known-issues §17.
 *
 * ⚠️ REPEATS, NOT SINGLE CLIPS. `phase-4-known-issues.md` §9: Cartesia's take-to-take variation on
 * one Hebrew sentence is ~1.1×, and a lone clip that looks 8% longer is inside the noise. DeepDub's
 * own variation is UNMEASURED, which is why the baseline is synthesized three times and its spread
 * is printed before any delta is interpreted. If the spread swallows the deltas, this probe has
 * answered nothing and says so.
 *
 * Claimed: round/prefix 24, `r24_*`. Next free: 25.
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/probe24_break_deepdub.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeLogger, tts as ttsBase } from '@livekit/agents';
import { loadEnv } from '../../src/config/env.js';
import { DeepdubTTS, deepdubOptions } from '../../src/modules/channels/voice-livekit/tts/deepdub.tts.js';
import { createSonioxSTT } from '../../src/modules/channels/voice-livekit/stt/soniox.stt.js';
import { toPhoneRate } from '../../src/modules/channels/voice-livekit/testing/wav.js';
import { measureStream } from '../../src/modules/channels/voice-livekit/stt/measure.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NIQQUD = /[\u0591-\u05C7]/gu;

/** The tool's own calendar line — the sentence the pause was actually shipped on (round 18, `ca`). */
const SENTENCE = 'רגע, אני בודקת את היומן.';
const TAGGED = (s: string): string => `רגע <break time="${s}s"/> אני בודקת את היומן.`;

const TAKES: Array<{ id: string; text: string; readBack: boolean }> = [
  { id: 'base1', text: SENTENCE, readBack: false },
  { id: 'base2', text: SENTENCE, readBack: false },
  { id: 'base3', text: SENTENCE, readBack: true },
  { id: 'b015', text: TAGGED('0.15'), readBack: true },
  { id: 'b025a', text: TAGGED('0.25'), readBack: true },
  { id: 'b025b', text: TAGGED('0.25'), readBack: false },
  { id: 'b035', text: TAGGED('0.35'), readBack: true },
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
  console.log(`engine=deepdub model=${engine.model} sampleRate=${engine.sampleRate}\n`);

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

  const rows: Array<{ id: string; ms: number; heard?: string }> = [];
  for (const t of TAKES) {
    const { pcm, sr } = await synth(t.text);
    const ms = Math.round((pcm.length / 2 / sr) * 1000);
    const file = join(HERE, `r24_${t.id}.wav`);
    writeFileSync(file, Buffer.concat([wavHeader(pcm.length, sr), pcm]));
    const row: { id: string; ms: number; heard?: string } = { id: t.id, ms };
    if (t.readBack) {
      const stt = createSonioxSTT(env);
      // Buffer is a Uint8Array: handing it straight to toPhoneRate resamples BYTES as samples and
      // Soniox hears noise, which reads as "the tag was silent" rather than as a broken instrument.
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
      const m = await measureStream(stt, toPhoneRate(samples, sr), 8000, { maxTrailingMs: 5000 });
      row.heard = m.text.replace(NIQQUD, '');
    }
    rows.push(row);
    const latin = row.heard && /[A-Za-z]/.test(row.heard) ? '  ⚠️ LATIN — TAG WAS SPOKEN' : '';
    console.log(`${t.id.padEnd(7)} ${String(ms).padStart(5)}ms  ${row.heard ?? ''}${latin}`);
  }

  const base = rows.filter((r) => r.id.startsWith('base')).map((r) => r.ms);
  const spread = Math.max(...base) - Math.min(...base);
  const median = base.slice().sort((a, b) => a - b)[Math.floor(base.length / 2)]!;
  console.log(`\nbaseline ${base.join(' / ')}ms   spread ${spread}ms   median ${median}ms`);
  for (const r of rows.filter((x) => x.id.startsWith('b0'))) {
    const d = r.ms - median;
    const verdict = Math.abs(d) <= spread ? 'inside the noise' : `+${d}ms over baseline`;
    console.log(`  ${r.id.padEnd(7)} ${verdict}`);
  }
  console.log(
    '\nRead this with §9 in hand: a delta smaller than the baseline spread is not a delta.\n' +
      'Latin in ANY transcript means the tag is spoken and the gate in voice-mode.ts is load-bearing.',
  );
  writeFileSync(join(HERE, 'probe24.json'), JSON.stringify({ rows, base, spread, median }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
