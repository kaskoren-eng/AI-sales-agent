import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { tenants } from '../db/schema/index.js';
import type { Database } from '../db/client.js';
import { UnauthorizedError, ForbiddenError } from '../shared/errors.js';

/**
 * THE FIX FOR THE ONE BUG THAT WAS BUILT-AND-BROKEN RATHER THAN MERELY MISSING.
 *
 * `tenants.isActive` existed from the first migration, and the operator console has had a
 * suspend/activate switch since the admin module shipped. Nothing ever read the flag. Grepping
 * `isActive` across src/ found it only in the schema, in admin display rollups, and in Zod
 * schemas — not in auth, not in the workers, not in the webhooks. Suspending a tenant wrote
 * `is_active = false` and changed nothing: their API key kept working, their flows kept running,
 * and their agent kept dialling on our Cartesia/OpenAI/LiveKit bill.
 *
 * For a SaaS this is the non-payment enforcement path, so it has to be real before there is a
 * second customer to enforce it against.
 */

export interface TenantStatus {
  exists: boolean;
  isActive: boolean;
}

/**
 * 30 seconds. This only bounds how long a *stale* status can survive, because suspending a tenant
 * busts the key explicitly (see invalidateTenantStatus). It exists so the JWT path — which
 * otherwise touches no database at all — does not add a query to every dashboard request.
 */
const STATUS_TTL_SECONDS = 30;

const key = (tenantId: string) => `tenant:status:${tenantId}`;

function encode(s: TenantStatus): string {
  return !s.exists ? 'missing' : s.isActive ? 'active' : 'inactive';
}

function decode(raw: string): TenantStatus {
  if (raw === 'missing') return { exists: false, isActive: false };
  return { exists: true, isActive: raw === 'active' };
}

/**
 * Reads tenant status, preferring Redis.
 *
 * FAILURE POLICY: a Redis outage falls through to Postgres. It never falls through to "allow" —
 * that would make a cache outage silently disable suspension, which is precisely the failure this
 * module exists to prevent.
 */
export async function getTenantStatus(
  deps: { db: Database; redis: Redis },
  tenantId: string,
): Promise<TenantStatus> {
  const cached = await deps.redis.get(key(tenantId)).catch(() => null);
  if (cached) return decode(cached);

  const [row] = await deps.db
    .select({ isActive: tenants.isActive })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const status: TenantStatus = row
    ? { exists: true, isActive: row.isActive !== false }
    : { exists: false, isActive: false };

  // Cache the negative result too: a stream of requests bearing a deleted tenant's token must not
  // become a stream of database queries.
  await deps.redis.setex(key(tenantId), STATUS_TTL_SECONDS, encode(status)).catch(() => undefined);

  return status;
}

/**
 * Call this the moment a tenant is suspended, reactivated, or deleted, so the change takes effect
 * now rather than within STATUS_TTL_SECONDS. Best-effort: if Redis is unreachable the entry
 * simply expires on its own.
 */
export async function invalidateTenantStatus(redis: Redis, tenantId: string): Promise<void> {
  await redis.del(key(tenantId)).catch(() => undefined);
}

/**
 * Pure. Throws the right error for an unusable tenant, or returns.
 *
 * A MISSING tenant is 401, not 404: the caller presented a credential that resolves to nothing,
 * and telling them "that tenant does not exist" would confirm which tenant ids are real.
 * A SUSPENDED tenant is 403 — the credential is valid, the account is not.
 */
export function assertTenantUsable(status: TenantStatus): void {
  if (!status.exists) throw new UnauthorizedError('Invalid credentials');
  if (!status.isActive) throw new ForbiddenError('Tenant is suspended');
}
