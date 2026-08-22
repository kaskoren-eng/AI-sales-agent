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

const slots = events('rag_slot');
const skipped = events('rag_skipped');
const packs = events('playbook_delivered');
const resolved = events('rag_resolved');
const sizes = events('playbook_packs');
const fillers = events('thinking_filler');

const watermarks = events('context_watermark');
const contextSeries = slots.map((t) => Number(t.contextTokens)).filter((n) => Number.isFinite(n));
/** The context WITHOUT the slot — system prompt + packs + transcript. */
const baseSeries = slots.map((t) => Number(t.contextTokensBeforeSlot)).filter((n) => Number.isFinite(n));
/** The slot's entire footprint per turn. Under a rolling slot this is bounded; under R2 it compounded. */
const slotFootprint = slots
  .map((t) => Number(t.contextTokens) - Number(t.contextTokensBeforeSlot))
  .filter((n) => Number.isFinite(n));
const expired = slots.filter((t) => t.deadlineExpired === true).length;
const awaited = slots.map((t) => Number(t.awaitedMs)).filter((n) => Number.isFinite(n));
/** Slots answered from a lookup started for an earlier interim of the same utterance. */
const reused = slots.filter((t) => t.reusedPrefix === true).length;
/** How much of the utterance the best candidate prefix covered — the input to any threshold retune. */
const coverages = slots
  .map((t) => Number(t.bestPrefixCoverage))
  .filter((n) => Number.isFinite(n) && n > 0)
  .sort((a, b) => a - b);
const medianCoverage = coverages.length ? coverages[Math.floor(coverages.length / 2)]! : 0;
const skipReasons = skipped.map((s) => s.reason as string);
const packHeadings = packs.flatMap((p) => (p.headings as string[]) ?? []);
/**
 * Discarded preemptive drafts, split by CAUSE.
 *
 * A draft dies for two unrelated reasons and only one of them is ours. If the rolling slot ever touched
 * `agent.chatCtx`, the equivalence check would reject the draft — that is the regression this file
 * exists to catch. But a caller who barges in also invalidates the draft, legitimately, and LiveKit logs
 * both with the same warning.
 *
 * Counting them together made this check fail the 2026-08-22 acceptance call over a caller who
 * interrupted himself — a red line for healthy behaviour, which is how a verifier stops being read.
 */
const discardLines = log.split('\n');
let discarded = 0;
let discardedByBargeIn = 0;
for (let i = 0; i < discardLines.length; i += 1) {
  if (!discardLines[i]!.includes('preemptive generation enabled but chat context')) continue;
  const preceding = discardLines.slice(Math.max(0, i - 6), i).join('\n');
  if (preceding.includes('speech interrupted, new user turn detected')) discardedByBargeIn += 1;
  else discarded += 1;
}
const started = (log.match(/starting preemptive generation/g) ?? []).length;
const injected = slots.filter((t) => Number(t.chunks) > 0).length;
const embedMs = slots.map((t) => Number(t.embedMs)).filter((n) => Number.isFinite(n));

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
check('retrieval ran at all', slots.length > 0, `${slots.length} rag_slot lines`);
check('retrieval filled a slot', injected > 0, `${injected} of ${slots.length} slots had chunks`);

// ── R2.1: the context diet ─────────────────────────────────────────────────────────────
// The whole point. Injection overhead must be FLAT, so context growth across the call is the
// transcript growing — not the transcript PLUS an ever-larger pile of knowledge blocks.
/**
 * THE R2.1 ACCEPTANCE TEST, stated as the property rather than as a number.
 *
 * A first version of this check compared total context growth against a guessed 250 tokens/turn and
 * failed a run that was working perfectly — because total growth is dominated by the TRANSCRIPT, which
 * is supposed to grow. The number said "fail" while the mechanism said "fine".
 *
 * The property that actually distinguishes R2.1 from R2 is that the slot's footprint is BOUNDED. Under
 * R2 every injection stayed forever, so footprint rose without limit; under a rolling slot it can never
 * exceed one turn's budget, whatever else the call does.
 */
const maxFootprint = slotFootprint.length ? Math.max(...slotFootprint) : 0;
const budgetCeiling = 1000 + 40; // budget + the marker line's own tokens
check(
  'knowledge footprint is flat, not cumulative',
  slotFootprint.length === 0 || maxFootprint <= budgetCeiling,
  slotFootprint.length
    ? `max slot footprint ${maxFootprint} tokens (ceiling ${budgetCeiling}); base context ${baseSeries[0]} -> ${baseSeries[baseSeries.length - 1]}`
    : 'no slots to judge',
);
check('no context watermark tripped', watermarks.length === 0, `${watermarks.length} watermark lines`);
check(
  'slot deadline rarely expires',
  slots.length === 0 || expired / slots.length <= 0.03,
  `${expired} of ${slots.length} expired (${slots.length ? Math.round((expired / slots.length) * 100) : 0}%) — revisit above 3%`,
);

/**
 * THE 2026-08-22 REGRESSION, as a standing check.
 *
 * `prefetch` warms the cache on interim transcripts; `resolve` asks for the longer preflight text. Keyed
 * on exact text those never matched, so every real turn discarded a warm lookup and paid a cold one —
 * median wait 239ms, 12.5% of slots expiring, and one expiry landing on the pricing question.
 *
 * Waits are asserted rather than merely measured because this failure is SILENT: retrieval still works,
 * the call still completes, and only the latency and the occasional un-grounded answer show it. The
 * threshold is deliberately above a warm-cache wait (~0ms) and below a cold embedding (~200ms).
 */
const firstPass = awaited.filter((ms) => ms > 0);
const medianWait = firstPass.length
  ? [...firstPass].sort((a, b) => a - b)[Math.floor(firstPass.length / 2)]!
  : 0;
check(
  'the warm prefetch is actually used (not orphaned by a key mismatch)',
  slots.length === 0 || reused / slots.length >= 0.5 || medianWait < 120,
  `${reused} of ${slots.length} slots reused a prefix; median non-zero wait ${medianWait}ms` +
    (coverages.length ? `; best available coverage median ${medianCoverage.toFixed(2)}` : ''),
);

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
  'contact-data turns were skipped, not embedded',
  skipReasons.includes('contact_data') || skipReasons.includes('answering_agent') || !skipReasons.length,
  `skip reasons: ${skipReasons.join(', ') || 'none'}`,
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
  'no preemptive draft discarded by injection (barge-in discards are the caller, not us)',
  discarded === 0,
  `${discarded} discarded by context change, ${discardedByBargeIn} by barge-in, of ${started} started`,
);

// ── things that would show up as a caller complaint ────────────────────────────────
check('no tool gate failure', !log.includes('tools_disabled'), log.includes('tools_disabled') ? 'tools_disabled present' : 'tools enabled');
check('no injection failure', !log.includes('knowledge_inject_failed'), 'knowledge_inject_failed absent');
check('DID routed to a tenant', log.includes('"source":"did_lookup"') || log.includes('call_identity'), 'call_identity present');

/**
 * A log with two sessions in it silently doubles every count and blends two different calls into one
 * verdict. That is not hypothetical: on 2026-08-22 a real inbound call landed on the same worker
 * while this scenario was running, and the first run of this script reported 76 retrievals and six
 * pack deliveries for a 21-turn scenario. Refuse to report rather than report something false.
 */
const sessionCount = (log.match(/received job request/g) ?? []).length;
if (sessionCount > 1) {
  console.error(
    [
      '',
      `REFUSING TO VERIFY: ${sessionCount} sessions in this log.`,
      'Every count below would be a blend of separate calls. Restart the worker with a fresh log',
      'file, re-run the scenario, and keep other calls off this worker while it runs.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

const pass = checks.filter((c) => c.ok).length;
const width = Math.max(...checks.map((c) => c.what.length));

console.log('\n' + '─'.repeat(width + 34));
console.log(`RAG FULL CALL — ${pass}/${checks.length} checks passed`);
console.log('─'.repeat(width + 34));
for (const c of checks) {
  console.log(`${c.ok ? ' PASS ' : ' FAIL '} ${c.what.padEnd(width)}  ${c.detail}`);
}

console.log('\nMeasured, not asserted (no target to pass or fail against):');
console.log(`  knowledge slots      ${slots.length}  (${injected} with chunks, ${expired} deadline-expired)`);
console.log(`  slot wait ms         ${awaited.length ? `median ${[...awaited].sort((a, b) => a - b)[Math.floor(awaited.length / 2)]} / max ${Math.max(...awaited)}` : 'n/a'}`);
console.log(`  prefix reuse         ${reused} of ${slots.length} slots; best-available coverage median ${medianCoverage.toFixed(2)}`);
console.log(`  context tokens       ${contextSeries.length ? `${contextSeries[0]} -> ${contextSeries[contextSeries.length - 1]} across ${contextSeries.length} turns` : 'n/a'}`);
console.log(`  context w/o slot     ${baseSeries.length ? `${baseSeries[0]} -> ${baseSeries[baseSeries.length - 1]}` : 'n/a'}`);
console.log(`  slot footprint       ${slotFootprint.length ? `min ${Math.min(...slotFootprint)} / max ${Math.max(...slotFootprint)} tokens` : 'n/a'}`);
console.log(`  skips                ${skipped.length}  (${skipReasons.join(', ') || 'none'})`);
console.log(`  embedding ms         ${embedMs.length ? `min ${Math.min(...embedMs)} / median ${embedMs.sort((a, b) => a - b)[Math.floor(embedMs.length / 2)]} / max ${Math.max(...embedMs)}` : 'n/a'}`);
console.log(`  thinking fillers     ${fillers.length}  (each one is a turn that crossed the threshold)`);
console.log(`  preemptive drafts    ${started} started, ${discarded} discarded\n`);

// Non-zero exit so this can gate a commit later, as the scenario runner already does.
process.exit(pass === checks.length ? 0 : 1);
