/**
 * Synthetic-caller test runner.
 *
 * Usage (the agent worker must already be running in another terminal):
 *   npm run voice:dev            # terminal 1
 *   npm run voice:test           # terminal 2 — all scenarios
 *   npm run voice:test -- short_answers   # one scenario
 *
 * Prints per-turn dead air (the number a human feels) and a summary. Exits non-zero if the
 * agent failed to answer a turn, so this can gate a commit later.
 */
import { loadEnv } from '../../../../config/env.js';
import { SCENARIOS, type Scenario, getScenario } from './scenarios.js';
import { SyntheticCaller, type CallResult } from './synthetic-caller.js';
import { ensureLogger } from './speech.js';

// rtc-node chatters at debug level about unhandled text streams; keep the report readable.
process.env.LOG_LEVEL ??= 'error';
ensureLogger('error');

const env = loadEnv();

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const scenarios: Scenario[] = requested.length > 0 ? requested.map(getScenario) : SCENARIOS;

const caller = new SyntheticCaller(env);
const results: Array<{ scenario: Scenario; result: CallResult }> = [];

for (const scenario of scenarios) {
  // A fresh room per scenario, so each starts from a clean greeting.
  const room = `synthtest-${scenario.name}-${process.pid}-${results.length}`;
  process.stdout.write(`\n▶ ${scenario.name} — ${scenario.description}\n`);

  try {
    const result = await caller.call(room, scenario.utterances);
    results.push({ scenario, result });

    if (result.error) {
      process.stdout.write(`  ✗ ${result.error}\n`);
      continue;
    }

    for (const t of result.turns) {
      const latency = t.responseLatencyMs === null ? 'NO REPLY' : `${t.responseLatencyMs}ms`;
      const flags = [
        t.interruptedCaller ? 'CUT THE CALLER OFF' : null,
        t.responseLatencyMs !== null && t.responseLatencyMs > 1200 ? 'DEAD AIR > 1.2s' : null,
      ]
        .filter(Boolean)
        .join(', ');
      process.stdout.write(
        `  ${latency.padStart(9)}  "${t.said}"${flags ? `   [${flags}]` : ''}\n`,
      );
    }
  } catch (err) {
    process.stdout.write(`  ✗ threw: ${(err as Error).message}\n`);
    results.push({
      scenario,
      result: { room, turns: [], error: (err as Error).message },
    });
  }
}

// ---- summary ---------------------------------------------------------------------------
const allTurns = results.flatMap((r) => r.result.turns);
const answered = allTurns.filter((t) => t.responseLatencyMs !== null);
const latencies = answered.map((t) => t.responseLatencyMs!).sort((a, b) => a - b);
const pct = (p: number) => (latencies.length ? latencies[Math.floor(latencies.length * p)]! : 0);
const cutOffs = allTurns.filter((t) => t.interruptedCaller).length;
const deadAir = answered.filter((t) => t.responseLatencyMs! > 1200).length;
const noReply = allTurns.length - answered.length;

process.stdout.write('\n' + '─'.repeat(64) + '\n');
process.stdout.write('DEAD AIR — caller stops speaking → agent starts speaking\n');
process.stdout.write(`  turns          ${allTurns.length} (${noReply} unanswered)\n`);
if (latencies.length > 0) {
  process.stdout.write(`  p50            ${pct(0.5)}ms\n`);
  process.stdout.write(`  p95            ${pct(0.95)}ms   (target < 800ms)\n`);
  process.stdout.write(`  min / max      ${latencies[0]}ms / ${latencies[latencies.length - 1]}ms\n`);
}
process.stdout.write(`  dead air >1.2s ${deadAir}   (target 0)\n`);
process.stdout.write(`  cut caller off ${cutOffs}   (target 0)\n`);
process.stdout.write('─'.repeat(64) + '\n');

const failed = results.some((r) => r.result.error) || noReply > 0;
process.exit(failed ? 1 : 0);
