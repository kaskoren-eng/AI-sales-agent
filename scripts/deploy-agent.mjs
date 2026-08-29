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
// `patches` is load-bearing: package.json's postinstall runs patch-package, and the Soniox
// finalize patch is what keeps end-of-turn at the VAD timer instead of ~565ms. Without it
// staged, `npm ci` finds no patches, applies nothing, and the agent silently runs slow.
const INCLUDE = ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'assets', 'patches'];

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
    throw new Error(`${file} not found - it is uploaded on every deploy (--secrets-file). Create it from .env.example, then make it cloud-ready with: node scripts/fix-agent-secrets.mjs`);
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

// EVERY DEPLOY, NOT ONLY create. Since the secrets-on-every-deploy change, `--secrets-file
// .env.agent` is passed unconditionally and `lk` REPLACES the whole secret set. Leaving this
// assert on the create path meant a normal deploy could upload an unvalidated .env.agent over
// production's working secrets — and .env.agent is, by design, a LAPTOP config (that is why
// scripts/fix-agent-secrets.mjs exists). The agent would not crash: it would lose its database,
// fail the tool gate CLOSED, meter nothing, and refuse DID-routed calls as "not in service".
// That is the 2026-08-16 incident. The file is uploaded on every deploy, so it is checked on
// every deploy.
// SECRETS ARE OPT-IN ON AN EXISTING AGENT, AND THAT IS NOT A WEAKENING OF THE RULE BELOW.
//
// That rule assumes `.env.agent` MIRRORS the cloud. On this machine it does not and never has:
// `lk agent secrets` lists 45 secrets on CA_azGQ9uaLxpot, while the best local `.env.agent` has 28
// — with laptop values. The cloud set is the source of truth, maintained by
// scripts/fix-agent-secrets.mjs, which merges a small correct subset into it. Uploading the local
// file wholesale would drop or corrupt production's settings: the very outage the secrets rule was
// written to prevent, arriving from the other direction.
//
// So a plain deploy ships CODE and leaves secrets untouched. Pass --with-secrets once you have
// genuinely made .env.agent a full mirror — it is validated first, on every path that uploads.
const WITH_SECRETS = MODE === 'create' || process.argv.includes('--with-secrets');

if (WITH_SECRETS) await assertDeployableSecrets('.env.agent');


// SECRETS GO UP ON EVERY DEPLOY, NOT ONLY ON CREATE.
//
// They used to be passed only when MODE === 'create', so `npm run agent:deploy` shipped new CODE
// against whatever secrets happened to be live. On 2026-08-16 that meant the deployed agent spoke
// Cartesia `sonic-3` for hours while `.env.agent` said `sonic-3.5` and every local check agreed
// with the file. Nothing in the deploy output hints at it — the build succeeds, the agent restarts,
// and the config silently is not what the repo says it is. That is the worst shape a bug can have,
// and the fix is one flag.
//
// `--secrets-file` resolves relative to the CWD (the repo root), NOT to the working-dir argument.
//
// ALWAYS THE WHOLE FILE. `lk` REPLACES the secret set rather than merging into it, so a partial
// `--secrets K=V` deletes everything not listed — that destroyed all 25 secrets on 2026-08-16,
// OPENAI_API_KEY and CARTESIA_API_KEY included, and the agent answered calls with no LLM. Passing
// `.env.agent` entire is what makes replace-semantics safe. Never hand this flag a subset.
const args = [
  'agent',
  MODE,
  ...(WITH_SECRETS ? ['--secrets-file', '.env.agent', '--ignore-empty-secrets'] : []),
  ...(MODE === 'create' ? ['--region', REGION] : []),
  STAGE,
];

if (!WITH_SECRETS) {
  console.log('secrets: NOT uploaded (code-only deploy) — the agent keeps its cloud secrets.');
  console.log('         to upload .env.agent instead, re-run with --with-secrets');
}

console.log(`lk ${args.join(' ')}\n`);
const r = spawnSync('lk', args, { stdio: 'inherit', shell: true });

// Record AFTER success only. A ref for a version that never shipped would make the next deploy's
// comparison wrong in the one direction that matters — claiming work is live when it is not.
if (r.status === 0) recordDeploy();

process.exit(r.status ?? 1);
