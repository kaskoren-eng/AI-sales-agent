import type { Queue } from 'bullmq';
import type { Channel } from '../shared/types.js';

export interface MessageProcessorJob {
  tenantId: string;
  channel: Channel;
  channelRef: string;
  from: string;
  content: string;
  contentType: string;
  rawPayload: Record<string, unknown>;
}

export function enqueueMessage(queue: Queue, job: MessageProcessorJob) {
  return queue.add('process-message', job, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  });
}
