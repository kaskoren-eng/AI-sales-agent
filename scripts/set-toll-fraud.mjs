#!/usr/bin/env node
/**
 * Set (or reset) a tenant's toll-fraud daily spend cap — for Phase 6 layer 5.3 verification.
 *
 * Layer 5.3: drop the cap to $0.01, attempt an outbound dial → it must be blocked with 429
 * (SPEND_LIMIT_EXCEEDED). Then reset so normal dialing resumes.
 *
 *   # set the cap to $0.01 (default when no value given):
 *   DATABASE_URL="$(grep '^DATABASE_URL=' .agent-secrets.env | cut -d= -f2-)" \
 *     node scripts/set-toll-fraud.mjs <tenantId> 0.01
 *
 *   # reset — removes the override, falls back to the $50/day + 100-calls/day defaults:
 *   DATABASE_URL="$(grep '^DATABASE_URL=' .agent-secrets.env | cut -d= -f2-)" \
 *     node scripts/set-toll-fraud.mjs <tenantId> reset
 *
 * NOTE: the dollar cap blocks once TODAY's accumulated spend ≥ the cap. After any earlier-layer
 * call there is spend on the books, so $0.01 bites immediately. On a truly fresh day (zero calls)
 * the very first dial sees spend=0 and is allowed — run 5.3 after at least one call, or right after
 * any other layer that placed one.
 */
import pg from 'pg';
import { config } from 'dotenv';

config();

const [, , tenantId, arg] = process.argv;
if (!tenantId) {
  console.error('usage: set-toll-fraud.mjs <tenantId> <limitUsd|reset>');
  process.exit(1);
}
const reset = arg === 'reset';
const limitUsd = reset ? null : Number(arg ?? '0.01');
if (!reset && (!Number.isFinite(limitUsd) || limitUsd <= 0)) {
  console.error(`invalid limit "${arg}" — must be a positive number or "reset"`);
  process.exit(1);
}

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const before = await client.query(
    `SELECT name, settings->'toll_fraud' AS toll_fraud FROM tenants WHERE id = $1`,
    [tenantId],
  );
  if (before.rows.length === 0) {
    console.error(`tenant ${tenantId} not found`);
    process.exit(1);
  }
  console.log(`tenant: ${before.rows[0].name}`);
  console.log('before toll_fraud:', JSON.stringify(before.rows[0].toll_fraud));

  if (reset) {
    // Drop the override → resolver falls back to $50/day + 100 calls/day.
    await client.query(`UPDATE tenants SET settings = settings - 'toll_fraud', updated_at = now() WHERE id = $1`, [
      tenantId,
    ]);
    console.log('RESET — toll_fraud override removed (defaults: $50/day, 100 calls/day).');
  } else {
    // Merge only the dollar cap; perMinuteRate/callLimit fall to their defaults.
    await client.query(
      `UPDATE tenants
         SET settings = coalesce(settings, '{}'::jsonb)
             || jsonb_build_object('toll_fraud', jsonb_build_object('dailySpendLimitUsd', $2::numeric)),
             updated_at = now()
       WHERE id = $1`,
      [tenantId, limitUsd],
    );
    console.log(`SET — dailySpendLimitUsd = $${limitUsd}. Outbound dials block once today's spend ≥ that.`);
  }

  const after = await client.query(`SELECT settings->'toll_fraud' AS toll_fraud FROM tenants WHERE id = $1`, [
    tenantId,
  ]);
  console.log('after  toll_fraud:', JSON.stringify(after.rows[0].toll_fraud));
} finally {
  await client.end();
}
