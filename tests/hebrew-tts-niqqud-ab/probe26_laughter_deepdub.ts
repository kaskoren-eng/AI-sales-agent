/**
 * Probe 26 — can DeepDub laugh at all, and by what route?
 *
 * Koren asked directly (2026-09-02): "תבדוק אם יש אופציית צחוק בדיפדאב". Context: `[laughter]`
 * was the ONE tag that produced a real laugh on Cartesia — the single positive row in that whole
 * matrix — and he BANNED it by ear in round 4b. The parallel non-verbal probe found it does not
 * laugh on DeepDub at all, so the one thing that worked does not survive the engine change.
 *
 * FOUR ROUTES, and they are not variations on one idea — they are different mechanisms:
 *   tag    `[laughter]` — the Cartesia route. Control. Expected inert here.
 *   emoji  the SDK exposes `acceptEmojis` on its stream params (`@deepdub/node` index.d.ts:55)
 *          and NOTHING in this repo has ever set it. A vendor does not add that flag unless
 *          emoji mean something to the model. Most promising route, and the only one with
 *          documentation behind it.
 *   hebrew orthographic laughter. Hebrew speakers WRITE this, so a Hebrew-trained model may have
 *          learned to voice it, and unlike a tag it is real text that cannot be "unparsed markup".
 *   —      (a fifth route exists and is not probed: `performanceReferencePromptId`, driving
 *          delivery from a reference recording. That is a feature, not a probe.)
 *
 * WHAT THIS CAN AND CANNOT SETTLE. It can tell you that something extra was rendered (duration,
 * against three baseline takes) and whether the cue was SPOKEN rather than performed (Soniox).
 * **It cannot tell you whether the result sounds like a laugh or like a cough.** Only Koren's ear
 * does that, and §17's history says so twice: `[laughter]` on Cartesia rendered a real laugh by
 * every measurement and he rejected it anyway. A positive here earns a listening page, not a
 * feature.
 *
 * ⚠️ EMOJI CARRY THEIR OWN RISK. If the model does not accept them it may READ them — "face with
 * tears of joy" inside a Hebrew sentence — which is §18's failure with a different mouth. Worth
 * knowing either way, because emoji reach her text from the LLM, not only from us.
 *
 * Claimed: round/prefix 26, `r26_*`.
 *
 *   npx tsx tests/hebrew-tts-niqqud-ab/probe26_laughter_deepdub.ts
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
const NIQQUD = /[֑-ׇ]/gu;

/** A real laugh spot in a sales call: he has just said something light, she answers warmly. */
const TAIL = 'זאת שאלה טובה, אני אסביר.';
const JOY = '\u{1F602}';
const SMILE = '\u{1F642}';

const TAKES: Array<{ id: string; text: string; readBack: boolean; note: string }> = [
  { id: 'base1', text: TAIL, readBack: false, note: 'baseline' },
  { id: 'base2', text: TAIL, readBack: false, note: 'baseline' },
  { id: 'base3', text: TAIL, readBack: true, note: 'baseline' },
  { id: 'tag', text: `[laughter] ${TAIL}`, readBack: true, note: 'Cartesia route, control' },
  { id: 'emo1', text: `${JOY} ${TAIL}`, readBack: true, note: 'emoji, leading' },
  { id: 'emo2', text: `זאת שאלה טובה ${SMILE} אני אסביר.`, readBack: true, note: 'emoji, medial' },
  { id: 'heb1', text: `חחח, ${TAIL}`, readBack: true, note: 'orthographic laughter' },
  { id: 'heb2', text: `הא הא, ${TAIL}`, readBack: true, note: 'orthographic laughter' },
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

  const rows: Array<{ id: string; note: string; ms: number; heard?: string }> = [];
  for (const t of TAKES) {
    let pcm: Buffer;
    let sr: number;
    try {
      ({ pcm, sr } = await synth(t.text));
    } catch (e) {
      console.log(`${t.id.padEnd(6)} ERROR  ${(e as Error).message}`);
      rows.push({ id: t.id, note: t.note, ms: -1, heard: `ERROR: ${(e as Error).message}` });
      continue;
    }
    const ms = Math.round((pcm.length / 2 / sr) * 1000);
    writeFileSync(join(HERE, `r26_${t.id}.wav`), Buffer.concat([wavHeader(pcm.length, sr), pcm]));
    const row: { id: string; note: string; ms: number; heard?: string } = { id: t.id, note: t.note, ms };
    if (t.readBack) {
      // Buffer is a Uint8Array — the Int16Array view is not optional. Handing the Buffer straight
      // to toPhoneRate resamples BYTES as samples, Soniox hears noise, and an empty transcript
      // reads as "the cue was silent", which is the comfortable answer. See testing/README.md.
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
      const stt = createSonioxSTT(env);
      const m = await measureStream(stt, toPhoneRate(samples, sr), 8000, { maxTrailingMs: 5000 });
      row.heard = m.text.replace(NIQQUD, '');
    }
    rows.push(row);
    const flag = row.heard && /[A-Za-z]/.test(row.heard) ? '  ** LATIN — CUE WAS SPOKEN' : '';
    console.log(`${t.id.padEnd(6)} ${String(ms).padStart(5)}ms  ${row.heard ?? ''}${flag}`);
  }

  const base = rows.filter((r) => r.id.startsWith('base') && r.ms > 0).map((r) => r.ms);
  const spread = Math.max(...base) - Math.min(...base);
  const median = base.slice().sort((a, b) => a - b)[Math.floor(base.length / 2)]!;
  console.log(`\nbaseline ${base.join(' / ')}ms   spread ${spread}ms   median ${median}ms\n`);
  for (const r of rows.filter((x) => !x.id.startsWith('base') && x.ms > 0)) {
    const d = r.ms - median;
    const spoken = r.heard != null && /[A-Za-z]/.test(r.heard);
    const verdict = spoken
      ? 'SPOKEN — the cue reached the caller as words'
      : Math.abs(d) <= spread
        ? 'inert — nothing rendered beyond the noise floor'
        : `${d > 0 ? '+' : ''}${d}ms of NON-LEXICAL audio — candidate, needs his ear`;
    console.log(`  ${r.id.padEnd(6)} ${r.note.padEnd(24)} ${verdict}`);
  }
  console.log('\nA candidate is not a laugh. Only his ear decides that — [laughter] on Cartesia');
  console.log('measured as a real laugh and he rejected it anyway (round 4b).');
  writeFileSync(join(HERE, 'probe26.json'), JSON.stringify({ rows, base, spread, median }, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
