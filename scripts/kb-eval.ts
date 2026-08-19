/**
 * The R1 gate, as a runnable number.
 *
 *   npm run kb:eval -- --tenant <uuid>
 *
 * Twenty Hebrew questions phrased the way a caller actually says them — including the shapes Soniox
 * really produces on a phone line (no final punctuation, colloquial spelling, occasional missing
 * word). Each is labelled with the substring that MUST appear in a retrieved chunk for the answer to
 * be considered found.
 *
 * WHY SUBSTRING LABELS AND NOT CHUNK IDS: chunk ids change every time the chunker improves, which
 * would make this eval fail for the right reason and look like a regression. A distinctive phrase from
 * the expected content survives re-chunking, so the eval measures RETRIEVAL, not chunk stability.
 *
 * Reports top-1 and top-3 hit rate plus the latency split. The gate is >=80% top-3.
 */
import { loadEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/client.js';
import { EmbeddingService } from '../src/modules/knowledge/embedding.service.js';
import { RetrievalService } from '../src/modules/knowledge/retrieval.service.js';

interface EvalCase {
  /** The caller's utterance, as STT would hand it over. */
  q: string;
  /** A distinctive phrase that must appear in a retrieved chunk. */
  expect: string;
  /** What the caller is really asking — for the failure report. */
  about: string;
}

/**
 * STT-realistic phrasing notes: Soniox output for Hebrew phone audio typically arrives WITHOUT a
 * question mark, sometimes without the leading particle ("אפשר לדעת" rather than "האם אפשר לדעת"),
 * and occasionally with a colloquial contraction. Several cases below are written that way on purpose
 * — a KB that only answers well-formed written Hebrew is useless on a live line.
 */
const CASES: EvalCase[] = [
  { q: 'כמה זה עולה', expect: 'אלף ארבע מאות תשעים', about: 'price — bare, no question mark' },
  { q: 'מה המחיר של החבילה הזולה', expect: 'חבילת בסיס', about: 'cheapest package' },
  { q: 'יש דמי הקמה', expect: 'שלושת אלפים וחמש מאות', about: 'setup fee' },
  { q: 'מה קורה אם אני עובר את המכסה של הלידים', expect: 'לכל ליד נוסף', about: 'overage' },
  { q: 'כמה לידים כלול בחבילת צמיחה', expect: 'ארבע מאות לידים', about: 'growth quota' },
  { q: 'אני רוצה לצאת אחרי חודשיים אפשר', expect: 'שלושים יום', about: 'exit terms' },
  { q: 'יש תקופת ניסיון בחינם', expect: 'אין ניסיון חינם', about: 'free trial' },
  { q: 'כמה זמן לוקח להקים את זה', expect: 'חמישה ימי עסקים', about: 'time to live' },
  { q: 'מה אני צריך להביא לכם בשביל להתחיל', expect: 'שאלון אפיון', about: 'what the client provides' },
  { q: 'היא מדברת עברית', expect: 'עברית כברירת מחדל', about: 'language' },
  { q: 'היא עובדת גם בשבת', expect: 'סופי שבוע', about: 'availability' },
  { q: 'תוך כמה זמן היא מתקשרת לליד', expect: 'פחות מדקה', about: 'response speed' },
  { q: 'היא קובעת פגישות ביומן שלי', expect: 'ביומן', about: 'calendar booking' },
  { q: 'השיחות מוקלטות', expect: 'מוקלטת', about: 'recording' },
  { q: 'מה קורה עם ההקלטות אחרי זה', expect: 'תשעים יום', about: 'retention' },
  { q: 'הלקוחות שלי יבינו שזה רובוט', expect: 'מגלה שהיא סוכנת דיגיטלית', about: 'objection — robotic' },
  { q: 'אני מעדיף שבן אדם יחזור אליהם', expect: 'תוך דקה מול אדם אחרי שש שעות', about: 'objection — prefer human' },
  { q: 'זה יקר לי', expect: 'כמה שווה פגישה אחת', about: 'objection — expensive (a STATEMENT, not a question)' },
  { q: 'אני לא מאמין שAI יכול להחליף איש מכירות', expect: 'לא מחליפה את איש המכירות', about: 'objection — mindset' },
  { q: 'זה מסתנכרן למערכת שלי', expect: 'ניהול הלקוחות', about: 'CRM sync' },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Normalise for comparison: Hebrew final letters and niqqud are not at issue here, but whitespace is. */
function contains(haystack: string, needle: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return norm(haystack).includes(norm(needle));
}

const env = loadEnv();

async function main() {
  const tenantId = arg('tenant');
  if (!tenantId) {
    console.error('Usage: npm run kb:eval -- --tenant <uuid>');
    process.exit(1);
  }

  const { db, pool } = createDatabase(env.DATABASE_URL);
  try {
    // minScore 0 so the eval measures RANKING, not the threshold. The threshold is a separate,
    // tunable decision; conflating them hides which one is failing.
    const retrieval = new RetrievalService(db, new EmbeddingService(env));

    let top1 = 0;
    let top3 = 0;
    const embedMs: number[] = [];
    const totalMs: number[] = [];
    const failures: Array<{ c: EvalCase; got: string[] }> = [];

    for (const c of CASES) {
      const result = await retrieval.search(tenantId, c.q, { topK: 3, minScore: 0 });
      embedMs.push(result.timing.embedMs);
      totalMs.push(result.timing.totalMs);

      const hitAt = result.chunks.findIndex((chunk) => contains(chunk.content, c.expect));
      if (hitAt === 0) top1 += 1;
      if (hitAt >= 0) top3 += 1;
      else failures.push({ c, got: result.chunks.map((ch) => ch.content.slice(0, 70)) });

      const mark = hitAt === 0 ? '①' : hitAt > 0 ? `③(${hitAt + 1})` : '✗';
      console.log(`${mark}  ${c.q}   [${c.about}]`);
    }

    const p = (arr: number[], q: number) => {
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0;
    };

    const n = CASES.length;
    console.log(`\n${'='.repeat(72)}`);
    console.log(`top-1 hit rate: ${top1}/${n}  (${((top1 / n) * 100).toFixed(0)}%)`);
    console.log(`top-3 hit rate: ${top3}/${n}  (${((top3 / n) * 100).toFixed(0)}%)   ← R1 gate: >=80%`);
    console.log(`embed  p50 ${p(embedMs, 0.5)}ms  p95 ${p(embedMs, 0.95)}ms`);
    console.log(`total  p50 ${p(totalMs, 0.5)}ms  p95 ${p(totalMs, 0.95)}ms   ← budget reference: 150ms`);
    console.log(`${'='.repeat(72)}\n`);

    if (failures.length > 0) {
      console.log('MISSES — what came back instead:\n');
      for (const f of failures) {
        console.log(`  Q: ${f.c.q}`);
        console.log(`  expected to contain: ${f.c.expect}`);
        f.got.forEach((g, i) => console.log(`    ${i + 1}. ${g}…`));
        console.log('');
      }
    }

    process.exitCode = top3 / n >= 0.8 ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\n✗ eval failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
