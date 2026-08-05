#!/usr/bin/env node
/**
 * Print the signed webhook URLs for a tenant.
 *
 * Inbound webhooks arrive with no credential of ours, so the tenant is carried in the URL and the
 * URL is signed — see src/modules/webhooks/webhook-tokens.ts. That makes the URL itself a secret:
 * anyone holding it can post events into that tenant. Treat it like a password.
 *
 *   node scripts/webhook-url.mjs clickscales
 *
 * Reads ENCRYPTION_KEY and a database URL from the environment.
 *
 * Against production from a laptop, the two live on different Railway services — ENCRYPTION_KEY on
 * the app, and the only externally-resolvable database URL on Postgres (the app's DATABASE_URL is
 * `postgres.railway.internal`, which resolves only inside Railway's network). So:
 *
 *   DBPUB=$(railway variables --service Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
 *   railway run --service AI-sales-agent env DATABASE_PUBLIC_URL="$DBPUB" \
 *     node scripts/webhook-url.mjs clickscales
 *
 * Locally, a plain `node scripts/webhook-url.mjs clickscales` with a .env is enough.
 */
import { createHmac } from 'node:crypto';
import pg from 'pg';

const slug = process.argv[2];
if (!slug) {
  console.error('usage: node scripts/webhook-url.mjs <tenant-slug>');
  process.exit(1);
}

const secret = process.env.ENCRYPTION_KEY;
if (!secret) {
  console.error('ENCRYPTION_KEY is not set — the URLs are derived from it and would be wrong.');
  process.exit(1);
}

const baseUrl = (process.env.BASE_URL ?? process.env.DASHBOARD_BASE_URL ?? '').replace(/\/$/, '');

// Mirrors buildWebhookToken() in src/modules/webhooks/webhook-tokens.ts. Kept in sync by
// webhook-tokens.test.ts, which asserts a known token against a fixed key.
const token = (provider, tenantId) =>
  `${tenantId}.${createHmac('sha256', secret).update(`webhook-url:v1:${provider}:${tenantId}`).digest('hex').slice(0, 32)}`;

const client = new pg.Client({
  connectionString: process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});
await client.connect();

const { rows } = await client.query('SELECT id, name, slug FROM tenants WHERE slug = $1', [slug]);
await client.end();

if (rows.length === 0) {
  console.error(`No tenant with slug "${slug}".`);
  process.exit(1);
}

const tenant = rows[0];
console.log(`\n  ${tenant.name}  [${tenant.slug}]\n`);
console.log('  Monday.com webhook URL — paste this into the board\'s integration:\n');
console.log(`    ${baseUrl || '<BASE_URL>'}/webhooks/leads/monday/${token('monday', tenant.id)}\n`);
console.log('  This URL is a credential. Anyone who has it can post events into this tenant.');
console.log('  It changes if ENCRYPTION_KEY is rotated — re-run this and update the vendor then.\n');
