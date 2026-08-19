import { describe, it, expect } from 'vitest';
import { cleanText, splitSentences, chunkText, splitSections } from './chunker.js';

describe('cleanText — removes decoration, never content', () => {
  it('strips markdown headings but keeps the heading text', () => {
    expect(cleanText('## מודל תמחור')).toBe('מודל תמחור');
  });

  it('strips list and quote markers', () => {
    expect(cleanText('- שיחה תוך דקה\n* בעברית\n1. גם בשבת\n> ציטוט')).toBe(
      'שיחה תוך דקה\nבעברית\nגם בשבת\nציטוט',
    );
  });

  it('drops standalone page numbers in both languages', () => {
    expect(cleanText('תוכן\n- 12 -\nPage 3\nעמוד 4\nעוד תוכן')).toBe('תוכן\nעוד תוכן');
  });

  it('drops horizontal rules and markdown table separators', () => {
    expect(cleanText('לפני\n---\n|---|:--:|\nאחרי')).toBe('לפני\nאחרי');
  });

  it('turns table rows into readable text rather than syntax', () => {
    expect(cleanText('| בסיס | 1,490 ₪ | 150 לידים |')).toBe('בסיס · 1,490 ₪ · 150 לידים');
  });

  it('keeps link labels and discards URLs', () => {
    expect(cleanText('ראה [המחירון](https://example.com/pricing) שלנו')).toBe('ראה המחירון שלנו');
    expect(cleanText('פרטים באתר https://clickscales.com עוד')).toBe('פרטים באתר עוד');
  });

  it('unwraps emphasis and inline code without losing the words', () => {
    expect(cleanText('**חשוב** ו-*גם* ו-`קוד`')).toBe('חשוב ו-גם ו-קוד');
  });

  it('collapses runs of blank lines to a single paragraph break', () => {
    expect(cleanText('א\n\n\n\nב')).toBe('א\n\nב');
  });

  it('never drops a price or a number that is part of a sentence', () => {
    const out = cleanText('המנוי החודשי הוא 1,490 ₪ לחודש.');
    expect(out).toContain('1,490');
    expect(out).toContain('₪');
  });
});

describe('splitSentences — Hebrew boundaries', () => {
  it('splits on terminal punctuation', () => {
    expect(splitSentences('שלום. מה קורה? בסדר!')).toEqual(['שלום.', 'מה קורה?', 'בסדר!']);
  });

  it('treats a newline as a boundary — KB headings carry no punctuation', () => {
    expect(splitSentences('מחירים\nחבילת בסיס')).toEqual(['מחירים', 'חבילת בסיס']);
  });

  it('does NOT split inside a decimal or thousands separator', () => {
    expect(splitSentences('המחיר 2,000.50 שקלים כולל הכל.')).toEqual(['המחיר 2,000.50 שקלים כולל הכל.']);
  });
});

describe('chunkText', () => {
  it('returns nothing for empty or decoration-only input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('---\n\n## \n')).toEqual([]);
  });

  it('keeps a short document as a single chunk', () => {
    const chunks = chunkText('הסוכנת מדברת עברית. היא עובדת גם בשבת.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe('הסוכנת מדברת עברית. היא עובדת גם בשבת.');
    expect(chunks[0]!.tokenCount).toBeGreaterThan(0);
  });

  it('never splits mid-sentence — every chunk ends where a sentence ends', () => {
    // 60 distinct sentences comfortably exceeds one chunk's budget.
    const sentences = Array.from({ length: 60 }, (_, i) => `זו משפט מספר ${i} עם מספיק מילים כדי לתפוס מקום אמיתי בטוקנים.`);
    const chunks = chunkText(sentences.join(' '));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content).toMatch(/[.!?]$/);
    }
  });

  it('numbers chunks contiguously from zero', () => {
    const sentences = Array.from({ length: 60 }, (_, i) => `משפט ${i} עם מספיק מילים כדי לתפוס מקום אמיתי בטוקנים כאן.`);
    const chunks = chunkText(sentences.join(' '));
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  it('carries one sentence of overlap so a straddling fact is retrievable from both sides', () => {
    const sentences = Array.from({ length: 60 }, (_, i) => `שורה ${i} ובה די מילים כדי למלא את התקציב של המקטע הזה בהחלט.`);
    const chunks = chunkText(sentences.join(' '));
    const firstLast = splitSentences(chunks[0]!.content).at(-1)!;
    expect(chunks[1]!.content.startsWith(firstLast)).toBe(true);
  });

  it('emits an oversized single sentence intact rather than cutting it', () => {
    const monster = `${'מילה '.repeat(900)}סוף.`;
    const chunks = chunkText(monster);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain('סוף.');
    expect(chunks[0]!.tokenCount).toBeGreaterThan(400);
  });
});

describe('splitSections — headings are hard boundaries', () => {
  it('splits at each heading and keeps the heading text', () => {
    const doc = ['# כותרת', 'גוף ראשון', '## שנייה', 'גוף שני'].join('\n');
    expect(splitSections(doc)).toEqual([
      { heading: 'כותרת', body: 'גוף ראשון' },
      { heading: 'שנייה', body: 'גוף שני' },
    ]);
  });

  it('keeps pre-heading text as a null-heading section', () => {
    const doc = ['הקדמה בלי כותרת', '## אחר כך', 'גוף'].join('\n');
    expect(splitSections(doc)[0]).toEqual({ heading: null, body: 'הקדמה בלי כותרת' });
  });
});

describe('chunkText — section semantics', () => {
  // The shape that exposed the original bug on the real ClickScales KB: two adjacent sections whose
  // bodies are individually small enough that a pure token budget packs them together.
  const doc = [
    '## תהליך ההקמה',
    'ההקמה נמשכת חמישה ימי עסקים. ביום הראשון יש שאלון אפיון.',
    '',
    '## התנגדות — זה יקר',
    'השאלה היא כמה שווה פגישה אחת. המנוי מחזיר את עצמו כשמספר הפגישות מכסה אותו.',
  ].join('\n');

  it('never merges two sections into one chunk', () => {
    const chunks = chunkText(doc);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.content).toContain('חמישה ימי עסקים');
    expect(chunks[0]!.content).not.toContain('פגישה אחת');
  });

  it('prefixes every chunk with its heading, so a chunk always states its topic', () => {
    const chunks = chunkText(doc);
    expect(chunks[0]!.content.startsWith('תהליך ההקמה\n')).toBe(true);
    expect(chunks[1]!.content.startsWith('התנגדות — זה יקר\n')).toBe(true);
  });

  it('carries the heading onto EVERY chunk of a section that had to split', () => {
    // The regression that actually mattered: the second half of a long section used to lose its topic
    // entirely, then rank in the top 3 for unrelated questions.
    const long = Array.from(
      { length: 60 },
      (_, i) => `משפט ${i} ובו די מילים כדי למלא את תקציב המקטע הזה.`,
    ).join(' ');
    const chunks = chunkText(['## מחירים', long].join('\n'));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.startsWith('מחירים\n')).toBe(true);
    }
  });

  it('drops a heading that has no body — it answers nothing and matches broadly', () => {
    expect(chunkText('## כותרת בלי גוף\n')).toEqual([]);
  });
});
