import fp from 'fastify-plugin';
import { Redis } from 'ioredis';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

export default fp(async (app) => {
  const redis = new Redis(app.env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  app.decorate('redis', redis);
  app.addHook('onClose', async () => {
    redis.disconnect();
  });
});
