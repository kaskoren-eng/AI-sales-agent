/**
 * Assign a phone number to a tenant — the database half of onboarding a DID.
 *
 * The provisioning model is hybrid: ClickScales buys the number and assigns it; the customer never
 * touches telephony. So onboarding is two steps, and this script is the first:
 *
 *   1. THIS SCRIPT — insert/update the `phone_numbers` row so inbound calls route to the tenant,
 *      AND put the number on the LiveKit inbound trunk so the call is accepted at the SIP layer.
 *   2. ZADARMA PORTAL — point that number's forwarding at the SIP URI (see infra/livekit-sip/).
 *
 * Step 1 does both halves on purpose. The trunk list and `phone_numbers` have to agree, and when a
 * human maintained the trunk by hand they did not: the checked-in trunk config said `numbers: []`
 * for weeks while production carried one number. The dangerous direction is a number in the
 * database but not on the trunk — the caller is refused at the SIP layer, our code never runs, and
 * nothing logs it. The customer reports it before we do.
 *
 * Do step 1 FIRST. A number forwarded to us with no row is answered with "not in service", which is
 * a caller hearing a dead line; a row with no forwarding is simply inert. Order the failure so it
 * lands on us rather than on the customer's lead.
 *
 * Usage:
 *   node scripts/provision-number.mjs --number +972555070922 --tenant <uuid> [--label "Acme main"]
 *   node scripts/provision-number.mjs --number +972555070922 --unassign
 *   node scripts/provision-number.mjs --number +972555070922 --deactivate
 *   node scripts/provision-number.mjs --list
 *   node scripts/provision-number.mjs --sync-trunk        # repair drift, touching no rows
 *   node scripts/provision-number.mjs --sync-trunk --dry-run
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { syncTrunkNumbers, expectedNumbers, diffNumbers, readInboundTrunk } from './lib/trunk-numbers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function env(name) {
  if (process.env[name]) return process.env[name];
  const line = readFileSync(join(ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} missing from environment and .env`);
  return line.slice(name.length + 1).trim();
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

/**
 * Mirrors `toE164` in src/shared/phone-number.ts.
 *
 * Duplicated deliberately: this script is plain ESM run by an operator against production, and
 * importing the TypeScript source would mean a build step between "customer is waiting" and "their
 * number works". The rule it encodes — store `+` and digits, reject anything else — is one line,
 * and the routing tests own the real implementation.
 */
function toE164(raw, defaultCountryCode = '972') {
  const cleaned = String(raw).trim().replace(/[^\d+]/g, '');
  if (!cleaned) return null;
  let digits;
  if (cleaned.startsWith('+')) digits = cleaned.slice(1);
  else if (cleaned.startsWith('00')) digits = cleaned.slice(2);
  else if (cleaned.startsWith('0')) digits = defaultCountryCode + cleaned.slice(1);
  else digits = cleaned;
  if (digits.includes('+')) return null;
  if (!/^\d{8,15}$/.test(digits)) return null;
  return `+${digits}`;
}

/**
 * DATABASE_PUBLIC_URL first, so this works from a laptop under `railway run --service Postgres`.
 * Railway injects DATABASE_URL as the INTERNAL host, which resolves only inside their network —
 * off-network it fails with a DNS error that reads like the database is down. Same order as
 * bootstrap-user.mjs, for the same reason.
 */
const connectionString =
  process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL || env('DATABASE_URL');
const client = new pg.Client({ connectionString });
await client.connect();

try {
  if (has('list')) {
    const { rows } = await client.query(
      `SELECT p.e164, p.label, p.is_active, p.tenant_id, t.name AS tenant_name
         FROM phone_numbers p
         LEFT JOIN tenants t ON t.id = p.tenant_id
        ORDER BY p.e164`,
    );
    if (rows.length === 0) {
      console.log('No numbers provisioned. Inbound calls to any DID will be refused.');
    }
    for (const r of rows) {
      const owner = r.tenant_name ?? (r.tenant_id ? r.tenant_id : 'UNASSIGNED');
      console.log(
        `${r.e164.padEnd(16)} ${r.is_active ? 'active  ' : 'inactive'} ${String(owner).padEnd(28)} ${r.label ?? ''}`,
      );
    }
    reportTrunk(rows);
    process.exit(0);
  }

  // Repair mode: make the trunk match the table without writing to the table. For fixing drift, and
  // for the first run after this script learned to do it at all.
  if (has('sync-trunk')) {
    const { rows } = await client.query('SELECT e164, tenant_id, is_active FROM phone_numbers');
    const res = syncTrunkNumbers(rows, { dryRun: has('dry-run') });
    if (res.dryRun) {
      console.log(`would set ${res.trunk.sipTrunkId} numbers to: ${res.expected.join(', ')}`);
      console.log(`  add:    ${res.diff.missing.join(', ') || '(none)'}`);
      console.log(`  remove: ${res.diff.extra.join(', ') || '(none)'}`);
    } else if (res.changed) {
      console.log(`trunk ${res.trunk.sipTrunkId} updated: ${res.expected.join(', ')}`);
      console.log(`IP allowlist intact: ${(res.trunk.allowedAddresses ?? []).join(', ')}`);
    } else {
      console.log(`trunk ${res.trunk.sipTrunkId} already matches the database.`);
    }
    process.exit(0);
  }

  const raw = arg('number');
  if (!raw) throw new Error('--number is required (or use --list)');
  const e164 = toE164(raw);
  if (!e164) throw new Error(`"${raw}" is not a usable phone number`);

  if (has('deactivate') || has('unassign')) {
    const { rows } = await client.query(
      `UPDATE phone_numbers
          SET ${has('deactivate') ? 'is_active = false' : 'tenant_id = NULL'}, updated_at = now()
        WHERE e164 = $1
        RETURNING e164, tenant_id, is_active`,
      [e164],
    );
    if (rows.length === 0) throw new Error(`${e164} is not provisioned`);
    console.log(`${e164}: tenant=${rows[0].tenant_id ?? 'NULL'} active=${rows[0].is_active}`);
    // Taking it off the trunk too means the call is refused at the SIP layer rather than costing a
    // room, a process and an announcement every time.
    await syncTrunkAfterWrite(client);
    console.log('Inbound calls to it are now refused at the trunk.');
    process.exit(0);
  }

  const tenantId = arg('tenant');
  if (!tenantId) throw new Error('--tenant <uuid> is required (or --unassign / --deactivate)');

  // Fail here rather than writing a row that points at nothing. A number mapped to a non-existent
  // tenant routes calls into a tenant read that returns nothing, which is far harder to diagnose
  // from a call recording than a refusal at provisioning time.
  const tenant = await client.query('SELECT id, name, is_active FROM tenants WHERE id = $1', [tenantId]);
  if (tenant.rows.length === 0) throw new Error(`no tenant ${tenantId}`);
  if (!tenant.rows[0].is_active) {
    console.warn(`WARNING: tenant "${tenant.rows[0].name}" is suspended — its calls will still be refused.`);
  }

  const { rows } = await client.query(
    `INSERT INTO phone_numbers (tenant_id, e164, label, is_active)
          VALUES ($1, $2, $3, true)
     ON CONFLICT (e164) DO UPDATE
            SET tenant_id = EXCLUDED.tenant_id,
                label = COALESCE(EXCLUDED.label, phone_numbers.label),
                is_active = true,
                updated_at = now()
       RETURNING e164, tenant_id, label`,
    [tenantId, e164, arg('label') ?? null],
  );

  console.log(`${rows[0].e164} -> ${tenant.rows[0].name} (${rows[0].tenant_id})`);
  await syncTrunkAfterWrite(client);
  console.log('');
  console.log('NEXT: point this number at our SIP URI in the Zadarma portal (infra/livekit-sip/README.md).');
} finally {
  await client.end();
}

/**
 * Push the table's state to the trunk after a write.
 *
 * A trunk failure must NOT fail the script: the row is already committed and the database is the
 * source of truth. But it must be impossible to miss, because the resulting state — a number that
 * routes in our code and is refused at the SIP layer — produces no log line anywhere and reads to
 * the customer as "your agent never answers". So it prints the repair command and says what is
 * broken until it is run.
 */
async function syncTrunkAfterWrite(db) {
  const { rows } = await db.query('SELECT e164, tenant_id, is_active FROM phone_numbers');
  try {
    const res = syncTrunkNumbers(rows);
    if (res.changed) {
      console.log(`trunk ${res.trunk.sipTrunkId}: ${res.expected.join(', ')}`);
    } else {
      console.log(`trunk ${res.trunk.sipTrunkId}: already correct`);
    }
  } catch (err) {
    console.error('');
    console.error('!! THE DATABASE IS UPDATED BUT THE SIP TRUNK IS NOT.');
    console.error(`!! ${err instanceof Error ? err.message : String(err)}`);
    console.error('!! Until this is fixed, calls to that number are rejected before our code runs,');
    console.error('!! and nothing will log it. Repair with:');
    console.error('!!     node scripts/provision-number.mjs --sync-trunk');
    process.exitCode = 1;
  }
}

/** Read-only drift report for `--list`. Never throws: listing must work without the LiveKit CLI. */
function reportTrunk(rows) {
  try {
    const trunk = readInboundTrunk();
    const actual = [...(trunk.numbers ?? [])].sort();
    console.log('');
    if (actual.length === 0) {
      console.log(`trunk ${trunk.sipTrunkId}: numbers list is EMPTY — it accepts every dialled number.`);
      console.log('  Run --sync-trunk to restore the list. See scripts/lib/trunk-numbers.mjs for why it matters.');
      return;
    }
    const { missing, extra } = diffNumbers(expectedNumbers(rows), actual);
    if (!missing.length && !extra.length) {
      console.log(`trunk ${trunk.sipTrunkId}: in sync (${actual.length} entries)`);
    } else {
      console.log(`trunk ${trunk.sipTrunkId}: OUT OF SYNC — run --sync-trunk`);
      // Listed first: this is the direction that gives a real customer a dead line.
      if (missing.length) console.log(`  in the database, NOT on the trunk: ${missing.join(', ')}`);
      if (extra.length) console.log(`  on the trunk, not in the database:  ${extra.join(', ')}`);
    }
  } catch (err) {
    console.log('');
    console.log(`(could not read the SIP trunk: ${err instanceof Error ? err.message : String(err)})`);
  }
}
