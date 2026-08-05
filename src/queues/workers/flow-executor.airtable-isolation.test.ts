/**
 * THE LEAK THIS CLOSES.
 *
 * `AIRTABLE_API_KEY` / `AIRTABLE_BASE_ID` / `AIRTABLE_TABLE_ID` are ClickScales' own Airtable
 * credentials, and they are set in production. The `update_airtable` flow step used them as a
 * blanket fallback for ANY tenant that had not configured Airtable itself.
 *
 * So a second customer running that step would have written their leads — names, phone numbers,
 * email addresses — into our base, and read ours back when searching by phone. It looks like the
 * feature working from both ends, and the tenant most likely to hit it is the one with no Airtable
 * at all, who has nothing to notice missing.
 *
 * The fallback is now gated on the tenant BEING ClickScales (`PLATFORM_TENANT_ID`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const capturedProcessors: Array<(job: any) => Promise<any>> = [];

vi.mock('bullmq', () => {
  class Worker {
    constructor(_name: string, processor: (job: any) => Promise<any>) {
      capturedProcessors.push(processor);
    }
    on() { return this; }
    close() { return Promise.resolve(); }
  }
  return { Worker };
});

vi.mock('../flow-executor.queue.js', () => ({
  enqueueFlowStep: vi.fn().mockResolvedValue({ id: 'next' }),
}));

// Constructing this is the observable proof that credentials were resolved. If the tenant is
// refused, it must never be built.
const airtableCtor = vi.fn();
vi.mock('../../modules/integrations/airtable/airtable.service.js', () => ({
  AirtableService: class {
    constructor(cfg: any) {
      airtableCtor(cfg);
    }
    findByPhone = vi.fn().mockResolvedValue(null);
    findByEmail = vi.fn().mockResolvedValue(null);
    updateRecord = vi.fn().mockResolvedValue(undefined);
  },
}));

import { createFlowExecutorWorker } from './flow-executor.worker.js';

const PLATFORM_TENANT = '613d826c-ad00-4302-9817-1c0649ed4f98';
const OTHER_TENANT = '11111111-2222-3333-4444-555555555555';

const AIRTABLE_STEP = {
  type: 'update_airtable',
  delayMinutes: 0,
  fields: { Status: 'Qualified' },
};

const PLATFORM_ENV = {
  AI_MODEL: 'gpt-5.4',
  ENCRYPTION_KEY: 'x'.repeat(32),
  PLATFORM_TENANT_ID: PLATFORM_TENANT,
  AIRTABLE_API_KEY: 'pat-ours',
  AIRTABLE_BASE_ID: 'appOURS',
  AIRTABLE_TABLE_ID: 'tblOURS',
  AIRTABLE_PHONE_FIELD: 'Phone',
  AIRTABLE_EMAIL_FIELD: 'Email',
};

function chain(rows: any[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
}

/** A tenant whose flow contains one update_airtable step and who has NO airtable settings. */
const tenantRow = {
  settings: { flows: { sync: { enabled: true, steps: [AIRTABLE_STEP] } } },
};

function makeDeps(env: Record<string, unknown>) {
  const warn = vi.fn();
  const db = { select: vi.fn(), update: vi.fn() };
  // Every select in this path — the flow lookup, the settings lookup, the lead lookup — resolves
  // through the same chain; only the first two matter before the guard.
  db.select.mockReturnValue(chain([tenantRow]));
  return {
    db: db as any,
    env: env as any,
    redis: { duplicate: vi.fn().mockReturnValue({}) } as any,
    flowExecutorQueue: { add: vi.fn() } as any,
    logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as any,
    _warn: warn,
  };
}

function job(tenantId: string) {
  return {
    id: 'j1',
    data: {
      tenantId,
      leadId: 'lead-1',
      flowName: 'sync',
      stepIndex: 0,
      leadPhone: '+972500000000',
      leadName: 'Dana',
      leadEmail: 'dana@example.com',
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
  };
}

describe('update_airtable — the platform credentials are not a shared fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    airtableCtor.mockClear();
    capturedProcessors.length = 0;
    vi.useFakeTimers({ now: new Date('2026-07-21T09:00:00.000Z'), toFake: ['Date'] });
  });

  afterEach(() => vi.useRealTimers());

  it('REFUSES to use ClickScales credentials for another tenant', async () => {
    const deps = makeDeps(PLATFORM_ENV);
    createFlowExecutorWorker(deps);

    await capturedProcessors[0](job(OTHER_TENANT));

    // The decisive assertion: no Airtable client was ever built, so nothing could be written.
    expect(airtableCtor).not.toHaveBeenCalled();
    expect(deps._warn).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: OTHER_TENANT,
        reason: 'airtable_not_connected_for_this_tenant',
      }),
      expect.any(String),
    );
  });

  it('still lets ClickScales itself use them', async () => {
    // The fallback exists for a reason — ClickScales' own flows run on these credentials. Narrowing
    // it must not break the tenant it was written for.
    const deps = makeDeps(PLATFORM_ENV);
    createFlowExecutorWorker(deps);

    await capturedProcessors[0](job(PLATFORM_TENANT));

    expect(airtableCtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'pat-ours', baseId: 'appOURS', tableId: 'tblOURS' }),
    );
  });

  it('refuses everyone when PLATFORM_TENANT_ID is unset', async () => {
    // Fail closed. An unset platform id must not mean "the old behaviour", or forgetting to set it
    // silently restores the leak.
    const { PLATFORM_TENANT_ID: _omitted, ...noPlatform } = PLATFORM_ENV;
    const deps = makeDeps(noPlatform);
    createFlowExecutorWorker(deps);

    await capturedProcessors[0](job(PLATFORM_TENANT));

    expect(airtableCtor).not.toHaveBeenCalled();
  });
});
