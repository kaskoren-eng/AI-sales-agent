import type { Queue } from 'bullmq';

export interface FlowExecutorJob {
  tenantId: string;
  leadId: string;
  flowName: string;
  stepIndex: number;
  leadPhone: string;
  leadName?: string;
  leadEmail?: string;
}

export function enqueueFlowStep(queue: Queue, job: FlowExecutorJob, delayMs: number = 0) {
  return queue.add('execute-flow-step', job, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    delay: delayMs,
    jobId: `flow-${job.tenantId}-${job.leadId}-${job.flowName}-${job.stepIndex}`,
  });
}
