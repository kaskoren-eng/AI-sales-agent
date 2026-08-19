/**
 * Query a tenant's knowledge base from the terminal — the R1 proof that retrieval works before any
 * agent code depends on it.
 *
 *   npm run kb:search -- --tenant <uuid> --query "כמה זה עולה?"
 *   npm run kb:search -- --tenant <uuid> --query "..." --top-k 5 --min-score 0
 *
 * Prints the latency split (embed / db / total) because that split is the R1 gate: if the embedding
 * round trip dominates, the fix is warming or prefetching, not a different vector store.
 */
import { loadEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/client.js';
import { EmbeddingService } from '../src/modules/knowledge/embedding.service.js';
import { RetrievalService } from '../src/modules/knowledge/retrieval.service.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const env = loadEnv();

async function main() {
  const tenantId = arg('tenant');
  const query = arg('query');
  const topK = arg('top-k') ? Number(arg('top-k')) : undefined;
  const minScore = arg('min-score') !== undefined ? Number(arg('min-score')) : undefined;

  if (!tenantId || !query) {
    console.error('Usage: npm run kb:search -- --tenant <uuid> --query "<question>" [--top-k N] [--min-score 0.3]');
    process.exit(1);
  }

  const { db, pool } = createDatabase(env.DATABASE_URL);
  try {
    const retrieval = new RetrievalService(db, new EmbeddingService(env));
    const result = await retrieval.search(tenantId, query, {
      ...(topK !== undefined ? { topK } : {}),
      ...(minScore !== undefined ? { minScore } : {}),
    });

    console.log(`\nQ: ${query}`);
    console.log(
      `latency: embed ${result.timing.embedMs}ms · db ${result.timing.dbMs}ms · total ${result.timing.totalMs}ms`,
    );
    if (result.discarded > 0) console.log(`(${result.discarded} below min-score, hidden)`);
    console.log('');

    if (result.chunks.length === 0) {
      console.log('  — no chunks above threshold —\n');
      return;
    }
    for (const [i, chunk] of result.chunks.entries()) {
      console.log(`  ${i + 1}. score ${chunk.score.toFixed(4)}  [doc ${chunk.documentId.slice(0, 8)} #${chunk.chunkIndex}]`);
      console.log(`     ${chunk.content.replace(/\n/g, '\n     ')}\n`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\n✗ search failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
