import { describe, expect, it } from 'vitest';
import { FactMemory, type FactField } from './fact-memory.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ACCEPTANCE TEST — two real calls, replayed turn by turn, in her own words.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every line below is copied verbatim out of `call-reports/2026-09-01T11-56-17-832Z.json` and
 * `call-reports/2026-09-01T12-33-41-747Z.json` — Koren's own calls of 2026-09-01, 14:56 and 15:33.
 * Nothing here is invented, and that is the point of the file: the ask counter had a list of
 * phrasings someone wrote down, it passed its own tests, and it was still blind to two of her five
 * business asks and to all four of her process asks, because she does not say what the list says.
 *
 * A test that exercises new patterns on sentences I made up would prove the same nothing over
 * again. So this replays the ACTUAL turn order, agent and caller alike — the caller turns matter,
 * because "has he answered yet" is what separates a re-ask from a follow-up.
 *
 * The timestamps are the real `atMs`, kept because the 20-second de-dupe window reads them.
 */

type Turn = [number, 'K' | 'L', string];

/** Feeds a whole call through the memory, exactly as agent.ts does on a live call. */
function replay(turns: Turn[], intentAsks = true): FactMemory {
  const memory = new FactMemory({ intentAsks });
  for (const [at, who, text] of turns) {
    if (who === 'K') memory.observeAgentUtterance(text, at);
    else memory.observeCallerUtterance(text);
  }
  return memory;
}

/** The 14:56 call, from the greeting to 400s — every discovery question she asked. */
const CALL_1456: Turn[] = [
  [7398, 'K', "שלום מדברת קרן העוזרת הדיגיטלית של ClickScales. איך אני יכולה לעזור?"],
  [9872, 'L', "מה המצב, קרן?"],
  [15478, 'K', "בסדר. אחלה, תודה. עם מי אני מדברת?"],
  [17677, 'L', "עם קורן."],
  [22904, 'K', "אֶה... נעים מאוד קורן. תפסתי אותךָ בזמן טוב?"],
  [27666, 'L', "כן."],
  [31998, 'K', "יום עמוס אצלך היום, או שיש לךָ דקה?"],
  [37488, 'L', "יש לי זמן."],
  [40461, 'K', "במה אתה עוסק?"],
  [62559, 'K', "רגע, אתה עוד על הקו?"],
  [69998, 'L', "כן."],
  [74101, 'K', "אֶממ... מה אתה עושה ביוםיום?"],
  [81938, 'L', "מה השאלה? לא הבנתי."],
  [85185, 'K', "אמ. במה אתה עוסק?"],
  [87537, 'L', "למה אני.  עוסק?"],
  [100970, 'K', "אוקי. כדי לראות אם זה רלוונטי אליךָ. אנחנו בונים סוכני AI לקול ולוואטסאפ שעונים לפניות של לקוחות וקובעים שיחות. מה הכי היית רוצֶה לשפר בטיפול בפניות היום?"],
  [106263, 'L', "כן, לא הבנתי מה את שואלת."],
  [110830, 'K', "אני שואלת על העבודה שלךָ. מה אתה עושה ביוםיום?"],
  [113518, 'L', "יש לי עסק."],
  [121223, 'K', "מה שקובע פה זה הפניות. מי עונה אצלך לפניות היום, ותוך כמה זמן חוזרים ללקוח?"],
  [127280, 'L', "לא הבנתי את הקשר למה שאת שואלת."],
  [139628, 'L', "הלו? מישהו פה?"],
  [151857, 'K', "אמ. אני פה. כדי להבין אם זה יכול לעזור לךָ בעסק, אני בודקת איך פניות נכנסות מטופלות היום. מי עונה לפניות אצלך, ותוך כמה זמן הלקוח מקבל מענה?"],
  [155526, 'L', "אה, אה."],
  [158801, 'K', "רֶגַע... אני שואלת איך זה עובד אצלך היום. כשנכנסת פנייה — מי מטפל בה, וכמה מהר חוזרים?"],
  [158899, 'L', "את לא יודעת בכלל איזה עסק יש לי. למה את קופצת ישר לעניין הפניות?"],
  [172383, 'K', "אוקי. אתה צודק. שאלתי מהר מדי. אמרת שיש לךָ עסק, וזה מה שיש לי כרגע. כדי שאבין אם זה רלוונטי — מה הכי מציק לךָ היום בטיפול בלידים או בשיחות עם לקוחות?"],
  [197040, 'K', "אני כאן, אין לחץ — קח את הזמן שאתה צריך ואני מחכה."],
  [203119, 'L', "בקיצור, יש לי לידים שנכנסים, ואני צריך עזרה בלטפל בהם."],
  [216568, 'K', "טוב, הבנתי. הבנתי. אוף.. זה באמת שוחק כשפניות נכנסות ואתה צריך להחזיק הכל לבד. בדרך כלל אתה סוגר לקוחות בטלפון, בזום, או בפגישה?"],
  [222318, 'L', "בטלפון בדרך כלל."],
  [227335, 'K', "מעולה. וכמה פניות חדשות נכנסות אליךָ ביום בערך?"],
  [233168, 'L', "אה... נכנסות בין."],
  [238578, 'L', "15 ל-20 פניות.  25 אפילו לפעמים. יש לנו המון פניות לעסק."],
  [245081, 'K', "וואלה? זה מספר יפה."],
  [251202, 'L', "אוקיי."],
  [254066, 'K', "כמה זמן ביום זה לוקח לךָ?"],
  [260017, 'L', "לא יודע, לוקח לנו כמה שעות. זה לוקח המון התעסקות."],
  [269477, 'K', "בסדר."],
  [269550, 'L', "הסוכנים האלה יודעים בעצם מה... הם יודעים לטפל בדברים האלה? הם לא כל כך מצליחים להבין ממה שאת אומרת. את שיחה קצת מבולבלת לי."],
  [288291, 'K', "זה חשש הגיוני, ואתה לא היחיד ששואל את זה. אנחנו בונים סוכני AI לקול ולוואטסאפ שנשמעים ומתנהגים כמו בני אדם. הם עונים לפניות, קובעים שיחות, ודואגים שכל ליד מקבל מענה מהר. לפי מה שסיפרת לי — יש אצלך הרבה פניות וזה גוזל לכם כמה שעות ביום. זה בדיוק מה שזה פותר. איך זה נשמע לךָ עד עכשיו?"],
  [289563, 'L', "מה זה ליד? מה זה ליד?"],
  [290670, 'L', "מה זה ליד?"],
  [291568, 'K', "אמ."],
  [297236, 'K', "אוקי. מישהו שהשאיר פרטים או פנה כדי לבדוק את השירות שלךָ."],
  [301264, 'L', "אז תגידי ליד, לא רק תגידי לי ליד."],
  [306166, 'K', "צודק. אני מתכוונת לפנייה מלקוח פוטנציאלי. אצלך אלה האנשים שמשאירים פרטים או מתקשרים כדי לבדוק את השירות שלךָ. איך זה נשמע לךָ עכשיו?"],
  [306269, 'L', "אמרת ליד, כאילו זה ליד משהו. אם את אומרת ליד, אז זה ליד כמו ש..."],
  [307728, 'K', "הבנתי"],
  [310058, 'L', "אומרים.  ליד, עם ההגייה שלו נכונה. את לא עושה את ההגייה הנכונה."],
  [317421, 'K', "בסדר. אני מתכוונת לפנייה של לקוח. זה מה שחשוב כאן. מה העסק שלךָ עושה בפועל?"],
  [321420, 'L', "אנחנו סוכנות לבניית אתרים."],
  [322742, 'L', "שאלת את זה כבר, לא?"],
  [323977, 'L', "אני רואה שזה... אני טועה."],
  [334468, 'K', "שאלתי מוקדם יותר ולא קיבלתי תשובה ברורה, אז עכשיו יש לי את זה. אתה סוכנות לבניית אתרים. מי אצלכם עונה לפניות היום, ותוך כמה זמן חוזרים ללקוח?"],
  [339150, 'L', "אה... אנחנו בדרך כלל עונים."],
  [343206, 'K', "וכמה מהר אתם חוזרים בדרך כלל?"],
  [348720, 'L', "אני לא יודע, תוך כמה...  שעות."],
  [349738, 'L', "תוך יום.  עבודה."],
  [350476, 'L', "בדרך כלל."],
  [360175, 'K', "אוף.. זה באמת שוחק. כשמישהו פונה אליךָ בבוקר ומקבל תשובה רק תוך יום עבודה, כמה מהם נעלמים בדרך לדעתך?"],
  [363918, 'L', "אה, לא יודע, יש כמה שני.  צורפים בדרך."],
  [366751, 'K', "יש מצב שכמה פשוט עוברים למישהו אחר. מה"],
  [367963, 'L', "שלא כולם מקבלים את המענה ו...  פונים לאחרים, אולי למתחרים."],
  [382278, 'K', "הבנתי אותךָ. זה בדיוק הכאב. כשפניות יושבות כמה שעות או יום, חלק מהאנשים פשוט ממשיכים הלאה למישהו אחר. אצלך היום מי תופס את השיחות והפניות שנכנסות — אתה, או מישהו מהצוות?"],
  [385258, 'L', "גם אני וגם מישהו מהצוות."],
  [391729, 'K', "אז היום גם אתה וגם מישהו מהצוות מטפלים בזה. מה הכי היית רוצֶה לשפר שם?"],
  [395117, 'L', "את הזמן מענה?"],
  [398030, 'K', "אוקי. אם היית משנה דבר אחד בתהליך הזה — מה היית מתקן ראשון?"],
  [398130, 'L', "ואת זה שאנחנו פחות נתעסק בדבר הזה."],
];

/** The 15:33 call, to 210s — the one where he said out loud that it was only questions. */
const CALL_1533: Turn[] = [
  [7296, 'K', "שלום מדברת קרן העוזרת הדיגיטלית של ClickScales. איך אני יכולה לעזור?"],
  [11721, 'L', "היי, כן, מה המצב?"],
  [15895, 'K', "בסדר. איך קוראים לךָ?"],
  [18693, 'L', "אני קורן."],
  [26331, 'K', "שניה... נעים מאוד קורן. תפסתי אותךָ בזמן טוב?"],
  [35115, 'L', "כן, תוך כדי זמן טוב."],
  [39152, 'K', "יום עמוס אז. במה אתה עוסק?"],
  [42443, 'L', "מה אמרת? לא הבנתי."],
  [48075, 'K', "אמ. שאלתי במה אתה עוסק. ספר לי בקצרה — מה אתה עושה?"],
  [51521, 'L', "אני, יש לי עסק של בניית אתרים."],
  [59882, 'K', "הבנתי. מי עונה לפניות אצלך, ותוך כמה זמן חוזרים ללקוח?"],
  [74969, 'L', "אה—"],
  [80431, 'K', "אֶממ... מי"],
  [80527, 'L', "אני אוהב בדרך כלל הפניות. לוקח כמה שעות עד שאנחנו עונים."],
  [84218, 'K', "אוקי."],
  [89542, 'K', "כמה שעות זה כבר נמרח. מה הכי מתסכל אותךָ בזה היום?"],
  [94820, 'L', "בדיוק כמו ש— בדיוק כמו שאמרת, שזה נמרח."],
  [100964, 'K', "זה באמת מתסכל. מה קורה לפנייה שנכנסת מחוץ לשעות העבודה?"],
  [104422, 'L', "אני לא יודע."],
  [108392, 'L', "אני מניח.  שאף אחד לא מתקשר אליו. רק היום למחרת. לא הבנתי את השאלה."],
  [114324, 'K', "טוב, הבנתי. פנייה שנכנסת בערב. מתי היא מקבלת מענה אצלך?"],
  [117281, 'L', "יום למחרת?"],
  [120302, 'K', "אוקי."],
  [129369, 'K', "אֶה... שם בדרך כלל בורחים לידים. איך אתה סוגר לקוח בדרך כלל — בטלפון, בזום, או בפגישה?"],
  [132683, 'L', "בזום."],
  [140837, 'K', "הבנתי. בערך כמה פניות חדשות ביום נכנסות אליךָ?"],
  [146121, 'L', "באזור ה-10 פניות ביום."],
  [156261, 'K', "זה לוקח לךָ לא מעט זמן. כמה מהפניות האלה נשארות עד מאוחר בלי מענה?"],
  [173605, 'L', "כן, אני—"],
  [176965, 'L', "אם אני מוצא שאת רק שואלת אותי שאלות ולא—"],
  [177176, 'K', "בטח, עשר פניות ביום זה הרבה. אנחנו בונים סוכני AI לקול"],
  [178188, 'K', "מה אתם עושים?"],
  [182633, 'L', "מדברת איתי קצת על מה אתם עושים, אנחנו לא מנהלים פה איזשהו דו-שיח, זה רק שאילת שאלות."],
  [203482, 'K', "הבנתי אותךָ. אנחנו בונים סוכני AI לקול ולוואטסאפ. הם עונים לכל פנייה תוך שניות וקובעים שיחות גם כשאתה לא זמין. לפי מה שסיפרת לי — יש לךָ עסק לבניית אתרים, ופניות אצלך נמרחות כמה שעות ולפעמים עד למחרת. זה בדיוק מה שזה פותר. איך זה נשמע לךָ עד עכשיו?"],
  [208450, 'L', "לא מעניין."],
  [209481, 'L', "כמה זה עולה?"],
];

describe('ask memory — the 2026-09-01 14:56 call, replayed', () => {
  /**
   * SHE ASKED WHAT HIS BUSINESS IS FIVE TIMES. The old counter saw three.
   *
   *    40s  "במה אתה עוסק?"                                  <- ASK_PATTERNS
   *    74s  "אֶממ... מה אתה עושה ביוםיום?"                     <- was invisible
   *    85s  "אמ. במה אתה עוסק?"                              <- ASK_PATTERNS
   *   111s  "אני שואלת על העבודה שלךָ. מה אתה עושה ביוםיום?"   <- was invisible
   *   317s  "…מה העסק שלךָ עושה בפועל?"                       <- ASK_PATTERNS
   *
   * And at 323s the caller said "שאלת את זה כבר, לא?" — he was counting, and he counted five.
   */
  it('counts five business asks where the old detector counted three', () => {
    expect(replay(CALL_1456).asks('business')).toBe(5);
    expect(replay(CALL_1456, false).asks('business')).toBe(3);
  });

  /**
   * SHE ASKED WHO ANSWERS HIS ENQUIRIES FOUR TIMES. The old counter saw ZERO — there was no such
   * field, so no note could ever mention it however many times she asked.
   */
  it('counts four process asks where the old detector had no field at all', () => {
    expect(replay(CALL_1456).asks('process')).toBe(4);
    expect(replay(CALL_1456, false).asks('process')).toBe(0);
  });

  /**
   * THE OTHER DIRECTION, and the one Koren cares about most: deepening is the behaviour he wants.
   *
   *   339s  lead   "אה... אנחנו בדרך כלל עונים."         <- he answered
   *   343s  KEREN  "וכמה מהר אתם חוזרים בדרך כלל?"       <- builds on it
   *   382s  KEREN  "…מי תופס את השיחות והפניות שנכנסות — אתה, או מישהו מהצוות?"
   *
   * 382s matches every keyword group `process` requires. It is excluded because he had answered,
   * not because the regex was tuned until it fell out — that distinction is the design.
   */
  it('does not count a follow-up that builds on an answer he has already given', () => {
    const memory = replay(CALL_1456);
    expect(memory.answered('process')).toBe(true);
    // Four, not five and not six: 343s and 382s both come after his answer at 339s.
    expect(memory.asks('process')).toBe(4);
  });

  it('reads the frustration and closing questions too, and stops once he answers them', () => {
    const memory = replay(CALL_1456);
    // 101s and 172s, then he answers at 203s — 392s and 398s are follow-ups, not re-asks.
    expect(memory.asks('frustration')).toBe(2);
    expect(memory.answered('frustration')).toBe(true);
    // 217s, answered at 222s with two words: "בטלפון בדרך כלל." — a closed question deserves a
    // closed answer, which is what `answerTokens` exists for.
    expect(memory.asks('closing')).toBe(1);
    expect(memory.answered('closing')).toBe(true);
  });

  /**
   * His answer arrived in two committed items — "אה... נכנסות בין." at 233s, then the numbers at
   * 239s. The window has to survive the first fragment or the answer is thrown away.
   */
  it('credits an answer the endpointer split across two turns', () => {
    const memory = replay(CALL_1456);
    expect(memory.asks('volume')).toBe(1);
    expect(memory.answered('volume')).toBe(true);
  });

  it('does not invent asks for the fields she never raised on this call', () => {
    const memory = replay(CALL_1456);
    expect(memory.asks('phone')).toBe(0);
    expect(memory.asks('email')).toBe(0);
    // One name ask, at 15s — "עם מי אני מדברת?" — and she never asked again.
    expect(memory.asks('name')).toBe(1);
  });

  /**
   * The 111s ask is the one the whole design turns on. At 114s he replied "יש לי עסק." — three
   * words, and she herself said at 334s *"שאלתי מוקדם יותר ולא קיבלתי תשובה ברורה"*. If that
   * counted as an answer the 317s ask would read as a follow-up and the count would be four.
   */
  it('does not read "יש לי עסק" as an answer — she did not read it as one either', () => {
    const upTo114s = CALL_1456.filter(([at]) => at <= 114_000);
    expect(replay(upTo114s).answered('business')).toBe(false);
    // He answers properly at 321s: "אנחנו סוכנות לבניית אתרים."
    expect(replay(CALL_1456).answered('business')).toBe(true);
  });
});

describe('ask memory — the 2026-09-01 15:33 call, replayed', () => {
  /**
   * The call where he said it out loud, at 183s:
   *     "אנחנו לא מנהלים פה איזשהו דו-שיח, זה רק שאילת שאלות."
   *
   * This call is the control. She asked each discovery question ONCE and he answered each one, so
   * a detector that fires here is producing false positives — and a false "you already asked this"
   * is the expensive failure, because it silences a legitimate question.
   */
  it('counts one ask per discovery question and no more', () => {
    const memory = replay(CALL_1533);
    expect(memory.asks('process')).toBe(1);
    expect(memory.asks('frustration')).toBe(1);
    expect(memory.asks('closing')).toBe(1);
    expect(memory.asks('volume')).toBe(1);
  });

  /**
   * Two business asks, six seconds apart, because he said "מה אמרת? לא הבנתי." in between. Both
   * are real — he heard the question twice — and the old detector already saw both, so the intent
   * layer must not turn them into three.
   */
  it('counts the two business asks the old detector already saw, and not a third', () => {
    expect(replay(CALL_1533).asks('business')).toBe(2);
    expect(replay(CALL_1533, false).asks('business')).toBe(2);
  });

  it('marks every discovery question he answered as answered', () => {
    const memory = replay(CALL_1533);
    expect(memory.answeredFields().sort()).toEqual(
      (['business', 'closing', 'frustration', 'process', 'volume'] as FactField[]).sort(),
    );
  });

  /**
   * NEAR MISSES, all from this call, all of which must stay at zero:
   *   101s  "מה קורה לפנייה שנכנסת מחוץ לשעות העבודה?"   <- about enquiries, not about who answers
   *   156s  "כמה מהפניות האלה נשארות עד מאוחר בלי מענה?"  <- counts enquiries, is not the volume Q
   *   178s  "מה אתם עושים?"                              <- about OUR company, not his business
   */
  it('the near misses stay near misses', () => {
    const one = (text: string, field: FactField) => {
      const m = new FactMemory();
      m.observeAgentUtterance(text);
      return m.asks(field);
    };
    expect(one('מה קורה לפנייה שנכנסת מחוץ לשעות העבודה?', 'process')).toBe(0);
    expect(one('כמה מהפניות האלה נשארות עד מאוחר בלי מענה?', 'volume')).toBe(0);
    expect(one('מה אתם עושים?', 'business')).toBe(0);
    // A summary of his answer is not a question about it — question sentences only.
    expect(one('אז היום גם אתה וגם מישהו מהצוות מטפלים בזה.', 'process')).toBe(0);
    // Her stock closing line mentions every noun `process` cares about and asks none of it.
    expect(one('איך זה נשמע לךָ עד עכשיו?', 'process')).toBe(0);
  });
});

describe('ask memory — the note', () => {
  it('names the discovery questions he has answered, and never tells her to stop', () => {
    const note = replay(CALL_1456).note() ?? '';
    expect(note).toMatch(/ALREADY answered/u);
    expect(note).toContain('who answers his enquiries today and how fast');
    expect(note).toMatch(/go deeper on what he actually said/u);
    // The 2026-08-31 lesson: nothing in this note may read as permission to wrap the call up.
    expect(note).not.toMatch(/Continue without it\./u);
  });

  /**
   * A field he ANSWERED can never appear in the exhaustion list, however many times she asked it
   * before he did. That is the direction this change moves the note in — fewer "stop asking"
   * lines, not more.
   */
  it('a question he answered is never listed as one she is stuck on', () => {
    const note = replay(CALL_1456).note() ?? '';
    if (note.includes('Do not ask again')) {
      expect(note).not.toMatch(/Do not ask again[^.]*who answers his enquiries/u);
    }
  });

  it('with the intent layer off, a call that only asked discovery questions has no new note', () => {
    // The kill-switch is a true revert: the four discovery fields cannot reach a count at all.
    const memory = replay(CALL_1533, false);
    for (const field of ['process', 'frustration', 'closing', 'volume'] as FactField[]) {
      expect(memory.asks(field)).toBe(0);
      expect(memory.answered(field)).toBe(false);
    }
    expect(memory.note() ?? '').not.toMatch(/ALREADY answered/u);
  });
});
