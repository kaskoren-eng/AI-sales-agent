import { describe, expect, it } from 'vitest';
import { ACKNOWLEDGEMENTS_HE_WIDE } from '../prompts/acknowledgements.he.js';
import { THINKING_FILLERS_HE } from '../prompts/thinking-fillers.he.js';
import { FixedLineAudio, buildFixedLineAllowlist, normalizeLine } from './fixed-line-audio.js';

const VOICE = 'voice-prompt-1';
const pcm = (n: number): Buffer => Buffer.alloc(n, 1);

describe('buildFixedLineAllowlist', () => {
  it('carries every acknowledgement and every thinking filler', () => {
    const list = buildFixedLineAllowlist();
    for (const word of ACKNOWLEDGEMENTS_HE_WIDE) expect(list).toContain(word);
    for (const filler of THINKING_FILLERS_HE) expect(list).toContain(filler);
  });

  it('is short — every entry is a constant, and the list is the whole security argument', () => {
    // If this ever grows into the dozens, something that is not a fixed line has been added.
    expect(buildFixedLineAllowlist().length).toBeLessThan(30);
  });
});

describe('eligibility — what may be held as audio at all', () => {
  const cache = new FixedLineAudio(buildFixedLineAllowlist());

  it('accepts a screened acknowledgement', () => {
    expect(cache.keyFor(VOICE, 'בסדר.')).not.toBeNull();
  });

  it('REFUSES anything the model wrote', () => {
    expect(cache.keyFor(VOICE, 'אנחנו עוזרים לעסקים להביא יותר לידים.')).toBeNull();
  });

  it("REFUSES a caller's own details — the property that makes this safe, not merely fast", () => {
    expect(cache.keyFor(VOICE, 'עמית')).toBeNull();
    expect(cache.keyFor(VOICE, 'אפס חמש אפס, תשע שבע שמונה')).toBeNull();
    expect(cache.keyFor(VOICE, 'koren@gmail.com')).toBeNull();
  });

  it('refuses a long string even if it somehow reached the allowlist', () => {
    const long = new FixedLineAudio(['x'.repeat(200)]);
    expect(long.allowedCount).toBe(0);
    expect(long.keyFor(VOICE, 'x'.repeat(200))).toBeNull();
  });

  it('matches through niqqud, because the guard points the word on its way to the voice', () => {
    // `בסדר.` leaves the bank unpointed; PRONUNCIATION_FIXES can hand the vendor a pointed form.
    // An exact-string cache would miss on exactly the lines this exists for, and miss SILENTLY.
    expect(cache.keyFor(VOICE, 'בְּסֵדֶר.')).not.toBeNull();
  });

  it('keys the EXACT text, so two pointings are never served for each other', () => {
    const plain = cache.keyFor(VOICE, 'בסדר.');
    const pointed = cache.keyFor(VOICE, 'בְּסֵדֶר.');
    expect(plain).not.toBeNull();
    expect(pointed).not.toBeNull();
    // A listening round chose one of these sounds. Serving the other would undo it silently.
    expect(plain).not.toBe(pointed);
  });

  it('keys the voice too — one tenant must never hear another tenant’s voice', () => {
    expect(cache.keyFor('voice-a', 'בסדר.')).not.toBe(cache.keyFor('voice-b', 'בסדר.'));
  });
});

describe('storing and serving', () => {
  it('serves the same chunks back, in order', () => {
    const cache = new FixedLineAudio(['בסדר.']);
    const key = cache.keyFor(VOICE, 'בסדר.')!;
    const chunks = [pcm(4), pcm(8), pcm(2)];
    cache.put(key, chunks);
    expect(cache.get(key)).toEqual(chunks);
  });

  it('misses before anything is stored', () => {
    const cache = new FixedLineAudio(['בסדר.']);
    expect(cache.get(cache.keyFor(VOICE, 'בסדר.')!)).toBeUndefined();
  });

  it('REFUSES to store a silent generation', () => {
    // Both vendors answer an unusable request with a SILENT stream rather than an error. Caching
    // that would turn one silent turn into a word that is silent for the worker's whole life.
    const cache = new FixedLineAudio(['בסדר.']);
    const key = cache.keyFor(VOICE, 'בסדר.')!;
    cache.put(key, []);
    expect(cache.get(key)).toBeUndefined();
    cache.put(key, [Buffer.alloc(0)]);
    expect(cache.get(key)).toBeUndefined();
  });

  it('counts hits and misses so a cache that never fires is visible', () => {
    const cache = new FixedLineAudio(['בסדר.']);
    const key = cache.keyFor(VOICE, 'בסדר.')!;
    cache.get(key);
    cache.put(key, [pcm(4)]);
    cache.get(key);
    cache.get(key);
    expect(cache.stats).toMatchObject({ hits: 2, misses: 1, stored: 1, bytes: 4 });
  });

  it('is bounded, so a future allowlist mistake cannot grow without limit', () => {
    const many = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const cache = new FixedLineAudio(many);
    for (const line of many) {
      const key = cache.keyFor(VOICE, line);
      if (key) cache.put(key, [pcm(2)]);
    }
    expect(cache.stats.stored).toBeLessThanOrEqual(64);
  });
});

describe('normalizeLine', () => {
  it('strips niqqud and collapses whitespace, and changes nothing else', () => {
    expect(normalizeLine('בְּסֵדֶר.')).toBe('בסדר.');
    expect(normalizeLine('  אֶממ...  ')).toBe('אממ...');
    expect(normalizeLine('טוב, הבנתי.')).toBe('טוב, הבנתי.');
  });
});
