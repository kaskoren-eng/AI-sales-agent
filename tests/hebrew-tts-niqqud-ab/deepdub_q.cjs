/** Synthesize the Keren quality-test sentences with DeepDub (realtime, he-IL), 24kHz. */
const fs = require('fs');
const path = require('path');
const { DeepdubClient } = require('@deepdub/node');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const env = (n) =>
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/).find((l) => l.startsWith(n + '=')).split('=')[1].trim();

const VOICE = env('DEEPDUB_VOICE_PROMPT_ID');
const MODEL = 'dd-etts-3.2';

async function main() {
  const rows = JSON.parse(fs.readFileSync(path.join(HERE, 'q_sentences.json'), 'utf8'));
  const client = new DeepdubClient(env('DEEPDUB_API_KEY'), { protocol: 'websocket', eu: true });
  await client.connect();
  try {
    for (const r of rows) {
      const out = path.join(HERE, `dd_q${r.id}.wav`);
      await client.generateToFile(out, r.text, {
        action: 'text-to-speech',
        voicePromptId: VOICE,
        model: MODEL,
        locale: 'he-IL',
        realtime: true,
        sampleRate: 24000,
        accentControl: { accentBaseLocale: 'he-IL', accentLocale: 'he-IL', accentRatio: 0.75 },
      });
      const n = fs.existsSync(out) ? fs.statSync(out).size : 0;
      console.log(`dd_q${r.id} ${r.tag}: ${n} bytes ${n > 1000 ? '' : 'FAILED'}`);
    }
    console.log('deepdub done');
  } finally {
    client.disconnect();
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
