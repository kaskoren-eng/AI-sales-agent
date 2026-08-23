#!/usr/bin/env node
/**
 * Onboard a brand-new tenant end to end, and report what customer #2 would actually hit.
 *
 * WHY A REHEARSAL AND NOT MORE UNIT TESTS. The unit suite was green through every one of the
 * problems this found, because each was a gap BETWEEN parts rather than inside one: tenant
 * creation never set a plan, the billing resolver treated "no plan" as free and unlimited, and
 * the operator console had no column that would have shown either. Nothing was individually
 * broken. The system just had no path where a second customer was walked from nothing to working.
 *
 * Run it against a THROWAWAY stack — it creates tenants, suspends one, and leaves rows behind:
 *
 *   docker run -d --name t2-pg -e POSTGRES_PASSWORD=t2 -e POSTGRES_DB=t2 -p 55434:5432 postgres:16-alpine
 *   docker run -d --name t2-redis -p 6390:6379 redis:7-alpine
 *   # apply src/db/migrations/*.sql in order, then start the API on :3010 with ADMIN_API_KEY set
 *   node scripts/rehearse-onboarding.mjs
 *
 * Override with BASE_URL and ADMIN_API_KEY. Never point it at production.
 */
const BASE = `${process.env.BASE_URL ?? 'http://127.0.0.1:3010'}/api/v1`;
const ADMIN = process.env.ADMIN_API_KEY ?? 'local-rehearsal-admin-key';

if (/railway\.app|clickscales/i.test(BASE)) {
  console.error('refusing to rehearse against what looks like production:', BASE);
  process.exit(2);
}

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${step}${detail ? ` — ${detail}` : ''}`);
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed = null;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

const short = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 130 ? s.slice(0, 130) + '…' : s;
};

console.log('\n── ONBOARDING TENANT #2 ────────────────────────────────────────\n');

// 1. Operator creates the workspace.
const created = await call('POST', '/admin/tenants', {
  token: ADMIN,
  body: { name: 'Acme Dental', slug: 'acme-dental', planCode: 'base' },
});
record('admin creates the tenant', created.status === 201 || created.status === 200, `${created.status} ${short(created.body)}`);
const tenant = created.body?.data ?? created.body?.tenant ?? created.body;
const tenantId = tenant?.id;
const apiKey = tenant?.apiKey;
if (!tenantId) {
  console.log('\ncannot continue without a tenant id');
  process.exit(1);
}

record('create response hides the stored key hash', !JSON.stringify(created.body).includes('apiKeyHash'), '');

// 2. Self-serve signup must still be closed.
const signup = await call('POST', '/auth/register', {
  body: { email: 'stranger@acme.test', password: 'a-long-enough-password', tenantName: 'Sneaky Co' },
});
record('self-serve signup stays closed', signup.status === 403, `${signup.status} ${signup.body?.error ?? ''}`);

// 3. The tenant's API key works and is scoped to it.
if (apiKey) {
  const me = await call('GET', '/tenants/me', { token: apiKey });
  record('tenant api key resolves to the right tenant', me.status === 200 && me.body?.id === tenantId, `${me.status}`);
} else {
  record('admin returned an api key at creation', false, 'no apiKey in the create response');
}

// 4. What a brand-new tenant sees on the pages a customer opens first.
const surfaces = [
  ['GET', '/metrics/summary?range=d7', 'Overview'],
  ['GET', '/leads?page=1&limit=20', 'Leads'],
  ['GET', '/calls?page=1&limit=20', 'Calls'],
  ['GET', '/scheduling/bookings', 'Bookings'],
  ['GET', '/integrations/google-calendar/status', 'Integrations'],
  ['GET', '/settings/business-profile', 'Settings — business profile'],
  ['GET', '/settings/agent-persona', 'Settings — agent persona'],
  ['GET', '/tenants/me/flows', 'Settings — flows'],
  ['GET', '/members', 'Team'],
];
if (apiKey) {
  for (const [method, path, label] of surfaces) {
    const r = await call(method, path, { token: apiKey });
    // 200 is fine; so is a considered 503 that explains itself. A 500 is not.
    const ok = r.status === 200 || r.status === 503;
    record(`${label} loads for an empty tenant`, ok, `${r.status} ${ok ? '' : short(r.body)}`);
  }
}

// 5. Cross-tenant isolation, with a real second key.
const other = await call('POST', '/admin/tenants', {
  token: ADMIN,
  body: { name: 'Beta Clinic', slug: 'beta-clinic', planCode: 'growth' },
});
const otherKey = (other.body?.data ?? other.body?.tenant ?? other.body)?.apiKey;
if (apiKey && otherKey) {
  const mine = await call('GET', '/tenants/me', { token: apiKey });
  const theirs = await call('GET', '/tenants/me', { token: otherKey });
  record(
    'two tenants see two different workspaces',
    mine.body?.id !== theirs.body?.id,
    `${mine.body?.slug} vs ${theirs.body?.slug}`,
  );

  // Tenant A tries to read tenant B by id.
  const peek = await call('GET', `/tenants/${theirs.body?.id}`, { token: apiKey });
  record('a tenant cannot read another tenant by id', peek.status === 403 || peek.status === 404, `${peek.status}`);
}

// 6. Suspension must actually lock a tenant out — the flag that used to be written and never read.
if (apiKey) {
  const suspend = await call('PATCH', `/admin/tenants/${tenantId}`, { token: ADMIN, body: { isActive: false } });
  record('admin can suspend a tenant', suspend.status === 200, `${suspend.status}`);
  const after = await call('GET', '/tenants/me', { token: apiKey });
  record('a suspended tenant is refused', after.status === 403 || after.status === 401, `${after.status}`);
  await call('PATCH', `/admin/tenants/${tenantId}`, { token: ADMIN, body: { isActive: true } });
}

// 7. Billing: what plan does a new tenant land on?
const listed = await call('GET', '/admin/tenants', { token: ADMIN });
const row = (listed.body?.data ?? []).find((t) => t.id === tenantId);
record(
  'a new tenant has a plan',
  Boolean(row?.planCode ?? row?.plan_code),
  `planCode=${row?.planCode ?? row?.plan_code ?? 'NONE'} billingStatus=${row?.billingStatus ?? row?.billing_status ?? '?'}`,
);

console.log('\n── SUMMARY ─────────────────────────────────────────────────────');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nfailures:');
  for (const f of failed) console.log(`  - ${f.step}: ${f.detail}`);
}

process.exit(failed.length === 0 ? 0 : 1);
