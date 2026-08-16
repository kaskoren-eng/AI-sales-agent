/**
 * Assign a phone number to a tenant — the database half of onboarding a DID.
 *
 * The provisioning model is hybrid: ClickScales buys the number and assigns it; the customer never
 * touches telephony. So onboarding is two steps, and this script is the first:
 *
 *   1. THIS SCRIPT — insert/update the `phone_numbers` row so inbound calls route to the tenant.
 *   2. ZADARMA PORTAL — point that number's forwarding at the SIP URI (see infra/livekit-sip/).
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
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

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

const client = new pg.Client({ connectionString: env('DATABASE_URL') });
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
    console.log('Inbound calls to it are now refused with the not-in-service announcement.');
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
  console.log('');
  console.log('NEXT: point this number at our SIP URI in the Zadarma portal (infra/livekit-sip/README.md).');
} finally {
  await client.end();
}
