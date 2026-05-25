import { Worker } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import type { CallAnalysisJob } from '../call-analysis.queue.js';
import type { Database } from '../../db/client.js';
import type { Env } from '../../config/env.js';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { callLearnings } from '../../db/schema/call-learnings.js';
import { CallAnalysisService } from '../../modules/calls/call-analysis.service.js';
import { handleDeadLetter } from '../dead-letter.js';

interface WorkerDeps {
  db: Database;
  env: Env;
  redis: Redis;
  deadLetterQueue: Queue;
}

export function createCallAnalysisWorker(deps: WorkerDeps) {
  const { db, env, redis, deadLetterQueue } = deps;
  const analysisService = new CallAnalysisService(env);

  const worker = new Worker<CallAnalysisJob>(
    'call-analysis',
    async (job) => {
      const { tenantId, learningId, recordingUrl, durationSecs } = job.data;

      // 1. Mark as transcribing
      await db
        .update(callLearnings)
        .set({ status: 'transcribing', durationSecs, recordingUrl })
        .where(and(eq(callLearnings.id, learningId), eq(callLearnings.tenantId, tenantId)));

      // 2. Download recording + transcribe with Whisper
      const transcript = await analysisService.downloadAndTranscribe(recordingUrl);

      // 3. Analyze transcript with GPT
      const analysis = await analysisService.analyzeTranscript(transcript);

      // 4. Store results
      await db
        .update(callLearnings)
        .set({ transcript, analysis, status: 'analyzed' })
        .where(and(eq(callLearnings.id, learningId), eq(callLearnings.tenantId, tenantId)));

      // 5. Bust Retell dynamic-variables cache so the next call gets fresh learnings
      const agentId = env.RETELL_AGENT_ID;
      if (agentId) {
        await redis.del(`retell:dynvars:${agentId}`);
      }

      return { learningId, transcriptSegments: transcript.length };
    },
    {
      connection: redis.duplicate(),
      concurrency: 2,
    },
  );

  worker.on('failed', (job, err) => {
    // Mark the learning record as failed
    if (job?.data.learningId) {
      db.update(callLearnings)
        .set({ status: 'failed' })
        .where(eq(callLearnings.id, job.data.learningId))
        .catch(() => {});
    }

    console.error(`Call analysis failed for job ${job?.id}:`, err);
    handleDeadLetter(deadLetterQueue, job, err);
  });

  return worker;
}
