import { Worker } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import type { CallAnalysisJob } from '../call-analysis.queue.js';
import type { Database } from '../../db/client.js';
import type { Env } from '../../config/env.js';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { callLearnings } from '../../db/schema/call-learnings.js';
import type { SalesCallAnalysis, TranscriptSegment } from '../../db/schema/call-learnings.js';
import { conversations } from '../../db/schema/index.js';
import { CallAnalysisService } from '../../modules/calls/call-analysis.service.js';
import { syncCallToCrm } from '../../modules/integrations/crm-sync.service.js';
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
      // LiveKit calls arrive with the transcript already on the row (the agent wrote it at call
      // end) — no recording to download, no Whisper. Analyze in place and finalize the dashboard
      // conversation. See enqueueLiveKitCallAnalysis.
      if (job.data.source === 'livekit') {
        const outcome = await analyzeLiveKitCall(deps, analysisService, job.data);
        // Workstream B — reflect the outcome in the tenant's CRM. Best-effort by contract
        // (syncCallToCrm never throws), wrapped again here so a CRM failure can never fail the
        // analysis job that already persisted the transcript + summary.
        try {
          await syncCallToCrm(
            {
              db,
              encryptionKey: env.ENCRYPTION_KEY,
              dashboardBaseUrl: env.DASHBOARD_BASE_URL,
            },
            {
              tenantId: job.data.tenantId,
              conversationId: job.data.conversationId,
              endReason: outcome.endReason,
              summary: outcome.summary,
            },
          );
        } catch (err) {
          console.error('crm_sync_failed', err instanceof Error ? err.message : String(err));
        }
        return { learningId: outcome.learningId, transcriptSegments: outcome.transcriptSegments };
      }

      const { tenantId, learningId, recordingUrl, durationSecs } = job.data;
      if (!recordingUrl) throw new Error('call-analysis: recordingUrl required for the recording path');

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

/**
 * The LiveKit path. The agent already persisted the transcript (and its own instrumentation —
 * tool_calls, end_reason, compliance) on the call_learnings row at call end. Here we add the GPT
 * sales analysis on top of that transcript and finalize the dashboard conversation.
 *
 * The GPT analysis is MERGED over the agent's fields, never replaces them — losing tool_calls or the
 * compliance verdicts would blind the audit trail. The conversation summary (shown in the calls
 * list) comes from the analysis's plain-language `summary`.
 */
export async function analyzeLiveKitCall(
  deps: Pick<WorkerDeps, 'db'>,
  analysisService: Pick<CallAnalysisService, 'analyzeTranscript'>,
  data: CallAnalysisJob,
): Promise<{ learningId: string; transcriptSegments: number; endReason?: string; summary?: string }> {
  const { db } = deps;
  const { tenantId, learningId, conversationId } = data;

  const [row] = await db
    .select({ transcript: callLearnings.transcript, analysis: callLearnings.analysis })
    .from(callLearnings)
    .where(and(eq(callLearnings.id, learningId), eq(callLearnings.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new Error(`call-analysis(livekit): learning ${learningId} not found for tenant`);

  const transcript: TranscriptSegment[] = row.transcript ?? [];
  const agentAnalysis: SalesCallAnalysis = row.analysis ?? {};

  // A too-thin transcript isn't worth an LLM round-trip (and a one-line call yields nothing to
  // learn). Still finalize: mark analyzed and end the conversation so it doesn't hang 'active'.
  const gptAnalysis: SalesCallAnalysis =
    transcript.length >= 2 ? await analysisService.analyzeTranscript(transcript) : {};

  // Agent-written fields (tool_calls, end_reason, compliance) are the base; GPT fields layer on top.
  const merged: SalesCallAnalysis = { ...agentAnalysis, ...gptAnalysis };

  await db
    .update(callLearnings)
    .set({ analysis: merged, status: 'analyzed' })
    .where(and(eq(callLearnings.id, learningId), eq(callLearnings.tenantId, tenantId)));

  // Finalize the Task-0 conversation row so the dashboard shows the call as ended + summarized.
  if (conversationId) {
    await db
      .update(conversations)
      .set({
        status: 'ended',
        ...(merged.summary ? { summary: merged.summary } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)));
  }

  return {
    learningId,
    transcriptSegments: transcript.length,
    endReason: merged.end_reason,
    summary: merged.summary,
  };
}
