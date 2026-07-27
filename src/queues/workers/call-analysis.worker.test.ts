import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/client.js';
import { callLearnings } from '../../db/schema/call-learnings.js';
import { conversations } from '../../db/schema/index.js';
import { analyzeLiveKitCall } from './call-analysis.worker.js';

/**
 * The LiveKit call-analysis path: GPT analysis layered over the agent's own instrumentation, and
 * the Task-0 conversation finalized. The Retell/Whisper path is unchanged and covered elsewhere.
 */
function fakeDb(row: { transcript: unknown; analysis: unknown } | null) {
  const updates: Array<{ table: unknown; vals: Record<string, unknown> }> = [];
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }),
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

const AGENT_ANALYSIS = {
  tool_calls: [{ atMs: 100, name: 'book_meeting', durationMs: 2850, ok: true }],
  end_reason: 'meeting_booked',
  recording_notice_played: false,
};

describe('analyzeLiveKitCall', () => {
  it('layers GPT analysis over the agent fields and marks the learning analyzed', async () => {
    const { db, updates } = fakeDb({ transcript: [{ speaker: 'user', text: 'hi' }, { speaker: 'agent', text: 'hello' }], analysis: AGENT_ANALYSIS });
    const analysisService = { analyzeTranscript: vi.fn(async () => ({ summary: 'Lead wanted a demo; booked.', what_worked: ['clear opener'] })) };

    await analyzeLiveKitCall({ db }, analysisService, {
      tenantId: 't1',
      learningId: 'learn-1',
      source: 'livekit',
      conversationId: 'convo-1',
    });

    const learningUpdate = updates.find((u) => u.table === callLearnings);
    expect(learningUpdate?.vals.status).toBe('analyzed');
    const merged = learningUpdate?.vals.analysis as Record<string, unknown>;
    // GPT fields added...
    expect(merged.summary).toBe('Lead wanted a demo; booked.');
    expect(merged.what_worked).toEqual(['clear opener']);
    // ...without losing the agent's instrumentation.
    expect(merged.tool_calls).toEqual(AGENT_ANALYSIS.tool_calls);
    expect(merged.end_reason).toBe('meeting_booked');
  });

  it('finalizes the conversation to ended + summary', async () => {
    const { db, updates } = fakeDb({ transcript: [{ speaker: 'user', text: 'a' }, { speaker: 'agent', text: 'b' }], analysis: {} });
    const analysisService = { analyzeTranscript: vi.fn(async () => ({ summary: 'Recap.' })) };

    await analyzeLiveKitCall({ db }, analysisService, { tenantId: 't1', learningId: 'l1', source: 'livekit', conversationId: 'convo-9' });

    const convoUpdate = updates.find((u) => u.table === conversations);
    expect(convoUpdate?.vals).toMatchObject({ status: 'ended', summary: 'Recap.' });
  });

  it('skips the LLM round-trip for a too-thin transcript but still finalizes', async () => {
    const { db, updates } = fakeDb({ transcript: [{ speaker: 'user', text: 'hi' }], analysis: AGENT_ANALYSIS });
    const analysisService = { analyzeTranscript: vi.fn(async () => ({ summary: 'nope' })) };

    await analyzeLiveKitCall({ db }, analysisService, { tenantId: 't1', learningId: 'l1', source: 'livekit', conversationId: 'convo-1' });

    expect(analysisService.analyzeTranscript).not.toHaveBeenCalled();
    expect(updates.find((u) => u.table === callLearnings)?.vals.status).toBe('analyzed');
    // No GPT summary → conversation ended but summary left untouched.
    const convoUpdate = updates.find((u) => u.table === conversations);
    expect(convoUpdate?.vals.status).toBe('ended');
    expect(convoUpdate?.vals.summary).toBeUndefined();
  });

  it('does not touch a conversation when none was threaded in', async () => {
    const { db, updates } = fakeDb({ transcript: [{ speaker: 'user', text: 'a' }, { speaker: 'agent', text: 'b' }], analysis: {} });
    const analysisService = { analyzeTranscript: vi.fn(async () => ({ summary: 'x' })) };

    await analyzeLiveKitCall({ db }, analysisService, { tenantId: 't1', learningId: 'l1', source: 'livekit' });

    expect(updates.find((u) => u.table === conversations)).toBeUndefined();
  });

  it('throws when the learning row is missing (job retries, transcript is safe on the row)', async () => {
    const { db } = fakeDb(null);
    const analysisService = { analyzeTranscript: vi.fn() };
    await expect(
      analyzeLiveKitCall({ db }, analysisService, { tenantId: 't1', learningId: 'gone', source: 'livekit' }),
    ).rejects.toThrow(/not found/);
  });
});
