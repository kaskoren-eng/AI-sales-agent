import { Worker } from 'bullmq';
import Papa from 'papaparse';
import { eq, and, or } from 'drizzle-orm';
import type { CsvImportJob } from '../csv-import.queue.js';
import type { Database } from '../../db/client.js';
import { leads, importJobs } from '../../db/schema/index.js';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { meterLead } from '../../modules/billing/usage.service.js';

interface WorkerDeps {
  db: Database;
  redis: Redis;
  deadLetterQueue: Queue;
}

interface RowError {
  row: number;
  message: string;
}

interface ParsedRow {
  name?: string;
  email?: string;
  phone?: string;
  [key: string]: string | undefined;
}

function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  // If the string is all digits (possibly with leading spaces stripped), prepend +
  if (/^\d+$/.test(trimmed)) {
    return `+${trimmed}`;
  }
  return trimmed;
}

export function createCsvImportWorker(deps: WorkerDeps) {
  const { db, redis, deadLetterQueue } = deps;

  const worker = new Worker<CsvImportJob>(
    'csv-import',
    async (job) => {
      const { jobId, tenantId, csvContent } = job.data;

      // 1. Fetch the import_jobs row and verify tenant ownership
      const [importJob] = await db
        .select()
        .from(importJobs)
        .where(and(eq(importJobs.id, jobId), eq(importJobs.tenantId, tenantId)))
        .limit(1);

      if (!importJob) {
        throw new Error(`Import job ${jobId} not found for tenant ${tenantId}`);
      }

      // 2. Update status → processing
      await db
        .update(importJobs)
        .set({ status: 'processing', updatedAt: new Date() })
        .where(and(eq(importJobs.id, jobId), eq(importJobs.tenantId, tenantId)));

      // 3. Parse the CSV
      const parsed = Papa.parse<ParsedRow>(csvContent, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => h.trim().toLowerCase(),
      });

      const rows = parsed.data;
      const totalRows = rows.length;
      const rowErrors: RowError[] = [];

      // Update total row count
      await db
        .update(importJobs)
        .set({ totalRows, updatedAt: new Date() })
        .where(and(eq(importJobs.id, jobId), eq(importJobs.tenantId, tenantId)));

      // 4 & 5. Process rows in batches of 500
      const BATCH_SIZE = 500;
      const PROGRESS_INTERVAL = 100;
      let processedRows = 0;

      interface LeadUpsert {
        rowIndex: number;
        name?: string;
        email?: string;
        phone?: string;
      }

      // Collect valid rows
      const validRows: LeadUpsert[] = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rawPhone = row.phone ?? row['phone number'] ?? row['mobile'] ?? '';
        const rawEmail = row.email ?? row['email address'] ?? '';
        const rawName = row.name ?? row['full name'] ?? row['first name'] ?? '';

        const phone = rawPhone ? normalizePhone(rawPhone) : undefined;
        const email = rawEmail.trim() || undefined;
        const name = rawName.trim() || undefined;

        // Skip rows missing both phone and email (silent — not an error)
        if (!phone && !email) {
          continue;
        }

        validRows.push({ rowIndex: i + 1, name, email, phone });
      }

      // Process in batches
      for (let batchStart = 0; batchStart < validRows.length; batchStart += BATCH_SIZE) {
        const batch = validRows.slice(batchStart, batchStart + BATCH_SIZE);

        for (const item of batch) {
          try {
            const { name, email, phone } = item;

            // Build the lookup condition: match by (tenantId, phone) OR (tenantId, email)
            const conditions = [];
            if (phone) conditions.push(and(eq(leads.tenantId, tenantId), eq(leads.phone, phone)));
            if (email) conditions.push(and(eq(leads.tenantId, tenantId), eq(leads.email, email)));

            const lookupCondition = conditions.length === 2
              ? or(...(conditions as [ReturnType<typeof and>, ReturnType<typeof and>]))
              : conditions[0]!;

            const [existing] = await db
              .select({ id: leads.id })
              .from(leads)
              .where(lookupCondition)
              .limit(1);

            if (existing) {
              // Update existing lead
              await db
                .update(leads)
                .set({
                  ...(name !== undefined ? { name } : {}),
                  ...(email !== undefined ? { email } : {}),
                  ...(phone !== undefined ? { phone } : {}),
                  updatedAt: new Date(),
                })
                .where(and(eq(leads.id, existing.id), eq(leads.tenantId, tenantId)));
            } else {
              // Insert new lead
              const [created] = await db.insert(leads).values({
                tenantId,
                name,
                email,
                phone,
                source: 'csv',
                status: 'new',
              }).returning({ id: leads.id });

              // BILLABLE, and the path most likely to produce a surprising invoice: a customer who
              // uploads a 2,000-row CSV has just bought 2,000 leads' worth of overage. Metering it
              // is what makes that visible on a usage screen instead of on a bill three weeks
              // later. Per-row rather than batched so a partially-failed import still meters
              // exactly the rows it actually created.
              if (created) await meterLead(db, { tenantId, leadId: created.id, source: 'csv' });
            }

            processedRows++;
          } catch (err) {
            rowErrors.push({
              row: item.rowIndex,
              message: err instanceof Error ? err.message : 'Unknown error',
            });
          }

          // 6. Update processedRows every 100 rows
          if (processedRows > 0 && processedRows % PROGRESS_INTERVAL === 0) {
            await db
              .update(importJobs)
              .set({ processedRows, updatedAt: new Date() })
              .where(and(eq(importJobs.id, jobId), eq(importJobs.tenantId, tenantId)));
          }
        }
      }

      // 8. Mark job as done (or failed if every row errored) with final counts
      const finalStatus = processedRows === 0 && rowErrors.length > 0 ? 'failed' : 'done';
      await db
        .update(importJobs)
        .set({
          status: finalStatus,
          processedRows,
          errors: rowErrors as any,
          updatedAt: new Date(),
        })
        .where(and(eq(importJobs.id, jobId), eq(importJobs.tenantId, tenantId)));

      return { jobId, tenantId, processedRows, errorCount: rowErrors.length };
    },
    {
      connection: redis.duplicate(),
      concurrency: 5,
    },
  );

  // 9. On BullMQ failure: mark job failed in DB and move to DLQ when exhausted
  worker.on('failed', async (job, err) => {
    console.error(`CSV import failed for job ${job?.id}:`, err);
    if (!job) return;

    const { jobId, tenantId } = job.data;

    try {
      await db
        .update(importJobs)
        .set({
          status: 'failed',
          errors: [{ row: 0, message: err.message }] as any,
          updatedAt: new Date(),
        })
        .where(and(eq(importJobs.id, jobId), eq(importJobs.tenantId, tenantId)));
    } catch (dbErr) {
      console.error('Failed to update import job status on failure:', dbErr);
    }

    const attemptsLeft = (job.opts.attempts ?? 1) - (job.attemptsMade ?? 0);
    if (attemptsLeft <= 0) {
      try {
        await deadLetterQueue.add(
          'csv-import-dead',
          { ...job.data, failedReason: err.message },
          { removeOnComplete: false, removeOnFail: false },
        );
      } catch (dlqErr) {
        console.error('Failed to enqueue dead letter for CSV import job:', dlqErr);
      }
    }
  });

  return worker;
}
