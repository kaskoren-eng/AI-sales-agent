import { describe, expect, it } from 'vitest';
import {
  ENGAGEMENT_WINDOW,
  EngagementTracker,
  callerSharedSubstance,
  callerTurnAwaitsAnswer,
  callerTurnNeedsThinkingTime,
  wordCount,
} from './engagement.js';

/**
 * Every caller line in this file is VERBATIM from the 2026-08-31 production call
 * (`call-reports/calls-2026-08-31.md`), because the two notes this module implements are both
 * "what she did on THAT call was wrong" and the only honest fixtures are the turns she did it on.
 */

describe('callerSharedSubstance — did he actually tell her something?', () => {
  it('YES for the most substantive thing the caller said all call', () => {
    // 35s. She answered it with "בניית אתרים זה תחום מעניין" — the mirror. A comprehension
    // acknowledgement here is at least TRUE, which is the bar this predicate sets.
    expect(callerSharedSubstance('אה, אני מתעסק בבניית אתרים.')).toBe(true);
  });

  it('YES for a long, real answer', () => {
    expect(
      callerSharedSubstance(
        'הייתי רוצה לשפר את זה שיש לי פשוט המון טלפונים, ואני מאבד ריכוז במהלך היום בגלל זה',
      ),
    ).toBe(true);
  });

  it('NO for a one-word answer — the "טוב, הבנתי" after "מחר." is the whole complaint', () => {
    // 433s: he said "מחר." and she answered "אוקיי." — correct. At 229s he said "בכלל אני לבד."
    // and she answered "טוב, הבנתי." There was nothing to have understood.
    expect(callerSharedSubstance('מחר.')).toBe(false);
    expect(callerSharedSubstance('כן.')).toBe(false);
    expect(callerSharedSubstance('בכלל אני לבד.')).toBe(false);
  });

  it('NO for a question, however long — he is waiting for an ANSWER', () => {
    // 213s: "היי, קרן. את לא רוצה לשאול אותי עוד שאלות?" → she opened "הבנתי אותךָ."
    expect(callerSharedSubstance('היי, קרן. את לא רוצה לשאול אותי עוד שאלות?')).toBe(false);
    expect(callerSharedSubstance('כמה זה עולה?')).toBe(false);
  });

  it('NO for a backchannel, even a repeated one', () => {
    for (const noise of ['אה...', 'אהה', 'כן', 'בסדר.', 'טוב', 'רגע', 'אממ']) {
      expect(callerSharedSubstance(noise), noise).toBe(false);
    }
  });

  it('NO for nothing at all', () => {
    expect(callerSharedSubstance(null)).toBe(false);
    expect(callerSharedSubstance('')).toBe(false);
    expect(callerSharedSubstance('   ')).toBe(false);
    expect(callerSharedSubstance('... — .')).toBe(false);
  });

  it('counts spoken digits as words — reading a number out loud IS talking', () => {
    expect(wordCount('פונים אליי בערך 15 עד 20 אנשים ביום')).toBe(8);
  });
});

describe('EngagementTracker — how much is he giving her?', () => {
  /** One caller turn each — she replies between them, as she does on a real call. */
  const feed = (tracker: EngagementTracker, lines: string[]): void => {
    for (const line of lines) {
      tracker.observeCaller(line);
      tracker.observeAgentTurn();
    }
  };

  it('claims nothing until he has actually spoken a few times', () => {
    const t = new EngagementTracker();
    t.observeCaller('כן.');
    expect(t.level).toBe('neutral');
    expect(t.note()).toBeNull();
    t.observeCaller('לא.');
    expect(t.level).toBe('neutral');
  });

  it('THE 2026-08-31 CALLER, first half: short answers → mandatory questions only', () => {
    const t = new EngagementTracker();
    feed(t, ['היי קרן, מה מצב?', 'אני קורן.', 'מה העניינים?', 'כן.', 'מחר.']);
    expect(t.level).toBe('terse');
    expect(t.note()).toMatch(/ONLY the MANDATORY discovery/u);
  });

  it('a caller who tells stories unlocks the optional questions', () => {
    const t = new EngagementTracker();
    feed(t, [
      'וראיתי שאתם יכולים לעזור לי להשתלט על כל נושא הלידים, כי מתקשרים אליי הרבה אנשים לטלפון',
      'הייתי רוצה לשפר את זה שיש לי פשוט המון טלפונים, ואני מאבד ריכוז במהלך היום בגלל זה',
      'טוב, אני אגיד. התכוונתי לכמות האנשים שפונים אליי. פונים אליי בערך 15 עד 20 אנשים ביום',
    ]);
    expect(t.level).toBe('engaged');
    expect(t.note()).toMatch(/you may add one or two OPTIONAL/u);
  });

  it('speaks ONCE per level, not once per turn — the tail must not churn', () => {
    const t = new EngagementTracker();
    feed(t, ['כן.', 'לא.', 'מחר.']);
    expect(t.note()).not.toBeNull();
    t.observeCaller('כן.');
    expect(t.note()).toBeNull();
    t.observeCaller('בסדר.');
    expect(t.note()).toBeNull();
  });

  it('follows a caller who warms up halfway through the call', () => {
    const t = new EngagementTracker();
    feed(t, ['כן.', 'לא.', 'מחר.']);
    expect(t.level).toBe('terse');
    t.note();
    feed(t, [
      'אז תראי, אני מתעסק בבניית אתרים כבר שבע שנים והעומס פשוט הרג אותי השנה',
      'מתקשרים אליי כל היום ואני לא מספיק לענות לכולם, זה מתסכל בטירוף',
      'בערך חמש עשרה עד עשרים אנשים ביום פונים אליי דרך הטלפון או הוואטסאפ',
      'ואני עונה לכולם לבד, אין לי אף אחד שעוזר לי עם זה בכלל',
      'אז כן, זה בדיוק מה שחיפשתי כשראיתי את המודעה שלכם ברשת',
    ]);
    expect(t.level).toBe('engaged');
    expect(t.note()).toMatch(/OPTIONAL/u);
  });

  it('only the last few turns count — the window is what makes it follow him', () => {
    const t = new EngagementTracker();
    feed(t, Array.from({ length: ENGAGEMENT_WINDOW }, () => 'כן.'));
    expect(t.averageWords).toBe(1);
    feed(t, Array.from({ length: ENGAGEMENT_WINDOW }, () => 'אחת שתיים שלוש ארבע חמש שש שבע שמונה תשע עשר אחת עשרה שתים עשרה'));
    expect(t.averageWords).toBe(14);
  });

  it('ignores an empty turn rather than counting it as a silent one', () => {
    const t = new EngagementTracker();
    feed(t, ['כן.', '', '   ', 'לא.']);
    expect(t.turns).toBe(2);
  });

  /**
   * MEASURED ON THE FIRST LOCAL RUN, not anticipated. `natural_flow`'s opening sentence arrived as
   * three committed items and a per-item average called the most talkative caller in the harness
   * TERSE. Koren's own call reported `fragmentedTurns: 8`, so this is how real Hebrew calls behave.
   */
  it('a sentence Soniox split into three is ONE turn, not three short ones', () => {
    const t = new EngagementTracker();
    // Verbatim from voice-test-runs/2026-08-31T10-59-46-243Z/natural_flow.
    t.observeCaller('היי.');
    t.observeCaller('אה...');
    t.observeCaller('ראיתי את המודעה שלכם באינסטגרם, ולא בדיוק הבנתי מה אתם עושים.');
    expect(t.turns).toBe(1);
    expect(t.averageWords).toBe(13);
  });

  it('the whole talkative scenario reads as ENGAGED once fragments are coalesced', () => {
    const t = new EngagementTracker();
    const turns: string[][] = [
      ['היי.', 'אה...', 'ראיתי את המודעה שלכם באינסטגרם, ולא בדיוק הבנתי מה אתם עושים.'],
      ['יש לי עסק קטן.', 'אנחנו מוכרים ריהוט לבית.', 'גם אונליין וגם חנות אחת בתל אביב.'],
      [
        'תראי, הבעיה שלי היא שמגיעות המון פניות בוואטסאפ, ואני פשוט לא מספיק לענות לכולן.',
        'בטח לא בערב.',
      ],
    ];
    for (const items of turns) {
      for (const item of items) t.observeCaller(item);
      t.observeAgentTurn();
    }
    expect(t.turns).toBe(3);
    expect(t.level).toBe('engaged');
  });

  it('without a reply between them, items keep extending the same turn', () => {
    const t = new EngagementTracker();
    t.observeCaller('כן.');
    t.observeCaller('כן.');
    t.observeCaller('כן.');
    expect(t.turns).toBe(1);
    expect(t.averageWords).toBe(3);
  });
});

describe('callerTurnAwaitsAnswer — round 19, the receipt goes when he ASKED', () => {
  it('is true for the three caller turns Koren judged on the 10:53 call', () => {
    // Verbatim from call-reports/2026-09-02T07-53-15-264Z.json — the turns that produced cards
    // o1, o2 and o3. All three got "בסדר." in front of the answer, and he rejected all three.
    expect(
      callerTurnAwaitsAnswer('זה ממש עובד שיש.  לה.  הסוכן הזה קו טלפון ומתקשרים אליו? הוא.'),
    ).toBe(true);
    expect(callerTurnAwaitsAnswer('פיזורים של עבודות?  למה...  שלי?')).toBe(true);
    expect(callerTurnAwaitsAnswer('מתי הזמן נוח?')).toBe(true);
  });

  it('is false when he is telling her something, so the receipt stays', () => {
    expect(callerTurnAwaitsAnswer('אני, יש לי עסק של משלוחים.')).toBe(false);
    expect(callerTurnAwaitsAnswer('לא יודע. מוקד. רוצה שייכנסו אליו עוד שיחות.')).toBe(false);
  });

  it('a turn it cannot read keeps the receipt — the safe direction is the old behaviour', () => {
    expect(callerTurnAwaitsAnswer(null)).toBe(false);
    expect(callerTurnAwaitsAnswer(undefined)).toBe(false);
    expect(callerTurnAwaitsAnswer('   ')).toBe(false);
  });

  it('disagrees with callerTurnNeedsThinkingTime on a question, which is the whole point', () => {
    // Conclusion 12 votes TRUE on a question ("a caller who ASKS is owed an explanation, and the
    // receipt covers the wait"). Round 19 overrides that clause, three cards out of three. If this
    // ever agrees, one of the two predicates has been quietly rewritten.
    const q = 'מתי הזמן נוח?';
    expect(callerTurnNeedsThinkingTime(q)).toBe(true);
    expect(callerTurnAwaitsAnswer(q)).toBe(true);
  });
});
