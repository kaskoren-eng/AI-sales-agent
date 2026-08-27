import type { Queue } from 'bullmq';

/**
 * Push a newly created lead onto ClickScales' own Airtable sales board.
 *
 * Only the lead id travels — the worker re-reads the row. A payload snapshot would go stale
 * between enqueue and run (consent ticked on a second form submit, metadata enriched), and the
 * board should show what we know at push time, not at intake time.
 */
export interface AirtableLeadPushJob {
  tenantId: string;
  leadId: string;
}

export function enqueueAirtableLeadPush(queue: Queue, job: AirtableLeadPushJob) {
  return queue.add('airtable-lead-push', job, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    // Deterministic: BullMQ drops a duplicate while the job record still exists. The stored
    // record id on the lead is the durable half of the same guarantee — Airtable's create API
    // has no idempotency key, so a blind retry is a second row on Koren's board.
    jobId: `airtable-lead-${job.leadId}`,
  });
}
