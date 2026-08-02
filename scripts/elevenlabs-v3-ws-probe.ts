/**
 * Does ANY form of ElevenLabs v3 render over the standalone TTS WEBSOCKET?
 *
 * WHY THIS EXISTS
 * ---------------
 * ElevenLabs' docs say, twice and by name, that `eleven_v3` is not available on the TTS websocket
 * (`/stream-input`, and "multi-context WebSockets are not available for the eleven_v3 model").
 * Our own worklog agrees: v3 403s the handshake, so the shipped v3 arm runs over HTTP — ~840ms
 * TTS TTFB, ~2.2s worst case, which FAILS the hard <1s requirement.
 *
 * But the docs never enumerate the models the websocket DOES accept — they only exclude
 * `eleven_v3`. And there is a second, newer model: `eleven_v3_conversational`, "an ultra-low-latency
 * version of Eleven v3, optimized for live, back-and-forth dialogue" (added Feb 2026). It is
 * documented as an ElevenAgents-only TTS model, delivered over the convai websocket — not the TTS
 * one. Nobody here has actually tried it against `/stream-input`. If it connects, we get v3-quality
 * Hebrew over a websocket with NO code change: two env values on the provider we already built.
 *
 * So: ask the server, don't argue with the docs.
 *
 * WHY RAW `ws` AND NOT THE LIVEKIT PLUGIN
 * ---------------------------------------
 * `@livekit/agents-plugin-elevenlabs` appends `auto_mode` and `sync_alignment` to the ws URL, and
 * those params ALONE cause a 403 on quality models (that is how we lost time last round). Driving
 * the socket directly is the only way to tell "the model is refused" apart from "the handshake
 * params are refused" — so handshake params are their own axis of the matrix below.
 *
 * WHY THERE IS A CONTROL ROW
 * --------------------------
 * `eleven_flash_v2_5` is known to work on this websocket. If the control cell fails, the harness or
 * the key is wrong and the run says NOTHING about v3. A bench that can only produce failures will
 * happily "prove" whatever you already believed.
 *
 * Run:  npx tsx scripts/elevenlabs-v3-ws-probe.ts
 * Cost: a few cents of credits. Places no call, deploys nothing, changes no shipped config.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { encodeWav, toPhoneRate } from '../src/modules/channels/voice-livekit/testing/wav.js';

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

const OUT_DIR = join(process.cwd(), 'el-ws-probe');

/** One short Hebrew sentence — the qualifying line Keren actually opens with. */
const HEBREW = 'שלום, מדברת קרן מקליקסקיילס. יש לך דקה לדבר על הפניות שנכנסו אליך השבוע?';

const VOICES = [
  // The Voice-Design "generated" voice that only renders correctly on v3 — the whole point.
  { id: 'rvWcnzLKiWMjusauPtAj', label: 'KEREN (Voice-Design)' },
  // Stock multilingual voice. Separates "this MODEL is refused" from "this VOICE is refused".
  { id: 'XB0fDUnXU5powFXDhCwa', label: 'Charlotte (stock)' },
];

const MODELS = [
  { id: 'eleven_v3_conversational', label: 'v3-conversational', isTarget: true },
  { id: 'eleven_v3', label: 'v3', isTarget: true },
  { id: 'eleven_flash_v2_5', label: 'flash-v2.5 (CONTROL)', isTarget: false },
];

const ENDPOINTS = [
  { path: 'stream-input', multi: false },
  { path: 'multi-stream-input', multi: true },
];

/** The plugin's defaults vs a bare handshake — the known 403 lever. */
const HANDSHAKES = [
  { label: 'bare', params: {} as Record<string, string> },
  { label: 'auto+sync', params: { auto_mode: 'true', sync_alignment: 'true' } },
];

const OUTPUT_FORMAT = 'pcm_22050';
const SAMPLE_RATE = 22_050;
const CELL_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------------------------
// Secrets — read from the agent secrets file, never from an argument or the transcript.
// ---------------------------------------------------------------------------------------------

function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return out;
}

const secrets = { ...loadEnvFile('.env'), ...loadEnvFile('.agent-secrets.env') };
const API_KEY = process.env.ELEVENLABS_API_KEY || secrets.ELEVENLABS_API_KEY;
if (!API_KEY) {
  console.error('ELEVENLABS_API_KEY not found in .env / .agent-secrets.env');
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// One cell
// ---------------------------------------------------------------------------------------------

interface CellResult {
  endpoint: string;
  model: string;
  voice: string;
  handshake: string;
  /** 'AUDIO' | 'EMPTY' | 'HTTP <code>' | 'CLOSE <code>' | 'TIMEOUT' | 'ERROR' */
  outcome: string;
  detail: string;
  ttfbMs: number | null;
  bytes: number;
  wav: string | null;
}

function probe(
  endpoint: (typeof ENDPOINTS)[number],
  model: (typeof MODELS)[number],
  voice: (typeof VOICES)[number],
  handshake: (typeof HANDSHAKES)[number],
): Promise<CellResult> {
  const base: CellResult = {
    endpoint: endpoint.path,
    model: model.id,
    voice: voice.label,
    handshake: handshake.label,
    outcome: 'TIMEOUT',
    detail: 'no response within timeout',
    ttfbMs: null,
    bytes: 0,
    wav: null,
  };

  const qs = new URLSearchParams({
    model_id: model.id,
    output_format: OUTPUT_FORMAT,
    ...handshake.params,
  });
  // No language_code on purpose: the worklog established that every model on our path either
  // rejects a forced `he` (1008) or silently ignores it. Forcing it here would add a second reason
  // for a cell to fail and make the result unreadable.
  const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voice.id}/${endpoint.path}?${qs}`;

  return new Promise<CellResult>((resolve) => {
    const chunks: Buffer[] = [];
    let started = 0;
    let ttfb: number | null = null;
    let settled = false;

    const ws = new WebSocket(url, { headers: { 'xi-api-key': API_KEY } });

    const finish = (patch: Partial<CellResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }

      const pcmBytes = Buffer.concat(chunks);
      const result: CellResult = { ...base, ...patch, bytes: pcmBytes.length, ttfbMs: ttfb };

      if (pcmBytes.length > 0) {
        const pcm = new Int16Array(
          pcmBytes.buffer.slice(pcmBytes.byteOffset, pcmBytes.byteOffset + pcmBytes.byteLength),
        );
        const name = `${endpoint.path}__${model.id}__${voice.id}__${handshake.label}`;
        // Studio rate for judging the voice, 8k for what the caller actually hears. Never judge a
        // phone voice on the studio file — that mistake is written up in agent.config.ts.
        writeFileSync(join(OUT_DIR, `${name}.wav`), encodeWav(pcm, SAMPLE_RATE));
        writeFileSync(
          join(OUT_DIR, `${name}.phone8k.wav`),
          encodeWav(toPhoneRate(pcm, SAMPLE_RATE), 8_000),
        );
        result.wav = `${name}.wav`;
        result.outcome = 'AUDIO';
      } else if (result.outcome === 'AUDIO') {
        // Socket closed politely having sent nothing. This is ElevenLabs' silent-failure mode and
        // it looks exactly like "cannot speak Hebrew" — it is not. Name it.
        result.outcome = 'EMPTY';
        result.detail = 'connected, closed cleanly, zero audio bytes';
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish({ outcome: 'TIMEOUT' }), CELL_TIMEOUT_MS);

    // A rejected upgrade never becomes a websocket — this is where a model refusal shows up as 403.
    ws.on('unexpected-response', (_req, res) => {
      const body: Buffer[] = [];
      res.on('data', (d: Buffer) => body.push(d));
      res.on('end', () =>
        finish({
          outcome: `HTTP ${res.statusCode}`,
          detail: Buffer.concat(body).toString('utf8').slice(0, 220).replace(/\s+/g, ' ') || '(no body)',
        }),
      );
    });

    ws.on('open', () => {
      started = Date.now();
      const ctx = endpoint.multi ? { context_id: 'probe' } : {};
      // Init frame: a single space, per the streaming protocol.
      ws.send(JSON.stringify({ text: ' ', voice_settings: { stability: 0.5, similarity_boost: 0.8 }, ...ctx }));
      ws.send(JSON.stringify({ text: `${HEBREW} `, try_trigger_generation: true, ...ctx }));
      // Flush: empty text closes a single-context stream; multi-context wants an explicit close.
      ws.send(JSON.stringify(endpoint.multi ? { context_id: 'probe', close_context: true } : { text: '' }));
    });

    ws.on('message', (data) => {
      let msg: { audio?: string; error?: string; message?: string; isFinal?: boolean };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.audio) {
        if (ttfb === null) ttfb = Date.now() - started;
        chunks.push(Buffer.from(msg.audio, 'base64'));
      }
      if (msg.error) finish({ outcome: 'ERROR', detail: `${msg.error}: ${msg.message ?? ''}`.slice(0, 220) });
      if (msg.isFinal) finish({ outcome: 'AUDIO', detail: 'stream finished' });
    });

    ws.on('close', (code, reason) => {
      // 1008 with a reason string is how ElevenLabs rejects a model/param after the upgrade.
      finish({
        outcome: chunks.length ? 'AUDIO' : `CLOSE ${code}`,
        detail: reason?.toString().slice(0, 220) || (chunks.length ? 'closed after audio' : '(no reason given)'),
      });
    });

    ws.on('error', (err) => finish({ outcome: 'ERROR', detail: String(err).slice(0, 220) }));
  });
}

// ---------------------------------------------------------------------------------------------
// The account's own model list — free, and authoritative for THIS key.
// ---------------------------------------------------------------------------------------------

async function listModels(): Promise<void> {
  const res = await fetch('https://api.elevenlabs.io/v1/models', { headers: { 'xi-api-key': API_KEY! } });
  if (!res.ok) {
    console.log(`GET /v1/models -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}\n`);
    return;
  }
  const models = (await res.json()) as Array<{
    model_id: string;
    name?: string;
    can_do_text_to_speech?: boolean;
    languages?: Array<{ language_id: string }>;
  }>;

  console.log('=== GET /v1/models (what THIS key can see) ===');
  for (const m of models) {
    const he = m.languages?.some((l) => l.language_id === 'he') ? 'he ✓' : 'he ✗';
    console.log(
      `  ${m.model_id.padEnd(30)} tts=${m.can_do_text_to_speech ? 'Y' : 'N'}  ${he}  ${m.name ?? ''}`,
    );
  }
  const v3c = models.find((m) => m.model_id === 'eleven_v3_conversational');
  console.log(
    v3c
      ? '  -> eleven_v3_conversational IS visible to this account as a TTS model.'
      : '  -> eleven_v3_conversational is NOT in this account\'s TTS model list (Agents-only).',
  );
  console.log('');
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  await listModels();

  const results: CellResult[] = [];
  console.log('=== websocket matrix ===');
  for (const endpoint of ENDPOINTS) {
    for (const model of MODELS) {
      for (const voice of VOICES) {
        for (const handshake of HANDSHAKES) {
          // Strictly sequential: the payg tier caps concurrency at 3, and a concurrency rejection
          // is indistinguishable from a model rejection in the output.
          const r = await probe(endpoint, model, voice, handshake);
          results.push(r);
          console.log(
            `  ${r.endpoint.padEnd(19)} ${r.model.padEnd(24)} ${r.voice.padEnd(21)} ${r.handshake.padEnd(10)} ` +
              `${r.outcome.padEnd(12)} ttfb=${r.ttfbMs ?? '-'}ms bytes=${r.bytes}  ${r.detail}`,
          );
        }
      }
    }
  }

  writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));

  const control = results.filter((r) => r.model === 'eleven_flash_v2_5' && r.outcome === 'AUDIO');
  const target = results.filter((r) => MODELS.find((m) => m.id === r.model)?.isTarget && r.outcome === 'AUDIO');

  console.log('\n=== verdict ===');
  if (control.length === 0) {
    console.log('  VOID — the flash_v2_5 control produced no audio. Harness or key is wrong;');
    console.log('  this run says nothing about v3. Fix and re-run before concluding anything.');
  } else if (target.length > 0) {
    console.log(`  v3 IS REACHABLE over the TTS websocket — ${target.length} cell(s) returned audio:`);
    for (const r of target) {
      console.log(`    ${r.model} @ ${r.endpoint} (${r.voice}, ${r.handshake}) ttfb=${r.ttfbMs}ms -> ${r.wav}`);
    }
    console.log('  LISTEN to the .phone8k.wav files before believing the latency number.');
  } else {
    console.log('  Docs confirmed: no form of v3 renders on the standalone TTS websocket');
    console.log(`  (control passed on ${control.length} cell(s), so the harness is sound).`);
    console.log('  The only websocket route to a v3 voice is the Agents / Speech Engine socket,');
    console.log('  which means ElevenLabs also owns STT and turn-taking. Separate decision.');
  }
  console.log(`\n  WAVs + results.json in ${OUT_DIR}`);
}

void main();
