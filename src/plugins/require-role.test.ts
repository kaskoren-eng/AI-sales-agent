import { describe, it, expect } from 'vitest';
import { requireRole } from './require-role.js';
import { ForbiddenError } from '../shared/errors.js';

const req = (over: Record<string, unknown> = {}) =>
  ({ authMethod: 'jwt', role: 'member', ...over }) as never;
const reply = {} as never;

describe('requireRole', () => {
  it('allows a role above the minimum', async () => {
    await expect(requireRole('member')(req({ role: 'admin' }), reply)).resolves.toBeUndefined();
    await expect(requireRole('viewer')(req({ role: 'owner' }), reply)).resolves.toBeUndefined();
  });

  it('allows a role exactly at the minimum', async () => {
    await expect(requireRole('admin')(req({ role: 'admin' }), reply)).resolves.toBeUndefined();
  });

  it('rejects a role below the minimum', async () => {
    await expect(requireRole('admin')(req({ role: 'member' }), reply)).rejects.toThrow(ForbiddenError);
    await expect(requireRole('member')(req({ role: 'viewer' }), reply)).rejects.toThrow(ForbiddenError);
    await expect(requireRole('owner')(req({ role: 'admin' }), reply)).rejects.toThrow(ForbiddenError);
  });

  it('rejects a session with no role at all', async () => {
    // A membership revoked mid-session. Absent must never read as permitted.
    await expect(requireRole('viewer')(req({ role: undefined }), reply)).rejects.toThrow(ForbiddenError);
  });

  it('rejects an unrecognised role rather than ranking it as zero', async () => {
    await expect(requireRole('viewer')(req({ role: 'superuser' }), reply)).rejects.toThrow(ForbiddenError);
  });

  it('lets API keys through — they are tenant-wide machine credentials', async () => {
    // Documented deliberate behaviour: role checks draw a line between PEOPLE in a workspace.
    // Failing existing API keys here would break every integration the day this shipped.
    await expect(
      requireRole('owner')(req({ authMethod: 'api_key', role: undefined }), reply),
    ).resolves.toBeUndefined();
  });
});
