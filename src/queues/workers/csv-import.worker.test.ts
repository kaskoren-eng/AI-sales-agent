import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((_name: string, processor: Function) => ({
    processor,
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { createCsvImportWorker } from './csv-import.worker.js';

const TENANT_ID = 'tenant-1';
const JOB_ID = 'import-job-uuid';

// ── CSV fixtures ───────────────────────────────────────────────────────────
const CSV_ALICE = 'Name,Email,Phone\nAlice Smith,alice@example.com,+1111111111';
const CSV_BOB = 'name,email,phone\nBob Jones,bob@example.com,+2222222222';
const CSV_ALICE_BOB = 'name,email,phone\nAlice Smith,alice@example.com,+1111111111\nBob Jones,bob@example.com,+2222222222';
const CSV_ALICE_EMPTY = 'Name,Email,Phone\nAlice Smith,alice@example.com,+1111111111\n,,';
const CSV_EMAIL_ONLY = 'name,email\nCarol,carol@example.com';

const IMPORT_JOB_ROW = { id: JOB_ID, tenantId: TENANT_ID, status: 'pending' };

// ── Mock chain helpers ─────────────────────────────────────────────────────
function makeUpdateChain() {
  return { set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(undefined) };
}

function makeSelectChain(rows: any[]) {
  return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue(rows) };
}

/**
 * `values()` is awaitable AND chainable, which is what drizzle actually gives you: an insert can be
 * awaited directly, or `.returning()` can be tacked on first. This fake used to model only the
 * first form, so adding a `.returning({ id })` to the worker — needed to meter the new lead —
 * failed inside the per-row try/catch and turned every imported row into an error count.
 *
 * A fake that supports less than the real thing does not make tests stricter; it makes them wrong
 * about a different library.
 */
function makeInsertChain(rows: any[] = [{ id: 'lead-uuid' }]) {
  const values = vi.fn().mockImplementation(() => {
    const promise: any = Promise.resolve(rows);
    promise.returning = vi.fn().mockResolvedValue(rows);
    return promise;
  });
  return { values };
}

/**
 * Build a db mock where the first select() returns the import job row
 * and all subsequent selects return empty (no existing leads).
 */
function makeDeps(dbOverride?: any) {
  const db = dbOverride ?? {
    select: vi.fn()
      .mockReturnValueOnce(makeSelectChain([IMPORT_JOB_ROW]))
      .mockReturnValue(makeSelectChain([])),
    insert: vi.fn().mockReturnValue(makeInsertChain()),
    update: vi.fn().mockReturnValue(makeUpdateChain()),
  };

  return {
    db,
    redis: { duplicate: vi.fn().mockReturnValue({}) } as any,
    deadLetterQueue: { add: vi.fn().mockResolvedValue({}) } as any,
  };
}

function makeJob(csvContent: string) {
  return {
    id: 'bull-job-1',
    data: { tenantId: TENANT_ID, jobId: JOB_ID, csvContent },
    attemptsMade: 1,
    opts: { attempts: 3 },
    queueName: 'csv-import',
  } as any;
}

describe('csv-import worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks job as processing then done on success', async () => {
    const deps = makeDeps();
    const worker = createCsvImportWorker(deps) as any;

    await worker.processor(makeJob(CSV_ALICE));

    expect(deps.db.update).toHaveBeenCalled();
    const setCalls = deps.db.update.mock.results[0].value.set.mock.calls;
    const statuses = setCalls.map((c: any[]) => c[0].status).filter(Boolean);
    expect(statuses).toContain('processing');
    expect(statuses).toContain('done');
  });

  it('inserts a lead for each valid row', async () => {
    const deps = makeDeps();
    const worker = createCsvImportWorker(deps) as any;

    const result = await worker.processor(makeJob(CSV_ALICE_BOB));

    expect(deps.db.insert).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ processedRows: 2, errorCount: 0 });
  });

  it('skips rows with no email or phone (silent, not counted as error)', async () => {
    const deps = makeDeps();
    const worker = createCsvImportWorker(deps) as any;

    const result = await worker.processor(makeJob(CSV_ALICE_EMPTY));

    expect(deps.db.insert).toHaveBeenCalledTimes(1); // only Alice inserted
    expect(result.processedRows).toBe(1);
    expect(result.errorCount).toBe(0);
  });

  it('skips duplicate — matched by phone', async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(makeSelectChain([IMPORT_JOB_ROW]))
        .mockReturnValue(makeSelectChain([{ id: 'existing-id' }])),
      insert: vi.fn().mockReturnValue(makeInsertChain()),
      update: vi.fn().mockReturnValue(makeUpdateChain()),
    };
    const deps = makeDeps(db);
    const worker = createCsvImportWorker(deps) as any;

    await worker.processor(makeJob(CSV_ALICE));

    expect(deps.db.insert).not.toHaveBeenCalled();
  });

  it('skips duplicate — matched by email when phone not present', async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(makeSelectChain([IMPORT_JOB_ROW]))
        .mockReturnValueOnce(makeSelectChain([{ id: 'dup' }])),
      insert: vi.fn().mockReturnValue(makeInsertChain()),
      update: vi.fn().mockReturnValue(makeUpdateChain()),
    };
    const deps = makeDeps(db);
    const worker = createCsvImportWorker(deps) as any;

    await worker.processor(makeJob(CSV_EMAIL_ONLY));
    expect(deps.db.insert).not.toHaveBeenCalled();
  });

  it('marks job as failed when ALL rows fail', async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(makeSelectChain([IMPORT_JOB_ROW]))
        .mockReturnValue(makeSelectChain([])),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockRejectedValue(new Error('DB error')),
      }),
      update: vi.fn().mockReturnValue(makeUpdateChain()),
    };
    const deps = makeDeps(db);
    const worker = createCsvImportWorker(deps) as any;

    const result = await worker.processor(makeJob(CSV_BOB));

    expect(result.errorCount).toBe(1);
    const setCalls = deps.db.update.mock.results[0].value.set.mock.calls;
    const statuses = setCalls.map((c: any[]) => c[0].status).filter(Boolean);
    expect(statuses).toContain('failed');
  });

  it('handles a mix of successes and failures — marks done (not failed)', async () => {
    let callCount = 0;
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(makeSelectChain([IMPORT_JOB_ROW]))
        .mockReturnValue(makeSelectChain([])),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation(() => {
          callCount++;
          // First row inserts cleanly, second blows up — the point of the test. Both branches have
          // to offer `.returning()`, since the worker reads the new lead's id to meter it.
          const promise: any =
            callCount === 1 ? Promise.resolve([{ id: 'lead-uuid' }]) : Promise.reject(new Error('partial error'));
          promise.returning =
            callCount === 1
              ? vi.fn().mockResolvedValue([{ id: 'lead-uuid' }])
              : vi.fn().mockRejectedValue(new Error('partial error'));
          return promise;
        }),
      })),
      update: vi.fn().mockReturnValue(makeUpdateChain()),
    };
    const deps = makeDeps(db);
    const worker = createCsvImportWorker(deps) as any;

    const result = await worker.processor(makeJob(CSV_ALICE_BOB));

    expect(result.processedRows).toBe(1);
    expect(result.errorCount).toBe(1);
    const setCalls = deps.db.update.mock.results[0].value.set.mock.calls;
    const statuses = setCalls.map((c: any[]) => c[0].status).filter(Boolean);
    expect(statuses).toContain('done');
    expect(statuses).not.toContain('failed');
  });

  it('uses source "csv" for inserted leads', async () => {
    const insertValues = vi.fn().mockResolvedValue([]);
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(makeSelectChain([IMPORT_JOB_ROW]))
        .mockReturnValue(makeSelectChain([])),
      insert: vi.fn().mockReturnValue({ values: insertValues }),
      update: vi.fn().mockReturnValue(makeUpdateChain()),
    };
    const deps = makeDeps(db);
    const worker = createCsvImportWorker(deps) as any;

    await worker.processor(makeJob(CSV_BOB));

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'csv', status: 'new', tenantId: TENANT_ID }),
    );
  });

  it('returns processedRows and errorCount', async () => {
    const deps = makeDeps();
    const worker = createCsvImportWorker(deps) as any;

    const result = await worker.processor(makeJob(CSV_ALICE_BOB));
    expect(result).toMatchObject({ processedRows: 2, errorCount: 0 });
  });

  it('updates import_job status to failed on worker failure event', async () => {
    const db = {
      select: vi.fn().mockReturnValue(makeSelectChain([])),
      insert: vi.fn().mockReturnValue(makeInsertChain()),
      update: vi.fn().mockReturnValue(makeUpdateChain()),
    };
    const deps = makeDeps(db);
    const { Worker } = await import('bullmq');

    let failedHandler: Function | undefined;
    vi.mocked(Worker).mockImplementationOnce((_name: string, _processor: any) => ({
      processor: _processor,
      on: vi.fn().mockImplementation((event: string, handler: Function) => {
        if (event === 'failed') failedHandler = handler;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }) as any);

    createCsvImportWorker(deps);

    const fakeJob = { id: 'j1', data: { tenantId: TENANT_ID, jobId: JOB_ID }, attemptsMade: 3, opts: { attempts: 3 } };
    failedHandler?.(fakeJob, new Error('catastrophic'));

    await vi.waitFor(() => {
      expect(deps.db.update).toHaveBeenCalled();
    });
  });
});
