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

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   * "CONTINUE WITHOUT IT" ENDED A CALL — 2026-08-31 16:51, replayed from the transcript.
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   *
   * Her real utterances, run through this class. Every ASK_PATTERN hit is genuine; the counter did
   * exactly what it was built to do. What it produced was a note reading *"You have already asked
   * 2+ times for: his phone number, his email address … Continue without it."* — and sixteen
   * seconds later she said "יש לי מספיק כדי להעביר לצוות", called `end_call`, and left a lead who
   * had agreed to 11:00 the next morning with no booking at all.
   *
   * Neither field was optional in the sense she took: `book_meeting` cannot run without a phone.
   * The counter is unchanged (see the note's own comment for why every alternative counting rule
   * breaks the 2026-08-29 fix); the WORDING is what carries this.
   */
  it('the exhaustion note never licenses ending the call — the 16:51 replay', () => {
    const m = new FactMemory();
    m.establish('name', 'קורן');
    m.establish('business', 'בניית אתרים');
    for (const [at, line] of [
      [294_000, 'אוקי. טריט, נכון? מה מספר הטלפון שלךָ?'],
      [300_000, 'בסדר. מה מספר הטלפון שלךָ?'],
      [320_000, 'אוקי. שפיץ טריט, נכון? ומה כתובת המייל?'],
      [331_000, 'אוקי. השם משפחה הוא שפיץ? מה כתובת המייל שלךָ?'],
    ] as Array<[number, string]>) {
      m.observeAgentUtterance(line, at);
    }
    // The reproduction: both fields really do reach the limit, and both really are still missing.
    expect(m.asks('phone')).toBe(MAX_ASKS_PER_FACT);
    expect(m.asks('email')).toBe(MAX_ASKS_PER_FACT);
    const note = m.note() ?? '';
    expect(note).toContain('his phone number, his email address');

    // The fix: "continue" is now unambiguous about WHAT continues.
    expect(note).toMatch(/Continue the CALL without it/u);
    expect(note).toMatch(/keep selling, keep booking/u);
    expect(note).toMatch(/not a reason to end the call/u);
    expect(note).toMatch(/never by this one/u);
    // And the bare phrase that had the second reading is gone.
    expect(note).not.toMatch(/machine\. Continue without it\./u);
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

/**
 * The 2026-08-30 note: "נעים מאוד" belongs to the introduction and nowhere else. This latch is the
 * state the speech guard reads to decide whether a greeting is still allowed out.
 */
describe('FactMemory — she introduces herself once', () => {
  it('starts having introduced nobody', () => {
    expect(new FactMemory().introduced).toBe(false);
  });

  it('latches on the greeting she actually spoke — the 35s line', () => {
    const m = new FactMemory();
    m.observeAgentUtterance('אוקיי. נעים מאוד, קורן. אנחנו בונים סוכני AI לקול ולוואטסאפ.');
    expect(m.introduced).toBe(true);
  });

  it('latches on נעים להכיר too — she does not always use the same words', () => {
    const m = new FactMemory();
    m.observeAgentUtterance('נעים להכיר, קורן.');
    expect(m.introduced).toBe(true);
  });

  it('does not latch on an ordinary reply', () => {
    const m = new FactMemory();
    m.observeAgentUtterance('אנחנו בונים סוכני AI לקול ולוואטסאפ. במה אתה עוסק?');
    expect(m.introduced).toBe(false);
  });

  it('tells the model, once it has happened', () => {
    const m = new FactMemory();
    m.observeAgentUtterance('נעים מאוד, קורן.');
    expect(m.note()).toMatch(/ALREADY greeted/u);
  });

  it('says nothing while there is nothing to say', () => {
    expect(new FactMemory().note()).toBeNull();
  });
});

/**
 * THE OTHER HALF OF "IS THIS SETTLED?" — what the lead has said is WRONG.
 *
 * 2026-08-31, live PSTN: she read `k o r e n at gmail dot com` back to a man whose address begins
 * `kas`. He said "לא נכון". Eight seconds later she proposed the identical string again, and the
 * call ended inside the loop with no booking — the second call in a row this defect has cost one.
 *
 * `#known` only ever grew, so a value the caller had explicitly killed looked, to every later turn,
 * exactly like a value nobody had established yet.
 */
describe('FactMemory — a value the lead ruled out', () => {
  it('refuses it at the tool, even on a first capture of an empty field', () => {
    const m = new FactMemory();
    m.reject('email', 'koren@gmail.com');
    const verdict = m.guardIdentity({ email: 'koren@gmail.com' }, false);
    expect(verdict.accepted.email).toBeUndefined();
    expect(verdict.rejected).toEqual([{ field: 'email', offered: 'koren@gmail.com' }]);
  });

  it('refuses it even when the model claims is_correction — the lead is who ruled it out', () => {
    const m = new FactMemory();
    m.reject('email', 'koren@gmail.com');
    expect(m.guardIdentity({ email: 'KOREN@GMAIL.COM' }, true).accepted.email).toBeUndefined();
  });

  it('still accepts the value he actually meant', () => {
    const m = new FactMemory();
    m.reject('email', 'koren@gmail.com');
    const verdict = m.guardIdentity({ email: 'kaskoren@gmail.com' }, false);
    expect(verdict.accepted.email).toBe('kaskoren@gmail.com');
    expect(verdict.rejected).toEqual([]);
  });

  it('clears a HELD value it contradicts — she must stop saying it, not just stop saving it', () => {
    const m = new FactMemory();
    m.establish('email', 'koren@gmail.com');
    m.reject('email', 'koren@gmail.com');
    expect(m.get('email')).toBeNull();
  });

  it('tells the model, in the note, never to say it back', () => {
    const m = new FactMemory();
    m.reject('email', 'koren@gmail.com');
    const note = m.note() ?? '';
    expect(note).toMatch(/WRONG/u);
    expect(note).toContain('«koren@gmail.com»');
  });

  it('ignores a blank rejection and does not invent a ledger entry', () => {
    const m = new FactMemory();
    m.reject('email', '   ');
    expect(m.rejectedValues('email')).toEqual([]);
    expect(m.note()).toBeNull();
  });
});

describe('reportSnapshot — what survives the call, and what deliberately does not', () => {
  it('reports identity as SHAPE and discovery as VALUE', () => {
    const m = new FactMemory();
    m.establish('name', 'קורן שטרית');
    m.establish('phone', '0509788845');
    m.establish('business', 'משלוחים');
    m.establish('volume', 'בערך חמישה עשר');
    const snap = m.reportSnapshot();
    // The name and the number are already in `leads` and in the transcript. A third copy is a
    // third place to erase them from.
    expect(snap.held.name).toBe(true);
    expect(snap.held.phone).toBe(true);
    // The hedge IS the signal here — "בערך חמישה עשר" is not 15, and losing the hedge loses what
    // makes reading it back sound like listening.
    expect(snap.held.business).toBe('משלוחים');
    expect(snap.held.volume).toBe('בערך חמישה עשר');
  });

  it('carries the ask counts, so the report says what the facts COST', () => {
    const m = new FactMemory();
    m.observeAgentUtterance('במה אתה עוסק?', 1000);
    m.observeAgentUtterance('אז מה העסק שלךָ עושה בפועל?', 2000);
    const snap = m.reportSnapshot();
    expect(snap.asks.business).toBe(2);
    // A field never asked for does not appear at all — an absent key and a zero mean the same
    // thing, and the smaller object is the one that survives being read at 3am.
    expect(snap.asks.email).toBeUndefined();
  });

  it('held and answered can disagree, and that disagreement is the finding', () => {
    // He answered out loud; `capture_lead_info` was never called. On the 2026-09-02 10:53 call
    // that was true for the WHOLE call — 275 seconds, one tool call, and it was the calendar.
    const m = new FactMemory();
    m.observeAgentUtterance('במה אתה עוסק?', 1000);
    m.observeCallerUtterance('יש לי עסק של משלוחים');
    const snap = m.reportSnapshot();
    expect(snap.answered).toContain('business');
    expect(snap.held.business).toBeUndefined();
  });
});
