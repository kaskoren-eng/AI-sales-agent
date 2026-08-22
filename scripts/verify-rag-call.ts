/**
 * Checks a `rag_full_call` run against what the R1/R2 machinery is supposed to do.
 *
 *   npx tsx scripts/verify-rag-call.ts /tmp/agent.log
 *
 * WHY THIS READS THE AGENT LOG AND NOT THE CALL REPORT. The report records what was SAID; these
 * mechanisms are things that happen (or fail to happen) between turns — a gate declining, a pack
 * arriving, a draft surviving. They are only observable in the agent's own telemetry.
 *
 * WHY IT ASSERTS ON EVENTS AND NOT ON HER WORDS. The synthetic caller speaks through Cartesia and is
 * heard through Soniox, so the exact Hebrew that reaches the agent is not the Hebrew in the scenario
 * file. Asserting "she quoted 1,490" would fail on a transcription artefact and pass on a lucky one.
 * Every check here is on something the pipeline did, which is stable under STT noise.
 *
 * READ THE OUTPUT AS A REPORT, NOT A VERDICT. A red line means the mechanism did not fire on this
 * run; it does not always mean the mechanism is broken, because the caller's utterance may not have
 * survived transcription. The FAIL list tells you where to look, not what to conclude.
 */
import { readFileSync } from 'node:fs';

const logPath = process.argv[2];
if (!logPath) {
  console.error('usage: npx tsx scripts/verify-rag-call.ts <agent.log>');
  process.exit(2);
}
const log = readFileSync(logPath, 'utf8');

/** Every `name {json}` telemetry line, parsed. */
function events(name: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of log.matchAll(new RegExp(`${name} (\\{[^\\n]*\\})`, 'g'))) {
    try {
      out.push(JSON.parse(m[1]!) as Record<string, unknown>);
    } catch {
      /* a truncated line is not a failure of the thing being measured */
    }
  }
  return out;
}

const ragTurns = events('rag_turn');
const skipped = events('rag_skipped');
const packs = events('playbook_delivered');
const resolved = events('rag_resolved');
const sizes = events('playbook_packs');
const fillers = events('thinking_filler');

const stages = new Set(ragTurns.map((t) => t.stage as string));
const skipReasons = skipped.map((s) => s.reason as string);
const packHeadings = packs.flatMap((p) => (p.headings as string[]) ?? []);
const discarded = (log.match(/preemptive generation enabled but chat context/g) ?? []).length;
const started = (log.match(/starting preemptive generation/g) ?? []).length;
const speculative = ragTurns.filter((t) => t.speculative === true).length;
const injected = ragTurns.filter((t) => t.injected === true).length;
const embedMs = ragTurns.map((t) => Number(t.embedMs)).filter((n) => Number.isFinite(n));

interface Check {
  what: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
const check = (what: string, ok: boolean, detail: string) => checks.push({ what, ok, detail });

// ── configuration actually took effect ─────────────────────────────────────────────
check('RAG resolved active', resolved.some((r) => r.active === true), JSON.stringify(resolved[0] ?? {}));
check('slim prompt in use', resolved.some((r) => r.slimPrompt === true), `slimPrompt=${resolved[0]?.slimPrompt}`);
check(
  'resident prompt is the slim one',
  sizes.length > 0 && Number(sizes[0]!.residentWords) < Number(sizes[0]!.fullWords) * 0.6,
  sizes.length ? `${sizes[0]!.residentWords} resident / ${sizes[0]!.fullWords} full` : 'no playbook_packs line',
);

// ── retrieval fired where it should ────────────────────────────────────────────────
check('retrieval ran at all', ragTurns.length > 0, `${ragTurns.length} rag_turn lines`);
check('retrieval injected something', injected > 0, `${injected} of ${ragTurns.length} injected`);
check('retrieval ran during discovery', stages.has('discovery'), `stages: ${[...stages].join(', ') || 'none'}`);
check('retrieval ran during qualifying', stages.has('qualifying'), `stages: ${[...stages].join(', ') || 'none'}`);

// ── the two gates ──────────────────────────────────────────────────────────────────
check(
  'acknowledgement skipped (never yet seen on synthetic audio)',
  skipReasons.includes('acknowledgement'),
  `skip reasons: ${skipReasons.join(', ') || 'none'}`,
);
check(
  'phase gate closed during booking',
  skipReasons.includes('phase_gate'),
  `skip reasons: ${skipReasons.join(', ') || 'none'}`,
);
check(
  'booking-stall reopened retrieval at scheduling',
  stages.has('scheduling'),
  stages.has('scheduling') ? 'rag_turn seen at stage=scheduling' : 'no retrieval after booking started',
);

// ── progressive disclosure ─────────────────────────────────────────────────────────
check('Step 2 pack delivered', packHeadings.some((h) => h.startsWith('Step 2')), packHeadings.join(' | ') || 'none');
check(
  'Step 3 + Step 4 packs delivered',
  packHeadings.some((h) => h.startsWith('Step 3')) && packHeadings.some((h) => h.startsWith('Step 4')),
  packHeadings.join(' | ') || 'none',
);
check(
  'no pack delivered twice',
  packHeadings.length === new Set(packHeadings).size,
  `${packHeadings.length} delivered, ${new Set(packHeadings).size} unique`,
);

// ── the preemptive draft, which is why R2 was rewritten ────────────────────────────
check(
  'no preemptive draft discarded',
  discarded === 0,
  `${discarded} discarded of ${started} started`,
);
check(
  'speculative path won more often than not',
  ragTurns.length > 0 && speculative > ragTurns.length / 2,
  `${speculative} speculative of ${ragTurns.length}`,
);

// ── things that would show up as a caller complaint ────────────────────────────────
check('no tool gate failure', !log.includes('tools_disabled'), log.includes('tools_disabled') ? 'tools_disabled present' : 'tools enabled');
check('no injection failure', !log.includes('knowledge_inject_failed'), 'knowledge_inject_failed absent');
check('DID routed to a tenant', log.includes('"source":"did_lookup"') || log.includes('call_identity'), 'call_identity present');

const pass = checks.filter((c) => c.ok).length;
const width = Math.max(...checks.map((c) => c.what.length));

console.log('\n' + '─'.repeat(width + 34));
console.log(`RAG FULL CALL — ${pass}/${checks.length} checks passed`);
console.log('─'.repeat(width + 34));
for (const c of checks) {
  console.log(`${c.ok ? ' PASS ' : ' FAIL '} ${c.what.padEnd(width)}  ${c.detail}`);
}

console.log('\nMeasured, not asserted (no target to pass or fail against):');
console.log(`  retrieval turns      ${ragTurns.length}  (${injected} injected, ${speculative} speculative)`);
console.log(`  skips                ${skipped.length}  (${skipReasons.join(', ') || 'none'})`);
console.log(`  embedding ms         ${embedMs.length ? `min ${Math.min(...embedMs)} / median ${embedMs.sort((a, b) => a - b)[Math.floor(embedMs.length / 2)]} / max ${Math.max(...embedMs)}` : 'n/a'}`);
console.log(`  thinking fillers     ${fillers.length}  (each one is a turn that crossed the threshold)`);
console.log(`  preemptive drafts    ${started} started, ${discarded} discarded\n`);

// Non-zero exit so this can gate a commit later, as the scenario runner already does.
process.exit(pass === checks.length ? 0 : 1);
