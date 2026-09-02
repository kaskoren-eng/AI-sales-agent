/**
 * The square-bracket net — round 24's pre-flip requirement.
 *
 * The stakes each case guards: a token that slips through either LAUGHS at a lead (Cartesia,
 * [laughter] renders "חח") or is SPELLED at him (DeepDub reads [breath] as "ברף"). Measured
 * 2026-09-02, probe21/probe24 + Soniox round-trips.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseBrackets } from './bracket-net.js';
import { guardSpeech } from './speech-guard.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(HERE, rel), 'utf-8');

describe('normaliseBrackets', () => {
  it('deletes the tag that laughs on one engine and is spelled on the other', () => {
    const r = normaliseBrackets('[laughter] המחיר נקבע לפי כמה שיחות.');
    expect(r.text).toBe('המחיר נקבע לפי כמה שיחות.');
    expect(r.dropped).toBe(1);
  });

  it('deletes a mid-sentence breath tag and heals the spacing', () => {
    const r = normaliseBrackets('אני מבינה. [breathing] זה באמת מתסכל.');
    expect(r.text).toBe('אני מבינה. זה באמת מתסכל.');
    expect(r.dropped).toBe(1);
  });

  it('deletes a TRUNCATED tag — the one a closing-bracket requirement would leave on the wire', () => {
    const r = normaliseBrackets('רגע, אני בודקת [breath');
    expect(r.text).toBe('רגע, אני בודקת');
    expect(r.dropped).toBe(1);
  });

  it('counts every token separately', () => {
    const r = normaliseBrackets('[sigh] טוב. [clears throat] אז ככה.');
    expect(r.dropped).toBe(2);
    expect(r.text).toBe('טוב. אז ככה.');
  });

  it('leaves Hebrew-bracketed text alone — a bracket followed by Hebrew is not markup', () => {
    const s = 'המחיר [אלף שקלים] לחודש.';
    const r = normaliseBrackets(s);
    expect(r.text).toBe(s);
    expect(r.dropped).toBe(0);
  });

  it('never touches an angle tag — <break> belongs to voice-mode.ts, not this net', () => {
    const s = 'רגע <break time="0.25s"/> אני בודקת את היומן.';
    const r = normaliseBrackets(s);
    expect(r.text).toBe(s);
    expect(r.dropped).toBe(0);
  });

  it('is a no-op (same reference, zero work) on bracket-free text', () => {
    const s = 'משפט רגיל בלי שום סוגריים.';
    expect(normaliseBrackets(s).text).toBe(s);
  });
});

describe('guardSpeech integration', () => {
  it('drops the token and counts it as bracketTagsDropped', () => {
    const r = guardSpeech('[laughter] זה מעולה, בוא נקבע.');
    expect(r.text).not.toContain('[');
    expect(r.text).toContain('בוא נקבע');
    expect(r.bracketTagsDropped).toBe(1);
    // The separate channel: a square token is NOT a pause-tag reading.
    expect(r.pauseTagsDropped ?? 0).toBe(0);
  });

  it('runs AFTER the leak scrub — a JSON payload with arrays is scrubbed whole, not chewed', () => {
    // A leaked tool-call payload carrying a JSON array. The scrub must see it intact; the net
    // must not pre-chew `["a"]` into fragments that no longer match the leak patterns.
    const r = guardSpeech('{"name":"book_meeting","args":{"slots":["a","b"]}}');
    expect(r.silent).toBe(true);
    expect(r.leakReasons?.length ?? 0).toBeGreaterThan(0);
    // The scrub took the whole payload; nothing was left for the bracket net to count.
    expect(r.bracketTagsDropped ?? 0).toBe(0);
  });

  it('reports zero on an ordinary sentence', () => {
    const r = guardSpeech('אני מבינה. זה באמת מתסכל.');
    expect(r.bracketTagsDropped ?? 0).toBe(0);
  });
});

describe('the counter reaches the report', () => {
  it('call-report carries the field and the recorder', () => {
    const src = read('./call-report.ts');
    expect(src).toContain('bracketTagsDropped: number');
    expect(src).toContain('recordBracketTagDropped');
  });

  it('agent.ts wires the callback at the tts call site and into the report', () => {
    const src = read('./agent.ts');
    expect(src).toContain('onBracketTagDropped: (count, spoken) =>');
    expect(src).toContain('report.recordBracketTagDropped');
  });
});
