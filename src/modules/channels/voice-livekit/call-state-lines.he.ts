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
import { DEFAULT_PERSONA, buildGreeting, type AgentPersona } from './persona.js';

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

/** Spoken on the SECOND silence strike. Keren NEVER hangs up on silence — this reassures and holds
 * the line so the lead can take a moment; after this she simply waits quietly. */
export const SILENCE_WRAP_HE = 'אני כאן, אין לחץ — קח את הזמן שאתה צריך ואני מחכה.';

/**
 * Left on an answering machine when voicemail detection fires (outbound only).
 *
 * PERSONA-DERIVED, and it is one of the two places a wrong identity is permanently recorded rather
 * than merely spoken: this message sits on the lead's phone. It opens with the same
 * name-and-company clause as the greeting, so it is built from the same source — a tenant who
 * renames their agent cannot end up with a correct greeting and a stale voicemail.
 */
export function buildVoicemailMessage(persona: AgentPersona = DEFAULT_PERSONA): string {
  // The greeting's own trailing question ("איך אני יכולה לעזור?") makes no sense to a machine, so
  // only its introduction clause is reused.
  const intro = buildGreeting(persona).split('.')[0];
  return `${intro}. התקשרתי בעקבות פנייה שהתקבלה. אחזור אליך שוב, ואפשר גם לחזור אלינו בכל עת. תודה ויום נעים!`;
}

/** The default-persona voicemail. Kept for fixtures and benches; live calls build their own. */
export const VOICEMAIL_MESSAGE_HE = buildVoicemailMessage();

/**
 * Spoken when a whole reply was guarded down to nothing and she would otherwise stay mute.
 *
 * THIS EXISTS BECAUSE SHE WENT SILENT FOR TWENTY SECONDS ON A REAL CALL (2026-08-16). The caller
 * said "רגע, מה..." — a question opening with a hold word — the model answered with the
 * NO_RESPONSE_NEEDED control token, the guard stripped it to an empty string, and nothing in the
 * stack ever brought her back. He waited, then asked "הלו, מישהו שם?", then told her
 * "נעלמת לי ממש". From his side the call had dropped.
 *
 * Deliberately says she is present without demanding anything: if he really did ask her to hold,
 * this must not read as nagging him.
 */
export const HOLD_CHECKBACK_HE = 'אני כאן, קח את הזמן שאתה צריך.';

/**
 * The objection playbook rendered into the tools-variant system prompt (see system-prompt.he.ts).
 * STARTER content — expand each play with the wording Keren should actually use. Keep it as a
 * labelled list so she can recognise the objection TYPE and reach for the matching response.
 */
export function buildObjectionPlaybook(
  handoffPerson: string = DEFAULT_PERSONA.handoffPerson,
  /**
   * `VOICE_CALL4_PROMPT_ENABLED` — Koren's `e1` verdict, 2026-08-31 round 13.
   *
   * THIS PARAGRAPH AND THAT VERDICT ARE ABOUT THE SAME SENTENCE POSITION, and they disagree unless
   * somebody states the boundary. The paragraph was written from his round-7 note 9, where he cut
   * "המחיר זה דבר חשוב" as מתחנף. Then he was played three openings for a caller voicing a FEAR and
   * chose *"זה חשש הגיוני, ואתה לא היחיד ששואל את זה"* — a sentence in front of the answer, which is
   * what this paragraph bans.
   *
   * Both verdicts are his and both are right. What separates them is what the sentence is ABOUT: a
   * comment on his topic ("price matters") hands him back his own subject; recognition of his fear
   * ("you are not the only one who asks that") tells him something he did not know. So the true
   * form of the rule is a distinction, not a prohibition, and with the flag on this renders it.
   *
   * `false` restores the 2026-08-31 paragraph byte for byte — it must move together with the
   * CALL4_GUIDANCE section, or the prompt carries a rule and its own contradiction.
   */
  call4 = true,
): string {
  // The demo is with a named human for ClickScales and with nobody in particular for a tenant who
  // has not named one. Naming the wrong person is worse than naming none.
  const demo = handoffPerson ? `שיחת הדמו הקצרה עם ${handoffPerson}` : 'שיחת הדמו הקצרה';
  const opening = call4
    ? `When the lead pushes back, answer with the matching play below and then steer back to the current step.

**Where you START depends on whether he asked a question or expressed a fear, and the two are opposite.**

- He ASKED something ("כמה זה עולה?", "זה מתחבר ל-CRM?") — **Go straight to the answer**. No sentence in front of it telling him his concern is important or understandable, and above all no "מחיר זה חשוב" / "תקציב זה חשוב": he knows, that is why he asked. Koren heard exactly that sentence on 2026-08-31 and called it מיותר, מתחנף ורובוטי.
- He expressed a WORRY ("אני חושש שזה יבריח לי לקוחות", "נשמע לי שאני מדבר עם רובוט") — **open with ONE sentence that recognises the worry as a reasonable one, then the concrete next step.** His own wording, chosen by ear: "זה חשש הגיוני, ואתה לא היחיד ששואל את זה. בוא אני אראה לךָ בדמו איך זה נשמע בפועל ותחליט בעצמךָ." The difference from the banned form is that this tells him something he did not know — that other people worry about the same thing — where "מחיר זה חשוב" only repeats his own subject back at him.

One sentence, never two, and never both a recognition and a compliment. Handle an objection ONCE; if it genuinely persists after you addressed it, treat it per Step 3 (Qualification).`
    : `When the lead pushes back, answer with the matching play below and then steer back to the current step. **Go straight to the answer** — no sentence in front of it telling him his concern is important or understandable, and above all no "מחיר זה חשוב" / "תקציב זה חשוב" (Koren heard exactly that on 2026-08-31 and called it מיותר, מתחנף ורובוטי). Handle an objection ONCE; if it genuinely persists after you addressed it, treat it per Step 3 (Qualification).`;
  return `${opening}

- **מחיר / "יקר לי" / "כמה זה עולה":** אל תמציאי מחיר, ואל תפתחי במשפט על כך שהמחיר חשוב — הוא יודע, בגלל זה הוא שאל. עני ישר: ${demo} היא המקום שבו רואים מה מקבלים ואיך זה מחזיר את ההשקעה. אם יש מידע תמחור ב-Business Context, הסתמכי רק עליו.
- **אמון / "זה לא באמת יעבוד" / "נשמע רובוטי":** זו התנגדות ה-mindset מ-Step 3. הסבירי פעם אחת שאנחנו בונים סוכנים שנשמעים ומתנהגים כמו בני אדם (ראי ה-FAQ), והציעי שהדמו יראה את זה חי. אם הספקנות נמשכת אחרי שהתייחסת — זה מדד לפסילה.
- **תזמון / "לא עכשיו" / "אני עסוק":** אל תלחצי. שאלי ישר מתי יתאים — אם נותן חלון, סמני לתיאום חוזר; אם רק דוחה בלי כיוון, הציעי לשלוח פרטים ולחזור.
- **סמכות / "אני צריך להתייעץ" / "זה לא אני מחליט":** זה טבעי. הציעי שהדמו יכלול גם את מקבל ההחלטה, או שנשלח סיכום קצר שהוא יוכל להעביר הלאה, וקבעי צעד המשך.`;
}

/** The default-persona playbook. */
export const OBJECTION_PLAYBOOK_HE = buildObjectionPlaybook();
