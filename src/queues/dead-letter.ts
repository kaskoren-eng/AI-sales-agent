import type { Job, Queue } from 'bullmq';

/**
 * Dead Letter Queue handler.
 *
 * Called from worker `failed` events when a job has exhausted all retries.
 * Moves the job data to a dedicated `dead-letter` queue for inspection/replay.
 */
export async function handleDeadLetter(
  deadLetterQueue: Queue,
  job: Job | undefined,
  err: Error,
): Promise<void> {
  if (!job) return;

  const isExhausted = (job.attemptsMade ?? 0) >= (job.opts?.attempts ?? 1);
  if (!isExhausted) return; // Still has retries left — don't DLQ yet

  try {
    await deadLetterQueue.add(
      'dead-letter',
      {
        originalQueue: job.queueName,
        originalJobId: job.id,
        originalJobName: job.name,
        data: job.data,
        failedReason: err.message,
        attemptsMade: job.attemptsMade,
        failedAt: new Date().toISOString(),
      },
      { removeOnComplete: 500, removeOnFail: false },
    );

    console.error(
      `[DLQ] Job ${job.id} (${job.name}) moved to dead-letter after ${job.attemptsMade} attempts: ${err.message}`,
    );
  } catch (dlqErr) {
    console.error('[DLQ] Failed to enqueue dead-letter job:', dlqErr);
  }
}
