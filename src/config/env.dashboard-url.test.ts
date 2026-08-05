import { describe, expect, it, vi, afterEach } from 'vitest';
import { loadEnv } from './env.js';

/**
 * THE BUG THIS EXISTS FOR — a password reset that was created and never sent.
 *
 * `DASHBOARD_BASE_URL` began life as a cosmetic setting: it built "view this call" back-links for
 * CRM notes, and when unset the link was simply omitted. Then accounts shipped, and the same
 * variable quietly became the origin of every password-reset and invite link.
 *
 * In production it was never set. So /auth/forgot-password created a valid reset token, skipped the
 * email, and returned 204 — the identical response it returns on success, because that endpoint
 * must not reveal whether an account exists. Nothing failed. Nothing logged. The only symptom was a
 * human waiting for an email that was never attempted, and a locked-out user would have had no way
 * back into the product.
 *
 * The lesson generalises past this one variable: when an OPTIONAL setting acquires a second
 * consumer for which it is not optional, the graceful degradation written for the first consumer
 * becomes silent breakage for the second. These tests pin the warning that surfaces it.
 */

const REQUIRED = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: 'x'.repeat(32),
  JWT_SECRET: 'y'.repeat(16),
  /**
   * Not required by the schema — required by the test runner. Vite defines its own `BASE_URL` (the
   * app's public base path, default "/") and it lands in process.env under Vitest, where it
   * shadows this project's unrelated BASE_URL and fails its `.url()` check. Any test that calls
   * loadEnv() dies on `BASE_URL: Invalid url` until it is stubbed, which looks nothing like a
   * name collision from the error message.
   */
  BASE_URL: 'https://api.example.com',
};

function stub(vars: Record<string, string>) {
  for (const [k, v] of Object.entries({ ...REQUIRED, ...vars })) vi.stubEnv(k, v);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('DASHBOARD_BASE_URL', () => {
  it('warns in production when unset — the exact production misconfiguration', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stub({ NODE_ENV: 'production', DASHBOARD_BASE_URL: '' });

    const env = loadEnv();

    expect(env.DASHBOARD_BASE_URL).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    // The message must name the consequence, not just the variable. An operator reading
    // "DASHBOARD_BASE_URL is not set" has no reason to treat it as urgent; one reading that users
    // cannot recover their password does.
    expect(warn.mock.calls[0]?.[0]).toMatch(/password-reset/i);
  });

  it('stays silent in production once set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stub({ NODE_ENV: 'production', DASHBOARD_BASE_URL: 'https://app.example.com' });

    expect(loadEnv().DASHBOARD_BASE_URL).toBe('https://app.example.com');
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn outside production — local dev legitimately runs without it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stub({ NODE_ENV: 'development', DASHBOARD_BASE_URL: '' });

    loadEnv();

    expect(warn).not.toHaveBeenCalled();
  });

  it('is a warning and not a boot failure', () => {
    // Deliberate: refusing to start over a password-reset link would turn a degraded feature into
    // a total outage of a voice product that is answering customer calls. The warning is the
    // whole mitigation, which is why the test above asserts it is legible.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    stub({ NODE_ENV: 'production', DASHBOARD_BASE_URL: '' });

    expect(() => loadEnv()).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
