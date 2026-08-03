/**
 * Deploy-time migration runner.
 *
 * WHY THIS EXISTS RATHER THAN `npm run db:migrate`:
 * that script is `tsx ./node_modules/drizzle-kit/bin.cjs migrate` — both `tsx` and `drizzle-kit`
 * are devDependencies, and the runtime image is built with `npm ci --omit=dev`. The CLI is simply
 * not present in production. This module uses the *runtime* migrator from drizzle-orm, which is a
 * real dependency, so it compiles into dist/ and ships.
 *
 * Until this landed, migrations were never run on deploy at all — `db:migrate` existed only as an
 * npm script a human had to remember. Schema changes reached production by hand, or didn't.
 *
 * Run as: node dist/db/migrate.js   (see Dockerfile CMD — migrate, then boot)
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDatabase } from './client.js';

/**
 * Any int64 works; it just has to be the same in every replica. Derived from "keren-migrate" so
 * it can't collide with an advisory lock taken by application code for something else.
 */
const MIGRATION_LOCK_ID = 8_147_233_901_552_364n;

/** Migrations are DDL — a slow one is a stuck deploy, and a stuck deploy should fail loudly. */
const LOCK_TIMEOUT_MS = 60_000;

export async function runMigrations(connectionString: string): Promise<void> {
  // The SQL files live next to this module in dist/db/migrations (see Dockerfile COPY).
  const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

  // maxRetries/idle are deliberately tight: this pool exists for the duration of one migration run.
  const { db, pool } = createDatabase(connectionString);

  try {
    // Railway can start two replicas simultaneously. Without this, both run `migrate()` against
    // the same __drizzle_migrations table and race — the loser either errors on a duplicate DDL or,
    // worse, half-applies. pg_advisory_lock blocks until the other replica finishes, at which point
    // the second run sees the journal is current and applies nothing.
    const acquired = await withTimeout(
      db.execute(sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`),
      LOCK_TIMEOUT_MS,
    );
    if (!acquired) throw new Error(`could not acquire migration lock within ${LOCK_TIMEOUT_MS}ms`);

    try {
      await migrate(db, { migrationsFolder });
      console.log(JSON.stringify({ event: 'migrations_applied', migrationsFolder }));
    } finally {
      // Advisory locks are session-scoped, so `pool.end()` below would release it anyway. Doing it
      // explicitly means a hung pool teardown can't hold the lock and block the other replica.
      await db.execute(sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`).catch(() => undefined);
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Executed directly (node dist/db/migrate.js), not when imported by a test.
// pathToFileURL rather than a hand-built `file://${argv[1]}`: on Windows a bare template produces
// `file://C:/...` (two slashes) while import.meta.url is `file:///C:/...` (three), so the guard
// silently never fires and the module does nothing when run directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('migrate: DATABASE_URL is not set');
    process.exit(1);
  }
  runMigrations(connectionString).then(
    () => process.exit(0),
    (err) => {
      // Exit non-zero so the container fails to start rather than serving against a stale schema.
      console.error('migrate: failed', err instanceof Error ? err.stack : String(err));
      process.exit(1);
    },
  );
}
