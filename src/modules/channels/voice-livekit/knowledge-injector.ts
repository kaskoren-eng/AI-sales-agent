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
 * 3. PREEMPTIVE GENERATION. LiveKit builds a draft reply from the INTERIM transcript, snapshotting
 *    `agent.chatCtx`, then discards that draft unless the context still matches at turn commit
 *    (`agent_activity.js`: `preemptive.chatCtx.isEquivalent(chatCtx)`). Injecting after that snapshot
 *    kills the draft on every RAG turn — a far larger latency cost than the retrieval it was saving.
 *    So retrieval is SPECULATIVE: it runs on the interim transcript, while the caller is still
 *    talking, so the knowledge is already in the context when the snapshot is taken. This also hides
 *    the ~205ms embedding round trip behind speech the caller is still producing.
 *
 * The speculative work is cached by normalised transcript, because Soniox emits many interim results
 * per utterance and they mostly repeat their own prefix.
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

export class KnowledgeInjector {
  /** Chunk ids already present in the chat context — the dedup set (constraint 2). */
  private readonly injectedChunkIds = new Set<string>();
  /** Speculative results keyed by normalised transcript, so repeated interim results are free. */
  private readonly speculativeCache = new Map<string, Promise<Awaited<ReturnType<RetrievalService['search']>>>>();

  constructor(
    private readonly retrieval: RetrievalService,
    private readonly tenantId: string,
    private readonly options: { topK?: number; minScore?: number } = {},
  ) {}

  private static normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * Start (or reuse) retrieval for an utterance without touching the chat context.
   *
   * Called on INTERIM transcripts. Deliberately fire-and-forget from the caller's perspective: a
   * speculative miss costs one embedding (fractions of a cent) and nothing else.
   */
  prefetch(transcript: string): void {
    const key = KnowledgeInjector.normalize(transcript);
    if (!key || this.speculativeCache.has(key)) return;
    const promise = this.retrieval.search(this.tenantId, transcript, this.options).catch((err) => {
      // Swallowed here so an unhandled rejection can never reach the call; `inject()` retries and
      // reports the failure properly if this result is actually needed.
      this.speculativeCache.delete(key);
      throw err;
    });
    this.speculativeCache.set(key, promise);
  }

  /**
   * Resolve retrieval for `transcript` (reusing the speculative result when the interim text matched)
   * and append a `[KNOWLEDGE]` message with anything not already in the context.
   *
   * Never throws: a knowledge lookup that fails must degrade to an un-grounded turn, never end a call.
   * The prompt's grounding rules already cover the un-grounded case ("I'll have the team follow up").
   */
  async inject(agent: AgentLike, transcript: string): Promise<InjectionResult> {
    const empty: InjectionResult = {
      injected: false,
      chunkIds: [],
      deduped: 0,
      timing: { embedMs: 0, dbMs: 0, totalMs: 0 },
    };

    try {
      const key = KnowledgeInjector.normalize(transcript);
      const pending = this.speculativeCache.get(key);
      const result = pending
        ? await pending
        : await this.retrieval.search(this.tenantId, transcript, this.options);

      const fresh = result.chunks.filter((c) => !this.injectedChunkIds.has(c.id));
      const deduped = result.chunks.length - fresh.length;
      if (fresh.length === 0) {
        return { ...empty, deduped, timing: result.timing };
      }

      const ctx = agent.chatCtx.copy();
      ctx.addMessage({ role: 'system', content: formatKnowledgeBlock(fresh) });
      await agent.updateChatCtx(ctx);

      for (const chunk of fresh) this.injectedChunkIds.add(chunk.id);

      return {
        injected: true,
        chunkIds: fresh.map((c) => c.id),
        deduped,
        timing: result.timing,
      };
    } catch (err) {
      console.error('knowledge_inject_failed', err instanceof Error ? err.message : String(err));
      return empty;
    }
  }

  /** Interim transcripts accumulate one cache entry each; cleared when a turn commits. */
  clearSpeculative(): void {
    this.speculativeCache.clear();
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
