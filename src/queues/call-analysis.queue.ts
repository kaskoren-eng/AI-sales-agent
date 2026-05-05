import type { Queue } from 'bullmq';

export interface CallAnalysisJob {
  tenantId: string;
  learningId: string;
  recordingUrl: string;
  recordingSid: string;
  durationSecs: number;
}

export async function enqueueCallAnalysis(queue: Queue, data: CallAnalysisJob): Promise<void> {
  await queue.add('call-analysis', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
  });
}
