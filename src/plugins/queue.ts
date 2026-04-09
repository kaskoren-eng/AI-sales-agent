import fp from 'fastify-plugin';
import { Queue } from 'bullmq';

declare module 'fastify' {
  interface FastifyInstance {
    queues: {
      messageProcessor: Queue;
      outboundSender: Queue;
      flowExecutor: Queue;
    };
  }
}

export default fp(async (app) => {
  const connection = app.redis.duplicate();

  const messageProcessor = new Queue('message-processor', { connection });
  const outboundSender = new Queue('outbound-sender', { connection });
  const flowExecutor = new Queue('flow-executor', { connection });

  app.decorate('queues', { messageProcessor, outboundSender, flowExecutor });

  app.addHook('onClose', async () => {
    await messageProcessor.close();
    await outboundSender.close();
    await flowExecutor.close();
  });
});
