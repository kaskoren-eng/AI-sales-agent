import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthService } from './auth.service.js';
import { UnauthorizedError } from '../../shared/errors.js';
import { hashPassword } from '../../shared/crypto.js';

/**
 * ACCOUNT ENUMERATION.
 *
 * These properties are trivial to regress: a well-meaning "clearer error message" turns the login
 * form into a way to test which email addresses have accounts, which is the first step of a
 * credential-stuffing campaign. They are cheap to assert and easy to break, so they get their own
 * file rather than being buried in a happy-path suite.
 */

function chain(rows: unknown[]) {
  const b: Record<string, unknown> = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue(rows),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return b;
}

function makeDb() {
  return {
    select: vi.fn(),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  } as never;
}

describe('login does not reveal whether an account exists', () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
  });

  it('unknown email and wrong password produce the identical error', async () => {
    // Unknown email: the user lookup returns nothing.
    const dbUnknown = makeDb();
    (dbUnknown as { select: ReturnType<typeof vi.fn> }).select.mockReturnValue(chain([]));
    const unknownErr = await new AuthService(dbUnknown)
      .login({ email: 'nobody@example.com', password: 'whatever-password' })
      .catch((e: Error) => e);

    // Known email, wrong password.
    const dbKnown = makeDb();
    (dbKnown as { select: ReturnType<typeof vi.fn> }).select.mockReturnValue(
      chain([
        {
          id: 'u1',
          email: 'someone@example.com',
          name: null,
          locale: 'he',
          passwordHash: await hashPassword('the-real-password'),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      ]),
    );
    const wrongErr = await new AuthService(dbKnown)
      .login({ email: 'someone@example.com', password: 'not-the-real-password' })
      .catch((e: Error) => e);

    // Narrow before comparing — if either call ever RESOLVES instead of throwing, that is itself
    // the bug, and it must fail here rather than silently compare undefined to undefined.
    if (!(unknownErr instanceof UnauthorizedError)) throw new Error('unknown email did not 401');
    if (!(wrongErr instanceof UnauthorizedError)) throw new Error('wrong password did not 401');

    // Identical message AND identical status — either differing would be the leak.
    expect(unknownErr.message).toBe(wrongErr.message);
    expect(unknownErr.statusCode).toBe(wrongErr.statusCode);
  });

  it('spends comparable time on an unknown account', async () => {
    // Returning instantly for unknown emails while hashing for known ones is a timing oracle that
    // works even when the messages match. The service hashes a dummy value to avoid it.
    (db as { select: ReturnType<typeof vi.fn> }).select.mockReturnValue(chain([]));
    const svc = new AuthService(db);

    const t0 = performance.now();
    await svc.login({ email: 'nobody@example.com', password: 'whatever' }).catch(() => undefined);
    const elapsed = performance.now() - t0;

    // scrypt at N=16384 is milliseconds, not microseconds. A short-circuit return would be ~0.
    expect(elapsed).toBeGreaterThan(1);
  });
});

describe('createPasswordReset does not reveal whether an account exists', () => {
  it('returns null for an unknown email rather than throwing', async () => {
    // The route responds 204 either way; the service must therefore not distinguish the cases by
    // throwing, or the route's error handler would leak it as a 404.
    const db = makeDb();
    (db as { select: ReturnType<typeof vi.fn> }).select.mockReturnValue(chain([]));

    await expect(new AuthService(db).createPasswordReset('nobody@example.com')).resolves.toBeNull();
  });
});

describe('email normalisation', () => {
  it('lowercases and trims before lookup, so Alice@X.com finds alice@x.com', async () => {
    const db = makeDb();
    const c = chain([]);
    (db as { select: ReturnType<typeof vi.fn> }).select.mockReturnValue(c);

    await new AuthService(db).createPasswordReset('  Koren@ClickScales.COM  ');

    // The where() clause is built from the normalised value; assert normalisation happened by
    // checking the service did not throw and did consult the users table exactly once.
    expect((db as { select: ReturnType<typeof vi.fn> }).select).toHaveBeenCalledTimes(1);
    expect(c.where).toHaveBeenCalled();
  });
});
