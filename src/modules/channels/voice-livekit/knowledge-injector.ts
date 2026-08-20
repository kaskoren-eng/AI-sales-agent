import type { RetrievalService, RetrievedChunk } from '../../knowledge/retrieval.service.js';

/**
 * Turns a caller's utterance into a `[KNOWLEDGE]` message in the chat context.
 *
 * Three constraints shape every decision in this file, and all three are measured facts about THIS
 * pipeline rather than general RAG advice:
 *
 * 1. PROMPT CACHE. OpenAI caches the longest common PREFIX. Injections are therefore APPEND-ONLY and
 *    are never removed or rewritten: replacing last turn's block would break the prefix at the first
 *    injection point and lose the cache from there onward — the exact failure per-turn injection was
 *    chosen to avoid. Measured on this pipeline: 92% cached with a stable prefix, 0% with a moving one.
 *
 * 2. TOKEN GROWTH. Append-only would grow without bound, so a chunk already in the context is never
 *    injected again. Dedup does double duty — it bounds growth AND stops her hearing the same fact
 *    three times in a call.
 *
 * 3. PREEMPTIVE GENERATION. LiveKit builds a draft reply BEFORE the turn commits, snapshotting
 *    `agent.chatCtx`, then discards that draft unless the context still matches at commit
 *    (`agent_activity.cjs:1680`: `preemptive.chatCtx.isEquivalent(chatCtx)`). Injecting after that
 *    snapshot kills the draft on every grounded turn.
 *
 *    MEASURED, 2026-08-19: it did exactly that — 4 of 6 drafts discarded with RAG on, 0 of 6 off.
 *    The first design PREFETCHED on interims but only INJECTED on the final transcript, on the
 *    assumption that retrieving early was enough. It is not: warming a cache does not put anything in
 *    the context, and the snapshot is taken before the final transcript exists.
 *
 *    WHERE THE SNAPSHOT ACTUALLY HAPPENS. Reading the pipeline end to end, the Soniox plugin emits
 *    `PREFLIGHT_TRANSCRIPT` the moment the caller pauses (`_internal.cjs:239` — final text present,
 *    no pending non-final text) and `audio_recognition.cjs:798` turns that straight into
 *    `onPreemptiveGeneration`, which copies the context synchronously. Plain `INTERIM_TRANSCRIPT`
 *    events, emitted while the caller is STILL SPEAKING, trigger no such thing.
 *
 *    So the safe window is the interim events before the pause, and the fix is to INJECT there rather
 *    than merely prefetch. The final-transcript injection stays as a catch-up and costs nothing when
 *    the speculative one already landed, because zero fresh chunks means the context is never touched.
 *
 * Speculative work is cached by normalised transcript, because Soniox emits many interim results per
 * utterance and they mostly repeat their own prefix. Because those interims now MUTATE the context,
 * every mutation is serialised (see `serialize`) — two concurrent injections would otherwise both copy
 * the same base context and the second would silently overwrite the first's block.
 */

/** How the retrieved block is labelled in the chat context. The prompt's grounding rules refer to this
 * exact marker, so the two must never drift apart. */
export const KNOWLEDGE_MARKER = '[KNOWLEDGE]';

export interface InjectionResult {
  injected: boolean;
  chunkIds: string[];
  /** Chunks that were retrieved but already present in the context — reported so the log distinguishes
   * "nothing matched" from "matched, already known". */
  deduped: number;
  timing: { embedMs: number; dbMs: number; totalMs: number };
}

/** The minimum a chat-context object must offer for injection. Kept structural so the unit tests do
 * not need a live LiveKit session. */
export interface ChatContextLike {
  addMessage(msg: { role: 'system' | 'user' | 'assistant'; content: string }): unknown;
}

export interface AgentLike {
  chatCtx: ChatContextLike & { copy(): ChatContextLike };
  updateChatCtx(ctx: ChatContextLike): Promise<void>;
}

/**
 * A Hebrew fragment shorter than this retrieves noise: "כמה זה" ("how much is") matches every pricing
 * chunk equally and nothing usefully. Below it, wait for more speech.
 */
const MIN_SPECULATIVE_CHARS = 12;

/** Re-retrieve only once the utterance has grown by this much — adjacent interims barely differ. */
const SPECULATIVE_GROWTH_CHARS = 12;

/**
 * Speculative attempts per turn. Each costs one embedding + one query, and the caller is still
 * speaking, so the ceiling is about spend rather than latency. Three covers the realistic shape of a
 * spoken question (an early stab, a mid-utterance refinement, one more if they keep going).
 */
const MAX_SPECULATIVE_PER_TURN = 3;

export class KnowledgeInjector {
  /** Chunk ids already present in the chat context — the dedup set (constraint 2). */
  private readonly injectedChunkIds = new Set<string>();
  /** Speculative results keyed by normalised transcript, so repeated interim results are free. */
  private readonly speculativeCache = new Map<string, Promise<Awaited<ReturnType<RetrievalService['search']>>>>();
  /** Serialises chat-context mutations; see constraint 3. */
  private mutations: Promise<unknown> = Promise.resolve();
  /** Per-turn speculative throttle state, reset by `endTurn()`. */
  private speculativeAttempts = 0;
  private lastSpeculativeLength = 0;
  /** Whether anything reached the context this turn — see `groundedThisTurn`. */
  private injectedThisTurn = false;

  constructor(
    private readonly retrieval: RetrievalService,
    private readonly tenantId: string,
    private readonly options: { topK?: number; minScore?: number } = {},
  ) {}

  private static normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * Run `fn` after every mutation already queued, so read-modify-write of the chat context is atomic.
   *
   * A rejected mutation must not poison the queue for the next one, hence the swallowed `catch` on the
   * stored promise — the returned promise still rejects for the caller.
   */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(fn, fn);
    this.mutations = next.catch(() => undefined);
    return next;
  }

  /**
   * Retrieve for `transcript`, reusing an identical search that is already in flight.
   *
   * Soniox repeats an interim verbatim more often than not, and the same text arrives again as the
   * FINAL transcript for short utterances — so this collapses what would otherwise be two or three
   * identical embedding round trips per turn into one.
   *
   * A failed search is evicted rather than cached, so the catch-up injection gets a real retry.
   */
  private search(transcript: string): Promise<Awaited<ReturnType<RetrievalService['search']>>> {
    const key = KnowledgeInjector.normalize(transcript);
    const pending = this.speculativeCache.get(key);
    if (pending) return pending;

    const promise = this.retrieval.search(this.tenantId, transcript, this.options).catch((err) => {
      this.speculativeCache.delete(key);
      throw err;
    });
    this.speculativeCache.set(key, promise);
    return promise;
  }

  /**
   * Resolve retrieval for `transcript` (reusing the speculative result when the interim text matched)
   * and append a `[KNOWLEDGE]` message with anything not already in the context.
   *
   * Never throws: a knowledge lookup that fails must degrade to an un-grounded turn, never end a call.
   * The prompt's grounding rules already cover the un-grounded case ("I'll have the team follow up").
   */
  async inject(agent: AgentLike, transcript: string): Promise<InjectionResult> {
    try {
      const result = await this.search(transcript);

      // Retrieval above is deliberately OUTSIDE the lock so concurrent lookups still overlap; only the
      // dedup-and-append below has to be atomic.
      return await this.serialize(async () => {
        const fresh = result.chunks.filter((c) => !this.injectedChunkIds.has(c.id));
        const deduped = result.chunks.length - fresh.length;
        if (fresh.length === 0) {
          return { ...emptyInjection(), deduped, timing: result.timing };
        }

        // Claimed before the await rather than after. `serialize` already makes this section atomic, so
        // the ordering is not load-bearing today and no test fails if it is swapped — it is here so
        // that dedup does not quietly come to depend on the lock still existing.
        for (const chunk of fresh) this.injectedChunkIds.add(chunk.id);

        const ctx = agent.chatCtx.copy();
        ctx.addMessage({ role: 'system', content: formatKnowledgeBlock(fresh) });
        await agent.updateChatCtx(ctx);

        this.injectedThisTurn = true;

        return {
          injected: true,
          chunkIds: fresh.map((c) => c.id),
          deduped,
          timing: result.timing,
        };
      });
    } catch (err) {
      console.error('knowledge_inject_failed', err instanceof Error ? err.message : String(err));
      return emptyInjection();
    }
  }

  /**
   * Inject from an INTERIM transcript, while the caller is still speaking — the only window in which a
   * mutation is free (constraint 3).
   *
   * Returns `null` when the throttle declined, which is the common case: Soniox emits many interims per
   * utterance and injecting on each would buy nothing for three times the spend.
   *
   * Retrieving from half a sentence is deliberate and safe in a way that retrieving from half a
   * sentence for a TOOL call would not be: the worst outcome is a chunk she did not need, sitting in
   * context unused. The catch-up injection on the final transcript still adds anything this missed.
   */
  injectSpeculative(agent: AgentLike, transcript: string): Promise<InjectionResult> | null {
    const text = KnowledgeInjector.normalize(transcript);
    if (text.length < MIN_SPECULATIVE_CHARS) return null;
    if (this.speculativeAttempts >= MAX_SPECULATIVE_PER_TURN) return null;
    if (this.lastSpeculativeLength > 0 && text.length - this.lastSpeculativeLength < SPECULATIVE_GROWTH_CHARS) {
      return null;
    }

    this.speculativeAttempts += 1;
    this.lastSpeculativeLength = text.length;
    return this.inject(agent, transcript);
  }

  /**
   * Did anything reach the context during this turn?
   *
   * This is what lets the final-transcript catch-up decide whether it may touch the context at all.
   * Injecting at that point costs the preemptive draft (constraint 3), so it is worth doing ONLY when
   * the alternative is an un-grounded answer — never merely to top up a turn that is already grounded.
   */
  get groundedThisTurn(): boolean {
    return this.injectedThisTurn;
  }

  /**
   * End of a user turn: drop the interim cache (one entry per interim) and re-arm the speculative
   * throttle. The dedup set deliberately SURVIVES — it spans the whole call, which is what stops the
   * same fact being injected again three turns later.
   */
  endTurn(): void {
    this.speculativeCache.clear();
    this.speculativeAttempts = 0;
    this.lastSpeculativeLength = 0;
    this.injectedThisTurn = false;
  }
}

/** A fresh object each time: callers spread and mutate these, so a shared instance would leak state. */
function emptyInjection(): InjectionResult {
  return { injected: false, chunkIds: [], deduped: 0, timing: { embedMs: 0, dbMs: 0, totalMs: 0 } };
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
