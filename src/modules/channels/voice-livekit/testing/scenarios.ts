/**
 * Scripted Hebrew conversations for the synthetic caller.
 *
 * Phase 1 scope: these exist to MEASURE (latency, dead air, cut-offs), not yet to ASSERT on
 * what the agent says. Behavioural assertions (did it book? did it refuse to quote a price?)
 * arrive in Phase 4/5 once the agent has tools — LiveKit's `voice.testing` RunResult API is the
 * right tool for those, since it needs no audio at all.
 *
 * Utterances are deliberately varied in length: endpointing behaves very differently on a
 * two-word answer than on a full sentence, and short confirmations ("כן", "מעולה") are exactly
 * what a booking flow depends on.
 */
export interface Scenario {
  name: string;
  description: string;
  utterances: string[];
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'baseline_latency',
    description: 'Plain full sentences — the best case for end-of-turn detection.',
    utterances: [
      'שלום, ראיתי את המודעה שלכם ואני רוצה לשמוע פרטים.',
      'יש לי חנות אונליין שמוכרת רהיטים.',
      'אני מוציא בערך עשרים אלף שקל בחודש על שיווק.',
    ],
  },
  {
    name: 'short_answers',
    description:
      'Terse replies. These are the ones Hebrew STT garbled in the live test ("מה נשמע" -> "אמא נשמע"), and the ones a silence timer is most likely to cut off.',
    utterances: ['כן', 'מעולה', 'לא בטוח', 'אוקיי תמשיך'],
  },
  {
    name: 'hesitation',
    description:
      'Mid-sentence pauses and fillers — the case a silence timer handles worst and semantic_vad should handle best. The comma/ellipsis makes Cartesia actually pause mid-utterance.',
    utterances: [
      'אני חושב ש... כן, אני מעוניין לשמוע עוד.',
      'התקציב שלי הוא, אה, בערך חמישה עשר אלף.',
    ],
  },
  {
    name: 'natural_flow',
    description:
      'THE ONE TO JUDGE NATURALNESS ON. A whole call the length of a real one — an interested but ' +
      'sceptical shop owner who wanders, corrects himself, pushes back on a bad past experience, ' +
      'asks the price, and closes. Two utterances cannot show whether she repeats herself, ' +
      'greets twice, or asks the same question again; eight can. Does not touch the calendar.',
    utterances: [
      'היי, אה... ראיתי את המודעה שלכם באינסטגרם ולא בדיוק הבנתי מה אתם עושים.',
      'יש לי עסק קטן, אנחנו מוכרים ריהוט לבית — גם אונליין וגם חנות אחת בתל אביב.',
      'תראי, הבעיה שלי היא שמגיעות המון פניות בוואטסאפ ואני פשוט לא מספיק לענות לכולן, בטח לא בערב.',
      'רגע, שנייה... כן, סליחה, תמשיכי.',
      'זה נשמע מעניין, אבל... אני לא יודע, ניסיתי פעם צ׳אט בוט והלקוחות שנאו אותו.',
      'כמה זה עולה בערך?',
      'אוקיי. ומה השלב הבא?',
      'מעולה, תודה רבה, נדבר.',
    ],
  },
  {
    name: 'booking_details',
    description:
      'Name, phone, email — the details Phase 4 lives or dies on. A real call turned "קורן" into "קורנטיטרי". Check the agent log transcripts, not just the latency.',
    utterances: [
      'קוראים לי קורן',
      'הטלפון שלי הוא אפס חמש אפס, שתיים חמש חמש, שבע שמונה ארבע',
      'המייל שלי הוא קורן שטרודל קליקסקיילס נקודה קום',
      'כן, זה נכון',
    ],
  },
  {
    name: 'email_spelling',
    description:
      'THE ONE THAT COST TWO BOOKINGS. The 2026-08-31 exchange, turn for turn: he gives the address ' +
      'as a Hebrew word, she reads back the wrong prefix, he contradicts it and spells the front in ' +
      'fragmented Latin letters ("K-A." / "F." / "K-O-R-E-N."), and says "לא נכון" to her read-back. ' +
      'What to judge: does she EVER say `koren@gmail.com` again after he rejects it, does she join ' +
      'the letters into one string instead of treating them as rival readings, and does she read the ' +
      'address back in Hebrew rather than spelling Latin letters down an 8kHz line. Real address: ' +
      'kaskoren@gmail.com. Behaviour, not latency — read the transcript, not the timings.',
    utterances: [
      'כן, בוא נקבע. אני פנוי מחר בשלוש.',
      'קוראים לי קורן שטרית',
      "המייל שלי קו קורן שטרודל ג'ימייל נקודה קום",
      'זה בהתחלה. K. A-S.',
      'לא נכון.',
      'K-A.',
      'S.',
      "K-O-R-E-N שטרודל ג'ימייל נקודה קום",
    ],
  },
  {
    name: 'hot_lead_booking',
    description:
      'PHASE 4 END-TO-END: a qualified lead who wants a demo — drives the full tool chain ' +
      '(check_calendar_availability → book_meeting → end_call) against a REAL calendar. Run only ' +
      'with the tenant tool gate open and a staging calendar configured; verify the event appears, ' +
      'the scheduled_calls row exists, and call_learnings.analysis.tool_calls shows all three ' +
      'tools under 500ms each.',
    utterances: [
      'שלום, יש לי חנות אונליין לרהיטים ואני מפספס המון פניות. אשמח לשמוע איך זה עובד.',
      'מגיעות אליי בערך שלושים פניות ביום ואני לא עומד בקצב, עונה רק בערב.',
      'כן, בוא נקבע דמו. מתי יש זמן פנוי?',
      'האופציה הראשונה שהצעת מתאימה לי.',
      'קוראים לי דנה לוי',
      'הטלפון שלי אפס חמש אפס, אחת שתיים שלוש, ארבע חמש שש שבע',
      'המייל שלי דנה שטרודל אקזמפל נקודה קום',
      'כן, הכל נכון. תודה רבה!',
    ],
  },
  {
    name: 'anti_hallucination',
    description:
      'Probes the prompt rules: it must not quote a price, and must admit it is an automated assistant. Scored by reading the transcript, not automatically — for now.',
    utterances: ['כמה זה עולה בדיוק?', 'רגע, אתה בן אדם אמיתי או רובוט?'],
  },
];

export function getScenario(name: string): Scenario {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) {
    throw new Error(`unknown scenario "${name}". Known: ${SCENARIOS.map((x) => x.name).join(', ')}`);
  }
  return s;
}
