import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import type { EmbeddingService } from './embedding.service.js';

/**
 * Call-time retrieval: a caller's utterance in, the few chunks that answer it out.
 *
 * This is the only component of R1 that will ever run inside a live call, so two things are
 * non-negotiable here:
 *
 * 1. TENANT ISOLATION. Every query carries `tenant_id = $1`. Not a convention, not a review note —
 *    `retrieval.service.test.ts` seeds two tenants with deliberately near-identical content and
 *    asserts tenant A can never surface a B chunk at any top_k. A leak here reads a competitor's
 *    pricing out loud down a phone line.
 * 2. MEASURED LATENCY. Every call returns its own embed/db/total split. The methodology forbids
 *    shipping a hot-path component whose cost is asserted rather than measured, and the R1 gate is
 *    exactly this number.
 */

export interface RetrievedChunk {
  id: string;
  documentId: string;
  content: string;
  chunkIndex: number;
  /**
   * The chunk's best evidence from either retriever: `max(vectorScore, lexicalScore)`. This is what
   * `minScore` filters on — a chunk found by strong lexical overlap must not be discarded because its
   * embedding was mediocre, which is the whole reason the lexical half exists.
   */
  score: number;
  /** Cosine SIMILARITY in [0,1] — 1 is identical. pgvector's `<=>` returns DISTANCE; we convert, so
   * the number reads the way a human expects ("at least this similar"). */
  vectorScore: number;
  /** Trigram `word_similarity` in [0,1]: how well the query matches the best-matching WORD RUN inside
   * the chunk. Chosen over plain `similarity()` because a short question against a 250-token chunk
   * dilutes whole-string trigram overlap to noise (measured: 0.056 where word_similarity gave 0.70). */
  lexicalScore: number;
}

export interface RetrievalTiming {
  embedMs: number;
  dbMs: number;
  totalMs: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  timing: RetrievalTiming;
  /** Chunks that were found but fell below `minScore`. Kept for the eval harness and the R3 debug
   * box: "nothing matched" and "matched weakly" are different failures with different fixes. */
  discarded: number;
}

export interface SearchOptions {
  topK?: number;
  minScore?: number;
}

/** Deliberately small. Three chunks of ~250 tokens is ~750 tokens added to a turn — a real cost paid
 * per turn, and the whole point of RAG here is to carry LESS than the prompt did, not more. */
const DEFAULT_TOP_K = 3;
/**
 * Below this similarity a chunk is noise. Tuned to be permissive in R1: a too-strict floor hides
 * recall problems the eval is meant to expose, and the grounding rules in the R2 prompt make a weak
 * chunk survivable (she says "I'll have the team follow up") whereas a missing chunk is invisible.
 */
const DEFAULT_MIN_SCORE = 0.3;

/**
 * The lexical half only votes when it has GENUINE overlap to report.
 *
 * Measured, and this gate is the difference between hybrid helping and hybrid hurting. Ungated,
 * equal-weight fusion traded wins for losses on the real KB: it rescued "זה יקר לי" (0.70 lexical) but
 * lost "כמה זה עולה", because "כמה" appears in several unrelated chunks ("כמה לידים", "כמה שווה") and a
 * high lexical RANK built from that noise displaced a perfectly good vector hit. Net effect: zero.
 *
 * With the floor, a chunk needs real word-run overlap before it can move — noise contributes nothing,
 * so the lexical half can only ever add hits. Real matches measured 0.61-0.70; noise sat far below.
 */
const LEXICAL_FLOOR = 0.35;

export class RetrievalService {
  constructor(
    private readonly db: Database,
    private readonly embeddings: EmbeddingService,
  ) {}

  async search(tenantId: string, query: string, options: SearchOptions = {}): Promise<RetrievalResult> {
    const topK = options.topK ?? DEFAULT_TOP_K;
    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    const startedAt = Date.now();

    const trimmed = query.trim();
    if (!trimmed) {
      return { chunks: [], discarded: 0, timing: { embedMs: 0, dbMs: 0, totalMs: 0 } };
    }

    const { embedding, ms: embedMs } = await this.embeddings.embedQuery(trimmed);
    const literal = `[${embedding.join(',')}]`;

    const dbStartedAt = Date.now();
    // HYBRID RETRIEVAL, fused by Reciprocal Rank Fusion.
    //
    // WHY HYBRID: measured on the real ClickScales KB, pure vector search put every chunk in a flat
    // 0.26-0.33 similarity band — the right answer did not score low, EVERYTHING scored the same. The
    // chunk headed "התנגדות — זה יקר" ranked 4th for "זה יקר לי", behind three unrelated chunks.
    // Trigram word_similarity scored that pair 0.70. Neither retriever is sufficient alone: the vector
    // half catches paraphrase, the lexical half catches the literal overlap the embedding fumbles.
    //
    // WHY RRF AND NOT A WEIGHTED SUM OF SCORES: cosine similarity and trigram similarity are different
    // scales with different distributions, so any fixed weighting is a magic number that silently
    // rebalances whenever content changes. RRF consumes only the RANKS, so it needs no normalisation
    // and no tuning. k=60 is the conventional constant; it flattens the difference between ranks deep
    // in the list while keeping the top few decisive.
    //
    // WHY THIS DOES NOT USE THE HNSW INDEX: it scans the tenant's chunks and computes both scores
    // exactly. At SMB scale (hundreds to low thousands of chunks per tenant) exact search is both fast
    // enough and MORE accurate than an approximate index. The HNSW and GIN indexes stay for the day a
    // tenant's KB outgrows that — this ordering is the thing to revisit then, not the schema.
    //
    // Parameterised throughout: `tenantId`, the query text and the vector are bound values.
    // `embedding_model` is in the filter on purpose — mixing models silently returns plausible nonsense
    // (see EmbeddingService), so a KB mid-re-embed returns FEWER results rather than wrong ones.
    const rows = await this.db.execute(sql`
      WITH scored AS (
        SELECT id,
               document_id,
               content,
               chunk_index,
               1 - (embedding <=> ${literal}::vector) AS vec_score,
               word_similarity(${trimmed}, content) AS lex_score
          FROM knowledge_chunks
         WHERE tenant_id = ${tenantId}
           AND embedding_model = ${this.embeddings.model}
      ), ranked AS (
        SELECT *,
               row_number() OVER (ORDER BY vec_score DESC) AS vec_rank,
               row_number() OVER (ORDER BY lex_score DESC) AS lex_rank
          FROM scored
      )
      SELECT id,
             document_id,
             content,
             chunk_index,
             vec_score,
             lex_score,
             (1.0 / (60 + vec_rank))
             + CASE WHEN lex_score >= ${LEXICAL_FLOOR} THEN 1.0 / (60 + lex_rank) ELSE 0 END AS rrf
        FROM ranked
       ORDER BY rrf DESC
       LIMIT ${topK}
    `);
    const dbMs = Date.now() - dbStartedAt;

    // node-postgres hands back a QueryResult; other drizzle drivers hand back a bare array. Accept
    // either so a driver swap does not silently return zero chunks (which would look like "the KB is
    // empty" rather than "the code is wrong").
    const raw = rows as unknown as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const resultRows = Array.isArray(raw) ? raw : (raw.rows ?? []);

    const all = resultRows.map((row) => {
      const vectorScore = Number(row.vec_score);
      const lexicalScore = Number(row.lex_score);
      return {
        id: String(row.id),
        documentId: String(row.document_id),
        content: String(row.content),
        chunkIndex: Number(row.chunk_index),
        score: Math.max(vectorScore, lexicalScore),
        vectorScore,
        lexicalScore,
      };
    });
    const chunks = all.filter((c) => c.score >= minScore);

    return {
      chunks,
      discarded: all.length - chunks.length,
      timing: { embedMs, dbMs, totalMs: Date.now() - startedAt },
    };
  }
}
