import fp from 'fastify-plugin';

export default fp(async (app) => {
  app.addHook('onResponse', async (request, reply) => {
    const tenantId = (request as any).tenantId;
    if (!tenantId) return;

    request.log.info({
      audit: true,
      tenantId,
      userId: (request as any).userId,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime,
    });
  });
});
