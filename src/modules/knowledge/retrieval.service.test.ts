import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '../../db/client.js';
import { knowledgeChunks, knowledgeDocuments } from '../../db/schema/knowledge.js';
import { tenants } from '../../db/schema/tenants.js';
import { RetrievalService } from './retrieval.service.js';
import type { EmbeddingService } from './embedding.service.js';

/**
 * TENANT ISOLATION — a hard test, against a real Postgres.
 *
 * This is deliberately NOT a mocked unit test. The isolation guarantee lives inside a raw SQL
 * `WHERE tenant_id = $1` string, which is precisely the kind of thing a mock cannot verify: a mock
 * would happily "pass" against a query that had no WHERE clause at all. The failure this guards
 * against is a tenant's agent reading a competitor's pricing aloud down a phone line, so it gets the
 * real database or it gets nothing.
 *
 * Requires pgvector (migration 0014). Skipped, loudly, when no local database is reachable — CI
 * without Postgres should not report a green tenant-isolation test it never ran.
 */

const DB_URL = process.env.DATABASE_URL ?? 'postgresql://dev:dev@localhost:5432/ai_sales_agent';
const DIMS = 1536;
const MODEL = 'test-embedding-model';

/** A deterministic unit-ish vector that leans on one axis, so similarity is predictable. */
function vec(axis: number, magnitude = 1): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[axis] = magnitude;
  return v;
}

/** A stub that returns whichever vector the test asks for — no network, no API key. */
function stubEmbeddings(embedding: number[]): EmbeddingService {
  return {
    model: MODEL,
    dimensions: DIMS,
    embedQuery: async () => ({ embedding, ms: 0 }),
    embedBatch: async () => [embedding],
    warm: async () => {},
  } as unknown as EmbeddingService;
}

let db: ReturnType<typeof createDatabase>['db'];
let pool: ReturnType<typeof createDatabase>['pool'];
let tenantA: string;
let tenantB: string;

/**
 * The reachability probe runs at MODULE LOAD, not in `beforeAll`, and that placement is load-bearing:
 * `it.skipIf(...)` is evaluated when the test is DEFINED, which happens before any hook has run. Doing
 * this in `beforeAll` left `available` false at definition time, so every case silently skipped against
 * a database that was in fact up -- a green run that tested nothing, which is the one outcome a
 * tenant-isolation suite must never produce.
 */
const available = await (async () => {
  try {
    ({ db, pool } = createDatabase(DB_URL));
    await db.execute(sql`select 1`);
    // The table must exist AND the extension must be installed, or this suite is meaningless.
    await db.execute(sql`select count(*) from knowledge_chunks`);
    return true;
  } catch {
    return false;
  }
})();

beforeAll(async () => {
  if (!available) return;

  const [a] = await db
    .insert(tenants)
    .values({ name: 'iso-test-A', slug: `iso-a-${Date.now()}`, apiKeyHash: `iso-a-${Date.now()}` })
    .returning({ id: tenants.id });
  const [b] = await db
    .insert(tenants)
    .values({ name: 'iso-test-B', slug: `iso-b-${Date.now()}`, apiKeyHash: `iso-b-${Date.now()}` })
    .returning({ id: tenants.id });
  tenantA = a!.id;
  tenantB = b!.id;

  // DELIBERATELY NEAR-IDENTICAL CONTENT. If isolation is broken, B's chunk is a plausible answer to
  // A's question, so a leak produces a confident wrong result rather than an obvious error.
  for (const [tenantId, price, axis] of [
    [tenantA, 'המנוי החודשי הוא 1,490 שקלים', 0],
    [tenantB, 'המנוי החודשי הוא 9,990 שקלים', 0],
  ] as const) {
    const [doc] = await db
      .insert(knowledgeDocuments)
      .values({ tenantId, title: 'pricing', sourceType: 'paste', status: 'ready', rawText: price })
      .returning({ id: knowledgeDocuments.id });
    await db.insert(knowledgeChunks).values({
      tenantId,
      documentId: doc!.id,
      content: price,
      // Same axis for both tenants → identical similarity to the query. The ONLY thing that can
      // separate them is the tenant filter.
      embedding: vec(axis),
      embeddingModel: MODEL,
      dims: DIMS,
      chunkIndex: 0,
      tokenCount: 10,
    });
  }
});

afterAll(async () => {
  if (!available) return;
  // Chunks and documents cascade from the tenant row.
  for (const id of [tenantA, tenantB].filter(Boolean)) {
    await db.delete(tenants).where(sql`id = ${id}`);
  }
  await pool.end();
});

describe('RetrievalService — tenant isolation', () => {
  it.skipIf(!available)('tenant A never receives tenant B chunks, at any top_k', async () => {
    const retrieval = new RetrievalService(db, stubEmbeddings(vec(0)));

    for (const topK of [1, 3, 10, 100]) {
      const result = await retrieval.search(tenantA, 'כמה זה עולה', { topK, minScore: 0 });
      expect(result.chunks.length).toBeGreaterThan(0);
      for (const chunk of result.chunks) {
        expect(chunk.content).toContain('1,490');
        expect(chunk.content).not.toContain('9,990');
      }
    }
  });

  it.skipIf(!available)('the mirror case holds — B never receives A chunks', async () => {
    const retrieval = new RetrievalService(db, stubEmbeddings(vec(0)));
    const result = await retrieval.search(tenantB, 'כמה זה עולה', { topK: 100, minScore: 0 });
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) {
      expect(chunk.content).not.toContain('1,490');
    }
  });

  it.skipIf(!available)('an unknown tenant gets nothing, not everything', async () => {
    const retrieval = new RetrievalService(db, stubEmbeddings(vec(0)));
    const result = await retrieval.search('00000000-0000-0000-0000-000000000000', 'כמה זה עולה', {
      topK: 100,
      minScore: 0,
    });
    expect(result.chunks).toHaveLength(0);
  });

  it.skipIf(!available)('chunks embedded by a different model are not mixed in', async () => {
    // Same tenant, same vector — but the query is embedded by another model. Cosine distance across
    // two embedding spaces is meaningless, so these rows must be invisible rather than merely ranked low.
    const retrieval = new RetrievalService(db, stubEmbeddings(vec(0)));
    (retrieval as unknown as { embeddings: { model: string } }).embeddings.model = 'some-other-model';
    const result = await retrieval.search(tenantA, 'כמה זה עולה', { topK: 100, minScore: 0 });
    expect(result.chunks).toHaveLength(0);
  });

  it.skipIf(!available)('reports a latency split for every query', async () => {
    const retrieval = new RetrievalService(db, stubEmbeddings(vec(0)));
    const result = await retrieval.search(tenantA, 'כמה זה עולה', { topK: 3 });
    expect(result.timing.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.timing.dbMs).toBeGreaterThanOrEqual(0);
    expect(result.timing).toHaveProperty('embedMs');
  });

  it.skipIf(!available)('an empty query does not hit the database at all', async () => {
    const retrieval = new RetrievalService(db, stubEmbeddings(vec(0)));
    const result = await retrieval.search(tenantA, '   ', { topK: 3 });
    expect(result.chunks).toHaveLength(0);
    expect(result.timing.totalMs).toBe(0);
  });
});
