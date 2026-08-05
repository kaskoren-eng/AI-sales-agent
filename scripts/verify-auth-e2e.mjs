/**
 * Live end-to-end verification of the auth system — every Phase 1 claim exercised against a
 * running deployment, not a mock.
 *
 * ⚠️  IT WRITES TO WHATEVER DATABASE YOU POINT IT AT. It registers a throwaway workspace and two
 *     users, suspends that workspace, and deletes everything it created on the way out. It never
 *     touches rows it did not make. Even so, prefer staging; if you run it against production,
 *     read the cleanup block at the bottom first.
 *
 * This is the harness that caught the empty-body refresh bug — /auth/refresh rejected every
 * browser-shaped request while passing a curl check, because curl sends no content-type unless
 * told to. Mocks and curl both missed it; a real client-shaped request did not.
 *
 * Usage (production, both credentials injected without printing them):
 *   JWT=$(railway variables --service AI-sales-agent --kv | grep '^JWT_SECRET=' | cut -d= -f2-)
 *   JWT_SECRET="$JWT" railway run --service Postgres node scripts/verify-auth-e2e.mjs
 *
 * JWT_SECRET is optional — without it the token-forgery section is skipped and the rest still runs.
 */
import pg from 'pg';
import { createHmac } from 'node:crypto';

const U = 'https://ai-sales-agent-production-9736.up.railway.app';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_PUBLIC_URL });
const stamp = Date.now();
const EMAIL = `demo-${stamp}@clickscales.test`;
const EMAIL2 = `demo2-${stamp}@clickscales.test`;
const PASSWORD = 'a-perfectly-fine-demo-passphrase';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const section = (n, title) => console.log(`\n${n}. ${title}\n${'─'.repeat(74)}`);

// --- helpers -----------------------------------------------------------------------------
let cookie = '';
async function call(path, { method = 'GET', body, token, useCookie = false } = {}) {
  const res = await fetch(`${U}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(useCookie && cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  // getSetCookie() rather than get('set-cookie'): a response can carry several Set-Cookie
  // headers and get() does not reliably give you all of them.
  const all = res.headers.getSetCookie?.() ?? [];
  const setCookie = all.join('\n');
  for (const c of all) {
    const m = /^refresh_token=([^;]*)/.exec(c);
    // An empty value is the server CLEARING the cookie (logout, failed refresh) — honour it.
    if (m) cookie = m[1] ? `refresh_token=${m[1]}` : '';
  }
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, json, setCookie };
}

const jwtForge = (secret, claims) => {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = b({ alg: 'HS256', typ: 'JWT' });
  const p = b({ ...claims, iat: (Date.now() / 1000) | 0, exp: ((Date.now() / 1000) | 0) + 900 });
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
};

let tenantId, userId;

try {
  console.log('\n' + '='.repeat(76));
  console.log('  PHASE 1 DEMONSTRATION — live against production');
  console.log('='.repeat(76));

  // ─────────────────────────────────────────────────────────────────────────────────────
  section(1, 'Self-service signup: a user AND their workspace, in one transaction');
  const reg = await call('/api/v1/auth/register', {
    method: 'POST',
    body: { email: EMAIL, password: PASSWORD, name: 'Demo Owner', tenantName: `Demo Co ${stamp}` },
  });
  check('POST /auth/register → 201', reg.status === 201, `got ${reg.status}`);
  check('returns an access token', !!reg.json?.accessToken);
  check('sets an httpOnly refresh cookie', /HttpOnly/i.test(reg.setCookie ?? ''));
  check('refresh cookie is SameSite=Lax', /SameSite=Lax/i.test(reg.setCookie ?? ''));
  check('refresh cookie is scoped to /api/v1/auth', /Path=\/api\/v1\/auth/i.test(reg.setCookie ?? ''));
  check('signup makes you OWNER', reg.json?.tenant?.role === 'owner', `role=${reg.json?.tenant?.role}`);
  tenantId = reg.json?.tenant?.id;
  userId = reg.json?.user?.id;
  console.log(`      workspace "${reg.json?.tenant?.name}" slug=${reg.json?.tenant?.slug}`);

  // ─────────────────────────────────────────────────────────────────────────────────────
  section(2, 'Password storage: scrypt, salted, never reversible');
  const { rows: pw } = await pool.query('SELECT password_hash FROM users WHERE email=$1', [EMAIL]);
  const hash = pw[0].password_hash;
  check('password is NOT stored in plaintext', !hash.includes(PASSWORD));
  check('stored as salt:hash', /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(hash));
  console.log(`      ${hash.slice(0, 28)}… (16-byte salt : 64-byte scrypt hash)`);

  // ─────────────────────────────────────────────────────────────────────────────────────
  section(3, 'Login, and the account-enumeration guarantee');
  const wrongPw = await call('/api/v1/auth/login', { method: 'POST', body: { email: EMAIL, password: 'wrong-password' } });
  const noUser = await call('/api/v1/auth/login', { method: 'POST', body: { email: `nobody-${stamp}@x.test`, password: 'wrong-password' } });
  check('wrong password → 401', wrongPw.status === 401);
  check('unknown email → 401', noUser.status === 401);
  check('BOTH return the identical message', wrongPw.json?.message === noUser.json?.message,
    `"${wrongPw.json?.message}"`);
  console.log('      → the login form cannot be used to discover which emails have accounts');

  const login = await call('/api/v1/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  check('correct password → 200 + token', login.status === 200 && !!login.json.accessToken);
  const AT = login.json.accessToken;

  // ─────────────────────────────────────────────────────────────────────────────────────
  section(4, 'The access token authenticates the real API');
  const leads = await call('/api/v1/leads', { token: AT });
  check('GET /api/v1/leads with token → 200', leads.status === 200);
  const me = await call('/api/v1/auth/me', { token: AT });
  check('GET /auth/me returns the right identity', me.json?.tenantId === tenantId && me.json?.role === 'owner',
    `role=${me.json?.role} authMethod=${me.json?.authMethod}`);

  // ─────────────────────────────────────────────────────────────────────────────────────
  section(5, 'A leaked JWT_SECRET is NOT a master key');
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.log('   (JWT_SECRET not injected — skipping forgery demo)');
  } else {
    const f1 = await call('/api/v1/leads', { token: jwtForge(secret, { tenantId, sub: userId }) });
    const f2 = await call('/api/v1/leads', { token: jwtForge(secret, { tenantId, sub: userId, sid: '00000000-0000-0000-0000-000000000000' }) });
    const f3 = await call('/api/v1/leads', { token: jwtForge(secret, { tenantId, sub: userId, sid: '00000000-0000-0000-0000-000000000000', rol: 'owner' }) });
    check('forged token, no session claim → 401', f1.status === 401);
    check('forged token, invented session id → 401', f2.status === 401);
    check('forged token claiming rol:owner → 401', f3.status === 401);
    console.log('      → signatures are VALID (real production secret). Access needs a session');
    console.log('        row in the database, which an attacker cannot create.');
  }

  // ─────────────────────────────────────────────────────────────────────────────────────
  section(6, 'Refresh rotation and stolen-token (reuse) detection');
  const stolen = cookie;
  const r1 = await call('/api/v1/auth/refresh', { method: 'POST', useCookie: true });
  check('refresh → 200 with a new token', r1.status === 200 && !!r1.json?.accessToken);
  check('the refresh cookie ROTATED', cookie !== stolen);
  const rotated = cookie;

  cookie = stolen;
  const replay = await call('/api/v1/auth/refresh', { method: 'POST', useCookie: true });
  check('replaying the OLD cookie → 401 (reuse detected)', replay.status === 401);

  cookie = rotated;
  const afterReuse = await call('/api/v1/auth/refresh', { method: 'POST', useCookie: true });
  check('the NEW cookie is dead too — whole chain revoked', afterReuse.status === 401);
  console.log('      → a thief gets one use; the next refresh by anyone locks BOTH parties out.');

  // Guard against a false positive: with no token at all this request 401s anyway, which would
  // make the claim "look" proven even if the refresh above had failed.
  if (r1.json?.accessToken) {
    const afterRevoke = await call('/api/v1/leads', { token: r1.json.accessToken });
    check('access token dies IMMEDIATELY with its session', afterRevoke.status === 401);
    console.log('      → revocation is instant, not "within 15 minutes".');
  } else {
    check('access token dies with its session', false, 'skipped — no token from refresh');
  }

  // ─────────────────────────────────────────────────────────────────────────────────────
  section(7, 'Roles: invite, permissions, and the last-owner guard');
  const fresh = await call('/api/v1/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  const OWNER = fresh.json.accessToken;

  const inv = await call('/api/v1/members/invites', { method: 'POST', token: OWNER, body: { email: EMAIL2, role: 'viewer' } });
  check('owner can invite → 201', inv.status === 201);
  const invOwner = await call('/api/v1/members/invites', { method: 'POST', token: OWNER, body: { email: `x-${stamp}@y.test`, role: 'owner' } });
  check('cannot INVITE straight to owner → 400', invOwner.status === 400,
    'ownership is transferred, not emailed');

  const token = inv.json?.token;
  if (token) {
    const acc = await call('/api/v1/auth/accept-invite', { method: 'POST', body: { token, password: PASSWORD, name: 'Demo Viewer' } });
    check('invitee accepts → 204', acc.status === 204);
  }
  const members = await call('/api/v1/members', { token: OWNER });
  check('workspace now has 2 members', members.json?.members?.length === 2,
    (members.json?.members ?? []).map((m) => m.role).join(' + '));

  const viewerLogin = await call('/api/v1/auth/login', { method: 'POST', body: { email: EMAIL2, password: PASSWORD } });
  const VIEWER = viewerLogin.json?.accessToken;
  const viewerReads = await call('/api/v1/leads', { token: VIEWER });
  check('viewer CAN read leads → 200', viewerReads.status === 200);
  const viewerInvites = await call('/api/v1/members/invites', { method: 'POST', token: VIEWER, body: { email: `z-${stamp}@y.test`, role: 'member' } });
  check('viewer CANNOT invite → 403', viewerInvites.status === 403);

  const demote = await call(`/api/v1/members/${userId}`, { method: 'PATCH', token: OWNER, body: { role: 'member' } });
  check('the only owner cannot demote themselves → 400', demote.status === 400,
    'a workspace with no owner is unadministrable');

  // ─────────────────────────────────────────────────────────────────────────────────────
  section(8, 'Tenant isolation: a session for one workspace sees only that workspace');
  const { rows: other } = await pool.query(`SELECT id, slug FROM tenants WHERE slug='clickscales' LIMIT 1`);
  const cross = await call('/api/v1/auth/switch-tenant', { method: 'POST', token: OWNER, body: { tenantId: other[0].id } });
  check('switching to a workspace you are NOT a member of → 403', cross.status === 403,
    `tried clickscales (${other[0].id.slice(0, 8)})`);

  // ─────────────────────────────────────────────────────────────────────────────────────
  section(9, 'Suspension is enforced — the button that used to do nothing');
  const before = await call('/api/v1/leads', { token: OWNER });
  check('active tenant → 200', before.status === 200);

  await pool.query('UPDATE tenants SET is_active=false WHERE id=$1', [tenantId]);
  console.log('      (set is_active=false directly; waiting out the 30s status cache…)');
  await new Promise((r) => setTimeout(r, 32_000));

  const after = await call('/api/v1/leads', { token: OWNER });
  check('suspended tenant, same token → 403', after.status === 403, after.json?.error);
  const loginSuspended = await call('/api/v1/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  check('suspended tenant cannot even log in → 403', loginSuspended.status === 403);
  console.log('      → before this phase, is_active was written by the admin console and read');
  console.log('        by NOTHING. A non-paying customer kept full access and kept dialling.');

  console.log('\n' + '='.repeat(76));
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('='.repeat(76));
} catch (err) {
  console.error('\nDEMO ERROR:', err instanceof Error ? err.stack : String(err));
  fail++;
} finally {
  // Cleanup — leave production exactly as we found it.
  if (tenantId) {
    await pool.query('DELETE FROM users WHERE email = ANY($1)', [[EMAIL, EMAIL2]]).catch(() => {});
    await pool.query('DELETE FROM tenants WHERE id=$1', [tenantId]).catch(() => {});
  }
  const t = await pool.query('SELECT count(*)::int n FROM tenants');
  const u = await pool.query('SELECT count(*)::int n FROM users');
  console.log(`\ncleanup: tenants=${t.rows[0].n} users=${u.rows[0].n} (demo rows removed)`);
  await pool.end();
}
