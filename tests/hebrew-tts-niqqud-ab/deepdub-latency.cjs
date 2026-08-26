/**
 * DeepDub latency benchmark — the make-or-break metric for a real-time voice agent.
 * Measures TTFB (text -> first audio chunk) on the streaming path, EU vs US endpoint,
 * cold vs warm. Also derives realtime-factor (audio produced per second of wall time).
 *
 * CAVEAT: measured from THIS machine. Production runs from the eu-central LiveKit agent,
 * so absolute numbers include local network RTT — treat EU-vs-US and cold-vs-warm as the
 * signal, and read absolute TTFB as an upper bound on what the deployed agent would see.
 */
const fs = require('fs');
const path = require('path');
const { DeepdubClient } = require('@deepdub/node');

const ROOT = path.resolve(__dirname, '..', '..');
const key = fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
  .split(/\r?\n/).find((l) => l.startsWith('DEEPDUB_API_KEY=')).split('=')[1].trim();

const VOICE = '2a343a72-49e7-4279-a6fd-3ae8965c811b';
const SR = 16000, BYTES_PER_SEC = SR * 2;

const SENTENCES = [
  ['short',  'שלום, מדברת קרן מ-ClickScales.'],
  ['medium', 'מה מספר הטלפון שלך? אשלח לך אישור במייל.'],
  ['long',   'הסוכן מתחבר ל-CRM שלך ומגיע עם דשבורד מלא לצפייה בכל השיחות והלידים.'],
];

function now() { return Number(process.hrtime.bigint() / 1000000n); }

async function connect(eu) {
  const c = new DeepdubClient(key, { protocol: 'websocket', eu });
  const t0 = now();
  await c.asyncStreamConnect({ model: 'dd-etts-3.2', locale: 'he-IL', voicePromptId: VOICE,
    format: 'wav', sampleRate: SR, realtime: true });
  return { c, connectMs: now() - t0 };
}

async function oneGen(c, text) {
  const t0 = now();
  await c.asyncStreamText(text);
  await c.asyncStreamEnd();
  let ttfb = null, bytes = 0, chunks = 0;
  while (true) {
    const audio = await c.asyncStreamRecvAudio({ timeoutMs: 15000 });
    if (audio === null) break;
    if (ttfb === null) ttfb = now() - t0;
    bytes += audio.length; chunks++;
  }
  const total = now() - t0;
  return { ttfb, total, bytes, chunks, audioMs: Math.round((bytes / BYTES_PER_SEC) * 1000) };
}

async function benchRegion(label, eu) {
  console.log(`\n===== ${label} =====`);
  const rows = [];
  for (const [name, text] of SENTENCES) {
    for (let run = 1; run <= 3; run++) {
      let conn;
      try {
        conn = await connect(eu);
        const r = await oneGen(conn.c, text);
        conn.c.disconnectStreaming();
        rows.push({ region: label, sentence: name, run, connectMs: conn.connectMs, ...r });
        const rtf = r.audioMs > 0 ? (r.audioMs / r.total).toFixed(2) : '?';
        console.log(`${name.padEnd(7)} run${run}  connect=${conn.connectMs}ms  TTFB=${r.ttfb}ms  total=${r.total}ms  audio=${r.audioMs}ms  chunks=${r.chunks}  rtf=${rtf}x`);
      } catch (e) {
        console.log(`${name} run${run} ERROR: ${e?.message || e}`);
        try { conn && conn.c.disconnectStreaming(); } catch {}
      }
    }
  }
  return rows;
}

async function main() {
  const all = [];
  all.push(...await benchRegion('EU', true));
  all.push(...await benchRegion('US', false));
  // warm-run summary (runs 2-3, ignoring the cold first hit)
  const warm = all.filter((r) => r.run >= 2 && r.ttfb != null);
  const by = {};
  for (const r of warm) { (by[r.region] ||= []).push(r.ttfb); }
  console.log('\n===== WARM TTFB summary (runs 2-3) =====');
  for (const [region, arr] of Object.entries(by)) {
    arr.sort((a, b) => a - b);
    const med = arr[Math.floor(arr.length / 2)];
    console.log(`${region}: median TTFB ${med}ms  (min ${arr[0]}, max ${arr[arr.length-1]}, n=${arr.length})`);
  }
  fs.writeFileSync(path.join(__dirname, 'latency.json'), JSON.stringify(all, null, 2));
  console.log('\nwrote latency.json');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
