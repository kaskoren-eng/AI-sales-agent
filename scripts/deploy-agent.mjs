/**
 * Deploys the LiveKit voice agent to LiveKit Cloud.
 *
 *   node scripts/deploy-agent.mjs create    first time (creates the agent + uploads secrets)
 *   node scripts/deploy-agent.mjs deploy    every time after (ships a new version)
 *
 * WHY A STAGING DIRECTORY INSTEAD OF JUST RUNNING `lk agent create`.
 *
 * `lk` builds whatever it finds at `Dockerfile` in the working directory. Our repo root already has
 * one — the FASTIFY API's — and it is `node:20-alpine`, which pulls in the dashboard and cannot run
 * the agent at all (LiveKit's native audio ships no musl build; an Alpine agent boots fine and then
 * dies on the first call). Pointing `lk` at the repo root made it build the API and fail on a
 * missing dashboard directory.
 *
 * Renaming the API's Dockerfile to get out of the way would break the API's own deploy. So instead
 * this stages a build context containing ONLY what the agent needs, with the agent's Dockerfile as
 * `Dockerfile`, and points `lk` at that. The two deploys stop fighting over one filename.
 *
 * SECRETS never enter the image: they are uploaded via `--secrets-file` and injected as environment
 * variables at runtime. `.env` is excluded from the build context entirely — anything baked into an
 * image layer is permanent and extractable by anyone who can pull it.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { assertDeployableCode, assertNotBehindMain } from './lib/deploy-guard.mjs';
import { assertNotDroppingLiveWork, recordDeploy } from './lib/deploy-ledger.mjs';

const MODE = process.argv[2] ?? 'deploy';
const STAGE = '.agent-build';
const REGION = 'eu-central';

// Only what the agent process actually needs to build and run.
// `assets` carries the compliance recording-notice WAV (assets/recording-notice.wav), which
// Dockerfile.agent COPYs in — must be staged or the build fails at "COPY assets ./assets".
const INCLUDE = ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'assets'];

await rm(STAGE, { recursive: true, force: true });
await mkdir(STAGE, { recursive: true });
for (const item of INCLUDE) {
  await cp(item, `${STAGE}/${item}`, { recursive: true });
}
await cp('Dockerfile.agent', `${STAGE}/Dockerfile`);
// livekit.toml carries the agent ID, so `lk` knows WHICH agent this is a new version of.
// It lives at the repo root (that is where `lk agent config` writes it) and must travel with the
// staged context, which is wiped and rebuilt on every deploy.
await cp('livekit.toml', `${STAGE}/livekit.toml`).catch(() => {
  throw new Error('livekit.toml missing — run: lk agent config --id <CA_...>');
});

// The agent's build context contains no secrets and no caller data. Stated explicitly rather than
// relied upon: `.env` and call-reports/ are simply never copied above.
await writeFile(`${STAGE}/.dockerignore`, ['node_modules', 'dist', '.env', '.env.*'].join('\n') + '\n');

/**
 * REFUSE TO SHIP A LAPTOP CONFIG.
 *
 * The agent was created once with `--secrets-file .env.agent` while that file still held
 * DATABASE_URL=localhost:5432 and REDIS_URL=redis:6379 — a docker-compose config. Inside a
 * LiveKit Cloud container `localhost` is the container and `redis` resolves to nothing, so the
 * agent ran for days with no database at all.
 *
 * It never crashed, which is what made it expensive. Every DB read failed, the tool gate failed
 * CLOSED exactly as designed, and calls ran with no tools, wrote no call_learnings row and metered
 * nothing. After DID routing shipped, a call could not be attributed to a tenant and was refused
 * outright. The system behaved as though it had been configured to do that.
 *
 * A hostname is checkable, so check it. `--ignore-empty-secrets` is the other half of the same
 * trap: it silently drops empty values, which is how PLATFORM_TENANT_ID never reached the cloud.
 */
async function assertDeployableSecrets(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new Error(`${file} not found - create mode needs it to upload secrets`);
  }

  const LOCAL_HOST = /(^|[@/])(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal|redis|postgres|db)(:\d+)?([/?]|$)/i;
  const REQUIRED = ['DATABASE_URL', 'REDIS_URL', 'PLATFORM_TENANT_ID', 'OPENAI_API_KEY'];

  const values = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }

  const problems = [];
  for (const key of REQUIRED) {
    const value = values.get(key);
    if (!value) {
      problems.push(`${key} is empty or missing - --ignore-empty-secrets would drop it silently`);
    } else if (key.endsWith('_URL') && LOCAL_HOST.test(value)) {
      problems.push(`${key} points at a local host - unreachable from LiveKit Cloud`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `${file} is not deployable:\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\n\nThis file is for running the agent on your machine. The cloud agent needs the PUBLIC\n' +
        'endpoints (Railway exposes DATABASE_PUBLIC_URL / REDIS_PUBLIC_URL).\n' +
        'Fix them with: node scripts/fix-agent-secrets.mjs',
    );
  }
}

// Three questions, in widening scope: is this build broken (markers), is it a rollback of merged
// work (main), is it a rollback of work that is LIVE but never merged (the ledger). Only the third
// can see another session's unmerged worktree, which is the common case on this machine.
await assertDeployableCode(STAGE);
assertNotBehindMain({ allowBehind: process.argv.includes('--allow-behind') });
if (MODE !== 'create') {
  assertNotDroppingLiveWork({ allowDrop: process.argv.includes('--allow-drop') });
}

if (MODE === 'create') await assertDeployableSecrets('.env.agent');

// `--secrets-file` resolves relative to the CWD (the repo root), NOT to the working-dir argument.
const args = [
  'agent',
  MODE,
  ...(MODE === 'create' ? ['--secrets-file', '.env.agent', '--ignore-empty-secrets', '--region', REGION] : []),
  STAGE,
];

console.log(`lk ${args.join(' ')}\n`);
const r = spawnSync('lk', args, { stdio: 'inherit', shell: true });

// Record AFTER success only. A ref for a version that never shipped would make the next deploy's
// comparison wrong in the one direction that matters — claiming work is live when it is not.
if (r.status === 0) recordDeploy();

process.exit(r.status ?? 1);
