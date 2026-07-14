/**
 * Shows what happened on a call.
 *
 *   npm run call:report          the most recent call
 *   npm run call:report -- all   every call, one summary line each
 *   npm run call:report -- 3     the 3rd most recent
 *
 * Reads the JSON that the agent writes to call-reports/ when a call ends. Before this existed, the
 * only record of a call was the agent's stdout, so the person whose calls these are could not look
 * at his own data.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = 'call-reports';
const arg = process.argv[2];

const files = (await readdir(DIR).catch(() => [])).filter((f) => f.endsWith('.json')).sort().reverse();

if (files.length === 0) {
  console.log(`No call reports in ${DIR}/.`);
  console.log('Take a call with the voice agent running (npm run voice:dev) and one will appear.');
  process.exit(0);
}

if (arg === 'all') {
  console.log(`${files.length} call(s)\n`);
  console.log('  when              turn-det  engine   end-of-turn     LLM     TTS  turns  CUT YOU OFF');
  console.log('  ' + '-'.repeat(86));
  for (const f of files) {
    const r = JSON.parse(await readFile(join(DIR, f), 'utf8'));
    const s = r.summary;
    console.log(
      `  ${r.startedAt.slice(0, 16).replace('T', ' ')}  ${r.config.turnDetection.padEnd(8)}  ` +
        `${r.config.sttProvider.padEnd(7)} ${ms(s.endOfTurnMedianMs).padStart(11)} ${ms(s.llmTtftMedianMs)} ${ms(s.ttsTtfbMedianMs)}  ` +
        `${String(s.turnsHeard).padStart(5)}  ${String(s.cutOffs ?? '?').padStart(6)}` +
        `${(s.cutOffs ?? 0) > 0 ? '   <-- SHE TALKED OVER YOU' : ''}`,
    );
  }
  console.log('\n  Note that the BROKEN call has the BEST end-of-turn number — a turn cut in half');
  console.log('  finalises faster. Read the cut-off column BEFORE you read the latency column.');
  process.exit(0);
}

const idx = Number.isInteger(Number(arg)) && arg ? Number(arg) - 1 : 0;
const file = files[idx];
if (!file) {
  console.log(`Only ${files.length} report(s) exist.`);
  process.exit(1);
}

const r = JSON.parse(await readFile(join(DIR, file), 'utf8'));
const s = r.summary;

line();
console.log(`CALL  ${r.startedAt.replace('T', ' ').slice(0, 19)}   ${r.durationSec}s   from ${r.callerPhone ?? 'browser'}`);
console.log(`      STT ${r.config.sttProvider} (${r.config.sttModel})  |  turn detection: ${r.config.turnDetection}`);
console.log(`      LLM ${r.config.llmModel}  |  TTS ${r.config.ttsModel}`);
line();

console.log('\nLATENCY (median per stage)\n');
console.log(`  end-of-turn      ${bar(s.endOfTurnMedianMs)}  ${ms(s.endOfTurnMedianMs)}   how long she waits before deciding you finished`);
console.log(`  LLM first token  ${bar(s.llmTtftMedianMs)}  ${ms(s.llmTtftMedianMs)}   how long GPT thinks`);
console.log(`  TTS first audio  ${bar(s.ttsTtfbMedianMs)}  ${ms(s.ttsTtfbMedianMs)}   how long until she starts speaking`);
console.log(`  ${'-'.repeat(60)}`);
console.log(`  worst case       ${' '.repeat(20)}  ${ms(s.worstCaseMs)}   if no stage overlapped another`);
console.log('\n  You feel LESS than the worst case: preemptive generation runs the LLM during the');
console.log('  end-of-turn wait, so those two overlap instead of stacking.');

console.log('\nHEALTH\n');
console.log(`  turns she heard     ${s.turnsHeard}`);
console.log(`  speech segments     ${s.ttsSegments ?? '?'}`);
const cut = s.cutOffs;
if (cut > 0) {
  console.log(`  CUT YOU OFF         ${cut}   <-- SHE STARTED REPLYING WHILE YOU WERE STILL TALKING`);
  console.log('');
  console.log('      This is the number to read FIRST, because latency cannot see it: a turn');
  console.log('      chopped in half finalises FASTER, so a broken call reports a BETTER');
  console.log('      end-of-turn median. Our best-ever 259ms came from the call where she went');
  console.log('      silent three times.');
} else {
  console.log(`  CUT YOU OFF         0   clean — she waited for you every time`);
}

if (r.usage?.modelUsage) {
  console.log('\nCOST\n');
  for (const u of r.usage.modelUsage) {
    const detail =
      u.type === 'llm_usage'
        ? `${u.inputTokens} in / ${u.outputTokens} out tokens`
        : u.type === 'stt_usage'
          ? `${Math.round((u.audioDurationMs ?? 0) / 1000)}s of audio`
          : `${u.charactersCount} chars -> ${Math.round((u.audioDurationMs ?? 0) / 1000)}s of speech`;
    console.log(`  ${String(u.type).replace('_usage', '').padEnd(4)}  ${String(u.provider).padEnd(16)} ${String(u.model).padEnd(22)} ${detail}`);
  }
}

if (r.transcript?.length) {
  console.log('\nTHE CONVERSATION\n');
  for (const t of r.transcript) {
    const who = t.role === 'user' ? 'CALLER' : 'AGENT ';
    console.log(`  [${String(Math.round(t.atMs / 1000)).padStart(3)}s] ${who}  ${t.text}`);
  }
}

if (r.shadow) {
  const live = r.shadow.authoritativeEngine;
  const shad = r.shadow.shadowEngine;
  console.log(`\nWHAT EACH ENGINE HEARD   (live: ${live}   |   shadow: ${shad}, silent)\n`);
  console.log('  Neither is ground truth. YOU were there — decide which one heard you right.\n');

  for (const a of r.shadow.authoritative) {
    const m = nearest(r.shadow.shadow, a.atMs);
    const differs = m && norm(m.text) !== norm(a.text);
    const mark = !m ? '  ??' : differs ? '  <>' : '  ==';
    console.log(`${mark}  [${String(Math.round(a.atMs / 1000)).padStart(3)}s]`);
    console.log(`        ${live.padEnd(7)} ${a.text}`);
    if (m) console.log(`        ${shad.padEnd(7)} ${m.text}`);
    console.log();
  }
  console.log('  ==  they agreed        <>  THEY DISAGREED — read these        ??  no matching turn');

  if (r.shadow.errors?.length) {
    console.log('\n  shadow-side errors (these never touched the caller):');
    for (const e of r.shadow.errors) console.log(`    ${e}`);
  }
}

console.log(`\nraw json: ${join(DIR, file)}`);
if (files.length > 1) console.log(`${files.length} calls on file — "npm run call:report -- all" to compare them.`);

// --- helpers ---
function ms(v) {
  return v === null || v === undefined ? '    —' : `${String(v).padStart(4)}ms`;
}
function bar(v) {
  if (!v) return ' '.repeat(20);
  const n = Math.min(20, Math.round(v / 100));
  return ('#'.repeat(n) + ' '.repeat(20)).slice(0, 20);
}
function norm(t) {
  return String(t ?? '').replace(/[.,!?"'\-־]/gu, '').replace(/\s+/gu, ' ').trim();
}
function nearest(list, atMs) {
  let best = null;
  let gap = Infinity;
  for (const i of list ?? []) {
    const d = Math.abs(i.atMs - atMs);
    if (d < gap) {
      gap = d;
      best = i;
    }
  }
  return gap <= 4000 ? best : null;
}
function line() {
  console.log('='.repeat(88));
}
