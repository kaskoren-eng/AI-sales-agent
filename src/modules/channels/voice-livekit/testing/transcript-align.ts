/**
 * Turns a transcript into "the greeting, then one reply per caller turn".
 *
 * NOT one transcript line per turn. A single reply routinely arrives as SEVERAL assistant lines —
 * a thinking filler ("אהה.") is committed separately from the sentence that follows it — and the
 * STT splits one caller utterance into several user lines ("התקציב שלי הוא." / "אה—"). Indexing
 * assistant lines directly puts turn 2's text under turn 1's audio, which is a caption that
 * contradicts the recording it sits on: the exact failure this whole page exists to avoid.
 *
 * So: collapse the transcript into runs of consecutive same-role lines, and pair each USER run with
 * the assistant run that immediately follows it. A turn the agent never answered gets `null` rather
 * than borrowing the next turn's words.
 */
export function alignTranscript(lines: Array<{ role: string; text: string }>): {
  greeting: string | null;
  replies: Array<string | null>;
} {
  const runs: Array<{ role: string; texts: string[] }> = [];
  for (const line of lines) {
    const last = runs[runs.length - 1];
    if (last && last.role === line.role) last.texts.push(line.text);
    else runs.push({ role: line.role, texts: [line.text] });
  }

  const join = (texts: string[]): string => texts.join(' ').trim();
  const greeting = runs[0]?.role === 'assistant' ? join(runs[0].texts) : null;

  const replies: Array<string | null> = [];
  for (const [i, run] of runs.entries()) {
    if (run.role !== 'user') continue;
    const next = runs[i + 1];
    replies.push(next && next.role === 'assistant' ? join(next.texts) : null);
  }
  return { greeting, replies };
}
