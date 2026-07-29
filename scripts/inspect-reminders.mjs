#!/usr/bin/env node
/**
 * Inspect the meeting-reminders queue — for Phase 6 layer 4.3 / 4.4 / 4.5 verification.
 *
 * Shows every DELAYED reminder job (the ones waiting to fire) with its fire time, channel, and the
 * meeting it belongs to — so you can confirm "4 jobs at the right times" (24h + 1h, wa + email),
 * that a cancel drained them (4.4), and that a <24h booking scheduled only 2 (4.5).
 *
 * Reminders are enqueued by the cloud agent onto its REDIS — i.e. PROD Redis. So point this at prod:
 *
 *   # bash (uses the prod URL already in .agent-secrets.env):
 *   REDIS_URL="$(grep '^REDIS_URL=' .agent-secrets.env | cut -d= -f2-)" node scripts/inspect-reminders.mjs
 *
 *   # or against local dev Redis:
 *   node scripts/inspect-reminders.mjs                     # falls back to .env REDIS_URL / localhost
 *
 * Read-only. Never modifies the queue.
 */
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from 'dotenv';

config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const QUEUE = 'meeting-reminders';

const redacted = REDIS_URL.replace(/(:)([^:@/]+)(@)/, '$1***$3');
console.log(`\nmeeting-reminders queue @ ${redacted}\n`);

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
const queue = new Queue(QUEUE, { connection });

try {
  const counts = await queue.getJobCounts('delayed', 'waiting', 'active', 'completed', 'failed');
  console.log('counts:', counts, '\n');

  const delayed = await queue.getDelayed();
  if (delayed.length === 0) {
    console.log('No delayed reminder jobs. (Book a meeting >24h out to see 4 appear.)');
  } else {
    // Fire time = when the job was added + its delay. Sort soonest-first.
    const rows = delayed
      .map((j) => {
        const fireAt = new Date((j.timestamp ?? 0) + (j.delay ?? 0));
        const d = j.data ?? {};
        return {
          fireAt,
          jobId: j.id,
          channel: d.channel,
          offsetMin: d.offsetMinutes,
          meetingStart: d.meetingStartIso,
          to: typeof d.to === 'string' ? `…${d.to.slice(-4)}` : d.to,
          scheduledCallId: d.scheduledCallId,
        };
      })
      .sort((a, b) => a.fireAt - b.fireAt);

    console.log(`${rows.length} delayed reminder job(s), soonest first:\n`);
    for (const r of rows) {
      console.log(
        `  ${r.fireAt.toISOString()}  [${r.channel}/${String(r.offsetMin).padStart(4)}m]  ` +
          `to=${r.to}  meeting=${r.meetingStart}\n    jobId=${r.jobId}  call=${r.scheduledCallId}`,
      );
    }
  }
} catch (err) {
  console.error('inspect failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await queue.close().catch(() => {});
  await connection.quit().catch(() => {});
}
