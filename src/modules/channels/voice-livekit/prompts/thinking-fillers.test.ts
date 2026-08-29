import { describe, expect, it } from 'vitest';
import {
  FILLER_COOLDOWN_MS,
  MAX_FILLERS_PER_CALL,
  THINKING_FILLERS_HE,
  ThinkingFillerLedger,
  pickThinkingFiller,
} from './thinking-fillers.he.js';

describe('thinking fillers', () => {
  it('never repeats a filler ALREADY USED ON THIS CALL, not merely the last one', () => {
    // The rule used to be "not twice in a row" and the 2026-08-29 call showed why that is too weak:
    // three fillers inside 194 seconds, and the caller heard the same word most of the time. Within
    // one short call any repeat is heard as a tic.
    for (let i = 0; i < 200; i++) {
      const used: string[] = [];
      for (let n = 0; n < MAX_FILLERS_PER_CALL; n++) {
        const next = pickThinkingFiller(used);
        expect(used).not.toContain(next);
        used.push(next);
      }
    }
  });

  it('there are always more fillers than a call is allowed to spend', () => {
    // This is what makes the no-repeat rule reachable rather than aspirational.
    expect(THINKING_FILLERS_HE.length).toBeGreaterThan(MAX_FILLERS_PER_CALL);
  });

  it('always returns something (never undefined) on the first turn', () => {
    expect(THINKING_FILLERS_HE).toContain(pickThinkingFiller([]));
  });

  it('still returns a word if every filler has somehow been used — never the last one again', () => {
    const used = [...THINKING_FILLERS_HE];
    const last = used[used.length - 1]!;
    for (let i = 0; i < 30; i++) expect(pickThinkingFiller(used)).not.toBe(last);
  });

  it('is a NOISE, not a sentence — no promises she might not keep', () => {
    // Koren asked for "not the full sentence, just the noise that people do when they think".
    // A filler that says "I'll check that for you" is a REPLY, and it commits her to something.
    for (const f of THINKING_FILLERS_HE) {
      const words = f.replace(/\.{2,}/gu, '').trim().split(/\s+/u);
      expect(words.length).toBeLessThanOrEqual(4);
      expect(f).not.toMatch(/\?/u); // a question is a turn hand-back, not a hesitation
    }
  });

  it('is short — the real answer queues BEHIND the filler, so a long one lengthens the wait', () => {
    for (const f of THINKING_FILLERS_HE) {
      expect(f.length).toBeLessThanOrEqual(22);
    }
  });

  it('is Hebrew that Israelis actually say, not translated English', () => {
    // "ובכן" would be correct Hebrew and would sound like a newsreader. These are speech.
    expect(THINKING_FILLERS_HE).toContain('אממ...');
    expect(THINKING_FILLERS_HE).toContain('רגע...');
    for (const f of THINKING_FILLERS_HE) {
      expect(f).toMatch(/[֐-׿]/u);
    }
  });
});

describe('ThinkingFillerLedger — one budget, two spenders', () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('an OFFER costs nothing — only a commit spends the budget', () => {
    // The whole reason the ledger exists. A filler is armed long before we know whether it will be
    // spoken: on an inference step whose only output is a tool call there is no reply to glue it to
    // and withFiller drops it. Counting at arm time burned the call's three fillers on words nobody
    // ever heard — which is how a slow, tool-heavy call ends up with no hesitation left at all.
    const c = clock();
    const ledger = new ThinkingFillerLedger(c.now);
    for (let i = 0; i < 10; i++) expect(ledger.offer()).not.toBeNull();
    expect(ledger.used).toHaveLength(0);
  });

  it('enforces the per-call ceiling on words actually spoken', () => {
    // It fired TWENTY-ONE times in a seven-minute call before the ceiling existed. That is not
    // thinking, it is a nervous tic.
    const c = clock();
    const ledger = new ThinkingFillerLedger(c.now);
    for (let n = 0; n < MAX_FILLERS_PER_CALL; n++) {
      const filler = ledger.offer();
      expect(filler).not.toBeNull();
      ledger.commit(filler!);
      c.advance(FILLER_COOLDOWN_MS + 1);
    }
    expect(ledger.offer()).toBeNull();
    expect(ledger.used).toHaveLength(MAX_FILLERS_PER_CALL);
  });

  it('holds the cooldown so two hesitations never land back-to-back', () => {
    const c = clock();
    const ledger = new ThinkingFillerLedger(c.now);
    ledger.commit(ledger.offer()!);
    c.advance(FILLER_COOLDOWN_MS - 1);
    expect(ledger.offer()).toBeNull();
    c.advance(2);
    expect(ledger.offer()).not.toBeNull();
  });

  it('never offers a word this call has already spoken', () => {
    const c = clock();
    const ledger = new ThinkingFillerLedger(c.now);
    const spoken: string[] = [];
    for (let n = 0; n < MAX_FILLERS_PER_CALL; n++) {
      const filler = ledger.offer()!;
      expect(spoken).not.toContain(filler);
      spoken.push(filler);
      ledger.commit(filler);
      c.advance(FILLER_COOLDOWN_MS + 1);
    }
  });
});
