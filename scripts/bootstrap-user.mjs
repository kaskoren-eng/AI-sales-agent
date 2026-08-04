#!/usr/bin/env node
/**
 * Create a user on an EXISTING tenant and print a one-time password-setup link.
 *
 * WHY THIS EXISTS: POST /auth/register creates a brand-new tenant, which is right for a new
 * customer and wrong for the tenants that already exist (clickscales and friends predate accounts
 * entirely). This is the operator path for "give a human a login on a tenant that is already
 * there" — the first user of each existing workspace, and the break-glass path if every owner of a
 * workspace loses access.
 *
 * NO PASSWORD IS EVER PASSED IN OR PRINTED. The script creates the account without one and issues
 * a password_reset token; the person clicks the link and chooses their own. A password that
 * travels through a terminal, a shell history, or a chat window is already compromised.
 *
 * Usage:
 *   node scripts/bootstrap-user.mjs --email you@example.com --tenant clickscales [--role owner]
 *
 * Against production, inject DATABASE_URL rather than hardcoding it:
 *   railway run --service Postgres node scripts/bootstrap-user.mjs --email ... --tenant ...
 *   (the Postgres service exposes DATABASE_PUBLIC_URL, which this script prefers)
 */
import pg from 'pg';
import { randomBytes, createHash } from 'node:crypto';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const email = String(args.email ?? '').trim().toLowerCase();
const tenantSlug = String(args.tenant ?? '').trim();
const role = String(args.role ?? 'owner');
const baseUrl = process.env.DASHBOARD_BASE_URL ?? args.baseUrl ?? '';

if (!email || !tenantSlug) {
  console.error('usage: bootstrap-user.mjs --email <email> --tenant <slug> [--role owner|admin|member|viewer]');
  process.exit(1);
}
if (!['owner', 'admin', 'member', 'viewer'].includes(role)) {
  console.error(`invalid role: ${role}`);
  process.exit(1);
}

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL (or DATABASE_PUBLIC_URL) is not set');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });
const RESET_TTL_MINUTES = 60;

try {
  const { rows: tenantRows } = await pool.query(
    'SELECT id, name FROM tenants WHERE slug = $1 LIMIT 1',
    [tenantSlug],
  );
  if (tenantRows.length === 0) {
    console.error(`no tenant with slug "${tenantSlug}"`);
    process.exit(1);
  }
  const tenant = tenantRows[0];

  await pool.query('BEGIN');

  // Idempotent: re-running for the same person issues a fresh link rather than erroring, which is
  // what you actually want when the first link expired or went to the wrong inbox.
  const { rows: userRows } = await pool.query(
    `INSERT INTO users (email, locale) VALUES ($1, 'he')
     ON CONFLICT (email) DO UPDATE SET updated_at = now()
     RETURNING id, password_hash`,
    [email],
  );
  const user = userRows[0];

  await pool.query(
    `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
    [tenant.id, user.id, role],
  );

  // Supersede any outstanding reset so an older emailed link stops working.
  await pool.query(
    `UPDATE auth_tokens SET used_at = now()
     WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`,
    [user.id],
  );

  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, 'password_reset', $2, now() + interval '${RESET_TTL_MINUTES} minutes')`,
    [user.id, tokenHash],
  );

  await pool.query('COMMIT');

  const link = baseUrl
    ? `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`
    : `(set DASHBOARD_BASE_URL to get a clickable link) token=${token}`;

  console.log('');
  console.log(`  user       ${email}${user.password_hash ? ' (existing account)' : ' (new account)'}`);
  console.log(`  workspace  ${tenant.name} [${tenantSlug}]`);
  console.log(`  role       ${role}`);
  console.log('');
  console.log('  Password setup link — valid for 60 minutes, single use:');
  console.log(`  ${link}`);
  console.log('');
  console.log('  This is shown ONCE. Re-run this script to issue a new one.');
  console.log('');
} catch (err) {
  await pool.query('ROLLBACK').catch(() => undefined);
  console.error('bootstrap failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await pool.end();
}
