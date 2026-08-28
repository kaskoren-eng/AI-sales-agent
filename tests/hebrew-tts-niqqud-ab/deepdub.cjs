/**
 * DeepDub TTS test — same Hebrew sentences we ran through Cartesia, to hear whether
 * DeepDub handles Hebrew gender / names / mixed-English natively (no niqqud tricks).
 *
 * Key is read from ../../.env (DEEPDUB_API_KEY) — never hardcoded here.
 * Run:  node tests/hebrew-tts-niqqud-ab/deepdub.cjs
 */
const fs = require('fs');
const path = require('path');
const { DeepdubClient } = require('@deepdub/node');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');

function envKey(name) {
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const line = env.split(/\r?\n/).find((l) => l.startsWith(name + '='));
  if (!line) throw new Error(`${name} not in .env`);
  return line.slice(name.length + 1).trim();
}

const VOICE = '2a343a72-49e7-4279-a6fd-3ae8965c811b';
const MODEL = 'dd-etts-3.2';

// id, tag, text — plain Hebrew, exactly what the agent would send (no niqqud).
const SENTENCES = [
  ['01', 'greeting-user',      'שלום, אני שמחה לעזור לך. איך אפשר לסייע לך היום?'],
  ['02', 'greeting-keren',     'שלום, מדברת קרן מ-ClickScales. איך אני יכולה לעזור?'],
  ['03', 'founder-name',       'קורן הוא המייסד של ClickScales, והוא זה שיעביר את הדמו.'],
  ['04', 'masc-cue',           'אדוני, מה השם שלך? אני אחזור אליך היום.'],
  ['05', 'fem-cue',            'גברתי, מה השם שלך? אני אחזור אליך היום.'],
  ['06', 'no-cue-gender',      'מה מספר הטלפון שלך? אשלח לך אישור.'],
  ['07', 'phone-digits',       'רק לוודא — אפס חמש אפס, תשע שבע, שמונה שמונה, ארבע חמש?'],
  ['08', 'crm-english',        'הסוכן מתחבר ל-CRM שלך ומגיע עם דשבורד מלא לצפייה בכל השיחות והלידים.'],
];

async function main() {
  const client = new DeepdubClient(envKey('DEEPDUB_API_KEY'), { protocol: 'websocket' });
  await client.connect();
  const manifest = [];
  try {
    for (const [id, tag, text] of SENTENCES) {
      const out = path.join(HERE, `dd_${id}.wav`);
      const params = {
        action: 'text-to-speech',
        voicePromptId: VOICE,
        model: MODEL,
        locale: 'he-IL',
        realtime: true,
        accentControl: { accentBaseLocale: 'he-IL', accentLocale: 'he-IL', accentRatio: 0.75 },
      };
      await client.generateToFile(out, text, params);
      const bytes = fs.existsSync(out) ? fs.statSync(out).size : 0;
      manifest.push({ id, tag, text, file: `dd_${id}.wav`, bytes });
      console.log(`${id} ${tag}: ${bytes} bytes  ${bytes > 1000 ? 'ok' : 'FAILED'}`);
    }
    fs.writeFileSync(path.join(HERE, 'deepdub.json'), JSON.stringify(manifest, null, 2));
    console.log('wrote deepdub.json');
  } finally {
    client.disconnect();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e?.message || e); process.exit(1); });
