import { describe, it, expect, vi } from 'vitest';
import { KnowledgeInjector, formatKnowledgeBlock, KNOWLEDGE_MARKER } from './knowledge-injector.js';
import type { RetrievalService, RetrievedChunk } from '../../knowledge/retrieval.service.js';

function chunk(id: string, content: string): RetrievedChunk {
  return { id, documentId: 'doc', content, chunkIndex: 0, score: 0.9, vectorScore: 0.9, lexicalScore: 0.1 };
}

type Msg = { role: string; content: string };

/**
 * A chat context with the REAL copy-then-replace semantics: `copy()` returns an independent snapshot,
 * and `updateChatCtx` swaps the live context for whatever it is handed.
 *
 * This matters more than it looks. An earlier version of this helper returned `this` from `copy()`, so
 * appends accumulated no matter how badly two injections raced — and the concurrency test below passed
 * with the mutation lock deleted. A fake that cannot lose an update cannot detect a lost update.
 *
 * `updateChatCtx` awaits once before swapping, so an interleaving actually exists to be caught.
 */
function makeCtx(initial: Msg[]) {
  const msgs = [...initial];
  return {
    msgs,
    addMessage(msg: { role: 'system' | 'user' | 'assistant'; content: string }) {
      msgs.push(msg);
      return msg;
    },
    copy() {
      return makeCtx(msgs);
    },
  };
}

function fakeAgent() {
  let live = makeCtx([]);
  /** A stable array that always mirrors the live context, so tests can hold on to one reference. */
  const messages: Msg[] = [];
  const agent = {
    get chatCtx() {
      return live;
    },
    updateChatCtx: vi.fn(async (ctx: ReturnType<typeof makeCtx>) => {
      await Promise.resolve();
      live = ctx;
      messages.length = 0;
      messages.push(...ctx.msgs);
    }),
  };
  return { agent, messages };
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
   * CONSTRAINT 3 — the search behind an interim must be REUSED when the same text arrives again as the
   * final transcript, not re-run: re-running spends the ~250ms embedding round trip inside the turn,
   * which is the whole cost this design exists to hide.
   */
  it('reuses an in-flight search instead of searching the same text twice', async () => {
    const { service, calls } = stubRetrieval([[chunk('c1', 'תשובה')]]);
    const { agent } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    await injector.injectSpeculative(agent, 'כמה זה עולה בחודש');
    await injector.inject(agent, 'כמה זה עולה בחודש');

    expect(calls).toEqual(['כמה זה עולה בחודש']); // exactly one search, not two
  });

  it('collapses repeated interim transcripts into a single search', async () => {
    const { service, calls } = stubRetrieval([[chunk('c1', 'תשובה')]]);
    const { agent } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    await injector.inject(agent, 'כמה זה עולה');
    await injector.inject(agent, 'כמה זה עולה');
    await injector.inject(agent, 'כמה זה עולה '); // trailing space — same utterance

    expect(calls).toHaveLength(1);
  });

  it('searches again when the final transcript differs from the interim', async () => {
    const { service, calls } = stubRetrieval([[chunk('c1', 'א')], [chunk('c2', 'ב')]]);
    const { agent } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    await injector.injectSpeculative(agent, 'כמה זה עולה בחודש');
    const result = await injector.inject(agent, 'כמה זה עולה בחודש בדיוק');

    expect(result.injected).toBe(true);
    expect(calls).toEqual(['כמה זה עולה בחודש', 'כמה זה עולה בחודש בדיוק']);
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

/**
 * THE REGRESSION THESE PIN. The first version prefetched on interims and injected only on the final
 * transcript; the 2026-08-19 call measured 4 of 6 preemptive drafts discarded with RAG on, 0 of 6 off.
 * The snapshot is taken at Soniox's PREFLIGHT event, before the final transcript exists, so injecting
 * there was always too late. Retrieval must reach the CONTEXT during the interims, not just a cache.
 */
describe('KnowledgeInjector — speculative injection (the preemptive-draft fix)', () => {
  it('injects during an interim, so the context is already grounded when the draft is snapshotted', async () => {
    const { service } = stubRetrieval([[chunk('c1', 'המחיר הוא 1,490')]]);
    const { agent, messages } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    const result = await injector.injectSpeculative(agent, 'כמה עולה החבילה הבסיסית');

    expect(result!.injected).toBe(true);
    expect(messages).toHaveLength(1);
    expect(injector.groundedThisTurn).toBe(true);
  });

  it('declines a fragment too short to retrieve anything but noise', () => {
    const { service, calls } = stubRetrieval([[chunk('c1', 'x')]]);
    const { agent } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    // "how much is" — matches every pricing chunk equally and none of them usefully.
    expect(injector.injectSpeculative(agent, 'כמה זה')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('declines an interim that has barely grown — adjacent interims are near-identical', async () => {
    const { service } = stubRetrieval([[chunk('c1', 'x')]]);
    const { agent } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    await injector.injectSpeculative(agent, 'כמה עולה החבילה');
    expect(injector.injectSpeculative(agent, 'כמה עולה החבילה ש')).toBeNull();
  });

  it('caps speculative work per turn — the old code paid for an embedding on every interim', async () => {
    const { service, calls } = stubRetrieval([[chunk('c1', 'a')], [chunk('c2', 'b')], [chunk('c3', 'c')], [chunk('c4', 'd')]]);
    const { agent } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    let text = 'כמה עולה החבילה';
    for (let i = 0; i < 8; i += 1) {
      const attempt = injector.injectSpeculative(agent, text);
      if (attempt) await attempt;
      text += ' ועוד מילה נוספת';
    }

    expect(calls).toHaveLength(3);
  });

  it('re-arms the throttle at the end of a turn', async () => {
    const { service, calls } = stubRetrieval([[chunk('c1', 'a')], [chunk('c2', 'b')]]);
    const { agent } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    await injector.injectSpeculative(agent, 'שאלה ראשונה ארוכה');
    injector.endTurn();
    const second = injector.injectSpeculative(agent, 'שאלה שנייה ארוכה');

    expect(second).not.toBeNull();
    await second;
    expect(calls).toHaveLength(2);
  });

  /** `groundedThisTurn` is what lets the final-transcript catch-up decide whether it may touch the
   * context at all — the whole draft-preserving rule in agent.ts hangs off it. */
  it('reports the turn as un-grounded when nothing was retrieved', async () => {
    const { service } = stubRetrieval([[]]);
    const { agent } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    await injector.injectSpeculative(agent, 'שאלה על משהו שלא קיים בכלל');

    expect(injector.groundedThisTurn).toBe(false);
  });

  it('clears grounded state between turns', async () => {
    const { service } = stubRetrieval([[chunk('c1', 'a')]]);
    const { agent } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    await injector.injectSpeculative(agent, 'שאלה ראשונה ארוכה');
    expect(injector.groundedThisTurn).toBe(true);
    injector.endTurn();
    expect(injector.groundedThisTurn).toBe(false);
  });

  /**
   * Interims now MUTATE the context, so two injections can be in flight at once. Both would copy the
   * same base context and the second `updateChatCtx` would silently discard the first block.
   */
  it('serialises concurrent injections instead of letting one overwrite the other', async () => {
    const { service } = stubRetrieval([[chunk('c1', 'ראשון')], [chunk('c2', 'שני')]]);
    const { agent, messages } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    await Promise.all([
      injector.inject(agent, 'שאלה ראשונה על מחיר'),
      injector.inject(agent, 'שאלה שנייה על זמנים'),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.content).join(' ')).toContain('ראשון');
    expect(messages.map((m) => m.content).join(' ')).toContain('שני');
  });

  it('does not inject the same chunk twice when two injections race', async () => {
    const { service } = stubRetrieval([[chunk('c1', 'אותו דבר')], [chunk('c1', 'אותו דבר')]]);
    const { agent, messages } = fakeAgent();
    const injector = new KnowledgeInjector(service, 'tenant-1');

    await Promise.all([
      injector.inject(agent, 'שאלה ראשונה על מחיר'),
      injector.inject(agent, 'שאלה שנייה על מחיר'),
    ]);

    expect(messages).toHaveLength(1);
  });
});
