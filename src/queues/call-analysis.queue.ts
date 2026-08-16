import type { Queue } from 'bullmq';

/**
 * Two producers feed the call-analysis worker:
 *  - Zadarma/Twilio recording webhook → `recordingUrl` present → download + Whisper + GPT.
 *  - LiveKit agent at call end → the transcript is ALREADY on the call_learnings row, so no
 *    recording/Whisper step: `source:'livekit'` + `learningId` (+ `conversationId` to finalize the
 *    dashboard conversation). Discriminated by `source`; the worker branches on it.
 */
export interface CallAnalysisJob {
  tenantId: string;
  learningId: string;
  source?: 'recording' | 'livekit';
  // Recording path only:
  recordingUrl?: string;
  recordingSid?: string;
  durationSecs?: number;
  // LiveKit path only — the conversations row created at dial time (Task 0), finalized on analyze.
  conversationId?: string;
}

export async function enqueueCallAnalysis(queue: Queue, data: CallAnalysisJob): Promise<void> {
  await queue.add('call-analysis', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
  });
}

/**
 * LiveKit variant: analyze the transcript already stored on the call_learnings row and finalize the
 * conversation. Fewer retries than the recording path — there is no flaky download, only an LLM call,
 * and the transcript is safely persisted on the row either way.
 */
export async function enqueueLiveKitCallAnalysis(
  queue: Queue,
  data: { tenantId: string; learningId: string; conversationId?: string },
): Promise<void> {
  const job: CallAnalysisJob = { ...data, source: 'livekit' };
  await queue.add('call-analysis', job, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
  });
}
