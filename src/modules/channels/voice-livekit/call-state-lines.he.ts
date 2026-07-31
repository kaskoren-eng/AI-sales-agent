/**
 * Hebrew wording for the situational reflexes + the objection playbook.
 *
 * THIS FILE IS CONTENT (Koren's), not engine. The values here are a working STARTER so the reflexes
 * ship end-to-end; refine the wording freely without touching call-state.ts / call-reflexes.ts. The
 * lines are spoken verbatim by `session.say()` (silence/voicemail) or rendered into the prompt
 * (objection playbook) — keep them natural, feminine first-person for Keren, and masculine when
 * addressing the (usually male) lead.
 */

import type { CallStage } from './call-state.js';

/** Gentle "are you still there?" — one per stage, so a silence in scheduling reads differently
 * from one in discovery. Spoken on the FIRST silence strike. */
export const SILENCE_NUDGE_HE: Record<CallStage, string> = {
  opening: 'הלו, אתה שומע אותי?',
  discovery: 'אתה עדיין איתי?',
  qualifying: 'רגע, אתה עוד על הקו?',
  scheduling: 'אתה איתי? בוא רק נסגור את הזמן.',
  closing: 'אתה איתי? כמעט סיימנו.',
  terminal: 'אתה עדיין שם?',
};

/** Spoken on the SECOND silence strike, right before Keren hangs up. */
export const SILENCE_WRAP_HE = 'נראה שנותקנו. אין בעיה, אנסה שוב מאוחר יותר. יום טוב!';

/** Left on an answering machine when voicemail detection fires (outbound only). */
export const VOICEMAIL_MESSAGE_HE =
  'שלום, מדברת קרן מ-ClickScales. התקשרתי בעקבות פנייה שהתקבלה. אחזור אליך שוב, ואפשר גם לחזור אלינו בכל עת. תודה ויום נעים!';

/**
 * The objection playbook rendered into the tools-variant system prompt (see system-prompt.he.ts).
 * STARTER content — expand each play with the wording Keren should actually use. Keep it as a
 * labelled list so she can recognise the objection TYPE and reach for the matching response.
 */
export const OBJECTION_PLAYBOOK_HE = `When the lead pushes back, first ACKNOWLEDGE the concern in one short sentence, then answer with the matching play below, then steer back to the current step. Handle an objection ONCE; if it genuinely persists after you addressed it, treat it per Step 3 (Qualification).

- **מחיר / "יקר לי" / "כמה זה עולה":** אל תמציאי מחיר. הכירי בכך שתקציב חשוב, והחזירי לערך — שיחת הדמו הקצרה עם קורן היא בדיוק המקום להראות מה מקבלים ואיך זה מחזיר את ההשקעה. אם יש מידע תמחור ב-Business Context, הסתמכי רק עליו.
- **אמון / "זה לא באמת יעבוד" / "נשמע רובוטי":** זו התנגדות ה-mindset מ-Step 3. הסבירי פעם אחת שאנחנו בונים סוכנים שנשמעים ומתנהגים כמו בני אדם (ראי ה-FAQ), והציעי שהדמו יראה את זה חי. אם הספקנות נמשכת אחרי שהתייחסת — זה מדד לפסילה.
- **תזמון / "לא עכשיו" / "אני עסוק":** אל תלחצי. הכירי בעיתוי, ושאלי מתי יתאים — אם נותן חלון, סמני לתיאום חוזר; אם רק דוחה בלי כיוון, הציעי לשלוח פרטים ולחזור.
- **סמכות / "אני צריך להתייעץ" / "זה לא אני מחליט":** זה טבעי. הציעי שהדמו יכלול גם את מקבל ההחלטה, או שנשלח סיכום קצר שהוא יוכל להעביר הלאה, וקבעי צעד המשך.`;
