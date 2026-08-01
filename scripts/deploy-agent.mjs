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
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

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

// `--secrets-file` resolves relative to the CWD (the repo root), NOT to the working-dir argument.
const args = [
  'agent',
  MODE,
  ...(MODE === 'create' ? ['--secrets-file', '.env.agent', '--ignore-empty-secrets', '--region', REGION] : []),
  STAGE,
];

console.log(`lk ${args.join(' ')}\n`);
const r = spawnSync('lk', args, { stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
