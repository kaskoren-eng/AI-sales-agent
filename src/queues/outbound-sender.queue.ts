import type { Queue } from 'bullmq';
import type { Channel } from '../shared/types.js';

export interface OutboundSenderJob {
  tenantId: string;
  channel: Channel;
  to: string;
  content: string;
  conversationId: string;
  metadata?: Record<string, unknown>;
}

export function enqueueOutbound(queue: Queue, job: OutboundSenderJob) {
  return queue.add('send-outbound', job, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  });
}
