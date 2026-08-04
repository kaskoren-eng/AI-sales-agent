import { z } from 'zod';
import { TENANT_ROLES } from '../../db/schema/index.js';

/**
 * Minimum 12 characters, no composition rules.
 *
 * This follows NIST SP 800-63B: length is what resists guessing, while forced
 * upper/lower/digit/symbol rules push people toward "Password1!" and a sticky note. The one
 * thing worth blocking is the handful of passwords that appear in every credential-stuffing
 * list — a full breach-corpus check (k-anonymity against HIBP) belongs here later.
 */
const password = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200, 'Password must be at most 200 characters')
  .refine(
    (p) => !['password1234', '123456789012', 'qwertyuiop12'].includes(p.toLowerCase()),
    'That password is too common',
  );

const email = z.string().email('Enter a valid email address').max(255);

export const registerSchema = z.object({
  email,
  password,
  name: z.string().min(1).max(255).optional(),
  tenantName: z.string().min(2, 'Workspace name is required').max(255),
  locale: z.enum(['he', 'en']).optional(),
});

export const loginSchema = z.object({
  email,
  // Deliberately NOT `password` — applying the strength rules on login would reject anyone whose
  // existing password predates them, and would leak the policy to an attacker probing the form.
  password: z.string().min(1).max(200),
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password,
});

export const switchTenantSchema = z.object({ tenantId: z.string().uuid() });

export const inviteSchema = z.object({
  email,
  // 'owner' is intentionally absent: ownership is transferred through updateMemberRole by an
  // existing owner, not handed out by emailing a link.
  role: z.enum(['admin', 'member', 'viewer']),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
  password: password.optional(),
  name: z.string().min(1).max(255).optional(),
});

export const updateMemberRoleSchema = z.object({ role: z.enum(TENANT_ROLES) });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
