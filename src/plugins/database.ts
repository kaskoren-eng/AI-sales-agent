import fp from 'fastify-plugin';
import { createDatabase } from '../db/client.js';
import type { Database } from '../db/client.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
  }
}

export default fp(async (app) => {
  const { db, pool } = createDatabase(app.env.DATABASE_URL);

  app.decorate('db', db);
  app.addHook('onClose', async () => {
    await pool.end();
  });
});
