import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/client.js';
import { tenants, leads, conversations } from '../../db/schema/index.js';

// Decrypt is identity in tests — settings hold the "encrypted" token verbatim, so mondayFor /
// airtableFor build a real client. We stub global fetch, so the REAL Monday/Airtable services run
// and we assert on the actual request payloads they emit.
vi.mock('../../shared/crypto.js', () => ({ decrypt: (v: string) => v, encrypt: (v: string) => v }));

import { syncCallToCrm } from './crm-sync.service.js';

const silent = { info() {}, warn() {}, error() {} };

/** A drizzle-ish fake that returns configured rows per table and records every update. */
function fakeDb(rows: { tenants?: any[]; conversations?: any[]; leads?: any[] }) {
  const updates: Array<{ table: unknown; vals: Record<string, unknown> }> = [];
  const db = {
    select: (_proj?: unknown) => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === tenants) return rows.tenants ?? [];
            if (table === conversations) return rows.conversations ?? [];
            if (table === leads) return rows.leads ?? [];
            return [];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ table, vals });
        },
      }),
    }),
  } as unknown as Database;
  return { db, updates };
}

const okJson = (data: unknown) => ({
  ok: true,
  status: 200,
  json: async () => data,
  text: async () => JSON.stringify(data),
});
const MONDAY_OK = okJson({ data: { change_multiple_column_values: { id: 'item1' } } });
const MONDAY_CREATE_OK = okJson({ data: { create_item: { id: 'item-new' } } });
const AIRTABLE_OK = okJson({ id: 'rec1', fields: {} });

interface FetchLog {
  monday: Array<{ query: string; variables: any }>;
  airtable: Array<{ url: string; method?: string; body: any }>;
}

/** Route fetch by host; capture parsed request bodies; let each host's behavior be overridden. */
function stubFetch(opts?: { mondayThrows?: boolean; airtableThrows?: boolean }) {
  const log: FetchLog = { monday: [], airtable: [] };
  const fn = vi.fn(async (url: any, init: any) => {
    const u = String(url);
    if (u.includes('api.monday.com')) {
      const body = JSON.parse(init.body);
      log.monday.push({ query: body.query, variables: body.variables });
      if (opts?.mondayThrows) throw new Error('monday network down');
      return body.query.includes('create_item') ? MONDAY_CREATE_OK : MONDAY_OK;
    }
    if (u.includes('api.airtable.com')) {
      log.airtable.push({ url: u, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (opts?.airtableThrows) throw new Error('airtable network down');
      return AIRTABLE_OK;
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return log;
}

const mondaySettings = (extra: any = {}) => ({
  monday: { encryptedApiToken: 'tok', boardId: 'b1', columnMap: { status: 'status_col', email: 'email_col' } },
  crm_sync: { monday: { statusLabels: { qualified: 'Hot Lead', disqualified: 'Not a fit' } }, ...extra },
});
const airtableSettings = (extra: any = {}) => ({
  airtable: { encryptedApiKey: 'key', baseId: 'base1', tableId: 'tbl1' },
  crm_sync: { airtable: { statusFieldName: 'Stage', statusValues: { qualified: 'Won', disqualified: 'Lost' } }, ...extra },
});
const lead = (over: any = {}) => ({
  id: 'lead1', tenantId: 't1', name: 'Dana', email: 'd@x.co', phone: '+972501112222',
  status: 'qualifying', score: 60, metadata: {}, ...over,
});
const deps = (db: Database) => ({ db, encryptionKey: 'k', logger: silent });

const BASE_INPUT = { tenantId: 't1', conversationId: 'c1', endReason: 'meeting_booked' as const };

beforeEach(() => stubFetch());
afterEach(() => vi.unstubAllGlobals());

describe('syncCallToCrm — B1 status sync', () => {
  it('meeting_booked → qualified, pushed to Monday with the tenant label', async () => {
    const log = stubFetch();
    const { db, updates } = fakeDb({
      tenants: [{ settings: mondaySettings() }],
      conversations: [{ leadId: 'lead1' }],
      leads: [lead({ metadata: { mondayItemId: 'item1' } })],
    });

    const res = await syncCallToCrm(deps(db), BASE_INPUT);

    expect(res.status).toBe('qualified');
    expect(res.localStatusUpdated).toBe(true);
    expect(res.monday?.ok).toBe(true);
    // our own lead moved to qualified
    const leadUpdate = updates.find((u) => u.table === leads);
    expect(leadUpdate?.vals.status).toBe('qualified');
    // Monday got the mapped LABEL, not our canonical string
    const call = log.monday.find((m) => m.query.includes('change_multiple_column_values'))!;
    const cols = JSON.parse(call.variables.columnValues);
    expect(cols.status_col).toBe('Hot Lead');
  });

  it('not_interested → disqualified with reason, pushed to Airtable with the mapped value', async () => {
    const log = stubFetch();
    const { db, updates } = fakeDb({
      tenants: [{ settings: airtableSettings() }],
      conversations: [{ leadId: 'lead1' }],
      leads: [lead({ metadata: { airtableRecordId: 'rec1' } })],
    });

    const res = await syncCallToCrm(deps(db), { ...BASE_INPUT, endReason: 'not_interested' });

    expect(res.status).toBe('disqualified');
    const leadUpdate = updates.find((u) => u.table === leads);
    expect(leadUpdate?.vals.status).toBe('disqualified');
    expect((leadUpdate?.vals.metadata as any).disqualifyReason).toBe('not_interested');
    // Airtable PATCH payload carries the mapped status value in the configured field
    const patch = log.airtable.find((a) => a.method === 'PATCH')!;
    expect(patch.body.fields).toEqual({ Stage: 'Lost' });
  });

  it('respects a per-tenant statusMap override', async () => {
    const log = stubFetch();
    const { db } = fakeDb({
      tenants: [{ settings: mondaySettings({ statusMap: { meeting_booked: 'contacted' }, monday: { statusLabels: { contacted: 'Follow up' } } }) }],
      conversations: [{ leadId: 'lead1' }],
      leads: [lead({ status: 'new', metadata: { mondayItemId: 'item1' } })],
    });

    const res = await syncCallToCrm(deps(db), BASE_INPUT);

    expect(res.status).toBe('contacted');
    const cols = JSON.parse(log.monday.find((m) => m.query.includes('change_multiple_column_values'))!.variables.columnValues);
    expect(cols.status_col).toBe('Follow up');
  });

  it('skips silently when no CRM is connected', async () => {
    const log = stubFetch();
    const { db, updates } = fakeDb({
      tenants: [{ settings: { crm_sync: {} } }],
      conversations: [{ leadId: 'lead1' }],
      leads: [lead()],
    });

    const res = await syncCallToCrm(deps(db), BASE_INPUT);

    expect(res.skipped).toBe('no_crm');
    expect(updates).toHaveLength(0);
    expect(log.monday).toHaveLength(0);
    expect(log.airtable).toHaveLength(0);
  });

  it('skips when crm_sync is disabled', async () => {
    const { db } = fakeDb({
      tenants: [{ settings: { ...mondaySettings(), crm_sync: { enabled: false } } }],
      conversations: [{ leadId: 'lead1' }],
      leads: [lead()],
    });
    const res = await syncCallToCrm(deps(db), BASE_INPUT);
    expect(res.skipped).toBe('disabled');
  });

  it('returns no_status_change for an outcome that does not move the pipeline', async () => {
    const { db, updates } = fakeDb({
      tenants: [{ settings: mondaySettings() }],
      conversations: [{ leadId: 'lead1' }],
      leads: [lead()],
    });
    const res = await syncCallToCrm(deps(db), { ...BASE_INPUT, endReason: 'wrong_person' });
    expect(res.skipped).toBe('no_status_change');
    expect(updates).toHaveLength(0);
  });

  it('honors canTransition — never pushes a status the guard rejects (opted_out lead)', async () => {
    const log = stubFetch();
    const { db, updates } = fakeDb({
      tenants: [{ settings: mondaySettings() }],
      conversations: [{ leadId: 'lead1' }],
      leads: [lead({ status: 'opted_out', metadata: { mondayItemId: 'item1' } })],
    });

    const res = await syncCallToCrm(deps(db), BASE_INPUT);

    expect(res.skipped).toBe('no_status_change');
    expect(res.localStatusUpdated).toBeFalsy();
    expect(updates).toHaveLength(0); // no local write
    expect(log.monday).toHaveLength(0); // no CRM push
  });

  it('still pushes to CRM when the lead is already at the target (book_meeting set it live)', async () => {
    const log = stubFetch();
    const { db, updates } = fakeDb({
      tenants: [{ settings: mondaySettings() }],
      conversations: [{ leadId: 'lead1' }],
      leads: [lead({ status: 'qualified', metadata: { mondayItemId: 'item1' } })],
    });

    const res = await syncCallToCrm(deps(db), BASE_INPUT);

    expect(res.status).toBe('qualified');
    expect(res.localStatusUpdated).toBe(false); // already there, no local write
    expect(updates).toHaveLength(0);
    expect(res.monday?.ok).toBe(true); // but the board still gets updated
    expect(log.monday.some((m) => m.query.includes('change_multiple_column_values'))).toBe(true);
  });

  it('creates a Monday item when the lead is not linked yet', async () => {
    const log = stubFetch();
    const { db, updates } = fakeDb({
      tenants: [{ settings: mondaySettings() }],
      conversations: [{ leadId: 'lead1' }],
      leads: [lead({ metadata: {} })], // no mondayItemId
    });

    await syncCallToCrm(deps(db), BASE_INPUT);

    expect(log.monday.some((m) => m.query.includes('create_item'))).toBe(true);
    // the new item id is persisted back to the lead metadata
    const metaWrite = updates.find((u) => (u.vals.metadata as any)?.mondayItemId === 'item-new');
    expect(metaWrite).toBeTruthy();
  });
});

describe('syncCallToCrm — failure isolation', () => {
  it('never throws and isolates one CRM failure from the other', async () => {
    const log = stubFetch({ mondayThrows: true }); // Monday down, Airtable fine
    const { db, updates } = fakeDb({
      tenants: [{ settings: { ...mondaySettings(), ...airtableSettings(), crm_sync: { monday: { statusLabels: {} }, airtable: { statusFieldName: 'Stage', statusValues: {} } } } }],
      conversations: [{ leadId: 'lead1' }],
      leads: [lead({ metadata: { mondayItemId: 'item1', airtableRecordId: 'rec1' } })],
    });

    const res = await syncCallToCrm(deps(db), BASE_INPUT);

    expect(res.monday?.ok).toBe(false);
    expect(res.monday?.error).toContain('monday');
    expect(res.airtable?.ok).toBe(true); // the other CRM still synced
    // and our own lead status was still updated despite the Monday failure
    expect(updates.find((u) => u.table === leads)?.vals.status).toBe('qualified');
  });

  it('returns an empty result (no throw) if the tenant lookup itself explodes', async () => {
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => { throw new Error('db gone'); } }) }) }),
    } as unknown as Database;

    const res = await syncCallToCrm({ db, encryptionKey: 'k', logger: silent }, BASE_INPUT);
    expect(res).toEqual({});
  });
});
