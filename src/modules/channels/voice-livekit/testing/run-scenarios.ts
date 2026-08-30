/**
 * Synthetic-caller test runner — ONE configuration, recorded.
 *
 * Usage (the agent worker must already be running in another terminal):
 *   npm run voice:dev            # terminal 1
 *   npm run voice:test           # terminal 2 — all scenarios
 *   npm run voice:test -- short_answers   # one scenario
 *
 * Prints per-turn dead air (the number a human feels) and a summary, AND writes an HTML page per
 * scenario with the audio on it — because the timings cannot tell you whether the Hebrew sounded
 * like a person, and that is the thing actually being worked on. Exits non-zero if the agent
 * failed to answer a turn, so this can gate a commit later.
 *
 * Since 2026-08-30 it dispatches the LOCAL worker BY NAME. Before that it created a plain room,
 * which LiveKit auto-dispatched — and on this project the production cloud agent is in that
 * auto-dispatch pool, so a "local" test run could be, and sometimes was, answered by production.
 * If you want the old behaviour, set VOICE_DEV_DEFAULT_DISPATCH=1 on BOTH the worker and here.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnv } from '../../../../config/env.js';
import { SCENARIOS, type Scenario, getScenario } from './scenarios.js';
import { SyntheticCaller, type CallResult } from './synthetic-caller.js';
import { ensureLogger } from './speech.js';
import { DEFAULT_DISPATCH_ESCAPE, DEV_AGENT_NAME, DEV_AGENT_NAME_VAR } from './dev-dispatch.js';
import { findCallReport, renderPage, writeRunArtifacts } from './report-html.js';

// rtc-node chatters at debug level about unhandled text streams; keep the report readable.
process.env.LOG_LEVEL ??= 'error';
ensureLogger('error');

const env = loadEnv();

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const scenarios: Scenario[] = requested.length > 0 ? requested.map(getScenario) : SCENARIOS;

// Must match whatever the worker in terminal 1 registered as — same resolution, same env vars.
const escape = process.env[DEFAULT_DISPATCH_ESCAPE];
const agentName =
  escape === '1' || escape === 'true'
    ? ''
    : process.env[DEV_AGENT_NAME_VAR]?.trim() || DEV_AGENT_NAME;

const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const outRoot = resolve('voice-test-runs', stamp);

const caller = new SyntheticCaller(env, { agentName, captureAudio: true });
const results: Array<{ scenario: Scenario; result: CallResult }> = [];
const pages: string[] = [];

process.stdout.write(
  agentName
    ? `dispatching agent "${agentName}" explicitly — production cannot answer these rooms\n`
    : `⚠ ${DEFAULT_DISPATCH_ESCAPE} is set: these rooms are auto-dispatched and the PRODUCTION cloud agent may answer them\n`,
);

for (const scenario of scenarios) {
  // A fresh room per scenario, so each starts from a clean greeting.
  const room = `synthtest-${scenario.name}-${process.pid}-${results.length}`;
  process.stdout.write(`\n▶ ${scenario.name} — ${scenario.description}\n`);

  try {
    const startedAt = Date.now();
    const result = await caller.call(room, scenario.utterances);
    results.push({ scenario, result });

    if (result.error) {
      process.stdout.write(`  ✗ ${result.error}\n`);
      continue;
    }

    // COLD START, stated out loud. The first call a freshly booted worker takes forks a job
    // process that imports tsx + googleapis + drizzle + Silero; every later call reuses it. If
    // this number is tens of seconds, turn 1 below is a cold-start measurement, not a config one.
    process.stdout.write(
      `  agent joined after ${result.agentJoinedMs ?? '—'}ms, greeting started ${result.greetingStartedMs ?? '—'}ms\n`,
    );
    if (result.mixStats) {
      process.stdout.write(
        `  whole-call mix: ${result.mixStats.segments} segments, ` +
          `${result.mixStats.overlappingSegments} overlapping, ` +
          `${result.mixStats.overlapMs}ms summed on top of each other\n`,
      );
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

    // ---- the listenable half ------------------------------------------------------------
    await new Promise((r) => setTimeout(r, 1_500)); // let the agent flush its report
    const dir = resolve(outRoot, scenario.name);
    await mkdir(dir, { recursive: true });
    const report = await findCallReport('call-reports', room, startedAt);
    const run = await writeRunArtifacts({
      dir,
      key: 'A',
      call: result,
      transcript: { greeting: report?.agentGreeting ?? null, replies: report?.agentReplies ?? [] },
    });
    const page = renderPage({
      title: `${scenario.name} · ${stamp}`,
      scenarioName: scenario.name,
      scenarioDescription: scenario.description,
      variants: [
        {
          key: 'A',
          label: 'the config this worker is running',
          overrides: {},
          pipeline: report?.pipeline ?? null,
        },
      ],
      runs: [run],
      warnings: report
        ? []
        : [
            `no call report matched room ${room} — the transcript column is empty and the ` +
              `resolved pipeline is unknown for this run.`,
          ],
      generatedAt: new Date().toISOString(),
    });
    const pagePath = resolve(dir, 'index.html');
    await writeFile(pagePath, page);
    pages.push(pagePath);
    process.stdout.write(`  → ${pagePath}\n`);
  } catch (err) {
    process.stdout.write(`  ✗ threw: ${(err as Error).message}\n`);
    results.push({
      scenario,
      result: {
        room,
        startedAt: Date.now(),
        turns: [],
        agentIdentity: null,
        agentName: null,
        agentJoinedMs: null,
        greetingStartedMs: null,
        greetingPcm: new Int16Array(0),
        mixedPcm: new Int16Array(0),
        error: (err as Error).message,
      },
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
process.stdout.write(
  '  ⚠ these are COMPARISON figures — they run ~1–1.5s high because they include transport\n' +
    '    and the jitter buffer. Never quote them as the product latency. See ./README.md.\n',
);
process.stdout.write('─'.repeat(64) + '\n');
for (const p of pages) process.stdout.write(`LISTEN: ${p}\n`);

const failed = results.some((r) => r.result.error) || noReply > 0;
process.exit(failed ? 1 : 0);
