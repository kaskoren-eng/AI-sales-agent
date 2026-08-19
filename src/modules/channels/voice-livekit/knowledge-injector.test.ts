import { describe, it, expect, vi } from 'vitest';
import { KnowledgeInjector, formatKnowledgeBlock, KNOWLEDGE_MARKER } from './knowledge-injector.js';
import type { RetrievalService, RetrievedChunk } from '../../knowledge/retrieval.service.js';

function chunk(id: string, content: string): RetrievedChunk {
  return { id, documentId: 'doc', content, chunkIndex: 0, score: 0.9, vectorScore: 0.9, lexicalScore: 0.1 };
}

/** A chat context that records what was appended, with the `copy()`/`updateChatCtx` shape the real one has. */
function fakeAgent() {
  const messages: Array<{ role: string; content: string }> = [];
  const ctx = {
    addMessage(msg: { role: 'system' | 'user' | 'assistant'; content: string }) {
      messages.push(msg);
      return msg;
    },
    copy() {
      return ctx;
    },
  };
  return {
    agent: { chatCtx: ctx, updateChatCtx: vi.fn(async () => {}) },
    messages,
  };
}

function stubRetrieval(results: RetrievedChunk[][]): { service: RetrievalService; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const service = {
    search: vi.fn(async (_tenant: string, query: string) => {
      calls.push(query);
      const chunks = results[Math.min(i, results.length - 1)] ?? [];
      i += 1;
      return { chunks, discarded: 0, timing: { embedMs: 1, dbMs: 1, totalMs: 2 } };
    }),
  } as unknown as RetrievalService;
  return { service, calls };
}

describe('formatKnowledgeBlock', () => {
  it('emits the marker the prompt refers to, and nothing citable', () => {
    const block = formatKnowledgeBlock([chunk('a', 'המנוי החודשי הוא 1,490 שקלים')]);
    expect(block.startsWith(KNOWLEDGE_MARKER)).toBe(true);
    expect(block).toContain('1,490');
    // No ids, no scores, no document titles — she would read them aloud.
    expect(block).not.toContain('doc');
    expect(block).not.toContain('0.9');
  });
});

describe('KnowledgeInjector', () => {
  it('appends a knowledge message and reports what it injected', async () => {
    const { service } = stubRetrieval([[chunk('c1', 'עובדת גם בשבת')]]);
    const { agent, messages } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    const result = await injector.inject(agent, 'היא עובדת בשבת');

    expect(result.injected).toBe(true);
    expect(result.chunkIds).toEqual(['c1']);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain('עובדת גם בשבת');
    expect(agent.updateChatCtx).toHaveBeenCalledOnce();
  });

  /**
   * CONSTRAINT 2 — the same chunk is never injected twice. This bounds token growth (injections are
   * append-only for cache reasons and are never removed) and stops her repeating a fact she has
   * already been given.
   */
  it('never injects a chunk that is already in the context', async () => {
    const { service } = stubRetrieval([[chunk('c1', 'פעם ראשונה')], [chunk('c1', 'פעם ראשונה')]]);
    const { agent, messages } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    await injector.inject(agent, 'שאלה');
    const second = await injector.inject(agent, 'שאלה אחרת');

    expect(second.injected).toBe(false);
    expect(second.deduped).toBe(1);
    expect(messages).toHaveLength(1);
  });

  it('injects only the fresh chunks when a result partly overlaps', async () => {
    const { service } = stubRetrieval([
      [chunk('c1', 'ידוע')],
      [chunk('c1', 'ידוע'), chunk('c2', 'חדש')],
    ]);
    const { agent, messages } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    await injector.inject(agent, 'א');
    const second = await injector.inject(agent, 'ב');

    expect(second.chunkIds).toEqual(['c2']);
    expect(second.deduped).toBe(1);
    expect(messages[1]!.content).toContain('חדש');
    expect(messages[1]!.content).not.toContain('ידוע');
  });

  /**
   * CONSTRAINT 3 — the speculative path. A prefetch on the interim transcript must be REUSED by the
   * final one, not re-run: re-running would spend the ~205ms embedding round trip inside the turn,
   * which is the whole cost this design exists to hide.
   */
  it('reuses a speculative prefetch instead of searching again', async () => {
    const { service, calls } = stubRetrieval([[chunk('c1', 'תשובה')]]);
    const { agent } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    injector.prefetch('כמה זה עולה');
    const result = await injector.inject(agent, 'כמה זה עולה');

    expect(result.injected).toBe(true);
    expect(calls).toEqual(['כמה זה עולה']); // exactly one search, not two
  });

  it('collapses repeated interim transcripts into a single search', async () => {
    const { service, calls } = stubRetrieval([[chunk('c1', 'תשובה')]]);
    const injector = new KnowledgeInjector(service, 'tenant-1');

    injector.prefetch('כמה זה');
    injector.prefetch('כמה זה');
    injector.prefetch('כמה זה '); // trailing space — same utterance
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toHaveLength(1);
  });

  it('falls back to a fresh search when the final transcript differs from the interim', async () => {
    const { service, calls } = stubRetrieval([[chunk('c1', 'א')], [chunk('c2', 'ב')]]);
    const { agent } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    injector.prefetch('כמה זה');
    const result = await injector.inject(agent, 'כמה זה עולה בחודש');

    expect(result.injected).toBe(true);
    expect(calls).toEqual(['כמה זה', 'כמה זה עולה בחודש']);
  });

  /** A knowledge lookup that fails must cost an un-grounded turn, never the call. */
  it('degrades to no injection when retrieval throws', async () => {
    const service = {
      search: vi.fn(async () => {
        throw new Error('pgvector is on fire');
      }),
    } as unknown as RetrievalService;
    const { agent, messages } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    const result = await injector.inject(agent, 'כמה זה עולה');

    expect(result.injected).toBe(false);
    expect(messages).toHaveLength(0);
    expect(agent.updateChatCtx).not.toHaveBeenCalled();
  });

  it('does not touch the context when nothing is retrieved', async () => {
    const { service } = stubRetrieval([[]]);
    const { agent, messages } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    const result = await injector.inject(agent, 'שאלה על משהו שלא קיים');

    expect(result.injected).toBe(false);
    expect(messages).toHaveLength(0);
    expect(agent.updateChatCtx).not.toHaveBeenCalled();
  });
});
