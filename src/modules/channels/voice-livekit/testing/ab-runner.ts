/**
 * A/B THE AGENT WITHOUT DEPLOYING AND WITHOUT PHONING ANYONE.
 *
 *   npm run voice:ab:call -- <variants.json> [scenario]
 *
 * Runs the SAME scripted Hebrew conversation once per variant, against a LOCAL agent worker that
 * this script starts and stops itself, and ends with one HTML page where the same turn from each
 * variant sits side by side with a player and a latency column.
 *
 * WHY IT SPAWNS THE WORKER ITSELF. A variant is a set of env values, and the only way to give a
 * LiveKit worker different env values is to start a different worker. Reusing one worker across
 * variants would silently run every variant with the first one's config — the same class of bug as
 * the dotenv trap in `env-overlay.ts`, and just as invisible. Sequential, never parallel: two
 * agents on one laptop contend for CPU and the latency column stops meaning anything.
 *
 * WHAT THE RUN PROVES, IN ORDER, EACH GATE BEFORE ANY MONEY IS SPENT:
 *   1. the variants differ from each other on paper                      (`assertVariantsDiffer`)
 *   2. every env key they name is a key this app actually reads          (`unknownEnvKeys`)
 *   3. the worker registered under the private name we dispatch to       (stdout)
 *   4. the agent that ANSWERED is that worker, not the production cloud  (`lk.agent.name`)
 *   5. the agent's own pipeline observer reports the variant's values    (`assertPipelinesDiffer`)
 *
 * Gate 5 is the one that matters. Everything before it is inference; gate 5 is the running session
 * reporting what it actually resolved to, read back out of the call report the agent wrote.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../../../../config/env.js';
import { getScenario } from './scenarios.js';
import { SyntheticCaller } from './synthetic-caller.js';
import { ensureLogger } from './speech.js';
import {
  findCallReport,
  renderPage,
  writeRunArtifacts,
  type VariantRun,
  type VariantSummary,
} from './report-html.js';
import {
  assertPipelinesDiffer,
  assertVariantsDiffer,
  loadVariantFile,
  unknownEnvKeys,
  variantKeys,
} from './variants.js';

const AGENT_ENTRY = fileURLToPath(new URL('../agent.ts', import.meta.url));
/**
 * The tsx CLI, resolved from the repo root rather than relatively: this script is always launched
 * by npm from the repo root, and a relative hop would break the moment the file moves or is run
 * from `dist/`.
 */
const TSX_CLI = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
const CALL_REPORTS_DIR = 'call-reports';
const OUT_ROOT = 'voice-test-runs';
/** Booting a worker under tsx pulls in googleapis + drizzle + the Silero model. It is not fast. */
const WORKER_READY_TIMEOUT_MS = 180_000;

process.env.LOG_LEVEL ??= 'error';
ensureLogger('error');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const variantPath = positional[0];

if (!variantPath) {
  console.error(
    'usage: npm run voice:ab:call -- <variants.json> [scenario]\n' +
      '  variants.json — see src/modules/channels/voice-livekit/testing/variants.example.json\n' +
      '  scenario      — a name from scenarios.ts (default: whatever the file says, else baseline_latency)\n' +
      '  --allow-unknown-keys  do not fail on env keys the schema does not define',
  );
  process.exit(2);
}

const env = loadEnv();
const file = loadVariantFile(variantPath);
const scenario = getScenario(positional[1] ?? file.scenario ?? 'baseline_latency');
const variants = file.variants;

// ── Gate 1: the variants differ on paper ────────────────────────────────────────────────────
assertVariantsDiffer(variants);

// ── Gate 2: every key they name is one this app reads ───────────────────────────────────────
const keys = variantKeys(variants);
const unknown = unknownEnvKeys(keys);
if (unknown.length > 0 && !flags.has('--allow-unknown-keys')) {
  console.error(
    `These variant env keys are not in the env schema (src/config/env.ts): ${unknown.join(', ')}\n` +
      `They would apply cleanly to process.env and change NOTHING — which produces two identical ` +
      `clips labelled A and B. Fix the spelling, or re-run with --allow-unknown-keys.`,
  );
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const outDir = resolve(OUT_ROOT, `${stamp}-${scenario.name}`);
await mkdir(outDir, { recursive: true });

const warnings: string[] = [];
const runs: VariantRun[] = [];
const summaries: VariantSummary[] = [];

for (const variant of variants) {
  console.log(`\n${'─'.repeat(70)}\n▶ variant ${variant.key} — ${variant.label}`);
  console.log(`  overrides: ${JSON.stringify(variant.env)}`);

  const overlayPath = resolve(outDir, `overlay_${variant.key}.json`);
  await writeFile(overlayPath, `${JSON.stringify(variant.env, null, 2)}\n`);

  // A per-variant worker name means a leftover worker from a previous variant can never answer
  // this one's call — it would be dispatched by a name that no longer matches.
  const agentName = `keren-ab-${variant.key.toLowerCase()}-${process.pid}`;
  const worker = await startWorker({ overlayPath, agentName });

  try {
    const room = `abtest-${scenario.name}-${variant.key}-${process.pid}-${Date.now()}`;
    const startedAt = Date.now();
    const caller = new SyntheticCaller(env, {
      agentName,
      identity: `ab-caller-${variant.key}`,
      captureAudio: true,
    });

    const call = await caller.call(room, scenario.utterances);
    if (call.error) {
      console.log(`  ✗ ${call.error}`);
      warnings.push(`variant ${variant.key}: ${call.error}`);
    }

    // Give the agent a moment to flush its final report before we go looking for it.
    await sleep(2_000);
    const report = await findCallReport(CALL_REPORTS_DIR, room, startedAt);
    if (!report) {
      warnings.push(
        `variant ${variant.key}: no call report matched room ${room}. The variant's resolved ` +
          `config could NOT be verified — treat the comparison as unproven.`,
      );
    } else {
      console.log(`  call report: ${report.path}`);
    }

    const run = await writeRunArtifacts({
      dir: outDir,
      key: variant.key,
      call,
      transcript: { greeting: report?.agentGreeting ?? null, replies: report?.agentReplies ?? [] },
    });
    runs.push(run);
    summaries.push({
      key: variant.key,
      label: variant.label,
      overrides: variant.env,
      pipeline: report?.pipeline ?? null,
    });

    console.log(
      `  agent joined after ${call.agentJoinedMs ?? '—'}ms` +
        (call.mixStats
          ? ` · mix ${call.mixStats.segments} segments, ${call.mixStats.overlappingSegments} overlapping (${call.mixStats.overlapMs}ms)`
          : ''),
    );
    for (const t of call.turns) {
      const latency = t.responseLatencyMs === null ? 'NO REPLY' : `${t.responseLatencyMs}ms`;
      console.log(`  ${latency.padStart(9)}  "${t.said}"`);
    }
  } finally {
    stopWorker(worker.pid);
  }
}

// ── Gate 5: the agent itself reported different configuration per variant ───────────────────
warnings.push(...assertPipelinesDiffer(summaries, keys));

const html = renderPage({
  title: `A/B · ${scenario.name} · ${variants.map((v) => v.key).join(' vs ')}`,
  scenarioName: scenario.name,
  scenarioDescription: scenario.description,
  variants: summaries,
  runs,
  warnings,
  generatedAt: new Date().toISOString(),
});
const pagePath = resolve(outDir, 'index.html');
await writeFile(pagePath, html);

console.log(`\n${'─'.repeat(70)}`);
for (const w of warnings) console.log(`  ⚠ ${w}`);
console.log(`\nOPEN THIS AND LISTEN:\n  ${pagePath}\n`);

// A run whose variants could not be told apart is a failed run, however pretty the page is.
const fatal = warnings.some((w) => w.startsWith('IDENTICAL') || w.includes('WRONG AGENT'));
process.exit(fatal ? 1 : 0);

// ---------------------------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Starts one agent worker with this variant's overlay and waits until LiveKit has registered it.
 *
 * Waiting for the REGISTRATION LINE, not for a timer: a worker that is still compiling has not
 * joined any dispatch pool, so a call placed against it fails with "no agent joined" and looks
 * like a broken variant rather than a slow laptop.
 */
async function startWorker(opts: { overlayPath: string; agentName: string }): Promise<{ pid: number }> {
  if (!existsSync(TSX_CLI)) {
    throw new Error(`tsx not found at ${TSX_CLI} — run this from the repo root (npm run voice:ab:call)`);
  }
  const child = spawn(
    process.execPath,
    [TSX_CLI, AGENT_ENTRY, 'dev'],
    {
      env: {
        ...process.env,
        // Neither key exists in .env, so dotenv's override cannot clobber them. That is the whole
        // reason the mechanism works — see env-overlay.ts.
        VOICE_TEST_OVERLAY: opts.overlayPath,
        VOICE_DEV_AGENT_NAME: opts.agentName,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const pid = child.pid;
  if (pid === undefined) throw new Error('failed to spawn the agent worker');

  return await new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopWorker(pid);
      rejectReady(new Error(`worker did not register within ${WORKER_READY_TIMEOUT_MS / 1000}s`));
    }, WORKER_READY_TIMEOUT_MS);

    const watch = (chunk: Buffer): void => {
      const text = chunk.toString();
      // Surface the two lines that prove the run is honest, and swallow the rest of the noise.
      for (const line of text.split(/\r?\n/u)) {
        if (line.includes('voice_test_overlay') || line.includes('worker_dispatch')) {
          console.log(`  [worker] ${line.trim()}`);
        }
      }
      if (!settled && text.includes('registered worker')) {
        settled = true;
        clearTimeout(timer);
        console.log(`  [worker] registered as "${opts.agentName}" (pid ${pid})`);
        resolveReady({ pid });
      }
    };
    child.stdout?.on('data', watch);
    child.stderr?.on('data', watch);
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectReady(new Error(`agent worker exited with code ${code} before registering`));
    });
  });
}

/**
 * Kills the worker AND its children.
 *
 * `cli.runApp` forks a child process per job. On Windows `child.kill()` reaches only the process we
 * spawned, and an orphaned job process stays registered — which then answers the NEXT variant's
 * call with the PREVIOUS variant's config. That is a silent wrong-answer, so the tree kill is not
 * housekeeping.
 */
function stopWorker(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
