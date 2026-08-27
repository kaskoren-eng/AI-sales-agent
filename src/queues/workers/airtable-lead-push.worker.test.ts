/**
 * The three promises this worker makes:
 *   1. Only ClickScales' own tenant ever reaches Koren's private sales board.
 *   2. A retry cannot create a second row (Airtable's create API has no idempotency key).
 *   3. Airtable being down is the push's problem and nobody else's — the lead is already in
 *      Postgres and the outbound call is already armed by the time this job runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedProcessors: Array<(job: any) => Promise<any>> = [];
const capturedFailedHandlers: Array<(job: any, err: Error) => void> = [];

vi.mock('bullmq', () => {
  class Worker {
    constructor(_name: string, processor: (job: any) => Promise<any>) {
      capturedProcessors.push(processor);
    }
    on(event: string, handler: any) {
      if (event === 'failed') capturedFailedHandlers.push(handler);
      return this;
    }
    close() { return Promise.resolve(); }
  }
  return { Worker };
});

// Constructing the service is the observable proof that the gates were passed. If the tenant is
// refused or the config is missing, it must never be built.
const airtableCtor = vi.fn();
const createRecord = vi.fn().mockResolvedValue('recNEW123');
vi.mock('../../modules/integrations/airtable/airtable.service.js', () => ({
  AirtableService: class {
    constructor(cfg: any) { airtableCtor(cfg); }
    createRecord = createRecord;
  },
}));

const handleDeadLetter = vi.fn();
vi.mock('../dead-letter.js', () => ({ handleDeadLetter: (...a: any[]) => handleDeadLetter(...a) }));

import { createAirtableLeadPushWorker } from './airtable-lead-push.worker.js';
import {
  LEAD_BOARD_RECORD_ID_KEY,
  LEAD_BOARD_FIELDS as F,
} from '../../modules/integrations/airtable/lead-board.js';

const PLATFORM_TENANT = '613d826c-ad00-4302-9817-1c0649ed4f98';
const OTHER_TENANT = '11111111-2222-3333-4444-555555555555';

const ENV = {
  PLATFORM_TENANT_ID: PLATFORM_TENANT,
  AIRTABLE_LEADS_PAT: 'pat-leads',
  AIRTABLE_LEADS_BASE_ID: 'app7IOcK9NvTvHyBm',
  AIRTABLE_LEADS_TABLE_ID: 'tblP4AW6CQLxZVO1P',
};

const LEAD_ROW = {
  name: 'Dana Levi',
  email: 'dana@example.com',
  phone: '+972501234567',
  source: 'clickscales.com',
  metadata: { mondayItemId: '999', utm_campaign: 'launch-he' },
  whatsappConsent: null,
};

function makeDeps(env: Record<string, unknown> = ENV, leadRows: any[] = [LEAD_ROW]) {
  const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(leadRows),
    }),
    update: vi.fn().mockReturnValue({ set: setSpy }),
  };
  return {
    db: db as any,
    env: env as any,
    redis: { duplicate: vi.fn().mockReturnValue({}) } as any,
    deadLetterQueue: { add: vi.fn() } as any,
    _setSpy: setSpy,
  };
}

const job = (tenantId: string) => ({
  id: 'airtable-lead-lead-1',
  data: { tenantId, leadId: 'lead-1' },
  attemptsMade: 0,
  opts: { attempts: 3 },
});

describe('airtable-lead-push worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedProcessors.length = 0;
    capturedFailedHandlers.length = 0;
    createRecord.mockResolvedValue('recNEW123');
  });

  it('REFUSES another tenant — this board is not a per-tenant feature', async () => {
    const deps = makeDeps();
    createAirtableLeadPushWorker(deps);

    const result = await capturedProcessors[0](job(OTHER_TENANT));

    expect(result).toEqual({ skipped: 'not_platform_tenant' });
    expect(airtableCtor).not.toHaveBeenCalled();
    // Not even a read: another tenant's lead row is never loaded for this purpose.
    expect(deps.db.select).not.toHaveBeenCalled();
  });

  it('refuses everyone when PLATFORM_TENANT_ID is unset', async () => {
    // Fail closed. An unset platform id must not degrade to "push whoever asked".
    const { PLATFORM_TENANT_ID: _omitted, ...noPlatform } = ENV;
    createAirtableLeadPushWorker(makeDeps(noPlatform));

    expect(await capturedProcessors[0](job(PLATFORM_TENANT))).toEqual({
      skipped: 'not_platform_tenant',
    });
    expect(airtableCtor).not.toHaveBeenCalled();
  });

  it('skips when the board is not configured', async () => {
    const { AIRTABLE_LEADS_PAT: _omitted, ...noPat } = ENV;
    createAirtableLeadPushWorker(makeDeps(noPat));

    expect(await capturedProcessors[0](job(PLATFORM_TENANT))).toEqual({ skipped: 'not_configured' });
    expect(airtableCtor).not.toHaveBeenCalled();
  });

  it('creates the row and caches the record id back onto the lead', async () => {
    const deps = makeDeps();
    createAirtableLeadPushWorker(deps);

    const result = await capturedProcessors[0](job(PLATFORM_TENANT));

    expect(result).toEqual({ recordId: 'recNEW123' });
    expect(airtableCtor).toHaveBeenCalledWith({
      apiKey: 'pat-leads',
      baseId: 'app7IOcK9NvTvHyBm',
      tableId: 'tblP4AW6CQLxZVO1P',
    });
    expect(createRecord).toHaveBeenCalledWith(expect.objectContaining({ [F.lead]: 'Dana Levi' }));

    // Spread-merge, not replace: metadata is shared with mondayItemId, airtableRecordId and the
    // Meta attribution blob, and clobbering it would quietly break the tenant CRM sync.
    expect(deps._setSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          mondayItemId: '999',
          utm_campaign: 'launch-he',
          [LEAD_BOARD_RECORD_ID_KEY]: 'recNEW123',
        },
      }),
    );
  });

  it('no-ops when the lead already has a board row', async () => {
    // The durable half of idempotency. BullMQ's deterministic jobId covers a retry while the job
    // record lives; this covers everything after that, including a manual re-enqueue.
    const deps = makeDeps(ENV, [
      { ...LEAD_ROW, metadata: { [LEAD_BOARD_RECORD_ID_KEY]: 'recOLD456' } },
    ]);
    createAirtableLeadPushWorker(deps);

    expect(await capturedProcessors[0](job(PLATFORM_TENANT))).toEqual({
      skipped: 'already_pushed',
      recordId: 'recOLD456',
    });
    expect(createRecord).not.toHaveBeenCalled();
    expect(deps.db.update).not.toHaveBeenCalled();
  });

  it('does not retry a lead that no longer exists', async () => {
    createAirtableLeadPushWorker(makeDeps(ENV, []));

    expect(await capturedProcessors[0](job(PLATFORM_TENANT))).toEqual({ skipped: 'lead_not_found' });
    expect(createRecord).not.toHaveBeenCalled();
  });

  it('lets an Airtable failure surface as a job failure, and dead-letters it', async () => {
    // Deliberately NOT swallowed inside the processor: BullMQ's retry is the recovery path and the
    // DLQ is where a push that never landed becomes visible instead of silently missing. Nothing
    // on the intake path is waiting on this — the job already ran off the request.
    const deps = makeDeps();
    createAirtableLeadPushWorker(deps);
    const err = new Error('Circuit breaker is OPEN for airtable');
    createRecord.mockRejectedValueOnce(err);

    await expect(capturedProcessors[0](job(PLATFORM_TENANT))).rejects.toThrow(/OPEN for airtable/);
    // No record id cached, so the retry still has work to do rather than seeing "already pushed".
    expect(deps.db.update).not.toHaveBeenCalled();

    const failed = { ...job(PLATFORM_TENANT), attemptsMade: 3 };
    capturedFailedHandlers[0](failed, err);
    expect(handleDeadLetter).toHaveBeenCalledWith(deps.deadLetterQueue, failed, err);
  });

  it('keeps PII out of the failure log', async () => {
    const deps = makeDeps();
    createAirtableLeadPushWorker(deps);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    capturedFailedHandlers[0](
      { ...job(PLATFORM_TENANT), attemptsMade: 3 },
      new Error('Airtable 422: bad'),
    );

    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).toContain('lead-1');
    expect(line).not.toContain('Dana Levi');
    expect(line).not.toContain('+972501234567');
    spy.mockRestore();
  });
});
