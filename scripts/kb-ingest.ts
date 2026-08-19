/**
 * Ingest a document into a tenant's knowledge base, synchronously (no queue).
 *
 *   npm run kb:ingest -- --tenant <uuid> --file <path> [--title "..."]
 *   npm run kb:ingest -- --tenant <uuid> --text "..." --title "Pricing"
 *
 * The CLI path deliberately bypasses BullMQ: seeding and re-seeding a KB is an operator action where
 * you want the error in your terminal, not in a dead-letter queue.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/client.js';
import { EmbeddingService } from '../src/modules/knowledge/embedding.service.js';
import { IngestionService } from '../src/modules/knowledge/ingestion.service.js';
import type { KnowledgeSourceType } from '../src/db/schema/knowledge.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const env = loadEnv();

async function main() {
  const tenantId = arg('tenant');
  const file = arg('file');
  const text = arg('text');
  const title = arg('title');

  if (!tenantId || (!file && !text)) {
    console.error('Usage: npm run kb:ingest -- --tenant <uuid> (--file <path> | --text "...") [--title "..."]');
    process.exit(1);
  }

  const rawText = file ? readFileSync(file, 'utf-8') : text!;
  const resolvedTitle = title ?? (file ? basename(file) : 'Pasted text');
  const sourceType: KnowledgeSourceType = file ? 'upload' : 'paste';

  const { db, pool } = createDatabase(env.DATABASE_URL);
  try {
    const ingestion = new IngestionService(db, new EmbeddingService(env));
    const result = await ingestion.createAndIngest({ tenantId, title: resolvedTitle, sourceType, rawText });
    console.log(
      `\n✓ ${resolvedTitle}\n  document ${result.documentId}\n  ${result.chunks} chunks · ${result.tokens} tokens · ${result.ms}ms\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\n✗ ingest failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
