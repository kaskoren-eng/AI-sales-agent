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
import { createHash } from 'node:crypto';
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

/**
 * THE AGENT MUST SHARE THE API'S ENCRYPTION KEY, AND IT DID NOT.
 *
 * `oauth_connections` holds each tenant's Google refresh token, encrypted AES-256-GCM with
 * `ENCRYPTION_KEY`. The API writes those rows; the AGENT reads them when it resolves whose calendar
 * to book into. Two processes, one ciphertext, one key — so the key has to be the same value in
 * both places.
 *
 * It was not. The agent was created with `--secrets-file .env.agent`, a laptop file whose
 * ENCRYPTION_KEY has never matched production (fingerprints 60e05bd1… vs fa0cacfe…). Same root
 * cause as the DATABASE_URL incident: a local config shipped to the cloud.
 *
 * The failure is quiet and looks like something else entirely. `resolveCalendarAuth` catches the
 * decryption error, logs it, and falls through to "this tenant has no calendar" — so the agent
 * reports `tools_disabled reason=calendar_not_configured` for a tenant whose calendar the dashboard
 * shows as connected. ClickScales was unaffected and hid it, because the platform tenant uses
 * service-account credentials from plain env vars and never decrypts anything.
 *
 * The three OAUTH values are needed for the same path: without them `loadConnection` returns null
 * before decryption is even attempted, so a tenant calendar fails twice over.
 */
const encryptionKey = railwayVar('AI-sales-agent', 'ENCRYPTION_KEY');
const oauthClientId = railwayVar('AI-sales-agent', 'GOOGLE_CALENDAR_OAUTH_CLIENT_ID');
const oauthClientSecret = railwayVar('AI-sales-agent', 'GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET');
const oauthRedirectUri = railwayVar('AI-sales-agent', 'GOOGLE_CALENDAR_OAUTH_REDIRECT_URI');

const missing = [];
if (!databaseUrl) missing.push('Postgres/DATABASE_PUBLIC_URL');
if (!redisUrl) missing.push('Redis/REDIS_PUBLIC_URL');
if (!encryptionKey) missing.push('AI-sales-agent/ENCRYPTION_KEY');
if (!oauthClientId) missing.push('AI-sales-agent/GOOGLE_CALENDAR_OAUTH_CLIENT_ID');
if (!oauthClientSecret) missing.push('AI-sales-agent/GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET');
if (!oauthRedirectUri) missing.push('AI-sales-agent/GOOGLE_CALENDAR_OAUTH_REDIRECT_URI');
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
  // Read from the API's own service, so the two processes cannot drift apart again.
  ENCRYPTION_KEY: encryptionKey,
  GOOGLE_CALENDAR_OAUTH_CLIENT_ID: oauthClientId,
  GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: oauthClientSecret,
  GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: oauthRedirectUri,
};

/** Secrets whose VALUE must never be printed — only a fingerprint, so a mismatch is still visible. */
const SENSITIVE = new Set([
  'ENCRYPTION_KEY',
  'GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET',
  'GOOGLE_CALENDAR_OAUTH_CLIENT_ID',
]);

console.log('will set on the LiveKit Cloud agent:');
for (const [k, v] of Object.entries(secrets)) {
  const shown = SENSITIVE.has(k)
    ? `sha256:${createHash('sha256').update(String(v)).digest('hex').slice(0, 12)}`
    : k.endsWith('_URL')
      ? describe(v)
      : v;
  console.log(`  ${k.padEnd(36)} ${shown}`);
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
