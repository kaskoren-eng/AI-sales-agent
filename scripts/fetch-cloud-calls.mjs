/**
 * Pulls call reports down from the LiveKit Cloud agent.
 *
 *   npm run call:fetch          then: npm run call:report
 *
 * WHY THIS IS NEEDED. In LiveKit Cloud the agent's filesystem is EPHEMERAL and unreachable — the
 * `call-reports/*.json` it writes go into a box nobody can open. The first cloud call proved it:
 * the agent cheerfully logged `call_report_written call-reports/2026-...json` for a file that could
 * never be read by anyone. Everything we know about a call has to leave the container through
 * STDOUT, which is what `lk agent logs` returns.
 *
 * So the agent now also prints the whole report as one JSON line (`call_report_json {...}`), and
 * this script fishes those lines out of the logs and writes them into call-reports/ locally, where
 * `npm run call:report` reads them exactly as it does for a laptop call.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const DIR = 'call-reports';
const TAIL_SECONDS = 30;

console.log('pulling logs from the cloud agent...');

// `lk agent logs` STREAMS — it never exits on its own. Give it a bounded window and take what
// arrives; the reports we want are the most recent lines anyway.
const r = spawnSync(
  process.platform === 'win32' ? 'powershell' : 'sh',
  process.platform === 'win32'
    ? ['-Command', `$j = Start-Job { lk agent logs }; Start-Sleep -Seconds ${TAIL_SECONDS}; Receive-Job $j; Stop-Job $j`]
    : ['-c', `timeout ${TAIL_SECONDS} lk agent logs`],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
const reports = [];
for (const line of out.split('\n')) {
  const i = line.indexOf('call_report_json ');
  if (i === -1) continue;
  try {
    reports.push(JSON.parse(line.slice(i + 'call_report_json '.length)));
  } catch {
    // A truncated log line. Skip it rather than crash the whole fetch.
  }
}

if (reports.length === 0) {
  console.log('No call reports in the cloud logs.');
  console.log('\nEither no call has been taken since the agent was last deployed, or the agent is');
  console.log('running a build from before call_report_json was added. Redeploy:');
  console.log('  node scripts/deploy-agent.mjs deploy');
  process.exit(0);
}

await mkdir(DIR, { recursive: true });
for (const rep of reports) {
  const stamp = String(rep.startedAt).replace(/[:.]/g, '-');
  const path = `${DIR}/${stamp}.json`;
  await writeFile(path, `${JSON.stringify(rep, null, 2)}\n`);
  console.log(`  ${path}   ${rep.durationSec}s   ${rep.transcript?.length ?? 0} transcript lines`);
}
console.log(`\n${reports.length} call(s) fetched. Read them with:  npm run call:report`);
