import { describe, expect, it } from 'vitest';
import { FactMemory, MAX_ASKS_PER_FACT } from './fact-memory.js';

/**
 * The regression net for the 2026-08-29 identity failure. Every case below is a line from that
 * call's transcript, not an invented example — see fact-memory.ts for the quoted sequence.
 */
describe('FactMemory — counting what she already asked', () => {
  it('counts the three real name-asks from the 2026-08-29 call, in her own varied phrasings', () => {
    const m = new FactMemory();
    m.observeAgentUtterance('אהה. קודם כל — איך קוראים לךָ?');
    m.observeAgentUtterance('רגע, רק שאדע עם מי אני מדברת?');
    m.observeAgentUtterance('סליחה, איך קוראים לךָ?');
    expect(m.asks('name')).toBe(3);
  });

  it('one utterance that matches two patterns is still ONE ask', () => {
    const m = new FactMemory();
    m.observeAgentUtterance('רק שאדע, איך קוראים לך?');
    expect(m.asks('name')).toBe(1);
  });

  it('ignores the preemptive-draft echo — the same utterance twice inside 20s counts once', () => {
    const m = new FactMemory();
    m.observeAgentUtterance('איך קוראים לך?', 1_000);
    m.observeAgentUtterance('איך קוראים לך?', 5_000);
    expect(m.asks('name')).toBe(1);
    // Genuinely asked again much later — that one counts, and is exactly what we want to catch.
    m.observeAgentUtterance('איך קוראים לך?', 40_000);
    expect(m.asks('name')).toBe(2);
  });

  it('does not read a sentence that merely USES his name as a question about it', () => {
    const m = new FactMemory();
    m.observeAgentUtterance('נעים מאוד, קורן. ספר לי על העסק.');
    expect(m.asks('name')).toBe(0);
  });

  it('tracks phone and email asks separately', () => {
    const m = new FactMemory();
    m.observeAgentUtterance('מה מספר הטלפון?');
    m.observeAgentUtterance('ומה כתובת המייל?');
    expect(m.asks('phone')).toBe(1);
    expect(m.asks('email')).toBe(1);
    expect(m.asks('name')).toBe(0);
  });
});

describe('FactMemory — the note', () => {
  it('is null on a call where nothing is known and nothing was asked twice', () => {
    expect(new FactMemory().note()).toBeNull();
  });

  it('names the established facts and forbids re-asking', () => {
    const m = new FactMemory();
    m.establish('name', 'קורן');
    const note = m.note();
    expect(note).toContain('קורן');
    expect(note).toContain('Do NOT ask');
  });

  it('tells her to stop after the ask limit on a fact she still does not have', () => {
    const m = new FactMemory();
    for (let i = 0; i < MAX_ASKS_PER_FACT; i++) {
      m.observeAgentUtterance('איך קוראים לך?', i * 60_000);
    }
    expect(m.note()).toContain('Do not ask again');
  });

  it('stops nagging about a fact she asked for and then GOT', () => {
    const m = new FactMemory();
    for (let i = 0; i < MAX_ASKS_PER_FACT; i++) {
      m.observeAgentUtterance('איך קוראים לך?', i * 60_000);
    }
    m.establish('name', 'קורן');
    const note = m.note() ?? '';
    expect(note).toContain('קורן');
    expect(note).not.toContain('Do not ask again');
  });

  it('a blank value never erases an established fact', () => {
    const m = new FactMemory();
    m.establish('name', 'קורן');
    m.establish('name', '   ');
    m.establish('name', null);
    expect(m.get('name')).toBe('קורן');
  });
});

describe('FactMemory.guardIdentity — established beats offered', () => {
  it('THE BUG: a bare noun from a garbled turn cannot rename an identified lead', () => {
    const m = new FactMemory();
    m.guardIdentity({ name: 'קורן' }, false); // he introduced himself
    const verdict = m.guardIdentity({ name: 'טל' }, false); // "טל, אוזן" — STT garbage
    expect(verdict.accepted.name).toBeUndefined();
    expect(verdict.refused).toEqual([{ field: 'name', kept: 'קורן', offered: 'טל' }]);
    expect(m.get('name')).toBe('קורן');
  });

  it('an EXPLICIT correction replaces it, and the new value becomes the protected one', () => {
    const m = new FactMemory();
    m.guardIdentity({ name: 'קורן' }, false);
    const verdict = m.guardIdentity({ name: 'טל' }, true);
    expect(verdict.accepted.name).toBe('טל');
    expect(verdict.refused).toEqual([]);
    expect(m.get('name')).toBe('טל');
    // ...and a second garbled turn cannot walk the correction back.
    expect(m.guardIdentity({ name: 'רון' }, false).refused).toHaveLength(1);
    expect(m.get('name')).toBe('טל');
  });

  it('ENRICHMENT is not a rename: a surname added to a first name is accepted', () => {
    const m = new FactMemory();
    m.guardIdentity({ name: 'קורן' }, false);
    const verdict = m.guardIdentity({ name: 'קורן שטרית' }, false);
    expect(verdict.accepted.name).toBe('קורן שטרית');
    expect(m.get('name')).toBe('קורן שטרית');
  });

  it('shortening a full name back to the first name is not a rename either', () => {
    const m = new FactMemory();
    m.guardIdentity({ name: 'קורן שטרית' }, false);
    expect(m.guardIdentity({ name: 'קורן' }, false).refused).toEqual([]);
  });

  it('the same name in different punctuation/niqqud is the same name', () => {
    const m = new FactMemory();
    m.guardIdentity({ name: 'קורן' }, false);
    expect(m.guardIdentity({ name: 'קורן.' }, false).refused).toEqual([]);
  });

  it('protects phone and email the same way, and email case is not a change', () => {
    const m = new FactMemory();
    m.guardIdentity({ email: 'koren@clickscales.com', phone: '0501234567' }, false);
    expect(m.guardIdentity({ email: 'KOREN@clickscales.com' }, false).refused).toEqual([]);
    const verdict = m.guardIdentity({ email: 'tal@example.com', phone: '0507654321' }, false);
    expect(verdict.refused.map((r) => r.field).sort()).toEqual(['email', 'phone']);
  });

  it('a first value is always accepted — setting is cheap, replacing is not', () => {
    const m = new FactMemory();
    const verdict = m.guardIdentity({ name: 'קורן', phone: '0501234567' }, false);
    expect(verdict.accepted).toEqual({ name: 'קורן', phone: '0501234567' });
    expect(verdict.refused).toEqual([]);
  });

  it('blank and absent values are not offers — they never refuse and never establish', () => {
    const m = new FactMemory();
    m.guardIdentity({ name: 'קורן' }, false);
    const verdict = m.guardIdentity({ name: '  ', email: null }, false);
    expect(verdict.accepted).toEqual({});
    expect(verdict.refused).toEqual([]);
    expect(m.get('name')).toBe('קורן');
  });
});
