#!/usr/bin/env node
/**
 * Rewrite the LiveKit Cloud agent's connection secrets from Railway's PUBLIC endpoints.
 *
 * WHY THIS EXISTS. The agent was created with `--secrets-file .env.agent`, and that file is a
 * LAPTOP config: DATABASE_URL=localhost:5432, REDIS_URL=redis:6379 (a docker-compose hostname),
 * and empty PLATFORM_TENANT_ID / VOICE_WEBHOOK_TENANT_ID which `--ignore-empty-secrets` then
 * skipped entirely.
 *
 * Inside a LiveKit Cloud container `localhost` is the container, and `redis` resolves to nothing.
 * So the agent has had no database and no Redis. That is not a crash — every DB read fails, the
 * tool gate fails CLOSED exactly as designed, and the call runs with no tools, writes no
 * call_learnings row, and meters nothing. Since DID routing shipped it is worse: a call cannot be
 * attributed to a tenant, so it is refused with "not in service".
 *
 * Railway's INTERNAL hostnames (postgres.railway.internal) resolve only inside Railway's network.
 * LiveKit Cloud is a different network, so the agent needs the PUBLIC URLs. That is the whole fix.
 *
 * No secret is printed. Values are read from the Railway CLI, written to a temp file, uploaded,
 * and the file is deleted — including if the upload fails.
 *
 *   railway run --service Postgres node scripts/fix-agent-secrets.mjs --dry-run
 *   railway run --service Postgres node scripts/fix-agent-secrets.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DRY = process.argv.includes('--dry-run');
const PLATFORM_TENANT_ID = '613d826c-ad00-4302-9817-1c0649ed4f98';

/** Read one variable from a Railway service without ever echoing it. */
function railwayVar(service, name) {
  // shell: true because on Windows `railway` is a .cmd shim that execFile cannot spawn directly.
  const out = execFileSync('railway', ['variables', '--service', service, '--kv'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  const line = out.split('\n').find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : null;
}

/** Host:port only — enough to verify the fix landed, useless to an attacker. */
const describe = (url) => {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '(default)'}`;
  } catch {
    return '(unparseable)';
  }
};

const databaseUrl = railwayVar('Postgres', 'DATABASE_PUBLIC_URL');
const redisUrl = railwayVar('Redis', 'REDIS_PUBLIC_URL');

const missing = [];
if (!databaseUrl) missing.push('Postgres/DATABASE_PUBLIC_URL');
if (!redisUrl) missing.push('Redis/REDIS_PUBLIC_URL');
if (missing.length) {
  console.error(`could not read: ${missing.join(', ')}`);
  console.error('Are you logged in to Railway and linked to the project?');
  process.exit(1);
}

const secrets = {
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  // Empty in .env.agent, so --ignore-empty-secrets dropped them. Without PLATFORM_TENANT_ID the
  // calendar resolver never takes the service-account branch, so ClickScales' own agent would have
  // no calendar even once the database is reachable.
  PLATFORM_TENANT_ID,
  VOICE_WEBHOOK_TENANT_ID: PLATFORM_TENANT_ID,
};

console.log('will set on the LiveKit Cloud agent:');
for (const [k, v] of Object.entries(secrets)) {
  console.log(`  ${k.padEnd(24)} ${k.endsWith('_URL') ? describe(v) : v}`);
}

if (DRY) {
  console.log('\n--dry-run: nothing uploaded.');
  process.exit(0);
}

const dir = mkdtempSync(path.join(tmpdir(), 'agent-secrets-'));
const file = path.join(dir, 'secrets.env');
try {
  writeFileSync(
    file,
    Object.entries(secrets)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );

  console.log('\nuploading (this restarts the agent)...');
  const r = spawnSync('lk', ['agent', 'update-secrets', '--secrets-file', file], {
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0) {
    console.error('\nupload failed — secrets unchanged.');
    process.exit(r.status ?? 1);
  }
  console.log('\ndone. Confirm with:  lk agent status');
} finally {
  // The file holds live credentials; remove it whether or not the upload worked.
  rmSync(dir, { recursive: true, force: true });
}
