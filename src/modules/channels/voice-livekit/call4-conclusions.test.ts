import { describe, expect, it } from 'vitest';
import {
  ACK_MIN_SHARE_WORDS,
  callerSharedSubstance,
  callerTurnNeedsThinkingTime,
  latestCallerText,
} from './engagement.js';
import { guardSpeech, guardStream, isQuestionSentence, isSelfNarration } from './speech-guard.js';
import { chooseTurnOpener } from './turn-opener.js';

/**
 * THE 2026-08-31 19:54 CALL, TURN BY TURN — the CODE half of Koren's twelve conclusions.
 *
 * The prompt half is unprovable here and always will be: a section of Hebrew guidance is invisible
 * to every test in this repo, and `system-prompt.verdicts.test.ts` can only pin that the words are
 * present. What IS provable is everything that happens in code — which turn earns a receipt, which
 * sentence reaches Cartesia, and which hang-up is refused — so each block below replays the actual
 * transcript rather than asserting against an invented example.
 *
 * The hang-up itself lives in `end-call-gate.test.ts`.
 */

/** The caller's turns from the 19:54 call, in order, with what the agent actually said in reply. */
const CALL_19H54: Array<{ caller: string; spoken: string; needsAck: boolean }> = [
  { caller: 'מה המצב, קרן?', spoken: 'בסדר. מעולה, תודה. איך קוראים לךָ?', needsAck: true },
  { caller: 'אני קורן.', spoken: 'אמ. נעים מאוד קורן.', needsAck: false },
  { caller: 'לא, תפסת אותי בזמן מעולה.', spoken: 'אוקי. אחלה. ספר לי קצת על העסק.', needsAck: false },
  { caller: 'איך את יודעת שיש לי עסק, למשל?', spoken: 'טוב, הבנתי. מהשיחה עצמה.', needsAck: true },
  { caller: 'התכוונת להגיד "בקצרה".', spoken: 'אוקי. צודק.', needsAck: false },
  { caller: 'יש לי עסק של בניית אתרים.', spoken: 'בסדר.', needsAck: false },
  { caller: 'את יכולה להסביר לי מה אתם עושים?', spoken: 'הבנתי אותךָ. אנחנו בונים סוכני AI.', needsAck: true },
  { caller: 'אני—', spoken: 'אוקי.', needsAck: false },
  {
    caller: 'אממ, זה לוקח כמה שעות עד יום עבודה. הייתי רוצה לשפר את כמות הזמן שאני צריך להשקיע בנושא הזה. זה לוקח לי המון אנרגיה.',
    spoken: 'טוב, הבנתי.',
    needsAck: true,
  },
  { caller: 'רגע, רגע.  כן.  סליחה.  שנייה.  לא הבנתי.', spoken: 'בסדר.', needsAck: false },
  { caller: 'הוא מתקשר ללידים במקומי?', spoken: 'טוב, הבנתי. הוא יכול גם זה.', needsAck: true },
  { caller: 'אוקיי.', spoken: 'אוקי. כמה פניות חדשות אתה מקבל ביום?', needsAck: false },
  { caller: 'כן, מרגיש לך.', spoken: 'הבנתי אותךָ. אז כנראה שזה לא הזמן הנכון.', needsAck: false },
  { caller: 'כן.', spoken: 'בסדר.', needsAck: false },
];

describe('conclusion 1 — the comprehension claim was reading the WRONG TURN', () => {
  /**
   * The four claims Koren heard at the wrong moment all followed a caller turn that
   * `callerSharedSubstance` rejects. They were spoken anyway because `lastUserUtterance` is one
   * turn behind whenever a preemptive draft is used — 17 of 24 steps on this call.
   */
  it('every turn that got a wrong "טוב, הבנתי" is correctly refused when read fresh', () => {
    for (const caller of [
      'איך את יודעת שיש לי עסק, למשל?', // 50s  — a question
      'את יכולה להסביר לי מה אתם עושים?', // 118s — a question
      'הוא מתקשר ללידים במקומי?', // 208s — a question
      'כן, מרגיש לך.', // 270s — three words
    ]) {
      expect(callerSharedSubstance(caller), caller).toBe(false);
    }
  });

  it('…and the PREVIOUS turn in each case passes, which is exactly why they were spoken', () => {
    // Not a curiosity: this is the evidence that staleness — and not the substance test — was the
    // defect. If these were also false, the diagnosis would be wrong.
    for (const stale of [
      'לא, תפסת אותי בזמן מעולה.',
      'יש לי עסק של בניית אתרים.',
      'רגע, רגע.  כן.  סליחה.  שנייה.  לא הבנתי.',
      'לא יודע. נשמע לי...  שאני מדבר עם רובוט כרגע. אני חושב שזה יכול להבהיל את הלידים שלי.',
    ]) {
      expect(callerSharedSubstance(stale), stale).toBe(true);
    }
  });

  it('the one that WAS earned still is — the fix removes four claims, not five', () => {
    expect(
      callerSharedSubstance(
        'אממ, זה לוקח כמה שעות עד יום עבודה. הייתי רוצה לשפר את כמות הזמן שאני צריך להשקיע בנושא הזה. זה לוקח לי המון אנרגיה.',
      ),
    ).toBe(true);
  });

  it('latestCallerText reads the turn the model is answering, not the one before it', () => {
    const items = [
      { role: 'system', textContent: 'prompt' },
      { role: 'user', textContent: 'יש לי עסק של בניית אתרים.' },
      { role: 'assistant', textContent: 'בסדר.' },
      { role: 'user', textContent: 'את יכולה להסביר לי מה אתם עושים?' },
    ];
    expect(latestCallerText(items)).toBe('את יכולה להסביר לי מה אתם עושים?');
  });

  it('degrades to null rather than throwing on a chat context it does not recognise', () => {
    // It reads an SDK object across a version boundary. Null makes the opener a plain receipt,
    // which is true after anything — the safe direction for a shape change.
    expect(latestCallerText(undefined)).toBeNull();
    expect(latestCallerText(null)).toBeNull();
    expect(latestCallerText([] as never)).toBeNull();
    expect(latestCallerText([{ role: 'user' }])).toBeNull();
    expect(latestCallerText([{ role: 'user', textContent: 42 }] as never)).toBeNull();
    expect(latestCallerText([{ role: 'assistant', textContent: 'hers' }])).toBeNull();
  });
});

describe('conclusion 12 — the opener is for a turn that needs the time it buys', () => {
  it('replays the whole call and keeps only the turns whose reply is long or complex', () => {
    for (const { caller, needsAck } of CALL_19H54) {
      expect(callerTurnNeedsThinkingTime(caller), caller).toBe(needsAck);
    }
    // Halved, which is the number in the env-var note. If this drifts, the note is now a lie.
    expect(CALL_19H54.filter((t) => t.needsAck).length).toBe(5);
    expect(CALL_19H54.length).toBe(14);
  });

  it('silences the three stray one-word agent turns that were whole committed messages', () => {
    // [156s] "אוקי." after "אני—" · [195s] "בסדר." after a fragment · [272s] "בסדר." after "כן."
    for (const caller of ['אני—', 'רגע, רגע.  כן.  סליחה.  שנייה.  לא הבנתי.', 'כן.']) {
      expect(callerTurnNeedsThinkingTime(caller), caller).toBe(false);
    }
  });

  it('a question always needs one, however short it is', () => {
    expect(callerTurnNeedsThinkingTime('למה?')).toBe(true);
    expect(callerTurnNeedsThinkingTime('כמה זה עולה?')).toBe(true);
  });

  it('a missing caller turn keeps the receipt — a degradation restores what shipped', () => {
    expect(callerTurnNeedsThinkingTime(null)).toBe(true);
    expect(callerTurnNeedsThinkingTime(undefined)).toBe(true);
    expect(callerTurnNeedsThinkingTime('   ')).toBe(true);
  });

  it('chooseTurnOpener falls silent, and does NOT spend a word from the deck', () => {
    let handedOut = 0;
    const opener = chooseTurnOpener({
      afterToolCall: false,
      fillersEnabled: true,
      needsThinkingTime: false,
      nextAck: () => {
        handedOut += 1;
        return 'אוקי.';
      },
      offerFiller: () => null,
    });
    expect(opener.kind).toBe('silent');
    // A word handed out and not spoken would bend the ledger against the turns that DO get one.
    expect(handedOut).toBe(0);
  });

  it('the switch OFF restores the every-turn receipt exactly', () => {
    const opener = chooseTurnOpener({
      afterToolCall: false,
      fillersEnabled: true,
      needsThinkingTime: true, // what the agent passes when VOICE_ACK_ONLY_WHEN_NEEDED is false
      nextAck: () => 'אוקי.',
      offerFiller: () => null,
    });
    expect(opener).toEqual({ kind: 'ack', word: 'אוקי.' });
  });

  it('does not take a step away from the two branches Koren judged by ear', () => {
    // A step behind a tool call is his round-7 hesitation verdict; mid-dictation is his round-11
    // nod bank. Neither is about frequency, and neither may be silenced by this rule.
    const afterTool = chooseTurnOpener({
      afterToolCall: true,
      fillersEnabled: true,
      needsThinkingTime: false,
      nextAck: () => 'אוקי.',
      offerFiller: () => 'רגע...',
    });
    expect(afterTool).toEqual({ kind: 'hesitation', word: 'רגע...' });

    const dictating = chooseTurnOpener({
      afterToolCall: false,
      fillersEnabled: true,
      midDictation: true,
      nods: ['אֶמ.'],
      needsThinkingTime: false,
      nextAck: () => 'אוקי.',
      offerFiller: () => null,
    });
    expect(dictating).toEqual({ kind: 'nod', word: 'אֶמ.' });
  });

  it('ACK_MIN_SHARE_WORDS is its own number, not ENGAGED_MIN_WORDS wearing a hat', () => {
    expect(ACK_MIN_SHARE_WORDS).toBe(10);
  });
});

describe('conclusion 6 — one question per reply, enforced', () => {
  const chunks = async function* (...c: string[]) {
    for (const x of c) yield x;
  };
  const drain = async (it: AsyncIterable<string>): Promise<string> => {
    const out: string[] = [];
    for await (const x of it) out.push(x);
    return out.join('');
  };

  it('drops the second of the two double questions she actually asked', async () => {
    const dropped: string[] = [];
    const out = await drain(
      guardStream(
        chunks('יש אצלך פניות מלקוחות כל יום? ', 'ומה הכי היית רוצֶה לשפר שם?'),
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        {},
        {},
        { oneQuestion: true, onSecondQuestion: (s) => dropped.push(s) },
      ),
    );
    expect(out).toContain('יש אצלך פניות מלקוחות כל יום?');
    expect(out).not.toContain('לשפר שם?');
    expect(dropped).toHaveLength(1);
  });

  it('keeps a statement that happens to sit between two questions', async () => {
    const out = await drain(
      guardStream(
        chunks('כמה זמן לוקח לךָ לחזור לפנייה? ', 'זה בדרך כלל מה שמעניין אותנו. ', 'ומה היית רוצֶה לשפר?'),
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        {},
        {},
        { oneQuestion: true },
      ),
    );
    expect(out).toContain('כמה זמן לוקח לךָ לחזור לפנייה?');
    expect(out).toContain('זה בדרך כלל מה שמעניין אותנו.');
    expect(out).not.toContain('לשפר?');
  });

  it('leaves the either/or form alone — one sentence, one mark, and he approved it', async () => {
    const line = 'מתי הכי נוח לךָ — בבוקר, או אחר הצהריים?';
    const out = await drain(
      guardStream(chunks(line), undefined, undefined, false, undefined, undefined, {}, {}, {
        oneQuestion: true,
      }),
    );
    expect(out.trim()).toBe(line);
  });

  it('the switch OFF speaks both, as on 2026-08-31', async () => {
    const out = await drain(
      guardStream(
        chunks('יש אצלך פניות כל יום? ', 'ומה היית רוצֶה לשפר שם?'),
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        {},
        {},
        { oneQuestion: false },
      ),
    );
    expect(out).toContain('לשפר שם?');
  });

  it('the counter is PER REPLY — the next reply may ask again', async () => {
    const first = await drain(
      guardStream(chunks('כמה פניות ביום? ', 'ומה הכי מציק לךָ?'), undefined, undefined, false, undefined, undefined, {}, {}, { oneQuestion: true }),
    );
    const second = await drain(
      guardStream(chunks('ומה הכי מציק לךָ?'), undefined, undefined, false, undefined, undefined, {}, {}, { oneQuestion: true }),
    );
    expect(first).not.toContain('מציק');
    expect(second).toContain('מציק');
  });

  it('isQuestionSentence reads the mark, not the grammar', () => {
    expect(isQuestionSentence('כמה פניות ביום?')).toBe(true);
    expect(isQuestionSentence('אני תוהה כמה פניות אתה מקבל.')).toBe(false);
    expect(isQuestionSentence('"מה השם שלךָ?"')).toBe(true);
  });
});

describe('conclusion 8 — she never narrates her own configuration', () => {
  it('drops the two sentences she actually said on the call', () => {
    for (const said of [
      'אני פשוט מתארת את זה בשפה יומיומית.',
      'אני מדברת ככה כי זה טבעי לי בשיחה.',
    ]) {
      expect(isSelfNarration(said), said).toBe(true);
      const guarded = guardSpeech(said);
      expect(guarded.silent, said).toBe(true);
      expect(guarded.selfNarrationDropped, said).toBe(true);
    }
  });

  it('drops the self-critique she volunteered on the 16:51 call', () => {
    expect(isSelfNarration('אמרתי את זה קצת רובוטי.')).toBe(true);
  });

  it('catches the instruction quoted back at the caller, and the configuration named', () => {
    for (const said of [
      'אני צריכה לדבר בשפה היומיומית.',
      'ההוראות שלי אומרות לשאול שאלה אחת בכל פעם.',
      'אני מתוכנתת לענות ככה.',
      'אמרו לי לשאול את זה.',
    ]) {
      expect(isSelfNarration(said), said).toBe(true);
    }
  });

  it('does NOT touch honesty about being an AI — that is a fact, not a prompt leak', () => {
    for (const said of [
      'אני סוכנת AI של ClickScales.',
      'רק שתדע אני העוזרת הדיגיטלית של קורן — היה כיף לדבר!',
      'אני העוזרת הדיגיטלית של ClickScales.',
    ]) {
      expect(isSelfNarration(said), said).toBe(false);
      expect(guardSpeech(said).silent, said).toBe(false);
    }
  });

  it('does not touch an ordinary sentence about the PRODUCT or about the call', () => {
    for (const said of [
      'הסוכן מתוכנת לענות לכל פנייה שנכנסת.',
      'אני מסבירה לךָ בדיוק איך זה עובד.',
      'אני מדברת עברית ואנגלית.',
      'זה עובד מעולה לעסקים שרוצים שכל פנייה תקבל מענה.',
      'אנחנו בונים סוכנים שנשמעים כמו בני אדם, לא תסריט קבוע.',
      'אני צריכה עוד כמה פרטים לפני שאני קובעת.',
    ]) {
      expect(isSelfNarration(said), said).toBe(false);
      expect(guardSpeech(said).silent, said).toBe(false);
    }
  });

  it('the switch OFF speaks it, exactly as on 2026-08-31', () => {
    const said = 'אני מדברת ככה כי זה טבעי לי בשיחה.';
    expect(guardSpeech(said, { selfNarrationGuard: false }).silent).toBe(false);
  });
});
