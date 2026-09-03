import fp from 'fastify-plugin';
import { Queue } from 'bullmq';

declare module 'fastify' {
  interface FastifyInstance {
    queues: {
      messageProcessor: Queue;
      outboundSender: Queue;
      flowExecutor: Queue;
      deadLetter: Queue;
      csvImport: Queue;
      callAnalysis: Queue;
      meetingReminders: Queue;
      airtableLeadPush: Queue;
      callbacks: Queue;
    };
  }
}

export default fp(async (app) => {
  const connection = app.redis.duplicate();

  const messageProcessor = new Queue('message-processor', { connection });
  const outboundSender = new Queue('outbound-sender', { connection });
  const flowExecutor = new Queue('flow-executor', { connection });
  const deadLetter = new Queue('dead-letter', { connection });
  const csvImport = new Queue('csv-import', { connection });
  const callAnalysis = new Queue('call-analysis', { connection });
  const meetingReminders = new Queue('meeting-reminders', { connection });
  const airtableLeadPush = new Queue('airtable-lead-push', { connection });
  // Created unconditionally, even though VOICE_CALLBACK_WORKER gates the CONSUMER. The queue
  // object is a handle, not a process; and the reconcile script and every future producer need
  // somewhere to put work. Nothing enqueues callbacks yet — the tool that will is F1.4 — so with
  // the worker off this queue simply stays empty.
  const callbacks = new Queue('callbacks', { connection });

  app.decorate('queues', { messageProcessor, outboundSender, flowExecutor, deadLetter, csvImport, callAnalysis, meetingReminders, airtableLeadPush, callbacks });

  app.addHook('onClose', async () => {
    await messageProcessor.close();
    await outboundSender.close();
    await flowExecutor.close();
    await deadLetter.close();
    await csvImport.close();
    await callAnalysis.close();
    await meetingReminders.close();
    await airtableLeadPush.close();
    await callbacks.close();
  });
});
