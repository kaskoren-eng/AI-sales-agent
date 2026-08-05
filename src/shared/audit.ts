import type { FastifyRequest } from 'fastify';
import type { Database } from '../db/client.js';
import { auditEvents } from '../db/schema/index.js';

/**
 * Write an audit row.
 *
 * WHAT THIS IS FOR. Consequential actions were recorded only as log lines
 * (`request.log.info({audit: true, ...})`). Those are real, but they live in the platform's log
 * retention, they are not queryable per tenant, and they cannot answer a customer asking "who
 * cancelled that booking?" or an auditor asking "who exported this data?".
 *
 * WHAT IT IS NOT FOR. Not an activity feed. Audit rows are for actions that are hard to undo,
 * touch money, touch credentials, or touch someone else's data. If everything is audited, the
 * audit log becomes a slower copy of the request log and nobody reads it.
 *
 * NEVER THROWS. An audit write must not be able to fail the action it is describing — a failed
 * insert here turning a successful suspension into a 500 would be a worse outcome than the missing
 * row. It logs loudly instead, so a silently broken audit trail is still visible.
 */
export interface AuditInput {
  tenantId?: string | null;
  actorUserId?: string | null;
  actorType: 'user' | 'api_key' | 'admin_key' | 'system';
  actorLabel?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function recordAudit(db: Database, input: AuditInput): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      tenantId: input.tenantId ?? null,
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorType,
      actorLabel: input.actorLabel ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? {},
      ip: input.ip ?? null,
    });
  } catch (err) {
    console.error(
      'audit_write_failed',
      JSON.stringify({ action: input.action, error: err instanceof Error ? err.message : String(err) }),
    );
  }
}

/**
 * Derive the actor from a request.
 *
 * The role and identity come from what the auth plugin RESOLVED, never from a token claim — the
 * same rule the authorisation path follows. An audit trail built from self-asserted identity
 * records whatever an attacker wanted it to say.
 */
export function actorFromRequest(request: FastifyRequest): Pick<
  AuditInput,
  'actorUserId' | 'actorType' | 'actorLabel' | 'ip'
> {
  if (request.userId) {
    // The label is the user id today. It exists so the row still means something after the user
    // row is deleted (the FK is `set null`), and it becomes the email once the auth plugin carries
    // one on the request — the schema is ready, the request object is not.
    return {
      actorUserId: request.userId,
      actorType: 'user',
      actorLabel: request.userId,
      ip: request.ip,
    };
  }
  if (request.authMethod === 'api_key') {
    // No user behind an API key, by construction — machine credentials predate accounts. The
    // tenant is the best identity available, and saying so is better than recording 'system'.
    return {
      actorUserId: null,
      actorType: 'api_key',
      actorLabel: request.tenantId ? `api_key:${request.tenantId}` : 'api_key',
      ip: request.ip,
    };
  }
  return { actorUserId: null, actorType: 'system', actorLabel: null, ip: request.ip };
}
