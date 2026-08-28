#!/usr/bin/env node
/**
 * repeatedPhraseCount BASELINE over an existing call-reports/ corpus.
 *
 * The metric shipped 2026-08-27 (CallReport.summary.repeatedPhraseCount — distinct 4-grams the
 * agent spoke 2+ times per call, the anti-repetition ledger's gate). Old reports predate it, so
 * this recomputes the same number over their transcripts to give the before-picture the
 * humanization plan measured informally (up to 62/call).
 *
 *   node scripts/repeated-phrases-baseline.mjs [dir]     # default: call-reports
 *
 * The counting logic MIRRORS countRepeatedFourGrams in
 * src/modules/channels/voice-livekit/phrase-ledger.ts (an .mjs script cannot import the TS
 * source). If the tokenizer there changes, change it here too — the whole point is that the
 * baseline and the live metric are the same currency.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const NIQQUD = /[֑-ׇ]/gu;
const PUNCT = /[.,!?…׃:;()"'«»״׳-]+/gu;

const tokens = (text) => text.replace(NIQQUD, '').replace(PUNCT, ' ').split(/\s+/u).filter(Boolean);

function countRepeatedFourGrams(lines) {
  const counts = new Map();
  for (const line of lines) {
    const t = tokens(line);
    for (let i = 0; i + 4 <= t.length; i++) {
      const g = t.slice(i, i + 4).join(' ');
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
  }
  let repeated = 0;
  for (const n of counts.values()) if (n >= 2) repeated++;
  return repeated;
}

const dir = process.argv[2] ?? 'call-reports';
const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();

const rows = [];
for (const f of files) {
  try {
    const report = JSON.parse(await readFile(join(dir, f), 'utf8'));
    const agentLines = (report.transcript ?? [])
      .filter((t) => t.role === 'assistant')
      .map((t) => t.text);
    if (agentLines.length === 0) continue; // aborted/empty calls say nothing about phrasing
    rows.push({
      file: f.replace(/\.json$/u, ''),
      agentLines: agentLines.length,
      repeated4grams: countRepeatedFourGrams(agentLines),
      duplicateReplies: report.summary?.duplicateReplies ?? '-',
    });
  } catch {
    // A malformed report is not part of the baseline.
  }
}

if (rows.length === 0) {
  console.error(`No usable reports in ${dir}/`);
  process.exit(1);
}

console.log('| call | agent lines | repeated 4-grams | duplicateReplies |');
console.log('|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.file} | ${r.agentLines} | ${r.repeated4grams} | ${r.duplicateReplies} |`);
}

const counts = rows.map((r) => r.repeated4grams).sort((a, b) => a - b);
const median = counts[Math.floor(counts.length / 2)];
const max = counts[counts.length - 1];
const over2 = counts.filter((n) => n > 2).length;
console.log('');
console.log(
  `calls=${rows.length} median=${median} max=${max} calls_over_gate(>2)=${over2}  (gate: ≤2 per call)`,
);
