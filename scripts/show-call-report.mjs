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

// WHAT THE PIPELINE ACTUALLY RESOLVED TO. The header above is what the agent ASKED for, read off
// env at the top of the call; this is what the running session reported back afterwards. They can
// differ — the SDK downgrades turn detection when its preconditions fail — and for weeks
// `preemptiveTts` appeared in NEITHER, which is why nobody could say whether preemptive TTS was on
// in production. Absent on reports written before 2026-08-30.
if (r.pipeline) {
  const p = r.pipeline.resolved;
  const nc = r.pipeline.noiseCancellation;
  const onOff = (v) => (v === null ? '?' : v ? 'ON' : 'off');
  console.log('\nPIPELINE AS RESOLVED (read back off the live session, not from env)\n');
  const drift = p.turnDetection !== r.config.turnDetection ? '   <-- DIFFERS from the requested mode' : '';
  console.log(`  turn detection      ${p.turnDetection ?? '?'}${drift}`);
  console.log(`  endpointing         ${p.endpointingMinDelayMs}-${p.endpointingMaxDelayMs}ms (${p.endpointingMode ?? '?'})`);
  console.log(`  preemptive gen      ${onOff(p.preemptiveGeneration)}   |   preemptive TTS  ${onOff(p.preemptiveTts)}`);
  console.log(`  components          stt=${p.sttLabel ?? '?'}  llm=${p.llmLabel ?? '?'}  tts=${p.ttsLabel ?? '?'}`);
  console.log(`  VAD                 ${p.vadAttached ? 'ours, attached' : 'MISSING'}${p.vadIsSdkDefault ? '  <-- SDK DEFAULT, our VOICE_VAD_* settings did not apply' : ''}`);
  // Never printed as a boolean: nothing below this layer reports whether the filter is processing
  // audio. See pipeline-observer.ts and the 2026-08-30 handoff.
  console.log(`  noise cancellation  attached=${nc.attached}  model=${nc.modelFileExists ? 'present' : 'MISSING'}  plugin=${nc.pluginLibExists ? 'present' : 'MISSING'}  engaged=${nc.engaged}`);
  if (r.pipeline.runningOnDefaults?.length) {
    console.log(`\n  running on code defaults (${r.pipeline.runningOnDefaults.length}): ${r.pipeline.runningOnDefaults.join(' ')}`);
  }
  line();
}

// THE HEADLINE NUMBER, and it goes first because for a while the stage medians below were read
// as the answer. They are not: they sum to a figure that assumes nothing overlaps, which is
// wrong exactly when preemptive generation is doing its job. Reported 1466ms on a call the
// caller experienced as 2535ms.
const d = s.deadAir;
if (d && d.samples > 0) {
  console.log('\nWHAT THE CALLER SAT THROUGH  (you stopped talking -> you heard something)\n');
  const verdict = (v) => (v === null ? '' : v < 1000 ? '   <-- under the 1s target' : '');
  console.log(`  typical turn     ${bar(d.medianMs)}  ${ms(d.medianMs)}${verdict(d.medianMs)}`);
  console.log(`  worst 1 in 10    ${bar(d.p90Ms)}  ${ms(d.p90Ms)}`);
  console.log(`  best / worst     ${' '.repeat(20)}  ${ms(d.minMs)} / ${ms(d.maxMs)}   over ${d.samples} turns`);
  // The budget, stated as pass/fail. Four calls in a row were read as "better" or "worse" than
  // each other when the only question that matters is whether the median clears 1000ms.
  const pass = d.medianMs !== null && d.medianMs < 1000;
  console.log(`\n  BUDGET 1000ms    ${pass ? 'PASS' : 'FAIL'}   median ${ms(d.medianMs)}`);
  if (d.samples < 6) {
    console.log(`\n  Only ${d.samples} turns — too few to call a result. Take another call.`);
  }
} else {
  console.log('\nWHAT THE CALLER SAT THROUGH\n  not measured (report predates the dead-air metric)');
}

// THE SILENCE THE NUMBER ABOVE CANNOT SEE, and until 2026-08-31 nobody was shown it.
//
// `deadAir` stops its stopwatch at her FIRST audio of a turn, and it never starts at all when the
// caller says nothing. So the 2026-08-31 call reported a healthy max of 3977ms while carrying two
// silences of 15.3 SECONDS — both of them the SDK's 15s `userAwayTimeout` finally letting the
// silence reflex speak. The gaps were in the JSON the whole time; nothing printed them.
const gapSummary = s.agentGap;
if (gapSummary && gapSummary.samples > 0 && gapSummary.maxMs !== null) {
  const REFLEX_LABEL = {
    silence_reflex: 'she asked whether he was still there (VOICE_SILENCE_AWAY_MS)',
    mute_checkback: 'she broke her own deliberate silence (VOICE_HOLD_CHECKBACK_MS)',
  };
  console.log('\nSILENCE WITH NOBODY TALKING  (she stopped, and nothing was said either way)\n');
  console.log(`  typical          ${bar(gapSummary.medianMs)}  ${ms(gapSummary.medianMs)}`);
  console.log(`  worst            ${bar(gapSummary.maxMs)}  ${ms(gapSummary.maxMs)}   over ${gapSummary.samples} of them`);
  const bad = [...gapSummary.gaps].filter((x) => x.gapMs >= 5000).sort((a, b) => b.gapMs - a.gapMs);
  if (bad.length > 0) {
    console.log('');
    for (const x of bad) {
      const why = x.endedBy
        ? REFLEX_LABEL[x.endedBy] ?? x.endedBy
        : x.tools.length > 0
          ? `${x.tools.map((t) => `${t.name} ${t.durationMs}ms`).join(', ')}`
          : 'NOTHING — no tool, no reflex, unattributed';
      console.log(`  ${String(Math.round(x.fromMs / 1000)).padStart(4)}s   ${ms(x.gapMs)} of dead line   <- ${why}`);
    }
    console.log('');
    console.log('      A caller hears every one of these as the line having gone dead. An');
    console.log('      UNATTRIBUTED one is the worst case: nobody can tell a hung request from a');
    console.log('      timer by looking at it. That is what `endedBy` in the JSON is for.');
  }
}

console.log('\nPIPELINE STAGES (median each — these do NOT add up to the number above)\n');
console.log(`  end-of-turn      ${bar(s.endOfTurnMedianMs)}  ${ms(s.endOfTurnMedianMs)}   how long she waits before deciding you finished`);
// With the instant acknowledgement on, the SDK's ttft measures OUR "אוקיי." rather than GPT, so
// the real number is reported separately. Showing only the SDK's would read as a 840ms win that
// no stage actually made.
if (s.modelTtftMedianMs != null) {
  console.log(`  LLM first token  ${bar(s.modelTtftMedianMs)}  ${ms(s.modelTtftMedianMs)}   how long GPT thinks`);
  console.log(`  first sound out  ${bar(s.llmTtftMedianMs)}  ${ms(s.llmTtftMedianMs)}   the acknowledgement, ahead of GPT`);
} else {
  console.log(`  LLM first token  ${bar(s.llmTtftMedianMs)}  ${ms(s.llmTtftMedianMs)}   how long GPT thinks`);
}
console.log(`  TTS first audio  ${bar(s.ttsTtfbMedianMs)}  ${ms(s.ttsTtfbMedianMs)}   how long until she starts speaking`);
console.log(`  ${'-'.repeat(60)}`);
console.log(`  serial total     ${' '.repeat(20)}  ${ms(s.worstCaseMs)}   if no stage overlapped another`);
// DID PREEMPTIVE ACTUALLY FIRE? `draftsDiscarded: 0` cannot answer that — it reads the same
// whether every draft was used or none was ever made. These counters split the two.
if (s.preemptive) {
  const g = s.preemptive.generation;
  console.log(`\n  preemptive drafts   started ${g.draftsStarted}  used ${g.draftsUsed}  invalidated ${g.draftsInvalidated}  unaccounted ${g.draftsUnaccounted}`);
  if (g.draftsStarted === 0) {
    console.log('      NONE STARTED — the mechanism did nothing on this call. That is a different');
    console.log('      finding from "no drafts were wasted", and a much worse one.');
  } else if (g.draftsUsed > 0) {
    console.log(`      ${g.draftsUsed} reply(ies) were written DURING the end-of-turn wait, ${g.leadTimeMedianMs}ms ahead of it (median).`);
  } else {
    console.log('      Started but never used: every draft was paid for and thrown away.');
  }
  const t = s.preemptive.tts;
  if (t.cancelled > 0) {
    // Cancelled TTS means a barge-in when preemptive TTS is OFF, and also discarded drafts when it
    // is ON — check the PIPELINE block above for which regime this call ran in.
    console.log(`  TTS thrown away     ${t.cancelled} synthesis(es), ${t.charactersDiscarded} of ${t.charactersSynthesized} characters`);
  }
  const l = s.preemptive.llm;
  if (l.cancelled > 0) {
    console.log(`  LLM thrown away     ${l.cancelled} call(s), ${l.cancelledPromptTokens} input tokens`);
  }
} else if (s.draftsDiscarded > 0) {
  console.log(`\n  drafts thrown away  ${s.draftsDiscarded}   <-- LLM calls paid for, never heard`);
  console.log('      A draft survives only if its transcript matches the committed one EXACTLY.');
  console.log('      If this is high and the silence above is not falling, drafting is pure cost.');
}
console.log('\n  Preemptive generation writes the reply DURING the end-of-turn wait, so the real');
console.log('  silence is smaller than this sum when it fires — and equal to it when it misses.');

console.log('\nHEALTH\n');
console.log(`  turns she heard     ${s.turnsHeard}`);
console.log(`  speech segments     ${s.ttsSegments ?? '?'}`);
const dup = s.duplicateReplies;
if (dup > 0) {
  console.log(`  SHE REPEATED HERSELF  ${dup}   <-- SHE SPOKE THE SAME ANSWER TWICE, VERBATIM`);
  console.log('');
  console.log('      This is what makes her sound broken — not latency, not the voice. She talks');
  console.log('      over herself and buries the caller in duplicated speech. Cause: preemptive');
  console.log('      TTS speaking the DRAFT reply and then the real one. Set VOICE_PREEMPTIVE_TTS=false.');
} else if (dup === 0) {
  console.log('  SHE REPEATED HERSELF  0   she said each thing once');
}
const frag = s.fragmentedTurns;
if (frag > 0) {
  console.log(`  SENTENCES SHE CHOPPED ${frag}   <-- SHE DECIDED YOU WERE DONE WHILE YOU WERE MID-SENTENCE`);
  console.log('');
  console.log('      Two of your turns in a row with no reply between them = one sentence cut in half.');
  console.log('      This is what breaks phone numbers: "050." / "888-45." arrive as fragments and');
  console.log('      she never receives a whole number. Raise VOICE_VAD_MIN_SILENCE_MS.');
} else if (s.fragmentedTurns === 0) {
  console.log('  SENTENCES SHE CHOPPED 0   she let you finish every time');
}
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
