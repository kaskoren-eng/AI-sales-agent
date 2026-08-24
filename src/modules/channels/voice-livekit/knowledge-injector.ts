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

/**
 * How many characters an interim must GROW before it earns another speculative lookup.
 *
 * Soniox streams an interim every ~100-200ms of speech, each a slightly longer prefix of the same
 * utterance. Un-debounced, a four-second question fired 15-30 embeddings and 15-30 unindexed
 * Postgres scans — per turn, mid-speech, against a 10-connection pool the resolve's own query then
 * queued behind. Sub-step growth rides the previous lookup instead; `findReusablePrefix` bridges
 * the remainder at resolve time.
 *
 * 6 and not 12, measured on the 2026-08-24 call: at 12, the last prefetch of "אוקיי, תגיד לי כמה
 * זה עולה" was the 21-char "אוקיי, תגיד לי כמה זה" — the debounce swallowed "עולה", the one word
 * carrying the meaning, and that prefix retrieves OBJECTION chunks, not pricing. One Hebrew word +
 * space is ~5 chars; the step must be small enough that the final content word usually earns its
 * own prefetch. Still ≤5 lookups on a long question, versus 15-30 un-debounced.
 */
const PREFETCH_MIN_GROWTH_CHARS = 6;

/**
 * ── WHY THE CACHE MATCHES ON PREFIXES AND NOT ONLY ON EXACT TEXT ───────────────────────────────
 *
 * Measured on the 2026-08-22 acceptance call (8 minutes, 34 turns): `resolve` waited a MEDIAN of
 * 239ms on every first inference of every turn, and the deadline expired on 4 of 32 slots (12.5%,
 * against a 3% threshold). One of those expiries landed on "כמה זה עולה?" and she answered "אין לי
 * כרגע את המידע הזה" to the most valuable question in the call — with the price sitting in the KB.
 *
 * The prefetch was not slow. It was ORPHANED. `prefetch` keys on the INTERIM transcript; `resolve`
 * asks for the PREFLIGHT text, which is longer. The two keys never match, so every turn threw away a
 * warm lookup and started a cold one on the critical path. The simulation hid this completely: the
 * synthetic caller's TTS speech produces an interim identical to the final, so the exact key hit
 * every time and the median wait was 1ms.
 *
 * So a lookup already in flight for a PREFIX of this utterance is reused. It is usually the same
 * question with its last word or two missing, and — the part that matters — it started ~150ms ago, so
 * the wait is what REMAINS of it rather than all of it. Reuse works whether or not it has settled.
 *
 * The two thresholds are deliberately conservative. Reusing a 3-character prefix would answer a
 * different question; requiring most of the utterance means a miss costs one embedding (cheap) and a
 * false reuse stays rare (expensive). `reusedPrefix` is logged per turn so the next real call
 * measures whether these numbers are right instead of us guessing at them twice.
 */
const MIN_PREFIX_COVERAGE = 0.7;
const MIN_PREFIX_CHARS = 12;

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
  /** The result came from a lookup started for a PREFIX of this utterance (an earlier interim). */
  reusedPrefix: boolean;
  /**
   * How much of this utterance the BEST available prefix covered, 0–1, whether or not it was used.
   *
   * Exists to make the next tuning pass evidence-based rather than another guess. If real calls show
   * reuse failing at a steady 0.6, the floor is too high; if the best candidate is routinely 0.2, then
   * Soniox interims arrive too sparsely for prefix reuse to be the answer at all and the fix is
   * somewhere else. Without this we would only know that it did not work.
   */
  bestPrefixCoverage: number;
  /** Absent when the result came from cache without any lookup this turn. */
  timing: { embedMs: number; dbMs: number; totalMs: number } | null;
}

type SearchResult = Awaited<ReturnType<RetrievalService['search']>>;

interface CacheEntry {
  promise: Promise<SearchResult>;
  /**
   * The key whose TEXT was actually embedded.
   *
   * Distinct from the map key, because a prefix reuse files the same lookup under a second key. Every
   * coverage test is made against this, never against the map key — otherwise reuses would chain
   * (a → b → c) and drift arbitrarily far from the text that was really searched.
   */
  searchedKey: string;
}

export class KnowledgeInjector {
  /** utterance -> in-flight or settled lookup. Insertion-ordered, evicted oldest-first. */
  private readonly cache = new Map<string, CacheEntry>();

  /** The last interim actually embedded, for the prefetch debounce. */
  private lastPrefetchedKey = '';

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
    if (!key) return;
    // Debounce growing interims of the same utterance: only a step of real new content earns a new
    // lookup. A revision that is NOT an extension (Soniox rewrote the text, or a new turn started)
    // always fires — the debounce is measured against what was last actually embedded.
    if (key.startsWith(this.lastPrefetchedKey) && this.lastPrefetchedKey.length > 0) {
      if (key.length - this.lastPrefetchedKey.length < PREFETCH_MIN_GROWTH_CHARS) return;
    }
    this.lastPrefetchedKey = key;
    // Swallow the rejection HERE as well as in `lookup`: a prefetch nobody ever resolves would
    // otherwise surface as an unhandled rejection and take the worker down on a KB outage.
    void this.lookup(key, transcript).entry.promise.catch(() => {});
  }

  /**
   * The longest in-flight-or-settled lookup whose searched text is a PREFIX of this utterance.
   *
   * Longest wins because it is the latest interim, and so the closest to what the caller actually
   * finished saying. Returns null when nothing covers enough of the utterance to stand in for it.
   */
  private findReusablePrefix(key: string): { entry: CacheEntry | null; bestCoverage: number } {
    let best: CacheEntry | null = null;
    let bestCoverage = 0;
    for (const entry of this.cache.values()) {
      const candidate = entry.searchedKey;
      if (candidate.length >= key.length) continue; // an exact hit was already tried; longer is not a prefix
      if (!key.startsWith(candidate)) continue;
      // Recorded before the thresholds are applied, so a near-miss is visible in the logs rather than
      // indistinguishable from having no candidate at all.
      const coverage = candidate.length / key.length;
      if (coverage > bestCoverage) bestCoverage = coverage;
      if (candidate.length < MIN_PREFIX_CHARS) continue;
      if (coverage < MIN_PREFIX_COVERAGE) continue;
      // Character coverage cannot see MEANING. On the 2026-08-24 call, "אוקיי, תגיד לי כמה זה"
      // covered 78% of "אוקיי, תגיד לי כמה זה עולה." and passed — but the missing "עולה" was the
      // whole question, and the truncated retrieval held objection chunks, not pricing. She told a
      // real caller "אין לי כרגע את המידע הזה" with the price sitting in the KB. So: if the
      // uncovered tail contains a CONTENT word (3+ letters), the prefix asked a different question —
      // pay the cold search instead of answering the wrong one. A short tail ("ש" finishing
      // "בחודש", "לי?", punctuation) still reuses.
      if (KnowledgeInjector.tailHasContentWord(key.slice(candidate.length))) continue;
      if (!best || candidate.length > best.searchedKey.length) best = entry;
    }
    return { entry: best, bestCoverage };
  }

  /** True when the text contains a word of 3+ letters — new meaning, not a word-completion crumb. */
  private static tailHasContentWord(tail: string): boolean {
    return tail
      .split(/\s+/)
      .some((word) => (word.match(/\p{L}/gu)?.length ?? 0) >= 3);
  }

  /**
   * Cached lookup, keyed on the normalized utterance. Failures are evicted so a retry is possible.
   *
   * `allowPrefix` is off for `prefetch`: an interim that reused an earlier interim would file the same
   * lookup under every intermediate key and crowd the LRU with duplicates of one turn. Only `resolve`
   * — the one call that is paying latency for the answer — reuses.
   */
  private lookup(
    key: string,
    transcript: string,
    allowPrefix = false,
  ): { entry: CacheEntry; reusedPrefix: boolean; bestPrefixCoverage: number } {
    const existing = this.cache.get(key);
    if (existing) {
      return { entry: existing, reusedPrefix: existing.searchedKey !== key, bestPrefixCoverage: 1 };
    }

    let bestPrefixCoverage = 0;
    if (allowPrefix) {
      const { entry: prefix, bestCoverage } = this.findReusablePrefix(key);
      bestPrefixCoverage = bestCoverage;
      if (prefix) {
        // File it under this key too, so a second inference in the same turn is an exact hit. The
        // entry keeps its ORIGINAL searchedKey, which is what future coverage tests are measured on.
        this.remember(key, prefix);
        return { entry: prefix, reusedPrefix: true, bestPrefixCoverage };
      }
    }

    const promise = this.retrieval
      .search(this.tenantId, transcript, { topK: this.options.topK, minScore: this.options.minScore })
      .catch((err) => {
        this.cache.delete(key);
        throw err;
      });

    const entry: CacheEntry = { promise, searchedKey: key };
    this.remember(key, entry);
    return { entry, reusedPrefix: false, bestPrefixCoverage };
  }

  /** Insert and bound. Oldest-first eviction: a settled promise costs almost nothing, but an unbounded
   * map on a twenty-minute call is a leak waiting to be found by someone else. */
  private remember(key: string, entry: CacheEntry): void {
    this.cache.set(key, entry);
    if (this.cache.size > LRU_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
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
      reusedPrefix: false,
      bestPrefixCoverage: 0,
      timing: null,
    };

    const key = KnowledgeInjector.normalize(transcript);
    if (!key) return empty;

    const deadlineMs = this.options.deadlineMs ?? DEFAULT_RESOLVE_DEADLINE_MS;
    const startedAt = Date.now();
    const { entry, reusedPrefix, bestPrefixCoverage } = this.lookup(key, transcript, true);
    const pending = entry.promise;

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
      return { ...empty, awaitedMs: Date.now() - startedAt, reusedPrefix, bestPrefixCoverage };
    }

    const awaitedMs = Date.now() - startedAt;
    if (!result) return { ...empty, awaitedMs, deadlineExpired: true, reusedPrefix, bestPrefixCoverage };

    return { ...this.buildSlot(result), awaitedMs, deadlineExpired: false, reusedPrefix, bestPrefixCoverage };
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
      reusedPrefix: false,
      bestPrefixCoverage: 0,
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
