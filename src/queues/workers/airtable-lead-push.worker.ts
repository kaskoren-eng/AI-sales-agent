import { Worker } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { AirtableLeadPushJob } from '../airtable-lead-push.queue.js';
import type { Database } from '../../db/client.js';
import type { Env } from '../../config/env.js';
import { leads } from '../../db/schema/index.js';
import { AirtableService } from '../../modules/integrations/airtable/airtable.service.js';
import {
  buildLeadBoardFields,
  LEAD_BOARD_RECORD_ID_KEY,
} from '../../modules/integrations/airtable/lead-board.js';
import { handleDeadLetter } from '../dead-letter.js';

interface WorkerDeps {
  db: Database;
  env: Env;
  redis: Redis;
  deadLetterQueue: Queue;
}

/**
 * One-way push: new lead → new row on ClickScales' own Airtable sales board.
 *
 * Runs off the request path on purpose. Airtable is a 15s-timeout third party behind a circuit
 * breaker; the lead-intake webhook also triggers the outbound call, and nothing about a sales
 * board should be able to sit in front of that.
 *
 * Never reads back from Airtable. The `findByPhone`/`findByEmail` lookups the tenant CRM sync
 * does are deliberately not used here — Postgres already deduped by phone-then-email before the
 * lead existed, so a second lookup would only add a round trip and a second failure mode.
 */
export function createAirtableLeadPushWorker(deps: WorkerDeps) {
  const { db, env, redis, deadLetterQueue } = deps;

  const worker = new Worker<AirtableLeadPushJob>(
    'airtable-lead-push',
    async (job) => {
      const { tenantId, leadId } = job.data;

      // Platform-tenant gate. The enqueue site checks this too; this is the one that matters,
      // because it is the last thing standing between another tenant's lead and Koren's private
      // board. Same shape as the Airtable env-credential guard in flow-executor.worker.ts.
      if (!env.PLATFORM_TENANT_ID || tenantId !== env.PLATFORM_TENANT_ID) {
        console.warn(
          JSON.stringify({ event: 'airtable_lead_push_skip', reason: 'not_platform_tenant', tenantId }),
        );
        return { skipped: 'not_platform_tenant' };
      }

      const apiKey = env.AIRTABLE_LEADS_PAT;
      const baseId = env.AIRTABLE_LEADS_BASE_ID;
      const tableId = env.AIRTABLE_LEADS_TABLE_ID;
      if (!apiKey || !baseId || !tableId) {
        console.warn(
          JSON.stringify({ event: 'airtable_lead_push_skip', reason: 'not_configured', tenantId }),
        );
        return { skipped: 'not_configured' };
      }

      const [lead] = await db
        .select({
          name: leads.name,
          email: leads.email,
          phone: leads.phone,
          source: leads.source,
          metadata: leads.metadata,
          whatsappConsent: leads.whatsappConsent,
        })
        .from(leads)
        .where(and(eq(leads.id, leadId), eq(leads.tenantId, tenantId)))
        .limit(1);

      // Deleted between enqueue and run. Not an error — retrying cannot bring it back.
      if (!lead) {
        console.warn(
          JSON.stringify({ event: 'airtable_lead_push_skip', reason: 'lead_not_found', tenantId, leadId }),
        );
        return { skipped: 'lead_not_found' };
      }

      const metadata = (lead.metadata as Record<string, unknown> | null) ?? {};
      const existingRecordId = metadata[LEAD_BOARD_RECORD_ID_KEY];
      if (typeof existingRecordId === 'string' && existingRecordId.length > 0) {
        return { skipped: 'already_pushed', recordId: existingRecordId };
      }

      // Reuses the module-level 'airtable' circuit breaker inside AirtableService (5 failures →
      // 30s cooldown). Deliberately not a second breaker: two failure counters against one API
      // means neither of them knows when Airtable is actually down.
      const svc = new AirtableService({ apiKey, baseId, tableId });
      const recordId = await svc.createRecord(buildLeadBoardFields(lead));

      // Spread-merge: `metadata` also carries mondayItemId, airtableRecordId, qualification and
      // the Meta attribution blob. A `set({ metadata: { key } })` would drop all of it.
      await db
        .update(leads)
        .set({ metadata: { ...metadata, [LEAD_BOARD_RECORD_ID_KEY]: recordId }, updatedAt: new Date() })
        .where(and(eq(leads.id, leadId), eq(leads.tenantId, tenantId)));

      // No PII in the log line — the board row itself is where the name and phone belong.
      console.log(JSON.stringify({ event: 'airtable_lead_push_ok', tenantId, leadId, recordId }));
      return { recordId };
    },
    {
      connection: redis.duplicate(),
      // Airtable allows 5 requests/second per base and answers a burst with 429s that the
      // breaker would count as real failures. Three is comfortably under it.
      concurrency: 3,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(
      JSON.stringify({
        event: 'airtable_lead_push_failed',
        jobId: job?.id,
        tenantId: job?.data?.tenantId,
        leadId: job?.data?.leadId,
        error: err.message,
      }),
    );
    handleDeadLetter(deadLetterQueue, job, err);
  });

  return worker;
}
