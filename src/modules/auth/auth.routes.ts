import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { AuthService, ACCESS_TOKEN_TTL, type LoginResult } from './auth.service.js';
import { EmailService } from '../channels/email/email.service.js';
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  switchTenantSchema,
  acceptInviteSchema,
} from './auth.schemas.js';
import { ValidationError, UnauthorizedError } from '../../shared/errors.js';

/**
 * The refresh token never reaches JavaScript. httpOnly means an XSS on the dashboard cannot read
 * it; sameSite=lax stops it riding along on cross-site requests; the path scopes it to the only
 * endpoints that need it. The ACCESS token is deliberately NOT a cookie — it is returned in the
 * body and held in memory by the client, so it cannot be replayed by the browser automatically.
 */
const REFRESH_COOKIE = 'refresh_token';

function setRefreshCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/api/v1/auth',
    expires: expiresAt,
  });
}

function clearRefreshCookie(reply: FastifyReply, secure: boolean) {
  reply.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth', httpOnly: true, secure, sameSite: 'lax' });
}

export async function authRoutes(app: FastifyInstance) {
  const svc = new AuthService(app.db);
  const email = new EmailService(app);
  const secureCookies = app.env.NODE_ENV === 'production';
  const baseUrl = app.env.DASHBOARD_BASE_URL ?? '';

  /**
   * Tolerate an EMPTY body on application/json.
   *
   * /refresh and /logout carry their credential in a cookie and take no body at all, but any
   * normal fetch client sets a default `Content-Type: application/json` on POST. Fastify's stock
   * JSON parser rejects that combination outright with "Body cannot be empty when content-type is
   * set to 'application/json'" — so the browser refresh call failed for a reason that had nothing
   * to do with the session, and every silent token renewal and page reload logged the user out.
   *
   * Scoped to this plugin, so the strict behaviour still applies everywhere else.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 262_144 },
    (_request, body: string, done) => {
      if (!body || body.trim() === '') return done(null, {});
      try {
        done(null, JSON.parse(body));
      } catch {
        // statusCode must be set explicitly: a bare SyntaxError reaches the error handler as an
        // unclassified throw and is served as 500. Malformed input from a client is a 400, and
        // reporting it as a server error sends people debugging the wrong machine.
        const err = new Error('Invalid JSON body') as Error & { statusCode: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  const issue = (reply: FastifyReply, result: LoginResult) => {
    const accessToken = app.jwt.sign(result.claims, { expiresIn: ACCESS_TOKEN_TTL });
    setRefreshCookie(reply, result.refreshToken, result.refreshExpiresAt, secureCookies);
    return {
      accessToken,
      expiresIn: 900,
      user: result.user,
      tenant: result.tenant,
    };
  };

  /**
   * Credential endpoints get their own much tighter bucket, keyed by IP. The API scope's 200/min
   * is sized for a dashboard doing real work; it is far too generous for password guessing.
   */
  await app.register(rateLimit, {
    max: 10,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
  });

  // ── Registration ──────────────────────────────────────────────────────────────────────────

  app.post('/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');

    await svc.register(parsed.data);

    // Log in immediately — a signup flow that then asks for the password again is friction with
    // no security benefit, since the credential was just proven.
    const result = await svc.login({
      email: parsed.data.email,
      password: parsed.data.password,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    request.log.info({ audit: true, event: 'user_registered', tenantId: result.tenant.id });
    reply.status(201);
    return issue(reply, result);
  });

  // ── Login / refresh / logout ───────────────────────────────────────────────────────────────

  app.post('/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Enter your email and password');

    const result = await svc.login({
      ...parsed.data,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    request.log.info({
      audit: true,
      event: 'auth_login',
      tenantId: result.tenant.id,
      userId: result.user.id,
      ip: request.ip,
    });
    return issue(reply, result);
  });

  app.post('/refresh', async (request, reply) => {
    const token = request.cookies?.[REFRESH_COOKIE];
    if (!token) throw new UnauthorizedError('No session');

    try {
      const result = await svc.refresh({
        refreshToken: token,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      return issue(reply, result);
    } catch (err) {
      // Clear the cookie on any failure, including detected reuse. Leaving a dead token in the
      // browser means the client retries it forever and never falls back to the login screen.
      clearRefreshCookie(reply, secureCookies);
      throw err;
    }
  });

  app.post('/logout', async (request, reply) => {
    const token = request.cookies?.[REFRESH_COOKIE];
    if (token) {
      const { hashToken } = await import('../../shared/crypto.js');
      const { authSessions } = await import('../../db/schema/index.js');
      const { eq } = await import('drizzle-orm');
      const [row] = await app.db
        .select({ id: authSessions.id })
        .from(authSessions)
        .where(eq(authSessions.refreshTokenHash, hashToken(token)))
        .limit(1);
      if (row) await svc.revokeSession(row.id);
    }
    clearRefreshCookie(reply, secureCookies);
    // Always 204: whether a session existed is not the caller's business, and a logout that can
    // fail is a logout users learn to distrust.
    reply.status(204);
  });

  // ── Password reset ────────────────────────────────────────────────────────────────────────

  app.post('/forgot-password', async (request, reply) => {
    const parsed = forgotPasswordSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Enter a valid email address');

    const created = await svc.createPasswordReset(parsed.data.email);

    // A reset token that exists but was never mailed is the worst of both worlds: the user waits
    // for an email that isn't coming, and the 204 below cannot tell them otherwise without turning
    // this endpoint into an account-enumeration oracle. So the only place it can surface is here.
    if (created && !baseUrl) {
      request.log.error(
        { audit: true, event: 'password_reset_undeliverable', reason: 'DASHBOARD_BASE_URL unset' },
        'password reset token created but no link could be built — the user gets nothing',
      );
    }

    if (created && baseUrl) {
      const link = `${baseUrl}/reset-password?token=${encodeURIComponent(created.token)}`;
      await email
        .sendEmail(
          parsed.data.email,
          'איפוס סיסמה / Reset your password',
          `<p>לחצו כדי לאפס את הסיסמה. הקישור תקף לשעה אחת.</p>
           <p>Click to reset your password. This link is valid for one hour.</p>
           <p><a href="${link}">${link}</a></p>
           <p>אם לא ביקשתם זאת, אפשר להתעלם מהמייל. / If you didn't request this, ignore this email.</p>`,
        )
        // A mail failure must not change the response — see below.
        .catch((err) => request.log.error({ err }, 'password_reset_email_failed'));
    }

    // ALWAYS 204, whether or not the account exists. Anything else turns this endpoint into an
    // account-enumeration oracle, which is the classic mistake here.
    reply.status(204);
  });

  app.post('/reset-password', async (request, reply) => {
    const parsed = resetPasswordSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');

    await svc.resetPassword(parsed.data.token, parsed.data.password);
    clearRefreshCookie(reply, secureCookies);
    reply.status(204);
  });

  // ── Invitations (unauthenticated: the token IS the credential) ─────────────────────────────

  app.post('/accept-invite', async (request, reply) => {
    const parsed = acceptInviteSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');

    const { userId } = await svc.acceptInvite(parsed.data);
    request.log.info({ audit: true, event: 'invite_accepted', userId });
    reply.status(204);
  });

  // ── Authenticated ─────────────────────────────────────────────────────────────────────────

  app.register(async (authed) => {
    authed.addHook('onRequest', app.authenticate);

    authed.get('/me', async (request: FastifyRequest) => {
      const memberships = await svc.listMemberships(request.userId!);
      return {
        userId: request.userId,
        tenantId: request.tenantId,
        role: request.role,
        authMethod: request.authMethod,
        tenants: memberships,
      };
    });

    authed.post('/switch-tenant', async (request, reply) => {
      const parsed = switchTenantSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError('A workspace id is required');
      // API keys are tenant-scoped by construction — there is nothing to switch to.
      if (!request.userId) throw new UnauthorizedError('Switching workspaces requires a user session');

      const result = await svc.switchTenant({
        userId: request.userId,
        tenantId: parsed.data.tenantId,
        currentSessionId: request.sessionId,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      return issue(reply, result);
    });
  });
}
