import type { FastifyInstance } from 'fastify';
import { AdminService } from './admin.service.js';
import { TenantService } from '../tenants/tenant.service.js';
import { createTenantSchema, updateTenantSchema } from '../tenants/tenant.schemas.js';
import { requireAdmin } from './admin.guard.js';
import { ValidationError } from '../../shared/errors.js';
import { invalidateTenantStatus } from '../../plugins/tenant-status.js';
import { safeTenant } from '../tenants/settings-policy.js';
import { recordAudit } from '../../shared/audit.js';
import { syncInboundTrunkNumbers } from './sip-trunk.service.js';
import { toE164 } from '../../shared/phone-number.js';
import { phoneNumbers } from '../../db/schema/index.js';

export async function adminRoutes(app: FastifyInstance) {
  const admin = new AdminService(app.db);
  const tenantsSvc = new TenantService(app.db);

  // Every admin route requires the operator key.
  app.addHook('onRequest', requireAdmin(app));

  // --- Monitoring ---
  app.get('/overview', async () => admin.overview());
  app.get('/tenants', async () => ({ data: await admin.listTenants() }));

  /**
   * The plans an operator can put a customer on.
   *
   * Read-only and deliberately so: a fourth tier is one INSERT, and a plans CRUD screen would be
   * a lot of surface for something that changes once a year. This exists because creating a
   * workspace now requires choosing a plan, and the operator should be choosing from what the
   * database actually has rather than from memory.
   *
   * Inactive plans are included — `internal` is is_active=false and is exactly what our own
   * workspaces belong on — but flagged, so the UI can separate "sell this" from "we use this".
   */
  app.get('/plans', async () => ({ data: await admin.listPlans() }));
  app.get('/tenants/:id', async (request) => {
    const { id } = request.params as { id: string };
    return admin.tenantDetail(id);
  });

  // --- Management (cross-tenant — this is the ONLY place these live) ---
  app.post('/tenants', async (request, reply) => {
    const result = createTenantSchema.safeParse(request.body);
    if (!result.success) throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid input');
    // Returns the plaintext apiKey ONCE — the operator copies it now; only the hash is stored.
    const created = await tenantsSvc.create(result.data);
    reply.status(201).send(created);
  });

  app.patch('/tenants/:id', async (request) => {
    const { id } = request.params as { id: string };
    const result = updateTenantSchema.safeParse(request.body);
    if (!result.success) throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid input');
    // name / slug / isActive — isActive:false is "suspend", true is "activate".
    // planCode / billingStatus / quotaEnforcement are the operator-only billing controls.
    const before = result.data.planCode ? await admin.readBillingPosture(id) : null;
    const updated = await tenantsSvc.update(id, result.data);

    /**
     * A PLAN CHANGE DOES NOT REPRICE THE MONTH IT LANDS IN.
     *
     * `usage_periods` snapshots the plan when the period opens, on purpose, so that a change made
     * on the 20th cannot silently reprice the 19 days already invoiced against the old terms. The
     * consequence is the part an operator will not guess: an upgrade agreed today takes effect at
     * the NEXT period turnover, and the customer's current invoice still reflects the old plan.
     *
     * That is the correct behaviour and the wrong thing to leave unsaid — the operator has just
     * told a customer their new price, so the response says plainly what the open period is still
     * priced at. Silence here is how a billing dispute starts.
     */
    let openPeriod: Awaited<ReturnType<typeof admin.readBillingPosture>> | null = null;
    if (result.data.planCode && result.data.planCode !== before?.planCode) {
      openPeriod = before;
      request.log.info({
        audit: true,
        event: 'tenant_plan_changed',
        tenantId: id,
        from: before?.planCode ?? null,
        to: result.data.planCode,
      });
      // Money. Needs a record that outlives log retention and can be shown to the customer.
      await recordAudit(app.db, {
        tenantId: id,
        action: 'tenant.plan_changed',
        targetType: 'tenant',
        targetId: id,
        actorType: 'admin_key',
        actorLabel: 'operator_console',
        ip: request.ip,
        metadata: { from: before?.planCode ?? null, to: result.data.planCode },
      });
    }

    if (result.data.billingStatus || result.data.quotaEnforcement) {
      await recordAudit(app.db, {
        tenantId: id,
        action: 'tenant.billing_updated',
        targetType: 'tenant',
        targetId: id,
        actorType: 'admin_key',
        actorLabel: 'operator_console',
        ip: request.ip,
        metadata: {
          ...(result.data.billingStatus ? { billingStatus: result.data.billingStatus } : {}),
          ...(result.data.quotaEnforcement ? { quotaEnforcement: result.data.quotaEnforcement } : {}),
        },
      });
    }

    // Suspension is enforced from a 30s-TTL status cache (see plugins/tenant-status.ts), so
    // without this the operator clicks "suspend" and the tenant keeps working for up to half a
    // minute — long enough to look broken, and long enough to place another call. Best-effort:
    // if Redis is unreachable the entry expires on its own.
    if (result.data.isActive !== undefined) {
      await invalidateTenantStatus(app.redis, id);
      request.log.info({
        audit: true,
        event: result.data.isActive ? 'tenant_activated' : 'tenant_suspended',
        tenantId: id,
      });
      // Suspension stops a customer's calls and API access. It needs a record that outlives log
      // retention and can be shown to the customer who asks why their agent went quiet.
      await recordAudit(app.db, {
        tenantId: id,
        action: result.data.isActive ? 'tenant.activated' : 'tenant.suspended',
        targetType: 'tenant',
        targetId: id,
        actorType: 'admin_key',
        actorLabel: 'operator_console',
        ip: request.ip,
      });
    }

    return {
      ...safeTenant(updated),
      // Present only when the plan actually changed, so the operator sees the discrepancy at the
      // moment they create it rather than when the invoice is queried.
      ...(openPeriod?.openPeriod
        ? {
            openPeriodStillPricedAs: openPeriod.openPeriod,
            note: 'The open billing period keeps the plan it was opened with. The new plan applies from the next period.',
          }
        : {}),
    };
  });

  app.get('/tenants/:id/numbers', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await admin.tenantNumbers(id) };
  });

  /**
   * Assign a DID to a tenant, and put it on the SIP trunk in the same call.
   *
   * Both halves, always, because they are one fact stored in two systems and a human keeping them
   * in step demonstrably did not: the checked-in trunk config said `numbers: []` for weeks while
   * production carried one number. The dangerous direction is a row here with no trunk entry — the
   * call is refused at the SIP layer, our code never runs, nothing logs it, and the customer
   * reports it before we notice.
   *
   * `scripts/provision-number.mjs` does the same job for an operator with a database connection.
   * This exists because that script needs a direct Postgres port, which some networks block, and
   * provisioning should not be the one onboarding step that depends on a firewall rule.
   */
  app.post('/tenants/:id/numbers', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { e164?: string; label?: string };

    const e164 = body.e164 ? toE164(body.e164) : null;
    if (!e164) throw new ValidationError('e164 must be a usable phone number, e.g. +972555070922');

    // Fail before writing a row that points at nothing: a number mapped to a missing tenant routes
    // calls into a read that returns nothing, which is far harder to diagnose from a recording than
    // a refusal at provisioning time.
    const tenant = await tenantsSvc.getById(id);

    const [row] = await app.db
      .insert(phoneNumbers)
      .values({ tenantId: id, e164, label: body.label ?? null, isActive: true })
      .onConflictDoUpdate({
        target: phoneNumbers.e164,
        set: { tenantId: id, label: body.label ?? null, isActive: true, updatedAt: new Date() },
      })
      .returning();

    await recordAudit(app.db, {
      tenantId: id,
      action: 'tenant.number_assigned',
      targetType: 'phone_number',
      targetId: e164,
      actorType: 'admin_key',
      actorLabel: 'operator_console',
      ip: request.ip,
      metadata: { e164, tenantName: tenant.name },
    });

    // The row is committed and is the source of truth, so a trunk failure must not fail the
    // request — but it must be impossible to miss, because the resulting state produces no log
    // line anywhere and reads to the customer as "your agent never answers".
    let trunk: Awaited<ReturnType<typeof syncInboundTrunkNumbers>> | null = null;
    let trunkError: string | null = null;
    try {
      trunk = await syncInboundTrunkNumbers({ db: app.db, env: app.env });
    } catch (err) {
      trunkError = err instanceof Error ? err.message : String(err);
      request.log.error(
        { audit: true, event: 'sip_trunk_sync_failed', e164, error: trunkError },
        'phone_numbers row written but the SIP trunk was NOT updated — calls to this number are refused before our code runs',
      );
    }

    reply.status(201);
    return {
      number: { e164: row!.e164, label: row!.label, isActive: row!.isActive, tenantId: id },
      trunk,
      ...(trunkError
        ? {
            warning:
              'The number is saved but the SIP trunk was not updated. Until it is, calls to this number are rejected at the SIP layer and nothing will log it. Repair: node scripts/provision-number.mjs --sync-trunk',
            trunkError,
          }
        : {}),
      next: 'Point this number at the SIP URI in the Zadarma portal (infra/livekit-sip/README.md).',
    };
  });

  /** Repair drift without touching any row. */
  app.post('/sip-trunk/sync', async () => syncInboundTrunkNumbers({ db: app.db, env: app.env }));

  app.post('/tenants/:id/rotate-key', async (request) => {
    const { id } = request.params as { id: string };
    // Returns the new plaintext key once.
    const rotated = await tenantsSvc.rotateApiKey(id);
    // Rotation instantly breaks every integration still using the old key. When something stops
    // working an hour later, this row is the answer.
    await recordAudit(app.db, {
      tenantId: id,
      action: 'api_key.rotated',
      targetType: 'tenant',
      targetId: id,
      actorType: 'admin_key',
      actorLabel: 'operator_console',
      ip: request.ip,
    });
    return rotated;
  });
}
