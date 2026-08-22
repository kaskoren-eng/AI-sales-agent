import type { RetrievalService, RetrievedChunk } from '../../knowledge/retrieval.service.js';

/**
 * Resolves the caller's utterance into a `[KNOWLEDGE]` block for ONE LLM inference.
 *
 * ── WHY THIS NO LONGER TOUCHES THE CHAT CONTEXT ────────────────────────────────────────────────
 *
 * R2 appended each retrieval to `agent.chatCtx`, permanently. Measured on the 2026-08-22 real call:
 * context grew 2,742 -> 8,306 tokens across four minutes, because injections accumulate and are never
 * removed. TTFT tracks context size, so the slim prompt ended the call SLOWER than the full prompt it
 * replaced — inverting the reason the slim prompt exists.
 *
 * R2.1 makes the slot ROLLING: the block is visible to exactly one inference and never enters session
 * history. That needs no removal of a prior block, because nothing is ever persisted to remove.
 *
 * The mechanism is native to the SDK and was verified before being relied on. `agent_activity.cjs:1883`
 * does `chatCtx = chatCtx.copy()` immediately before calling `llmNode`, so `llmNode` edits a
 * per-inference copy. Two consequences, both load-bearing:
 *
 *   1. Session history stays clean, so injection overhead is FLAT rather than cumulative.
 *   2. `agent.chatCtx` is untouched, so LiveKit's preemptive equivalence check
 *      (`preemptive.chatCtx.isEquivalent(chatCtx)`) never sees the edit and the draft SURVIVES.
 *      R2 spent a whole cycle fighting that check; here it simply does not apply.
 *
 * This class therefore returns a block. It does not mutate anything. `agent.ts` appends it inside
 * `llmNode`, which is the only place that is safe.
 *
 * ── WHY HISTORY DEDUP IS GONE ──────────────────────────────────────────────────────────────────
 *
 * R2 never injected a chunk twice per call, because injections were permanent and repeating one wasted
 * tokens forever. Under a rolling slot the opposite is true: the block vanishes after the inference, so
 * a chunk needed on turn 9 must be retrieved AGAIN on turn 9. Re-retrieval is the intended behaviour,
 * not waste. Dedup now applies only WITHIN a single result set.
 *
 * ── THE ONE HAZARD THE ROLLING SLOT INTRODUCES ─────────────────────────────────────────────────
 *
 * Because the draft is never invalidated, a retrieval that lands after `llmNode` has run is silently
 * discarded and she answers un-grounded with no self-correction. R2's invalidation was accidentally
 * protective here. `resolve()` therefore awaits an in-flight lookup with a hard deadline; on expiry it
 * proceeds un-grounded but does NOT cancel the lookup, so the result still lands in the cache and a
 * follow-up turn on the same topic is grounded instantly instead of re-paying the slow path.
 */

/** How the retrieved block is labelled in the chat context. The prompt's grounding rules refer to this
 * exact marker, so the two must never drift apart. */
export const KNOWLEDGE_MARKER = '[KNOWLEDGE]';

/**
 * Per-turn token budget for the slot.
 *
 * 1,000 tokens is roughly four of our ~250-token chunks — more than `top_k` will usually return, so on
 * a normal turn this binds on nothing and costs nothing. It exists for the pathological turn: a large
 * tenant KB, a raised `top_k`, or chunks that came from a document with long sections.
 */
export const DEFAULT_KNOWLEDGE_TOKEN_BUDGET = 1000;

/**
 * How long an inference will wait for an in-flight retrieval before answering un-grounded.
 *
 * `llmNode` runs at Soniox's PREFLIGHT — the moment the caller pauses — which is BEFORE endpointing has
 * finished deciding the turn is over. Part of this wait is therefore hidden behind time the caller was
 * going to spend anyway. Report `deadlineExpired` as a share of gated turns; if it exceeds ~3% on real
 * calls, the prefetch window is too short and the gate or the cache needs another pass, not this number.
 */
export const DEFAULT_RESOLVE_DEADLINE_MS = 300;

/** Bounded so a long call cannot accumulate one promise per utterance. */
const LRU_MAX = 16;

export interface KnowledgeSlot {
  /** The text to append, or null when there is nothing worth appending. */
  block: string | null;
  chunkIds: string[];
  /** Tokens in the block, from the chunks' stored counts — no hot-path tokenization. */
  tokens: number;
  /** Chunks dropped because the budget bound. */
  dropped: number;
  /** Chunks discarded as duplicates WITHIN this result set. */
  dedupedInResult: number;
  /** How long `resolve` waited for an in-flight lookup. */
  awaitedMs: number;
  /** The lookup did not finish in time; this inference is un-grounded. */
  deadlineExpired: boolean;
  /** Absent when the result came from cache without any lookup this turn. */
  timing: { embedMs: number; dbMs: number; totalMs: number } | null;
}

type SearchResult = Awaited<ReturnType<RetrievalService['search']>>;

export class KnowledgeInjector {
  /** utterance -> in-flight or settled lookup. Insertion-ordered, evicted oldest-first. */
  private readonly cache = new Map<string, Promise<SearchResult>>();

  constructor(
    private readonly retrieval: RetrievalService,
    private readonly tenantId: string,
    private readonly options: {
      topK?: number;
      minScore?: number;
      maxTokens?: number;
      deadlineMs?: number;
    } = {},
  ) {}

  private static normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * Start a lookup without waiting for it. Called on INTERIM transcripts, while the caller is still
   * speaking, so the embedding round trip is spent on speech they have not finished producing.
   *
   * Mutates nothing and returns nothing: a speculative miss costs one embedding and no correctness.
   */
  prefetch(transcript: string): void {
    const key = KnowledgeInjector.normalize(transcript);
    if (key) void this.lookup(key, transcript);
  }

  /** Cached lookup, keyed on the normalized utterance. Failures are evicted so a retry is possible. */
  private lookup(key: string, transcript: string): Promise<SearchResult> {
    const existing = this.cache.get(key);
    if (existing) return existing;

    const promise = this.retrieval
      .search(this.tenantId, transcript, { topK: this.options.topK, minScore: this.options.minScore })
      .catch((err) => {
        this.cache.delete(key);
        throw err;
      });

    this.cache.set(key, promise);
    // Oldest-first eviction. A settled promise costs almost nothing, but an unbounded map on a
    // twenty-minute call is a leak waiting to be found by someone else.
    if (this.cache.size > LRU_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return promise;
  }

  /**
   * Resolve the slot for THIS inference.
   *
   * Never throws: a knowledge lookup that fails must cost an un-grounded turn, never a call. The
   * prompt's grounding rules already cover the un-grounded case ("I'll have the team follow up").
   */
  async resolve(transcript: string): Promise<KnowledgeSlot> {
    const empty: KnowledgeSlot = {
      block: null,
      chunkIds: [],
      tokens: 0,
      dropped: 0,
      dedupedInResult: 0,
      awaitedMs: 0,
      deadlineExpired: false,
      timing: null,
    };

    const key = KnowledgeInjector.normalize(transcript);
    if (!key) return empty;

    const deadlineMs = this.options.deadlineMs ?? DEFAULT_RESOLVE_DEADLINE_MS;
    const startedAt = Date.now();
    const pending = this.lookup(key, transcript);

    // The deadline races the lookup; it does NOT cancel it. An abandoned lookup still settles into the
    // cache, so the next turn on the same topic is grounded from memory rather than re-paying this.
    let result: SearchResult | null = null;
    try {
      result = await Promise.race([
        pending,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), deadlineMs).unref?.()),
      ]);
    } catch (err) {
      console.error('knowledge_lookup_failed', err instanceof Error ? err.message : String(err));
      return { ...empty, awaitedMs: Date.now() - startedAt };
    }

    const awaitedMs = Date.now() - startedAt;
    if (!result) return { ...empty, awaitedMs, deadlineExpired: true };

    return { ...this.buildSlot(result), awaitedMs, deadlineExpired: false };
  }

  /** Dedup within the result set, then trim to the token budget. */
  private buildSlot(result: SearchResult): KnowledgeSlot {
    const seen = new Set<string>();
    const unique: RetrievedChunk[] = [];
    for (const chunk of result.chunks) {
      if (seen.has(chunk.id)) continue;
      seen.add(chunk.id);
      unique.push(chunk);
    }

    // Chunks arrive in RRF order, best first, so the budget is spent on the best evidence and the
    // trim falls on the weakest. `tokenCount` comes from ingest — nothing is tokenized here.
    const budget = this.options.maxTokens ?? DEFAULT_KNOWLEDGE_TOKEN_BUDGET;
    const kept: RetrievedChunk[] = [];
    let tokens = 0;
    for (const chunk of unique) {
      const cost = chunk.tokenCount || 0;
      if (kept.length > 0 && tokens + cost > budget) break;
      kept.push(chunk);
      tokens += cost;
    }

    return {
      block: kept.length > 0 ? formatKnowledgeBlock(kept) : null,
      chunkIds: kept.map((c) => c.id),
      tokens,
      dropped: unique.length - kept.length,
      dedupedInResult: result.chunks.length - unique.length,
      awaitedMs: 0,
      deadlineExpired: false,
      timing: result.timing,
    };
  }
}

/**
 * Render chunks as the block the model reads.
 *
 * Plain text, no scores, no ids, no document titles: everything here is a candidate for being READ
 * ALOUD by a model that is trying to be helpful, and "according to document 3, score 0.71" is the
 * kind of thing that ends up in a caller's ear. The prompt separately forbids mentioning sources; this
 * makes it hard to disobey by giving her nothing to cite.
 */
export function formatKnowledgeBlock(chunks: RetrievedChunk[]): string {
  const body = chunks.map((c) => c.content.trim()).join('\n\n');
  return `${KNOWLEDGE_MARKER}\n${body}`;
}
