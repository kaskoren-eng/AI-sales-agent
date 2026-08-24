import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export function createDatabase(
  connectionString: string,
  // Additive, for callers with latency requirements (the voice worker). The API server and
  // migrations keep pg's defaults by passing nothing.
  poolOptions?: Omit<pg.PoolConfig, 'connectionString'>,
) {
  const pool = new pg.Pool({ connectionString, ...poolOptions });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Database = ReturnType<typeof createDatabase>['db'];
