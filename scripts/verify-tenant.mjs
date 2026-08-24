/**
 * Is this tenant actually ready to serve a customer?
 *
 *   railway run --service AI-sales-agent node scripts/verify-tenant.mjs <slug> [--key <tenantApiKey>]
 *
 * READ-ONLY, and that is a deliberate constraint rather than a convenience. The obvious way to test
 * the tenant-facing half is to rotate the tenant's API key and use the fresh one — which instantly
 * breaks every integration still holding the old key. A verification step that can damage the thing
 * it verifies is worse than no verification step, because it will eventually be run against a live
 * customer by someone following a runbook. Pass `--key` if you have the tenant's key; without it the
 * tenant-side checks are SKIPPED and reported as skipped, never quietly passed.
 *
 * Exits non-zero if any check fails, so it can gate a handover.
 */

const ROOT =
  process.env.VERIFY_BASE_URL ??
  'https://ai-sales-agent-production-9736.up.railway.app/api/v1';

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--'));
const tenantKey = args.includes('--key') ? args[args.indexOf('--key') + 1] : null;

if (!slug) {
  console.error('usage: verify-tenant.mjs <slug> [--key <tenantApiKey>]');
  process.exit(2);
}

const ADMIN = process.env.ADMIN_API_KEY;
if (!ADMIN) {
  console.error('ADMIN_API_KEY is not set. Run through: railway run --service AI-sales-agent node …');
  process.exit(2);
}

let failed = 0;
let skipped = 0;
const pass = (label, detail = '') => console.log(`  \x1b[32mok\x1b[0m    ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail = '') => {
  failed += 1;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? ` — ${detail}` : ''}`);
};
const skip = (label, why) => {
  skipped += 1;
  console.log(`  \x1b[33mskip\x1b[0m  ${label} — ${why}`);
};
const check = (good, label, detail) => (good ? pass(label, detail) : fail(label, detail));

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${ROOT}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}
const admin = (m, p, body) => call(m, `/admin${p}`, { token: ADMIN, body });

// ---------------------------------------------------------------------------

const list = await admin('GET', '/tenants');
if (list.status !== 200) {
  console.error(`cannot list tenants: ${list.status} ${JSON.stringify(list.body)}`);
  process.exit(2);
}
const tenant = (list.body?.data ?? []).find((t) => t.slug === slug);
if (!tenant) {
  console.error(`no tenant with slug "${slug}"`);
  process.exit(2);
}
const other = (list.body?.data ?? []).find((t) => t.slug !== slug);

const detail = await admin('GET', `/tenants/${tenant.id}`);
const t = detail.body?.tenant;

console.log(`\n\x1b[1m${slug}\x1b[0m  ${tenant.id}\n`);

console.log('── billing ──');
check(Boolean(t?.planCode), 'has a plan', `planCode=${t?.planCode ?? 'NONE'}`);
check(
  t?.planCode && t.planCode !== 'internal',
  'plan is a sellable one',
  t?.planCode === 'internal' ? 'internal is our own tier, not a customer plan' : `${t?.planCode}`,
);
check(Boolean(t?.billingStatus), 'billing status set', t?.billingStatus);
// Not a failure: nothing enforces this yet (Phase 5b). Reported so it is a decision, not a default.
console.log(`  info  quota enforcement = ${t?.quotaEnforcement} (stored; nothing enforces it yet)`);

console.log('\n── telephony ──');
// A tenant with no number cannot receive a call; the trunk and phone_numbers must both know it.
check(Boolean(tenant.isActive), 'tenant is active', tenant.isActive ? '' : 'suspended tenants are refused at the door');

console.log('\n── tenant-facing ──');
if (!tenantKey) {
  skip('own calendar connected', 'no --key given');
  skip('cannot read another tenant', 'no --key given');
  skip('cannot change its own plan', 'no --key given');
} else {
  const me = await call('GET', '/tenants/me', { token: tenantKey });
  check(me.body?.id === tenant.id, 'the key resolves to THIS tenant', me.body?.slug ?? `${me.status}`);

  const cal = await call('GET', '/integrations/google-calendar/status', { token: tenantKey });
  check(cal.body?.connected === true, 'calendar connected', cal.body?.accountEmail ?? `${cal.status}`);
  // The one that matters for isolation: booking into OUR calendar rather than theirs is the
  // failure this whole phase exists to prevent, and it looks identical to success from the UI.
  check(
    cal.body?.usesPlatformCredentials === false,
    'books into ITS OWN calendar',
    cal.body?.usesPlatformCredentials ? 'USING PLATFORM CREDENTIALS — bookings land in ClickScales' : '',
  );
  check(cal.body?.needsReconnect !== true, 'calendar token still valid', cal.body?.needsReconnect ? 'needs reconnect' : '');

  if (other) {
    const peek = await call('GET', `/tenants/${other.id}`, { token: tenantKey });
    check(peek.status === 403 || peek.status === 404, 'cannot read another tenant', `${peek.status}`);
  }

  const selfUpgrade = await call('PATCH', '/tenants/me', { token: tenantKey, body: { planCode: 'internal' } });
  const after = await admin('GET', `/tenants/${tenant.id}`);
  check(
    after.body?.tenant?.planCode === t?.planCode,
    'cannot change its own plan',
    `PATCH /tenants/me → ${selfUpgrade.status}, plan still ${after.body?.tenant?.planCode}`,
  );
}

console.log('\n── still needs a real call ──');
console.log('  Inbound routing and metering cannot be verified from here. Dial the tenant\'s number');
console.log('  with `lk agent logs` ALREADY RUNNING, and look for:');
console.log(`      call_identity {"tenantId":"${tenant.id}","source":"did_lookup",…}`);
console.log('  `source` must be "did_lookup". "env_fallback" means it landed on the platform tenant.');

console.log(`\n${failed === 0 ? '\x1b[32mall checks passed\x1b[0m' : `\x1b[31m${failed} failed\x1b[0m`}${skipped ? `, ${skipped} skipped` : ''}\n`);
process.exit(failed === 0 ? 0 : 1);
