/**
 * A one-clip-at-a-time TTS worker for the PYTHON listening rounds.
 *
 * WHY THIS EXISTS. `synth.py` spoke Cartesia over `curl`, because Cartesia's `/tts/bytes` is a
 * plain HTTP POST and that is a dozen lines of Python. DeepDub is not: it is a per-generation
 * WEBSOCKET protocol with a socket pool, a generation-id router, an idle-liveness timeout and an
 * `isFinished` terminal, all of which live in `tts/deepdub.tts.ts`. Reimplementing that in Python
 * would be a SECOND implementation of the protocol that decides what Koren hears — and a second
 * implementation drifts. So the Python rounds delegate here, and this file builds the engine
 * through production's own `buildTTS()`. Same reasoning as `testing/tts-engine.ts`, same rule:
 * a copy drifts, a call cannot.
 *
 * WHY A PERSISTENT WORKER AND NOT ONE PROCESS PER CLIP. DeepDub pays a real websocket connect on
 * the first generation. A round is 10-25 clips; paying that per clip turns a one-minute round into
 * several, and — worse — makes the first clip of every pair systematically slower than the second,
 * which is exactly the kind of artefact an A/B page must not have.
 *
 * PROTOCOL — one JSON object per line on stdin, one per line on stdout:
 *   in   {"text": "שלום.", "out": "C:\\...\\r24_a_A.wav"}
 *   out  {"ok": true, "bytes": 155596, "sampleRate": 48000, "audioMs": 1620}
 *   out  {"ok": false, "error": "..."}
 * Close stdin to shut it down. It never exits on a synthesis error — one bad line must not cost
 * the round every clip already rendered.
 *
 * The engine comes from `VOICE_TTS_PROVIDER` in `.env`, or from `--engine=` — a FLAG, not an env
 * var, because `loadEnv()` runs dotenv with `override: true`, so `VOICE_TTS_PROVIDER=x npx tsx ...`
 * is a silent no-op. Same trap, same answer, as `testing/tts-engine.ts`.
 *
 *   echo '{"text":"בדיקה.","out":"/tmp/x.wav"}' | npx tsx tests/hebrew-tts-niqqud-ab/tts_worker.ts
 */
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { initializeLogger, tts as ttsBase } from '@livekit/agents';
import { loadEnv } from '../../src/config/env.js';
import { buildTTS } from '../../src/modules/channels/voice-livekit/agent.config.js';

/** A 16-bit mono PCM WAV header with REAL lengths — never the 0xFFFFFFFF a streamer emits. */
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
  const base = loadEnv();
  const flag = process.argv.find((a) => a.startsWith('--engine='))?.slice('--engine='.length);
  if (flag && !['cartesia', 'deepdub', 'elevenlabs'].includes(flag)) {
    throw new Error(`--engine=${flag} is not a provider this build knows`);
  }
  // The caller's pin must reach `buildTTS`, not just the banner. Without this the Python side could
  // ask for DeepDub, be told "ready", and be handed Cartesia audio for the whole round — the exact
  // mislabelling this migration exists to end.
  const env = flag ? { ...base, VOICE_TTS_PROVIDER: flag as typeof base.VOICE_TTS_PROVIDER } : base;
  const engine = buildTTS(env);

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

  // The banner goes to STDERR so stdout stays a clean one-object-per-line channel. The Python side
  // prints it, so a round can never be judged without knowing which engine spoke it.
  process.stderr.write(
    `tts_worker ready: provider=${env.VOICE_TTS_PROVIDER} model=${engine.model} sampleRate=${engine.sampleRate}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ ready: true, provider: env.VOICE_TTS_PROVIDER, model: engine.model, sampleRate: engine.sampleRate })}\n`,
  );

  // Pays the websocket connect before the first REAL clip, so clip #1 is not systematically slower
  // than the rest of the round.
  try {
    await synth('חימום.');
  } catch {
    /* a failed warm-up is not fatal — the first real clip will report the error properly */
  }

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const req = JSON.parse(trimmed) as { text: string; out: string };
      const r = await synth(req.text);
      if (r.pcm.length === 0) throw new Error('engine returned no audio');
      writeFileSync(req.out, Buffer.concat([wavHeader(r.pcm.length, r.sr), r.pcm]));
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          bytes: r.pcm.length + 44,
          sampleRate: r.sr,
          audioMs: Math.round((r.pcm.length / 2 / r.sr) * 1000),
        })}\n`,
      );
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: (err as Error).message })}\n`);
    }
  }

  await engine.close();
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
