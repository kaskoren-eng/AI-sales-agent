import { countTokens } from './tokens.js';

/**
 * Text → clean, retrievable chunks. Pure and synchronous, so it unit-tests without a DB or a network.
 *
 * WHY CLEANING IS NOT POLISH: a chunk that carries a page footer or a markdown table pipe costs twice
 * — once in latency (the LLM chews the filler on a live call, mid-conversation) and once in accuracy
 * (the noise dilutes the embedding, so the chunk ranks for the wrong questions). Garbage in, garbage
 * out is the whole ballgame here.
 *
 * WHY SENTENCE BOUNDARIES, NOT A CHARACTER WINDOW: a chunk cut mid-sentence is a fact cut in half.
 * "המחיר הוא 2,000 שקל" split after "המחיר הוא" retrieves as a price chunk and answers with nothing.
 * Hebrew makes this worse than English — no capitalisation to recover the boundary from.
 */

/** Target size per chunk. Small enough that 3 chunks are a cheap addition to a turn, large enough to
 * hold a complete answer (a price + its condition, a policy + its exception). */
const TARGET_TOKENS = 250;
/** Hard ceiling — a single sentence longer than this is emitted alone rather than silently dropped. */
const MAX_TOKENS = 400;
/** Sentences of trailing overlap carried into the next chunk, so a fact that straddles a boundary is
 * retrievable from both sides. One sentence is enough; more just duplicates tokens. */
const OVERLAP_SENTENCES = 1;

export interface Chunk {
  content: string;
  chunkIndex: number;
  tokenCount: number;
}

/** Shared with the voice hot path — see `tokens.ts` for why there is exactly one of these. */
const tokens = countTokens;

/**
 * Strip the furniture that survives copy-paste and markdown export but means nothing to a caller's
 * question: page numbers, running headers/footers, horizontal rules, markdown syntax, bare URLs,
 * table pipes, list bullets.
 *
 * Deliberately conservative — it removes *decoration*, never content. When in doubt the text stays:
 * a stray asterisk costs one token, a deleted price costs a booking.
 */
export function cleanText(raw: string): string {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    // Zero-width and BOM characters — invisible, and they split words inside the tokenizer.
    .replace(/[​-‍﻿]/g, '')
    .split('\n');

  const cleaned: string[] = [];
  for (const line of lines) {
    let l = line.trim();
    if (!l) {
      // Keep ONE blank line as a paragraph signal; collapse runs.
      if (cleaned.length > 0 && cleaned[cleaned.length - 1] !== '') cleaned.push('');
      continue;
    }
    // Standalone page numbers: "12", "- 12 -", "Page 12", "עמוד 12".
    if (/^[-–—\s]*(?:page|עמוד)?\s*\d{1,4}\s*(?:\/\s*\d{1,4})?[-–—\s]*$/i.test(l)) continue;
    // Horizontal rules / decorative separators.
    if (/^[-=_*·•~—–]{3,}$/.test(l)) continue;
    // Markdown table alignment rows: |---|:--:|
    if (/^\|?[\s:|-]{5,}\|?$/.test(l) && l.includes('-')) continue;

    // Markdown heading markers — the heading TEXT is valuable context, the #s are not. The `|$` arm
    // matters: an empty heading ("## " with nothing after it) must reduce to nothing and be dropped,
    // not survive as a bare "##" chunk. Anchored to require whitespace-or-end so "#hashtag" is left
    // alone.
    l = l.replace(/^#{1,6}(?:\s+|$)/, '');
    // Blockquote and list markers.
    l = l.replace(/^>\s?/, '').replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '');
    // Table pipes → sentence-ish separators, so a row reads as text rather than as syntax.
    if (l.includes('|')) {
      l = l.replace(/\s*\|\s*/g, ' · ').replace(/^ ·\s*/, '').replace(/\s*· $/, '').trim();
    }
    // Emphasis / inline code markers, keeping the words.
    l = l.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/`([^`]+)`/g, '$1');
    // Markdown links → their label. The URL is noise to a phone conversation.
    l = l.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    // Bare URLs and raw image tags.
    l = l.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/https?:\/\/\S+/g, '').replace(/\bwww\.\S+/g, '');
    l = l.replace(/[ \t]{2,}/g, ' ').trim();

    if (l) cleaned.push(l);
  }

  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Split cleaned text into sentences.
 *
 * Hebrew punctuation is the same `.!?` set as English, plus the maqaf/geresh which are intra-word.
 * A newline also ends a sentence here: KB documents are full of headings and one-line facts that
 * carry no terminal punctuation at all, and gluing those to the next line produces nonsense.
 *
 * Guard against the classic false split: a decimal or a thousands separator ("2,000.50", "ג.ג.")
 * must not end a sentence, so a period is only terminal when followed by whitespace/end AND not
 * sitting between two digits.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\n+/)) {
    const line = block.trim();
    if (!line) continue;
    // Split after . ! ? … followed by whitespace, unless the period is between digits.
    const parts = line.split(/(?<=(?<!\d)[.!?…])\s+(?=\S)/);
    for (const p of parts) {
      const s = p.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

export interface Section {
  /** The markdown heading this section sits under, with its `#` markers stripped. Null for text that
   * appears before any heading. */
  heading: string | null;
  body: string;
}

/**
 * Split a markdown document at its headings, BEFORE cleaning (cleaning removes the `#` markers, so
 * the boundaries have to be read while they still exist).
 *
 * WHY SECTIONS ARE HARD BOUNDARIES: measured on the real ClickScales KB. Packing purely by token
 * budget produced chunks that straddled two unrelated sections and chunks that began mid-section with
 * no heading — and those headless fragments then ranked in the top 3 for almost every question while
 * answering none of them. The clearest case: the "expensive" objection split, and the half starting
 * "המנוי מחזיר את עצמו" carried no signal that it was about price at all. A KB document's headings ARE
 * its semantic boundaries; crossing them manufactures exactly the irrelevant-context problem RAG is
 * here to remove.
 */
export function splitSections(raw: string): Section[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const sections: Section[] = [];
  let heading: string | null = null;
  let body: string[] = [];

  const flush = () => {
    const text = body.join('\n').trim();
    if (text || heading) sections.push({ heading, body: text });
    body = [];
  };

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[2]!.trim();
    } else {
      body.push(line);
    }
  }
  flush();

  return sections.filter((s) => s.body.length > 0 || (s.heading?.length ?? 0) > 0);
}

/**
 * Pack sentences into ~TARGET_TOKENS chunks, never splitting a sentence, never crossing a section
 * boundary, and carrying OVERLAP_SENTENCES of context across each within-section boundary.
 *
 * Every chunk is PREFIXED with its section heading. That prefix costs a handful of tokens and buys two
 * things: a long section's later chunks still say what they are about, and the heading's words join the
 * embedding, so "כמה זמן לוקח להקים" matches a chunk headed "תהליך ההקמה" on topic rather than on
 * incidental vocabulary.
 *
 * A sentence longer than MAX_TOKENS on its own becomes its own chunk — oversized but intact. The
 * alternative (hard-cutting it) is the mid-sentence break this function exists to prevent.
 */
export function chunkText(raw: string): Chunk[] {
  const chunks: Chunk[] = [];

  for (const section of splitSections(raw)) {
    const cleaned = cleanText(section.body);
    const heading = section.heading ? cleanText(section.heading) : null;

    // A heading with no body is a document title or an empty section: it carries no fact to retrieve,
    // and as a chunk of its own it would match broadly and answer nothing.
    if (!cleaned) continue;

    const sentences = splitSentences(cleaned);
    if (sentences.length === 0) continue;

    let current: string[] = [];
    let currentTokens = 0;

    const emit = () => {
      if (current.length === 0) return;
      const body = current.join(' ').trim();
      if (!body) return;
      const content = heading ? `${heading}\n${body}` : body;
      chunks.push({ content, chunkIndex: chunks.length, tokenCount: tokens(content) });
    };

    for (const sentence of sentences) {
      const t = tokens(sentence);

      if (t > MAX_TOKENS) {
        emit();
        const content = heading ? `${heading}\n${sentence}` : sentence;
        chunks.push({ content, chunkIndex: chunks.length, tokenCount: tokens(content) });
        current = [];
        currentTokens = 0;
        continue;
      }

      if (currentTokens + t > TARGET_TOKENS && current.length > 0) {
        emit();
        const overlap = current.slice(-OVERLAP_SENTENCES);
        current = [...overlap];
        currentTokens = overlap.reduce((sum, s) => sum + tokens(s), 0);
      }

      current.push(sentence);
      currentTokens += t;
    }
    emit();
  }

  return chunks;
}
