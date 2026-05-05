import type { Queue } from 'bullmq';

export interface CsvImportJob {
  jobId: string;
  tenantId: string;
  csvContent: string;
}

export function enqueueCsvImport(queue: Queue, job: CsvImportJob) {
  return queue.add('csv-import', job, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    jobId: `csv-import-${job.jobId}`,
  });
}
