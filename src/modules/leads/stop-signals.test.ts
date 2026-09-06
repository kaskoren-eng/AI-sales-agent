import { describe, it, expect, vi } from 'vitest';
import {
  classifyStopSignal,
  detectStopPhrase,
  normalizeForStopMatch,
  stopConfirmationText,
  STOP_CONFIRMATIONS,
  type StopClassifier,
} from './stop-signals.js';

/**
 * The guardrail Koren asked for on 2026-09-04: the agent must know when to STOP, not only when to
 * keep following up.
 *
 * The three tiers are not decoration. Each `describe` below is one of the three ways this can be
 * wrong, in descending order of how expensive the mistake is:
 *
 *   · chasing a lead who told us to stop        → a complaint, and in Israel a regulator
 *   · stopping a lead who asked to be called    → the follow-up feature silently deletes itself
 *   · depending on OpenAI to notice either      → both of the above, on the day it is down
 */

describe('normalizeForStopMatch', () => {
  it('strips niqqud, punctuation and case so the phrase list can stay readable', () => {
    expect(normalizeForStopMatch('אַל תִּתְקַשֵּׁר!!!')).toBe('אל תתקשר');
    expect(normalizeForStopMatch('  STOP.  ')).toBe('stop');
    expect(normalizeForStopMatch('Do   not  call   me')).toBe('do not call me');
  });

  it('is empty for an empty or whitespace-only message', () => {
    expect(normalizeForStopMatch('')).toBe('');
    expect(normalizeForStopMatch('   \n ')).toBe('');
  });
});

describe('detectStopPhrase — HARD STOP is deterministic, because the law is', () => {
  const hard = [
    'אל תתקשרו אליי יותר',
    'תפסיקו לשלוח לי הודעות',
    'הסר אותי מהרשימה',
    'תורידו אותי מרשימת התפוצה',
    'די להתקשר אליי כל יום',
    'אתם מטרידים אותי',
    'do not call me again',
    "don't call me",
    'please remove me from your list',
    'unsubscribe',
  ];
  for (const text of hard) {
    it(`hard-stops: "${text}"`, () => {
      const out = detectStopPhrase(text);
      expect(out.verdict).toBe('hard_stop');
      expect(out.source).toBe('phrase');
    });
  }

  it('a bare STOP is a hard stop — the SMS convention', () => {
    expect(detectStopPhrase('stop').verdict).toBe('hard_stop');
    expect(detectStopPhrase('STOP').verdict).toBe('hard_stop');
    expect(detectStopPhrase('הסר').verdict).toBe('hard_stop');
  });

  it('but "stop" INSIDE a sentence is not, or we opt out people who are still talking', () => {
    expect(detectStopPhrase('can you stop by our office tomorrow?').verdict).not.toBe('hard_stop');
    expect(detectStopPhrase('אני רוצה לעצור רגע ולחשוב על זה').verdict).not.toBe('hard_stop');
  });
});

describe('detectStopPhrase — SOFT STOP ends the chase without blacklisting anybody', () => {
  const soft = [
    'לא מעוניין תודה',
    'זה לא רלוונטי בשבילי',
    'כבר סגרתי עם חברה אחרת',
    'כבר יש לי ספק',
    'תודה אבל לא',
    'not interested',
    'no thanks, we already have a solution',
  ];
  for (const text of soft) {
    it(`soft-stops: "${text}"`, () => {
      expect(detectStopPhrase(text).verdict).toBe('soft_stop');
    });
  }
});

describe('detectStopPhrase — TIMING IS NOT REFUSAL', () => {
  /**
   * The most valuable message a lead can send is "call me later". It is the entire reason the
   * follow-up ladder exists. Reading one of these as a stop does not just lose a lead — it deletes
   * the feature, quietly, for everyone.
   */
  const timing = [
    'לא עכשיו, אני בישיבה',
    'תתקשר אליי מחר בבוקר',
    'אני עסוק, תחזור אליי בהמשך השבוע',
    'אני נוהג כרגע',
    'call me later please',
    "i'm busy right now",
  ];
  for (const text of timing) {
    it(`continues: "${text}"`, () => {
      expect(detectStopPhrase(text).verdict).toBe('continue');
    });
  }

  it('THE TRAP: "לא מעוניין לדבר עכשיו, תתקשר מחר" contains a soft phrase and is still a callback', () => {
    // Without the timing guard the soft list would end the single hottest lead in the pipeline.
    expect(detectStopPhrase('אני לא מעוניין לדבר עכשיו, תתקשר מחר').verdict).toBe('continue');
  });

  it('but a timing phrase does NOT rescue a genuine do-not-call', () => {
    // Hard beats timing beats soft — the order is the design.
    expect(detectStopPhrase('אני עסוק, ואל תתקשרו אליי יותר').verdict).toBe('hard_stop');
  });
});

describe('classifyStopSignal — the two layers, and what happens when one is missing', () => {
  const classifierSaying = (verdict: string): StopClassifier => ({
    complete: vi.fn(async () => JSON.stringify({ verdict, reason: 'test' })),
  });

  it('a hard phrase short-circuits — the classifier is never even asked', async () => {
    const c = classifierSaying('continue');
    const out = await classifyStopSignal('אל תתקשרו אליי יותר', c);
    expect(out.verdict).toBe('hard_stop');
    expect(c.complete).not.toHaveBeenCalled();
  });

  it('the classifier catches what no phrase list ever will', async () => {
    const out = await classifyStopSignal('אחי עזוב, מצאנו כבר משהו', classifierSaying('soft_stop'));
    expect(out.verdict).toBe('soft_stop');
    expect(out.source).toBe('classifier');
  });

  it('the classifier may overrule the broad soft list — it saw the whole sentence', async () => {
    const out = await classifyStopSignal('לא צריך להסביר, אני כבר בפנים', classifierSaying('continue'));
    expect(out.verdict).toBe('continue');
  });

  it('NO CLASSIFIER: the phrase lists still run — this is the outage path', async () => {
    expect((await classifyStopSignal('אל תתקשרו אליי', null)).verdict).toBe('hard_stop');
    expect((await classifyStopSignal('לא מעוניין', null)).verdict).toBe('soft_stop');
    expect((await classifyStopSignal('תתקשר מחר', null)).verdict).toBe('continue');
  });

  it('A THROWING CLASSIFIER DOES NOT STOP EVERYONE', async () => {
    // The tempting "fail closed = stop" would, during one OpenAI outage, end every live
    // conversation in the system — invisibly, and for every tenant at once.
    const broken: StopClassifier = { complete: async () => { throw new Error('502'); } };
    const out = await classifyStopSignal('כמה זה עולה?', broken);
    expect(out.verdict).toBe('continue');
    expect(out.source).toBe('phrase_fallback');
  });

  it('a throwing classifier still cannot lose a hard phrase', async () => {
    const broken: StopClassifier = { complete: async () => { throw new Error('502'); } };
    expect((await classifyStopSignal('תפסיקו לשלוח לי', broken)).verdict).toBe('hard_stop');
  });

  it('unparseable output falls back to the phrase layer rather than inventing a verdict', async () => {
    const chatty: StopClassifier = { complete: async () => 'I think he is probably fine with it' };
    const out = await classifyStopSignal('מתי אפשר להיפגש?', chatty);
    expect(out.verdict).toBe('continue');
    expect(out.source).toBe('phrase_fallback');
  });

  it('reads JSON out of a fenced or chatty reply', async () => {
    const fenced: StopClassifier = {
      complete: async () => '```json\n{"verdict":"hard_stop","reason":"asked to be removed"}\n```',
    };
    const out = await classifyStopSignal('אני מבקש שלא תפנו אליי שוב', fenced);
    expect(out.verdict).toBe('hard_stop');
  });

  it('an empty message is never a stop', async () => {
    expect((await classifyStopSignal('', null)).verdict).toBe('continue');
    expect((await classifyStopSignal('   ', null)).verdict).toBe('continue');
  });
});

describe('stopConfirmationText — the one line we send back', () => {
  it('confirms a hard stop, because for a do-not-call the confirmation IS the record', () => {
    expect(stopConfirmationText('hard_stop')).toBe('קיבלנו. הסרנו אותך מרשימת הפניות ולא ניצור קשר שוב.');
  });

  it('confirms a soft stop more gently, and leaves the door open', () => {
    expect(stopConfirmationText('soft_stop')).toContain('לא נטריד יותר');
  });

  it('says nothing at all on continue', () => {
    expect(stopConfirmationText('continue')).toBeNull();
  });

  /**
   * Hebrew forces a gender choice in the second person and we do not know the lead's. The last
   * message a lead ever receives from us is the worst possible place to guess wrong.
   */
  it('is gender-neutral — no second-person inflection in either line', () => {
    for (const line of Object.values(STOP_CONFIRMATIONS)) {
      expect(line).not.toMatch(/תשנה|תשני|מעוניין |מעוניינת |שלך[ךם]?\b/);
    }
  });

  it('never sells: no link, no offer, no invitation to reply', () => {
    for (const line of Object.values(STOP_CONFIRMATIONS)) {
      expect(line).not.toMatch(/http|www\.|\?/);
      // One sentence-ish: a confirmation that runs on is a conversation.
      expect(line.length).toBeLessThan(90);
    }
  });
});
