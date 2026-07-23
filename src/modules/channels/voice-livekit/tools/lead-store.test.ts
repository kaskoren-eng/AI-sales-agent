import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../../db/client.js';
import { findLeadIdByPhone, mergeLeadQualification, phoneSuffix, upsertLead } from './lead-store.js';

function fakeDb(opts: { phoneMatch?: string | null } = {}) {
  const updates: Array<{ vals: Record<string, unknown>; where: unknown }> = [];
  const inserts: Record<string, unknown>[] = [];
  const selects: unknown[] = [];
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: (w: unknown) => {
          selects.push(w);
          return { limit: async () => (opts.phoneMatch ? [{ id: opts.phoneMatch }] : []) };
        },
      }),
    })),
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => ({
        where: async (w: unknown) => {
          updates.push({ vals, where: w });
        },
      }),
    })),
    insert: vi.fn(() => ({
      values: (vals: Record<string, unknown>) => {
        inserts.push(vals);
        return { returning: async () => [{ id: 'lead-new' }] };
      },
    })),
  } as unknown as Database;
  return { db, updates, inserts, selects };
}

describe('phoneSuffix', () => {
  it('normalizes Israeli formats to the last 9 digits', () => {
    expect(phoneSuffix('+972-50-123-4567')).toBe('501234567');
    expect(phoneSuffix('0501234567')).toBe('501234567');
  });
});

describe('findLeadIdByPhone', () => {
  it('refuses to match on suffixes too short to be meaningful', async () => {
    const { db } = fakeDb({ phoneMatch: 'lead-x' });
    expect(await findLeadIdByPhone(db, 't1', '123')).toBeNull();
  });

  it('returns the tenant-scoped match', async () => {
    const { db } = fakeDb({ phoneMatch: 'lead-x' });
    expect(await findLeadIdByPhone(db, 't1', '+972501234567')).toBe('lead-x');
  });
});

describe('upsertLead', () => {
  it('known leadId → tenant-scoped backfill update, no insert', async () => {
    const { db, updates, inserts } = fakeDb();
    const id = await upsertLead(db, 't1', { leadId: 'lead-known', callerPhone: null }, { name: 'דנה' });
    expect(id).toBe('lead-known');
    expect(updates).toHaveLength(1);
    expect(inserts).toHaveLength(0);
  });

  it('status is written ONLY when the caller decides so', async () => {
    const { db, updates } = fakeDb();
    await upsertLead(db, 't1', { leadId: 'l1', callerPhone: null }, { name: 'x' });
    expect(updates[0]!.vals).not.toHaveProperty('status');
    await upsertLead(db, 't1', { leadId: 'l1', callerPhone: null }, { name: 'x' }, { status: 'qualified' });
    expect(updates[1]!.vals).toMatchObject({ status: 'qualified' });
  });

  it('phone match (falls back to callerPhone) → update existing', async () => {
    const { db, updates, inserts } = fakeDb({ phoneMatch: 'lead-by-phone' });
    const id = await upsertLead(db, 't1', { leadId: null, callerPhone: '+972501234567' }, { name: 'דנה' });
    expect(id).toBe('lead-by-phone');
    expect(updates).toHaveLength(1);
    expect(inserts).toHaveLength(0);
  });

  it('stranger → inserts a voice-livekit lead, callerPhone as phone, default status new', async () => {
    const { db, inserts } = fakeDb({ phoneMatch: null });
    const id = await upsertLead(db, 't1', { leadId: null, callerPhone: '+972501234567' }, { name: 'דנה' });
    expect(id).toBe('lead-new');
    expect(inserts[0]).toMatchObject({
      tenantId: 't1',
      phone: '+972501234567',
      source: 'voice-livekit',
      status: 'new',
    });
  });
});

describe('mergeLeadQualification', () => {
  it('merges into metadata.qualification and raises score monotonically', async () => {
    const { db, updates } = fakeDb();
    await mergeLeadQualification(db, 't1', 'l1', { budget: '20K' }, 90);
    expect(updates).toHaveLength(1);
    const vals = updates[0]!.vals;
    expect(vals).toHaveProperty('metadata'); // jsonb || merge expression
    expect(vals).toHaveProperty('score'); // GREATEST expression
  });

  it('leaves score untouched when no floor is given', async () => {
    const { db, updates } = fakeDb();
    await mergeLeadQualification(db, 't1', 'l1', { notes: 'x' });
    expect(updates[0]!.vals).not.toHaveProperty('score');
  });
});
