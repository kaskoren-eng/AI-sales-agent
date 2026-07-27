import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../db/client.js';
import {
  createVoiceConversation,
  ensureWebCallPlaceholderLead,
  WEB_CALL_PLACEHOLDER_SOURCE,
} from './call-record.js';

/**
 * Task 0 — the row-creation helpers that make LiveKit calls visible in the dashboard calls list.
 * Mocks the Drizzle chain (same pattern as lead-store.test.ts): capture what got inserted.
 */
function fakeDb(opts: { existingLeadId?: string | null; newConversationId?: string; newLeadId?: string } = {}) {
  const inserts: Array<{ table: 'lead' | 'conversation'; vals: Record<string, unknown> }> = [];
  let nextInsertReturns: string = opts.newConversationId ?? 'convo-new';
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => (opts.existingLeadId ? [{ id: opts.existingLeadId }] : []),
        }),
      }),
    })),
    insert: vi.fn(() => ({
      values: (vals: Record<string, unknown>) => {
        // Distinguish the two inserts by a field only one of them carries.
        const isConversation = 'channelRef' in vals || 'channel' in vals;
        inserts.push({ table: isConversation ? 'conversation' : 'lead', vals });
        nextInsertReturns = isConversation
          ? (opts.newConversationId ?? 'convo-new')
          : (opts.newLeadId ?? 'lead-new');
        return { returning: async () => [{ id: nextInsertReturns }] };
      },
    })),
  } as unknown as Database;
  return { db, inserts };
}

describe('ensureWebCallPlaceholderLead', () => {
  it('reuses the existing per-tenant placeholder lead — no insert', async () => {
    const { db, inserts } = fakeDb({ existingLeadId: 'placeholder-1' });
    const id = await ensureWebCallPlaceholderLead(db, 't1');
    expect(id).toBe('placeholder-1');
    expect(inserts).toHaveLength(0);
  });

  it('creates one when none exists, tagged with the sentinel source', async () => {
    const { db, inserts } = fakeDb({ existingLeadId: null, newLeadId: 'placeholder-new' });
    const id = await ensureWebCallPlaceholderLead(db, 't1');
    expect(id).toBe('placeholder-new');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.table).toBe('lead');
    expect(inserts[0]!.vals).toMatchObject({
      tenantId: 't1',
      source: WEB_CALL_PLACEHOLDER_SOURCE,
    });
  });
});

describe('createVoiceConversation', () => {
  it('inserts a voice conversation keyed by room name and returns its id', async () => {
    const { db, inserts } = fakeDb({ newConversationId: 'convo-42' });
    const id = await createVoiceConversation(db, {
      tenantId: 't1',
      leadId: 'lead-1',
      roomName: 'call-out-abc',
    });
    expect(id).toBe('convo-42');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.vals).toMatchObject({
      tenantId: 't1',
      leadId: 'lead-1',
      channel: 'voice',
      channelRef: 'call-out-abc',
      status: 'active',
    });
  });
});
