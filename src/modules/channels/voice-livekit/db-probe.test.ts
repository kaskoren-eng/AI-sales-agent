import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE BOOT-TIME DATABASE PROBE.
 *
 * Written after a six-day outage that produced no signal at all. The cloud agent was created with
 * a laptop secrets file — DATABASE_URL=localhost:5432 — and inside a container `localhost` is the
 * container. Every query failed, and nothing anywhere said so, because three individually correct
 * decisions compose into silence: pools do not connect eagerly, the tool gate is fail-closed, and
 * teardown writes are best-effort. The system was working as designed and the design had no way
 * to notice.
 *
 * The probe's contract is narrow and both halves matter: report accurately, and NEVER throw. It
 * runs inside `prewarm`, so throwing would stop the worker booting — turning a degraded agent,
 * which the fail-closed gates already handle safely, into no agent at all.
 */

const execute = vi.fn();
const end = vi.fn(async () => undefined);
const createDatabase = vi.fn((_url: string) => ({ db: { execute }, pool: { end } }));

vi.mock('../../../db/client.js', () => ({
  createDatabase: (url: string) => createDatabase(url),
}));

const { probeDatabase } = await import('./db-probe.js');

const URL_WITH_PASSWORD = 'postgres://user:hunter2@db.example.test:5432/app';

let logs: string[] = [];
let errors: string[] = [];

beforeEach(() => {
  logs = [];
  errors = [];
  execute.mockReset();
  end.mockClear();
  createDatabase.mockClear();
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errors.push(a.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('probeDatabase', () => {
  it('reports success with the host, so the logs answer "which database is this"', async () => {
    execute.mockResolvedValue(undefined);

    await probeDatabase(URL_WITH_PASSWORD);

    expect(errors).toHaveLength(0);
    const line = logs.find((l) => l.startsWith('agent_db_ok'));
    expect(line).toBeDefined();
    // The host is the whole point: last time, the entire diagnosis was working out which one it was.
    expect(line).toContain('db.example.test:5432');
    // And no credentials — which is why it prints the host rather than the URL. These lines get
    // pasted into incident threads.
    expect(line).not.toContain('hunter2');
  });

  it('does NOT throw when the database is unreachable', async () => {
    // The contract that matters most. This runs in prewarm; throwing would stop the worker
    // booting, and a degraded agent is strictly better than no agent.
    execute.mockRejectedValue(new Error('getaddrinfo ENOTFOUND localhost'));

    await expect(probeDatabase(URL_WITH_PASSWORD)).resolves.toBeUndefined();
  });

  it('says what broke, what it costs, and how to fix it', async () => {
    execute.mockRejectedValue(new Error('getaddrinfo ENOTFOUND localhost'));

    await probeDatabase(URL_WITH_PASSWORD);

    const line = errors.find((l) => l.startsWith('agent_db_unreachable'));
    expect(line).toBeDefined();
    expect(line).toContain('ENOTFOUND');
    // Consequences, so whoever reads it knows this is not cosmetic.
    expect(line).toMatch(/no tools/i);
    expect(line).toMatch(/refused/i);
    // And the remedy, because this log is read by whoever is mid-incident at the time.
    expect(line).toContain('fix-agent-secrets');
  });

  it('survives a malformed DATABASE_URL rather than throwing on the URL parse', async () => {
    // A garbled connection string is at least as likely as an unreachable one, and it must produce
    // a diagnostic too — not an exception out of prewarm before any of this runs.
    execute.mockRejectedValue(new Error('invalid connection string'));

    await expect(probeDatabase('not-a-url')).resolves.toBeUndefined();
    expect(errors.find((l) => l.startsWith('agent_db_unreachable'))).toContain('unparseable');
  });

  it('releases the pool on both paths, so probing never leaks a connection', async () => {
    execute.mockResolvedValue(undefined);
    await probeDatabase(URL_WITH_PASSWORD);
    expect(end).toHaveBeenCalledTimes(1);

    end.mockClear();
    execute.mockRejectedValue(new Error('down'));
    await probeDatabase(URL_WITH_PASSWORD);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
