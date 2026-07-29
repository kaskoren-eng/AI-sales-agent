import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../db/client.js';
import {
  createVoiceConversation,
  ensureAgentSideConversation,
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
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: async () => (opts.existingLeadId ? [{ id: opts.existingLeadId }] : []),
        }),
      }),
    })),
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          updates.push(vals);
        },
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
  return { db, inserts, updates };
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

describe('ensureAgentSideConversation (inbound Task 0)', () => {
  it('uses a known leadId directly — no lead lookup — and opens the conversation', async () => {
    const { db, inserts, updates } = fakeDb({ newConversationId: 'convo-in' });
    const res = await ensureAgentSideConversation(db, {
      tenantId: 't1',
      leadId: 'lead-known',
      callerPhone: '+972501234567',
      roomName: 'call-_+972501234567_x',
    });
    expect(res).toEqual({ leadId: 'lead-known', conversationId: 'convo-in' });
    // Only the conversation was inserted; no new lead created, no lead update.
    expect(inserts.filter((i) => i.table === 'lead')).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(inserts.find((i) => i.table === 'conversation')?.vals).toMatchObject({ leadId: 'lead-known' });
  });

  it('inbound with no leadId resolves the caller to an existing lead by phone', async () => {
    const { db, inserts } = fakeDb({ existingLeadId: 'lead-by-phone', newConversationId: 'convo-in' });
    const res = await ensureAgentSideConversation(db, {
      tenantId: 't1',
      leadId: null,
      callerPhone: '+972509788845',
      roomName: 'call-_+972509788845_y',
    });
    expect(res).toEqual({ leadId: 'lead-by-phone', conversationId: 'convo-in' });
    expect(inserts.filter((i) => i.table === 'lead')).toHaveLength(0); // reused, not created
    expect(inserts.find((i) => i.table === 'conversation')?.vals).toMatchObject({ leadId: 'lead-by-phone' });
  });

  it('inbound with no leadId and no phone match creates a fresh lead, then the conversation', async () => {
    const { db, inserts } = fakeDb({ existingLeadId: null, newLeadId: 'lead-fresh', newConversationId: 'convo-in' });
    const res = await ensureAgentSideConversation(db, {
      tenantId: 't1',
      leadId: null,
      callerPhone: '+972500000000',
      roomName: 'call-_+972500000000_z',
    });
    expect(res).toEqual({ leadId: 'lead-fresh', conversationId: 'convo-in' });
    expect(inserts.find((i) => i.table === 'lead')?.vals).toMatchObject({ tenantId: 't1', source: 'voice-livekit' });
    expect(inserts.find((i) => i.table === 'conversation')?.vals).toMatchObject({ leadId: 'lead-fresh' });
  });
});
