import { describe, it, expect, vi } from 'vitest';
import {
  KnowledgeInjector,
  formatKnowledgeBlock,
  KNOWLEDGE_MARKER,
  DEFAULT_KNOWLEDGE_TOKEN_BUDGET,
} from './knowledge-injector.js';
import type { RetrievalService, RetrievedChunk } from '../../knowledge/retrieval.service.js';

function chunk(id: string, content: string, tokenCount = 10): RetrievedChunk {
  return { id, documentId: 'doc', content, chunkIndex: 0, tokenCount, score: 0.9, vectorScore: 0.9, lexicalScore: 0.1 };
}

/** A retrieval service that hands back a scripted result per call, and records the queries. */
function stubRetrieval(results: RetrievedChunk[][], delayMs = 0): { service: RetrievalService; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const service = {
    search: vi.fn(async (_tenant: string, query: string) => {
      calls.push(query);
      const chunks = results[Math.min(i, results.length - 1)] ?? [];
      i += 1;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
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

describe('KnowledgeInjector.resolve — the rolling slot', () => {
  it('returns a block for the utterance and reports what is in it', async () => {
    const { service } = stubRetrieval([[chunk('c1', 'עובדת גם בשבת', 12)]]);
    const injector = new KnowledgeInjector(service, 'tenant-1');

    const slot = await injector.resolve('היא עובדת בשבת');

    expect(slot.block).toContain('עובדת גם בשבת');
    expect(slot.chunkIds).toEqual(['c1']);
    expect(slot.tokens).toBe(12);
    expect(slot.deadlineExpired).toBe(false);
  });

  /**
   * THE WHOLE POINT OF R2.1. R2 appended to `agent.chatCtx` and context grew 2,742 -> 8,306 tokens
   * across four minutes. This class must have no way to mutate anything: it returns a block, and the
   * caller decides where to put it (inside `llmNode`, on a per-inference copy).
   */
  it('mutates nothing — the R2 mutation API is gone', () => {
    const { service } = stubRetrieval([[chunk('c1', 'x')]]);
    const injector = new KnowledgeInjector(service, 'tenant-1') as unknown as Record<string, unknown>;
    for (const name of ['inject', 'injectSpeculative', 'endTurn', 'groundedThisTurn']) {
      expect(injector[name], name).toBeUndefined();
    }
  });

  /**
   * HISTORY DEDUP IS DELIBERATELY GONE. Under R2 a chunk was injected at most once per call, because
   * injections were permanent. Under a rolling slot the block vanishes after the inference, so a fact
   * needed again on a later turn must be retrieved again. Re-retrieval is the design, not a leak.
   */
  it('returns the same chunk again on a later turn', async () => {
    const { service } = stubRetrieval([[chunk('c1', 'המחיר')], [chunk('c1', 'המחיר')]]);
    const injector = new KnowledgeInjector(service, 'tenant-1');

    const first = await injector.resolve('כמה זה עולה בחודש');
    const second = await injector.resolve('ומה המחיר של החבילה הגדולה');

    expect(first.chunkIds).toEqual(['c1']);
    expect(second.chunkIds).toEqual(['c1']);
    expect(second.block).toContain('המחיר');
  });

  it('deduplicates within one result set', async () => {
    const { service } = stubRetrieval([[chunk('c1', 'פעם'), chunk('c1', 'פעם'), chunk('c2', 'אחרת')]]);
    const injector = new KnowledgeInjector(service, 'tenant-1');

    const slot = await injector.resolve('שאלה כלשהי');

    expect(slot.chunkIds).toEqual(['c1', 'c2']);
    expect(slot.dedupedInResult).toBe(1);
  });

  it('returns no block when nothing was retrieved', async () => {
    const { service } = stubRetrieval([[]]);
    const injector = new KnowledgeInjector(service, 'tenant-1');

    const slot = await injector.resolve('שאלה על משהו שלא קיים');

    expect(slot.block).toBeNull();
    expect(slot.tokens).toBe(0);
  });

  it('degrades to no block when retrieval throws', async () => {
    const service = {
      search: vi.fn(async () => {
        throw new Error('pgvector is on fire');
      }),
    } as unknown as RetrievalService;
    const injector = new KnowledgeInjector(service, 'tenant-1');

    const slot = await injector.resolve('כמה זה עולה');

    expect(slot.block).toBeNull();
  });
});

describe('KnowledgeInjector — the token budget', () => {
  it('keeps everything when the budget is not binding', async () => {
    const { service } = stubRetrieval([[chunk('a', 'א', 100), chunk('b', 'ב', 100)]]);
    const injector = new KnowledgeInjector(service, 'tenant-1');

    const slot = await injector.resolve('שאלה ארוכה מספיק');

    expect(slot.chunkIds).toEqual(['a', 'b']);
    expect(slot.dropped).toBe(0);
    expect(slot.tokens).toBe(200);
  });

  /** Chunks arrive in RRF order, best first — so the trim must fall on the WEAKEST evidence. */
  it('drops from the weakest end when the budget binds', async () => {
    const { service } = stubRetrieval([[chunk('best', 'א', 600), chunk('mid', 'ב', 600), chunk('worst', 'ג', 600)]]);
    const injector = new KnowledgeInjector(service, 'tenant-1', { maxTokens: 1000 });

    const slot = await injector.resolve('שאלה ארוכה מספיק');

    expect(slot.chunkIds).toEqual(['best']);
    expect(slot.dropped).toBe(2);
    expect(slot.block).not.toContain('ג');
  });

  /**
   * A single oversized chunk is kept rather than dropped. An empty slot on a turn that HAD a matching
   * fact is the worse failure: she says "I'll have the team follow up" to a question the KB answers.
   */
  it('keeps one oversized chunk rather than returning nothing', async () => {
    const { service } = stubRetrieval([[chunk('huge', 'ארוך מאוד', 5000)]]);
    const injector = new KnowledgeInjector(service, 'tenant-1', { maxTokens: 1000 });

    const slot = await injector.resolve('שאלה ארוכה מספיק');

    expect(slot.chunkIds).toEqual(['huge']);
    expect(slot.dropped).toBe(0);
  });

  it('defaults to the documented budget', () => {
    expect(DEFAULT_KNOWLEDGE_TOKEN_BUDGET).toBe(1000);
  });
});

describe('KnowledgeInjector — prefetch, cache and the deadline', () => {
  it('reuses a prefetch instead of searching the same text twice', async () => {
    const { service, calls } = stubRetrieval([[chunk('c1', 'תשובה')]]);
    const injector = new KnowledgeInjector(service, 'tenant-1');

    injector.prefetch('כמה זה עולה בחודש');
    const slot = await injector.resolve('כמה זה עולה בחודש');

    expect(slot.chunkIds).toEqual(['c1']);
    expect(calls).toEqual(['כמה זה עולה בחודש']); // one search, not two
  });

  it('treats trivially different spellings as the same utterance', async () => {
    const { service, calls } = stubRetrieval([[chunk('c1', 'x')]]);
    const injector = new KnowledgeInjector(service, 'tenant-1');

    injector.prefetch('כמה זה עולה');
    injector.prefetch('  כמה   זה עולה  ');
    await injector.resolve('כמה זה עולה');

    expect(calls).toHaveLength(1);
  });

  /**
   * THE HAZARD THE ROLLING SLOT INTRODUCES. The preemptive draft is never invalidated now, so a
   * retrieval that lands after `llmNode` has run would be silently discarded and she would answer
   * un-grounded with no self-correction. `resolve` therefore waits — but only so long.
   */
  it('gives up after the deadline and says so', async () => {
    const { service } = stubRetrieval([[chunk('c1', 'מאוחר מדי')]], 200);
    const injector = new KnowledgeInjector(service, 'tenant-1', { deadlineMs: 20 });

    const slot = await injector.resolve('שאלה ארוכה מספיק');

    expect(slot.deadlineExpired).toBe(true);
    expect(slot.block).toBeNull();
    expect(slot.awaitedMs).toBeGreaterThanOrEqual(15);
  });

  /**
   * An abandoned lookup is NOT cancelled — it settles into the cache, so the follow-up turn on the
   * same topic is grounded from memory instead of re-paying the slow path. The difference between
   * one slow turn and two.
   */
  it('keeps the abandoned lookup, so the next turn on the same topic is instant', async () => {
    const { service, calls } = stubRetrieval([[chunk('c1', 'הגיע באיחור')]], 60);
    const injector = new KnowledgeInjector(service, 'tenant-1', { deadlineMs: 10 });

    const missed = await injector.resolve('שאלה ארוכה מספיק');
    expect(missed.deadlineExpired).toBe(true);

    await new Promise((r) => setTimeout(r, 90)); // the abandoned lookup lands

    const second = await injector.resolve('שאלה ארוכה מספיק');
    expect(second.deadlineExpired).toBe(false);
    expect(second.chunkIds).toEqual(['c1']);
    expect(calls).toHaveLength(1); // never re-searched
  });

  /**
   * ── THE 2026-08-22 REGRESSION ────────────────────────────────────────────────────────────────
   *
   * `prefetch` fires on INTERIM transcripts; `resolve` asks for the PREFLIGHT text, which is longer.
   * Keyed on exact text, the two never matched, so every real turn discarded a warm lookup and paid a
   * cold one: median wait 239ms and 4 of 32 slots expiring, one of them on "כמה זה עולה?" — she
   * answered "אין לי כרגע את המידע הזה" with the price sitting in the KB.
   *
   * The existing suite passed throughout, because every test prefetched the SAME string it resolved.
   * So did the 21-turn simulation, because synthetic TTS speech yields an interim identical to the
   * final. Only real speech, which pauses mid-sentence, produces the mismatch.
   */
  it('reuses a lookup started for an earlier interim of the same utterance', async () => {
    const { service, calls } = stubRetrieval([[chunk('c1', 'המנוי החודשי הוא 1,490 שקלים')]]);
    const injector = new KnowledgeInjector(service, 'tenant-1');

    injector.prefetch('כמה זה עולה בחוד'); // interim: caller still mid-word
    const slot = await injector.resolve('כמה זה עולה בחודש'); // preflight: the committed turn

    expect(slot.reusedPrefix).toBe(true);
    expect(slot.chunkIds).toEqual(['c1']);
    expect(calls).toHaveLength(1); // the cold path was NOT re-entered
  });

  it('reuses the LATEST interim, not the earliest', async () => {
    const { service, calls } = stubRetrieval([[chunk('early', 'א')], [chunk('late', 'ב')]]);
    const injector = new KnowledgeInjector(service, 'tenant-1');

    injector.prefetch('מה תנאי היציאה מה'); // 16 chars
    injector.prefetch('מה תנאי היציאה מהחוזה'); // 21 chars — closer to what he actually said
    const slot = await injector.resolve('מה תנאי היציאה מהחוזה?');

    expect(slot.chunkIds).toEqual(['late']);
    expect(calls).toHaveLength(2);
  });

  /**
   * The expensive direction. A prefix that drops the SUBJECT of the question retrieves for a different
   * question, and she would answer confidently off the wrong chunks — worse than answering un-grounded.
   */
  it('refuses a prefix that is too short to stand for the utterance', async () => {
    const { service, calls } = stubRetrieval([[chunk('wrong', 'לא קשור')]]);
    const injector = new KnowledgeInjector(service, 'tenant-1');

    injector.prefetch('האם יש לכם'); // 10 chars — could precede almost any question
    const slot = await injector.resolve('האם יש לכם אינטגרציה עם מערכת קרסו');

    expect(slot.reusedPrefix).toBe(false);
    expect(calls).toHaveLength(2); // searched properly rather than reusing
  });

  it('never treats a different question as a prefix', async () => {
    const { service, calls } = stubRetrieval([[chunk('a', 'א')], [chunk('b', 'ב')]]);
    const injector = new KnowledgeInjector(service, 'tenant-1');

    injector.prefetch('כמה זה עולה בחודש');
    const slot = await injector.resolve('מה תנאי היציאה מהחוזה');

    expect(slot.reusedPrefix).toBe(false);
    expect(slot.chunkIds).toEqual(['b']);
    expect(calls).toEqual(['כמה זה עולה בחודש', 'מה תנאי היציאה מהחוזה']);
  });

  /**
   * Reuse must not CHAIN. Coverage is always measured against the text that was really embedded, so a
   * short prefix cannot be laundered into covering an arbitrarily long utterance by hopping through
   * intermediate keys.
   */
  it('measures coverage against the searched text, so reuse cannot drift', async () => {
    const { service, calls } = stubRetrieval([[chunk('c1', 'x')]]);
    const injector = new KnowledgeInjector(service, 'tenant-1');

    injector.prefetch('כמה זה עולה בחוד'); // 16 chars, actually embedded
    await injector.resolve('כמה זה עולה בחודש'); // 17 — reuses, filed under a second key
    expect(calls).toHaveLength(1);

    // 27 chars. Against the 16 that were searched this is 59% — under the floor, so it must NOT reuse,
    // even though a 17-char key now sits in the cache and would have passed at 63%.
    const far = await injector.resolve('כמה זה עולה בחודש לעסק קטן?');
    expect(far.reusedPrefix).toBe(false);
    expect(calls).toHaveLength(2);
  });

  /** A reused lookup that is still in flight is still a win: the wait is what REMAINS of it. */
  it('reuses an in-flight prefix and waits only for the remainder', async () => {
    const { service, calls } = stubRetrieval([[chunk('c1', 'בדרך')]], 120);
    const injector = new KnowledgeInjector(service, 'tenant-1');

    injector.prefetch('מה תנאי היציאה מהחו');
    await new Promise((r) => setTimeout(r, 80)); // 80ms of the 120ms already elapsed
    const slot = await injector.resolve('מה תנאי היציאה מהחוזה');

    expect(slot.reusedPrefix).toBe(true);
    expect(slot.deadlineExpired).toBe(false);
    expect(slot.awaitedMs).toBeLessThan(100); // not the full 120
    expect(calls).toHaveLength(1);
  });

  it('does not wait at all when the answer is already cached', async () => {
    const { service } = stubRetrieval([[chunk('c1', 'מוכן')]]);
    const injector = new KnowledgeInjector(service, 'tenant-1');

    injector.prefetch('שאלה ארוכה מספיק');
    await new Promise((r) => setTimeout(r, 5));
    const slot = await injector.resolve('שאלה ארוכה מספיק');

    expect(slot.awaitedMs).toBeLessThan(20);
    expect(slot.deadlineExpired).toBe(false);
  });

  /** A twenty-minute call must not accumulate one promise per utterance. */
  it('bounds the cache', async () => {
    const { service, calls } = stubRetrieval([[chunk('c1', 'x')]]);
    const injector = new KnowledgeInjector(service, 'tenant-1');

    for (let i = 0; i < 40; i += 1) injector.prefetch(`שאלה מספר ${i} על השירות`);
    await new Promise((r) => setTimeout(r, 5));

    const cache = (injector as unknown as { cache: Map<string, unknown> }).cache;
    expect(cache.size).toBeLessThanOrEqual(16);
    expect(calls).toHaveLength(40); // every distinct utterance was still searched
  });
});
