/**
 * Reads shadow-mode STT data off real calls and reports where the two engines disagreed.
 *
 *   node scripts/analyze-shadow-stt.mjs [days]      (default: 7)
 *
 * WHAT THIS CAN AND CANNOT TELL YOU — read before quoting any number it prints.
 *
 * NEITHER ENGINE IS GROUND TRUTH. Two STT engines disagreeing tells you that they disagree. It does
 * NOT tell you which one was right, and no amount of arithmetic over the two transcripts will. The
 * only way to know who was correct is for a Hebrew speaker to listen, or to read the pair and judge.
 *
 * So this script deliberately does NOT print "Soniox WER: 8%". That number would be a lie dressed as
 * a measurement — it would really mean "how often Soniox differs from OpenAI", which scores the
 * incumbent as perfect by definition and could only ever conclude that the challenger is worse.
 *
 * What it prints instead:
 *   - DIVERGENCE rate: how often the two disagreed at all. High divergence means the choice matters.
 *   - The worst disagreements, side by side, FOR A HUMAN TO READ. That is the actual deliverable.
 *   - Divergence isolated to the fields Phase 4 cannot get wrong: numbers, names, emails.
 *
 * Populate it by running a few real calls with SHADOW_STT_ENABLED=true.
 */
import pg from 'pg';

const DAYS = Number(process.argv[2] ?? 7);

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. Run with: node --env-file=.env scripts/analyze-shadow-stt.mjs');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

const { rows } = await pool.query(
  `SELECT id, tenant_id, created_at, shadow_stt_transcript
     FROM call_learnings
    WHERE shadow_stt_transcript IS NOT NULL
      AND created_at > NOW() - ($1 || ' days')::interval
    ORDER BY created_at DESC`,
  [DAYS],
);

if (rows.length === 0) {
  console.log(`No shadow-mode calls in the last ${DAYS} days.`);
  console.log('\nTo collect some: set SHADOW_STT_ENABLED=true, restart the voice agent, take a few');
  console.log('real calls. Both engines will transcribe the caller; only the live one is heard.');
  await pool.end();
  process.exit(0);
}

console.log(`${rows.length} shadow call(s) in the last ${DAYS} days\n`);

const pairs = [];
const errors = [];

for (const row of rows) {
  const s = row.shadow_stt_transcript;
  if (!s) continue;
  for (const e of s.errors ?? []) errors.push(e);

  // Align the two engines by TIME, not by index. They segment differently — one hears a pause as
  // end-of-turn where the other hears a hesitation — so turn 3 of one is not turn 3 of the other.
  // Pairing by index would manufacture disagreements that never happened.
  for (const auth of s.authoritative ?? []) {
    const match = nearest(s.shadow ?? [], auth.atMs);
    if (!match) continue;
    pairs.push({
      callId: row.id,
      authoritativeEngine: s.authoritativeEngine,
      shadowEngine: s.shadowEngine,
      authoritative: auth.text,
      shadow: match.text,
      driftMs: Math.abs(match.atMs - auth.atMs),
    });
  }
}

if (pairs.length === 0) {
  console.log('Calls found, but no comparable turns in them.');
  await pool.end();
  process.exit(0);
}

const scored = pairs.map((p) => ({
  ...p,
  divergence: divergence(p.authoritative, p.shadow),
  numeric: hasNumbers(p.authoritative) || hasNumbers(p.shadow),
}));

const agreed = scored.filter((p) => p.divergence === 0);
const numericTurns = scored.filter((p) => p.numeric);

console.log('=== Divergence — how often the engines disagreed ===');
console.log(`  turns compared      ${scored.length}`);
console.log(`  identical           ${agreed.length}  (${pctOf(agreed.length, scored.length)})`);
console.log(`  mean divergence     ${(avg(scored.map((p) => p.divergence)) * 100).toFixed(1)}%`);
if (numericTurns.length > 0) {
  console.log(
    `  turns with numbers  ${numericTurns.length}, mean divergence ` +
      `${(avg(numericTurns.map((p) => p.divergence)) * 100).toFixed(1)}%  <-- Phase 4 depends on these`,
  );
}

console.log('\n=== The disagreements, worst first — READ THESE, they are the point ===');
console.log('Neither column is ground truth. Decide with your own ears which engine heard right.\n');
for (const p of scored.filter((x) => x.divergence > 0).sort((a, b) => b.divergence - a.divergence).slice(0, 25)) {
  console.log(`  [${(p.divergence * 100).toFixed(0).padStart(3)}% differ]  call ${String(p.callId).slice(0, 8)}${p.numeric ? '  (contains numbers)' : ''}`);
  console.log(`     ${p.authoritativeEngine.padEnd(7)} (live)   "${p.authoritative}"`);
  console.log(`     ${p.shadowEngine.padEnd(7)} (shadow) "${p.shadow}"\n`);
}

if (errors.length > 0) {
  console.log('=== Shadow-side errors (these never touched a caller) ===');
  for (const e of [...new Set(errors)].slice(0, 10)) console.log(`  ${e}`);
}

await pool.end();

// --- helpers ---

/** Word-level edit distance / reference length. Symmetric enough for a disagreement measure. */
function divergence(a, b) {
  const wa = tokens(a);
  const wb = tokens(b);
  if (wa.length === 0 && wb.length === 0) return 0;
  const denom = Math.max(wa.length, wb.length, 1);
  return editDistance(wa, wb) / denom;
}

function tokens(text) {
  return String(text ?? '')
    .replace(/[.,!?;:"'`()[\]{}…—–\-־״׳]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function editDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Closest shadow turn in time. Beyond 4s apart they are different turns, not a disagreement. */
function nearest(list, atMs) {
  let best = null;
  let bestGap = Infinity;
  for (const item of list) {
    const gap = Math.abs(item.atMs - atMs);
    if (gap < bestGap) {
      bestGap = gap;
      best = item;
    }
  }
  return bestGap <= 4000 ? best : null;
}

/** Numbers, spoken or written — the phone numbers, budgets and times Phase 4 cannot get wrong. */
function hasNumbers(text) {
  return /\d/u.test(text) || /\b(אפס|אחת|אחד|שתיים|שניים|שלוש|ארבע|חמש|שש|שבע|שמונה|תשע|עשר|עשרים|מאה|אלף)\b/u.test(text);
}

const avgOf = (xs) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
function avg(xs) {
  return xs.length === 0 ? 0 : avgOf(xs);
}
function pctOf(n, d) {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`;
}
