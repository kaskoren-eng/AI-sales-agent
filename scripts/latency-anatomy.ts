/**
 * `npm run latency:anatomy [file|all]` — the per-turn latency table for a call report.
 *
 * Reads the metrics a report already carries and prints one row per caller turn, plus the split
 * by turn class. Runs over old reports too: a field the build could not record shows as `-`, and
 * a row it cannot classify says `unknown` rather than guessing.
 *
 * Default is every report in `call-reports/`, newest first, with a pooled table at the end —
 * because one 6-turn call is not a sample, and the whole point of this instrument is to stop
 * conclusions being drawn from one median over one call.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildTurnAnatomy,
  summarizeLatency,
  type AnatomyMetric,
  type AnatomyToolCall,
  type LatencySummary,
  type TurnAnatomy,
} from '../src/modules/channels/voice-livekit/latency-anatomy.js';

const DIR = 'call-reports';
const arg = process.argv[2];

const files = (await readdir(DIR).catch(() => []))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .reverse();

if (files.length === 0) {
  console.log(`No reports in ${DIR}/. Pull them with: npm run call:fetch`);
  process.exit(0);
}

const chosen = arg && arg !== 'all' ? files.filter((f) => f.includes(arg)) : files;
if (chosen.length === 0) {
  console.log(`No report matching "${arg}". Available:\n  ${files.join('\n  ')}`);
  process.exit(1);
}

const pooled: TurnAnatomy[] = [];

for (const file of chosen) {
  const r = JSON.parse(await readFile(join(DIR, file), 'utf8')) as {
    durationSec?: number;
    config?: { ttsModel?: string; llmModel?: string };
    pipeline?: { resolved?: Record<string, unknown> };
    metrics?: AnatomyMetric[];
    toolCalls?: AnatomyToolCall[];
  };
  const turns = buildTurnAnatomy(r.metrics ?? [], r.toolCalls ?? []);
  const sum = summarizeLatency(turns);
  // Re-indexed per call when pooled, so one call's turn 3 cannot be mistaken for another's.
  pooled.push(...turns);

  const res = r.pipeline?.resolved ?? {};
  console.log(`\n${'='.repeat(100)}`);
  console.log(
    `${file}   ${r.durationSec ?? '?'}s   ${r.config?.ttsModel ?? '?'}   ${r.config?.llmModel ?? '?'}`,
  );
  console.log(
    `  endpointing ${String(res.endpointingMinDelayMs ?? '?')}/${String(res.endpointingMaxDelayMs ?? '?')}ms` +
      `   preemptiveGen ${onOff(res.preemptiveGeneration)}   preemptiveTts ${onOff(res.preemptiveTts)}` +
      `   turnDetection ${String(res.turnDetection ?? '?')}`,
  );
  console.log(`${'='.repeat(100)}`);
  printTurns(turns);
  printSummary(sum);
}

if (chosen.length > 1) {
  console.log(`\n${'#'.repeat(100)}`);
  console.log(`POOLED — ${chosen.length} calls, ${pooled.filter((t) => t.index > 0).length} caller turns`);
  console.log(`${'#'.repeat(100)}`);
  printSummary(summarizeLatency(pooled));
}

function printTurns(turns: readonly TurnAnatomy[]): void {
  console.log(
    '\n  turn   at      eou   deadAir  1stAudio  enterVc  txt2Vc  modelTtft  ttsTtfb  unexpl  steps  drafts  tokens(cached)  opener        class          tools',
  );
  for (const t of turns) {
    const label = t.index === 0 ? 'greet' : String(t.index).padStart(5);
    console.log(
      `  ${label}  ${s(t.atMs, 6)}  ${s(t.eouMs, 5)}  ${s(t.deadAirMs, 7)}  ${s(t.firstAudioMs, 8)}  ` +
        `${s(t.voiceEnteredMs, 7)}  ${s(t.textToVoiceMs, 6)}  ` +
        `${s(t.modelTtftMs, 9)}  ${s(t.ttsTtfbMs, 7)}  ${s(t.unexplainedMs, 6)}  ${String(t.inferenceSteps).padStart(5)}  ` +
        `${String(t.draftsDiscarded).padStart(6)}  ${tokens(t)}  ${(t.opener ?? '-').padEnd(12)}  ` +
        `${t.klass.padEnd(13)}  ${t.toolNames.join(',') || '-'}${t.toolMs ? ` (${t.toolMs}ms)` : ''}`,
    );
  }
}

function printSummary(sum: LatencySummary): void {
  console.log(`\n  ${sum.turns} caller turns.  DEAD AIR by class (the caller's own wait):\n`);
  console.log('    class            n    p50     p75     p90    modelTtft p50   ttsTtfb p50');
  for (const [k, v] of Object.entries(sum.byClass)) {
    if (v.n === 0) continue;
    console.log(
      `    ${k.padEnd(14)}  ${String(v.n).padStart(3)}  ${s(v.deadAirP50, 5)}  ${s(v.deadAirP75, 5)}  ` +
        `${s(v.deadAirP90, 5)}  ${s(v.modelTtftP50, 13)}  ${s(v.ttsTtfbP50, 12)}`,
    );
  }
  const a = sum.all;
  console.log(
    `    ${'ALL'.padEnd(14)}  ${String(a.n).padStart(3)}  ${s(a.deadAirP50, 5)}  ${s(a.deadAirP75, 5)}  ` +
      `${s(a.deadAirP90, 5)}  ${s(a.modelTtftP50, 13)}  ${s(a.ttsTtfbP50, 12)}`,
  );
  console.log(
    `\n  audio started BEFORE the model's first token on ` +
      `${sum.audioBeforeFirstTokenPct === null ? '?' : `${sum.audioBeforeFirstTokenPct}%`} of ` +
      `${sum.audioBeforeFirstTokenSamples} judgeable turns` +
      `${sum.audioBeforeFirstTokenSamples === 0 ? '  (no first_audio_frame — report predates it)' : ''}`,
  );
}

function tokens(t: TurnAnatomy): string {
  if (t.promptTokens === null) return '-'.padStart(14);
  const cached = t.promptCachedTokens === null ? '?' : `${Math.round((t.promptCachedTokens / t.promptTokens) * 100)}%`;
  return `${t.promptTokens}(${cached})`.padStart(14);
}

function s(v: number | null, width: number): string {
  return (v === null ? '-' : String(v)).padStart(width);
}

function onOff(v: unknown): string {
  return v === undefined || v === null ? '?' : v ? 'ON' : 'off';
}
