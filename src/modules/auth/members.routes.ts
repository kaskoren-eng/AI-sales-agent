import type { FastifyInstance } from 'fastify';
import { AuthService } from './auth.service.js';
import { EmailService } from '../channels/email/email.service.js';
import { inviteSchema, updateMemberRoleSchema } from './auth.schemas.js';
import { requireRole } from '../../plugins/require-role.js';
import { ValidationError, ForbiddenError } from '../../shared/errors.js';

/**
 * Team management. Mounted INSIDE the authenticated API scope, so `request.tenantId` is already
 * resolved and every query is naturally scoped to the caller's own workspace — there is no route
 * here that takes a tenant id from the caller.
 */
export async function membersRoutes(app: FastifyInstance) {
  const svc = new AuthService(app.db);
  const email = new EmailService(app);
  const baseUrl = app.env.DASHBOARD_BASE_URL ?? '';

  /**
   * An invite is deliverable only if there is both a link to build and a mailer to carry it.
   * Checking the base URL alone meant an environment with no `RESEND_API_KEY` reported
   * `{ sent: true }` for a mail that was silently dropped — and the admin, who had no other copy
   * of the token, could not finish onboarding anyone. With both halves checked, the fallback below
   * does its job: hand the operator the raw token so the invite can still be completed by hand.
   */
  const canEmail = Boolean(baseUrl) && email.configured;

  app.get('/', async (request) => ({ members: await svc.listMembers(request.tenantId) }));

  app.post('/invites', { preHandler: requireRole('admin') }, async (request, reply) => {
    const parsed = inviteSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');
    if (!request.userId) throw new ForbiddenError('Inviting requires a user session');

    const { token } = await svc.createInvite({
      tenantId: request.tenantId,
      email: parsed.data.email,
      role: parsed.data.role,
      invitedByUserId: request.userId,
    });

    if (canEmail) {
      const link = `${baseUrl}/accept-invite?token=${encodeURIComponent(token)}`;
      await email
        .sendEmail(
          parsed.data.email,
          'הזמנה להצטרף / You have been invited',
          `<p>הוזמנתם להצטרף לסביבת העבודה. הקישור תקף לשבעה ימים.</p>
           <p>You have been invited to join a workspace. This link is valid for seven days.</p>
           <p><a href="${link}">${link}</a></p>`,
        )
        .catch((err) => request.log.error({ err }, 'invite_email_failed'));
    }

    request.log.info({
      audit: true,
      event: 'member_invited',
      tenantId: request.tenantId,
      role: parsed.data.role,
    });
    reply.status(201);
    // The raw token is returned ONLY when the invite could not be mailed, so an operator can still
    // complete it by hand. Once a link can be built AND sent, the token never leaves the server.
    return canEmail ? { sent: true } : { sent: false, token };
  });

  app.patch('/:userId', { preHandler: requireRole('admin') }, async (request) => {
    const { userId } = request.params as { userId: string };
    const parsed = updateMemberRoleSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('A valid role is required');

    // Only an owner may create another owner. Without this an admin could promote themselves
    // and then remove the owner — a one-step takeover of the workspace.
    if (parsed.data.role === 'owner' && request.role !== 'owner') {
      throw new ForbiddenError('Only an owner can grant ownership');
    }

    await svc.updateMemberRole(request.tenantId, userId, parsed.data.role);
    request.log.info({
      audit: true,
      event: 'member_role_changed',
      tenantId: request.tenantId,
      targetUserId: userId,
      role: parsed.data.role,
    });
    return { ok: true };
  });

  app.delete('/:userId', { preHandler: requireRole('admin') }, async (request, reply) => {
    const { userId } = request.params as { userId: string };

    // Removing yourself is how people accidentally lock themselves out; "leave workspace" should
    // be a deliberate, separately-named action rather than a side effect of the members table.
    if (userId === request.userId) {
      throw new ValidationError('You cannot remove yourself from the workspace');
    }

    await svc.removeMember(request.tenantId, userId);
    request.log.info({
      audit: true,
      event: 'member_removed',
      tenantId: request.tenantId,
      targetUserId: userId,
    });
    reply.status(204);
  });
}
