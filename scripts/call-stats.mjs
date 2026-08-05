#!/usr/bin/env node
// Per-call voice stats from the DB (call_learnings.call_report), the durable home for the transcript
// + latency that used to live only in ephemeral `lk agent logs`. Every LiveKit call lands here.
//
// Usage:
//   node scripts/call-stats.mjs                 # newest 15 calls, one line each
//   node scripts/call-stats.mjs --limit 40
//   node scripts/call-stats.mjs --full <id>     # full transcript + per-turn metrics for one call
//                                               # (<id> = full uuid or a leading prefix)
//   DATABASE_URL=... node scripts/call-stats.mjs # override which DB (defaults to the agent's prod DB)
//
// DB precedence: $DATABASE_URL, else DATABASE_URL from .agent-secrets.env (the deployed agent's DB —
// where real calls land), else from .env.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function urlFrom(file) {
  try {
    const m = readFileSync(join(root, file), 'utf8').match(/^DATABASE_URL=(.*)$/m);
    return m ? m[1].replace(/["'\r]/g, '').trim() : '';
  } catch {
    return '';
  }
}
const DB = process.env.DATABASE_URL || urlFrom('.agent-secrets.env') || urlFrom('.env');
if (!DB) {
  console.error('No DATABASE_URL (env, .agent-secrets.env, or .env).');
  process.exit(1);
}

const args = process.argv.slice(2);
const fullIdx = args.indexOf('--full');
const fullId = fullIdx >= 0 ? args[fullIdx + 1] : null;
const limIdx = args.indexOf('--limit');
const limit = limIdx >= 0 ? Number(args[limIdx + 1]) : 15;

const ms = (v) => (v === null || v === undefined ? '  -  ' : String(Math.round(v)).padStart(5));
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);

const client = new pg.Client({ connectionString: DB, ssl: { rejectUnauthorized: false } });
await client.connect();

if (fullId) {
  const { rows } = await client.query(
    `select id, created_at, call_report from call_learnings
     where call_report is not null and id::text like $1 order by created_at desc limit 1`,
    [`${fullId}%`],
  );
  if (!rows.length) {
    console.error(`No call with call_report matching id "${fullId}".`);
    await client.end();
    process.exit(1);
  }
  const r = rows[0];
  const cr = r.call_report;
  console.log(`\nCall ${r.id}  (${r.created_at.toISOString?.() ?? r.created_at})`);
  console.log(`caller ${cr.callerPhone ?? '-'} | ${cr.durationSec}s | model ${cr.config?.ttsModel}`);
  const s = cr.summary ?? {};
  console.log(
    `latency: EOU ${ms(s.endOfTurnMedianMs)} | LLM ${ms(s.llmTtftMedianMs)} | TTS ${ms(s.ttsTtfbMedianMs)} | worst ${ms(s.worstCaseMs)}  (ms)`,
  );
  console.log(
    `turns ${s.turnsHeard} | ttsSeg ${s.ttsSegments} | cutOffs ${s.cutOffs} | fragmented ${s.fragmentedTurns} | dup ${s.duplicateReplies} | cache ${s.promptCacheHitPct ?? '-'}%`,
  );
  console.log('\n--- transcript ---');
  for (const t of cr.transcript ?? []) {
    console.log(`[${String(Math.round(t.atMs / 1000)).padStart(3)}s] ${pad(t.role, 9)} ${t.text}`);
  }
  console.log('\n--- per-turn metrics ---');
  for (const m of cr.metrics ?? []) {
    const bits = Object.entries(m)
      .filter(([k]) => k !== 'stage' && k !== 'atMs')
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(`[${String(Math.round((m.atMs ?? 0) / 1000)).padStart(3)}s] ${pad(m.stage, 14)} ${bits}`);
  }
  console.log('');
  await client.end();
  process.exit(0);
}

const { rows } = await client.query(
  `select id, created_at, duration_secs, status, call_report from call_learnings
   where call_report is not null order by created_at desc limit $1`,
  [limit],
);

console.log(
  `\n${pad('when', 20)} ${pad('id', 8)} ${pad('caller', 15)} ${pad('model', 26)} ${pad('dur', 4)} ${pad('EOU', 5)} ${pad('LLM', 5)} ${pad('TTS', 5)} ${pad('worst', 6)} ${pad('cut', 3)} ${pad('frg', 3)} ${pad('dup', 3)}`,
);
console.log('-'.repeat(130));
for (const r of rows) {
  const cr = r.call_report ?? {};
  const s = cr.summary ?? {};
  const when = (r.created_at.toISOString?.() ?? String(r.created_at)).replace('T', ' ').slice(0, 19);
  console.log(
    `${pad(when, 20)} ${pad(r.id.slice(0, 8), 8)} ${pad(cr.callerPhone ?? '-', 15)} ${pad(cr.config?.ttsModel ?? '-', 26)} ${pad((cr.durationSec ?? r.duration_secs ?? '') + 's', 4)} ${ms(s.endOfTurnMedianMs)} ${ms(s.llmTtftMedianMs)} ${ms(s.ttsTtfbMedianMs)} ${ms(s.worstCaseMs).padStart(6)} ${pad(s.cutOffs, 3)} ${pad(s.fragmentedTurns, 3)} ${pad(s.duplicateReplies, 3)}`,
  );
}
// --by-model: the real-call A/B. Groups the same calls by the TTS model that actually spoke and
// reports median-of-per-call-medians per arm.
//
// THIS IS THE NUMBER THAT DECIDES A MODEL SWAP, not the offline bench. `npm run voice:model-ab`
// measures Cartesia's websocket from a laptop; this measures what a caller on a real PSTN line
// waited for, through the deployed agent, in the production region. They can disagree, and when
// they do this one is right.
if (args.includes('--by-model')) {
  const byModel = new Map();
  for (const r of rows) {
    const cr = r.call_report ?? {};
    const model = cr.config?.ttsModel ?? '-';
    if (!byModel.has(model)) byModel.set(model, []);
    byModel.get(model).push(cr.summary ?? {});
  }

  const med = (xs) => {
    const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };

  console.log(`\n--- by TTS model (${rows.length} call(s)) ---`);
  console.log(
    `${pad('model', 26)} ${pad('calls', 5)} ${pad('EOU', 5)} ${pad('LLM', 5)} ${pad('TTS', 5)} ${pad('worst', 6)} ${pad('cut', 4)} ${pad('frg', 4)}`,
  );
  console.log('-'.repeat(70));
  for (const [model, ss] of [...byModel.entries()].sort()) {
    console.log(
      `${pad(model, 26)} ${pad(ss.length, 5)} ${ms(med(ss.map((s) => s.endOfTurnMedianMs)))} ${ms(med(ss.map((s) => s.llmTtftMedianMs)))} ${ms(med(ss.map((s) => s.ttsTtfbMedianMs)))} ${ms(med(ss.map((s) => s.worstCaseMs))).padStart(6)} ${pad(ss.reduce((a, s) => a + (s.cutOffs ?? 0), 0), 4)} ${pad(ss.reduce((a, s) => a + (s.fragmentedTurns ?? 0), 0), 4)}`,
    );
  }
  // A median over three calls is a rumour. Say the sample size out loud rather than let a
  // confident-looking table imply more than it has.
  const thin = [...byModel.values()].some((ss) => ss.length < 5);
  if (thin) console.log('\n  NOTE: fewer than 5 calls in an arm — indicative only, not a result.');
  console.log('  TTS is the column the model swap moves. EOU and LLM should be unchanged;');
  console.log('  if they move, something other than the model differed between the arms.\n');
}

console.log(`\n${rows.length} call(s). Use --full <id> for transcript + per-turn metrics, --by-model for the A/B.\n`);
await client.end();
