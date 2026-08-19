import OpenAI from 'openai';
import type { Env } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';
import { EMBEDDING_DIMENSIONS } from '../../db/schema/knowledge.js';

/**
 * The single place text becomes a vector.
 *
 * One client for both sides of RAG (ingest-time chunks, call-time queries) because they MUST use the
 * same model: cosine distance between two different embedding spaces is a meaningless number that
 * happens to sort, so a mismatch does not error — it silently returns wrong chunks. `knowledge_chunks`
 * records `embedding_model` per row, and retrieval filters on it, so a half-migrated KB cannot poison
 * results.
 *
 * LATENCY NOTE (matters at call time, not at ingest time): this is a network round trip on the voice
 * hot path. `warm()` exists so a call can pay the TLS/DNS cost during the greeting — the same trick
 * the TTS path already uses for its cold socket — instead of paying it inside the caller's first
 * question. R1 only measures; R2 wires the warm-up.
 */
export class EmbeddingService {
  private readonly client: OpenAI;
  readonly model: string;
  readonly dimensions: number;

  constructor(private readonly env: Env) {
    if (!env.OPENAI_API_KEY) {
      throw new AppError('OPENAI_API_KEY is required for knowledge-base embeddings', 500, 'EMBEDDING_NOT_CONFIGURED');
    }
    this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    this.model = env.EMBEDDING_MODEL;
    this.dimensions = env.EMBEDDING_DIMENSIONS ?? EMBEDDING_DIMENSIONS;
  }

  /**
   * Embed one query. Returns the vector plus the elapsed ms, because the caller (retrieval) reports a
   * latency split and the methodology requires every new hot-path component to be measured, not
   * assumed.
   */
  async embedQuery(text: string): Promise<{ embedding: number[]; ms: number }> {
    const startedAt = Date.now();
    const embedding = await this.embedOne(text);
    return { embedding, ms: Date.now() - startedAt };
  }

  /**
   * Embed many chunks. Batched because the API accepts an array and one round trip for 96 chunks beats
   * 96 round trips by two orders of magnitude — ingestion of a real document is otherwise dominated by
   * HTTP overhead.
   *
   * Batch size 96 is deliberately below the API's per-request token ceiling for ~250-token chunks,
   * leaving headroom for the oversized-sentence chunks the chunker can emit.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    const BATCH = 96;
    for (let i = 0; i < texts.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH);
      const response = await this.client.embeddings.create({
        model: this.model,
        input: slice,
        ...(this.env.EMBEDDING_DIMENSIONS ? { dimensions: this.env.EMBEDDING_DIMENSIONS } : {}),
      });
      // The API documents index-ordered output, but the order is load-bearing here (vector i must
      // belong to chunk i) so sort defensively rather than trusting it.
      const sorted = [...response.data].sort((a, b) => a.index - b.index);
      for (const item of sorted) out.push(item.embedding);
    }
    if (out.length !== texts.length) {
      throw new AppError(
        `Embedding count mismatch: sent ${texts.length}, received ${out.length}`,
        502,
        'EMBEDDING_COUNT_MISMATCH',
      );
    }
    return out;
  }

  private async embedOne(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
      ...(this.env.EMBEDDING_DIMENSIONS ? { dimensions: this.env.EMBEDDING_DIMENSIONS } : {}),
    });
    const embedding = response.data[0]?.embedding;
    if (!embedding) {
      throw new AppError('Embedding API returned no vector', 502, 'EMBEDDING_EMPTY');
    }
    return embedding;
  }

  /** Open the connection ahead of the first real query, so its TLS handshake is not billed to a
   * caller's turn. Failures are swallowed: a cold socket is a latency problem, never a call-ending one. */
  async warm(): Promise<void> {
    try {
      await this.embedOne('חם');
    } catch {
      // Intentionally silent — see above.
    }
  }
}
