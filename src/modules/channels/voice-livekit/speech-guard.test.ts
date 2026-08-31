import { describe, expect, it } from 'vitest';
import {
  AddressGenderTracker,
  applyPronunciationFixes,
  dropAckEcho,
  forceAddressGender,
  forceMasculineAddress,
  guardSpeech,
  guardStream,
  notifyIfSilent,
  withFiller,
} from './speech-guard.js';
import { THINKING_FILLERS_HE } from './prompts/thinking-fillers.he.js';
import { DICTATION_NOD } from './dictation.js';

/**
 * These are the ACTUAL sentences the agent said to Koren on a real call. Not hypotheticals.
 */
describe('speech guard — the silence control token', () => {
  it('never lets NO_RESPONSE_NEEDED reach the caller', () => {
    // She said this out loud, in English, to a Hebrew caller who had just asked her to hold on.
    const r = guardSpeech('NO_RESPONSE_NEEDED');
    expect(r.silent).toBe(true);
    expect(r.text).toBe('');
  });

  it('stays SILENT when the token is the whole reply — that is the point of it', () => {
    // The caller said "רגע" / "שנייה". The correct behaviour is to say nothing at all.
    expect(guardSpeech('  NO_RESPONSE_NEEDED  ').silent).toBe(true);
  });

  it('strips the token but still speaks the rest, if the model mixed them', () => {
    const r = guardSpeech('NO_RESPONSE_NEEDED כן, אני מקשיבה.');
    expect(r.silent).toBe(false);
    expect(r.text).toBe('כן, אני מקשיבה.');
  });
});

describe('speech guard — she must not claim a booking that does not exist', () => {
  it('rewrites "קבעתי לך שיחת דמו למחר" — nothing was booked', () => {
    // Verbatim from the call. No calendar was touched; the agent has no tools. The lead would have
    // hung up believing he had a demo at 10am, and nobody would ever have rung him.
    const r = guardSpeech('מעולה, שמחה לשמוע. קבעתי לך שיחת דמו למחר.');
    expect(r.text).not.toMatch(/קבעתי לך/u);
    expect(r.text).toMatch(/אעביר את הבקשה לצוות/u);
    expect(r.interventions.length).toBeGreaterThan(0);
  });

  it('rewrites "תקבל אישור" — no confirmation is being sent by anyone', () => {
    const r = guardSpeech('הדמו למחר ב-10. תקבל אישור, תודה רבה ונדבר!');
    expect(r.text).not.toMatch(/תקבל אישור/u);
    expect(r.text).toMatch(/אעביר את הבקשה לצוות/u);
  });

  it('leaves "אני בודקת זמינות" ALONE — a promise to look is not a lie', () => {
    // Deliberately narrow. Only the COMPLETED act is caught. Over-blocking would make her mute
    // in the middle of a sale, which is its own failure.
    const t = 'מעולה, אני בודקת זמינות ליום שלישי בשעה שלוש.';
    expect(guardSpeech(t).text).toBe(t);
    expect(guardSpeech(t).interventions).toHaveLength(0);
  });

  it('leaves an ordinary sales sentence completely untouched', () => {
    const t = 'אנחנו בונים סוכני AI לשיחות קוליות ולוואטסאפ. מה השם המלא?';
    expect(guardSpeech(t).text).toBe(t);
    expect(guardSpeech(t).interventions).toHaveLength(0);
  });
});

describe('speech guard — model-emitted niqqud is stripped, OUR verified marks survive', () => {
  it('removes niqqud/cantillation the model may emit', () => {
    const r = guardSpeech('שָׁלוֹם, מְדַבֶּרֶת קֶרֶן.');
    expect(r.text).toBe('שלום, מדברת קרן.');
    expect(r.interventions).toContain(
      'stripped model-emitted niqqud (unverified pointing is unreliable on Cartesia)',
    );
  });

  it('is a silent no-op on ordinary unpointed Hebrew', () => {
    const t = 'שלום, מדברת קרן. איך אפשר לעזור?';
    expect(guardSpeech(t).text).toBe(t);
    expect(guardSpeech(t).interventions).toHaveLength(0);
  });

  it('THE ORDER IS LOAD-BEARING: the strip runs first, so the pronunciation fix survives it', () => {
    // If stripNiqqud ever moves after the tables, this sentence loses its kamatz silently and
    // every pronunciation fix in the file is dead code. The model's own pointing goes; ours stays.
    const r = guardSpeech('שָׁלוֹם, מה השם שלך?');
    expect(r.text).toBe('שלום, מה השם שלךָ?');
  });
});

/**
 * The streaming guard. THIS IS THE ONE THAT MATTERS FOR LATENCY.
 *
 * The first version buffered the whole reply and cost 718ms per turn. She must start speaking after
 * her FIRST SENTENCE, not after her last.
 */
describe('guardStream — she speaks before the reply is finished', () => {
  const chunks = async function* (...c: string[]) {
    for (const x of c) yield x;
  };
  const drain = async (it: AsyncIterable<string>) => {
    const out: string[] = [];
    for await (const x of it) out.push(x);
    return out;
  };

  it('emits the FIRST sentence before the rest of the reply has even arrived', async () => {
    // This is the whole point. If this test ever asserts a single joined string, the latency
    // regression is back.
    const out = await drain(guardStream(chunks('מעולה. ', 'איזה עסק ', 'יש לך?')));
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toContain('מעולה');
  });

  it('still catches a false booking claim mid-stream', async () => {
    const out = (await drain(guardStream(chunks('מעולה. ', 'קבעתי לך שיחת דמו למחר. ', 'תודה!')))).join('');
    expect(out).not.toMatch(/קבעתי לך/u);
    expect(out).toMatch(/אעביר את הבקשה לצוות/u);
    expect(out).toMatch(/מעולה/u); // the innocent sentence survives
  });

  it('still swallows NO_RESPONSE_NEEDED entirely', async () => {
    const out = (await drain(guardStream(chunks('NO_RESPONSE', '_NEEDED')))).join('').trim();
    expect(out).toBe('');
  });

  it('does not split a sentence on a number or a time', async () => {
    // "ב-10." and "10:30" must not be cut in half and handed to the TTS as fragments.
    const out = (await drain(guardStream(chunks('הדמו נקבע ל-10:30 מחר בבוקר.')))).join('');
    expect(out).toContain('10:30');
  });

  it('leaves a normal reply completely intact', async () => {
    const out = (await drain(guardStream(chunks('אנחנו בונים סוכני AI. ', 'מה השם המלא?')))).join('');
    expect(out).toContain('אנחנו בונים סוכני AI');
    expect(out).toContain('מה השם המלא');
  });
});

/**
 * PHASE 4: after book_meeting SUCCEEDS on a call, "קבעתי לך" stops being a lie — and rewriting the
 * truth would itself be the lie. The predicate is ToolRuntimeContext.bookingCompleted.
 */
describe('guardStream — the booking-claim rewrite is conditional on a REAL booking', () => {
  const chunks = async function* (...c: string[]) {
    for (const x of c) yield x;
  };
  const drain = async (it: AsyncIterable<string>) => {
    const out: string[] = [];
    for await (const x of it) out.push(x);
    return out;
  };

  it('booking completed → the claim passes through, because it is now TRUE', async () => {
    const out = (
      await drain(guardStream(chunks('קבעתי לך שיחת דמו ליום ראשון בעשר. ', 'נשלח לך את הפרטים!'), () => true))
    ).join('');
    // The claim SURVIVES (as "קבעתי לךָ" — the pronunciation fix still applies, see below)...
    expect(out).toMatch(/קבעתי לךָ/u);
    // ...and is NOT rewritten into the pass-to-the-team line.
    expect(out).not.toMatch(/אעביר את הבקשה לצוות/u);
  });

  it('tools enabled but nothing booked YET → the claim is still a lie, still rewritten', async () => {
    const out = (
      await drain(guardStream(chunks('קבעתי לך שיחת דמו למחר.'), () => false))
    ).join('');
    expect(out).not.toMatch(/קבעתי לך/u);
    expect(out).toMatch(/אעביר את הבקשה לצוות/u);
  });

  it('the predicate is read PER SENTENCE — a booking mid-reply frees the very next sentence', async () => {
    let booked = false;
    const source = async function* () {
      yield 'קבעתי לך פגישה. '; // sentence 1 — before the booking: must be rewritten
      booked = true; // book_meeting succeeded between sentences
      yield 'קבעתי לך פגישה ליום ראשון.'; // sentence 2 — now true: must survive
    };
    const out = await drain(guardStream(source(), () => booked));
    expect(out[0]).not.toMatch(/קבעתי/u); // rewritten to the pass-to-the-team truth
    expect(out[1]).toMatch(/קבעתי לךָ/u); // survives (pronunciation-fixed, not censored)
  });

  it('NO_RESPONSE_NEEDED and the pronunciation fix stay armed even after a booking', async () => {
    const out = (
      await drain(guardStream(chunks('NO_RESPONSE_NEEDED שלחתי לך אישור למייל שלך.'), () => true))
    ).join('');
    expect(out).not.toMatch(/NO_RESPONSE_NEEDED/u);
    expect(out).toMatch(/שלךָ/u); // the pronunciation fix is unconditional
  });

  it('guardSpeech honours the flag directly', () => {
    const claim = 'קבעתי לך שיחת דמו למחר.';
    expect(guardSpeech(claim, { allowBookingClaims: true }).text).toMatch(/קבעתי לךָ/u);
    expect(guardSpeech(claim, { allowBookingClaims: false }).text).not.toMatch(/קבעתי/u);
    expect(guardSpeech(claim).text).not.toMatch(/קבעתי/u); // default stays fail-closed
  });
});

/**
 * THE GENDER FIX — a TTS bug, fixed in the pipeline, not by crippling her vocabulary.
 *
 * Koren: "אותה מילה, פעם זכר פעם נקבה" — Cartesia guesses the vowels at random, because Hebrew does
 * not write them. And: "אל תגדיר אותם כמילים אסורות, זה לא פתרון" — so the LLM keeps its natural
 * Hebrew and the pipeline fixes the SOUND.
 */
describe('forceAddressGender — fixing pronunciation, not vocabulary', () => {
  it('forces שלך to be pronounced shel-KHA with ONE kamatz — the round-3 winner', () => {
    // Verified against the real TTS on sonic-3.5 (tests/hebrew-tts-niqqud-ab, round 3): the
    // minimal-niqqud variant beat the old שלכה respelling by ear, and "שלךָ" round-trips through
    // an 8kHz line + Soniox back to "שלך". The mark is non-standard output nobody ever sees.
    expect(forceMasculineAddress('מה מספר הטלפון שלך?')).toBe('מה מספר הטלפון שלךָ?');
  });

  it('fixes every ambiguous suffix in the masculine — per-word winners, not one technique', () => {
    // Kamatz won for the first four (rounds 3/3b: m1/m2/bm1/bm2 = C). For the last three Koren
    // rejected plain and kamatz (3b), and round 3c confirmed the כה respelling over a patach
    // mark (c1/c2/c3 = B). The split is final — per-word winners, all by ear.
    expect(forceMasculineAddress('אשלח לך')).toBe('אשלח לךָ');
    expect(forceMasculineAddress('אחזור אליך')).toBe('אחזור אליךָ');
    expect(forceMasculineAddress('לשמוע אותך')).toBe('לשמוע אותךָ');
    expect(forceMasculineAddress('לדבר איתך')).toBe('לדבר איתכה');
    expect(forceMasculineAddress('בשבילך')).toBe('בשבילכה');
    expect(forceMasculineAddress('עבורך')).toBe('עבורכה');
  });

  it('fixes every ambiguous suffix in the feminine — per-word winners, not one technique', () => {
    // Koren's rounds 3/3b verdicts verbatim: f1=C f2=B bf1=B bf2=C bf3=B bf4=C bf5=C.
    // Each entry is whatever his ear picked — mixing respelling and niqqud is the point.
    expect(forceAddressGender('אשלח לך', 'f')).toBe('אשלח לָךְ');
    expect(forceAddressGender('מה השם שלך?', 'f')).toBe('מה השם שלאך?');
    expect(forceAddressGender('אחזור אליך', 'f')).toBe('אחזור אלַיִךְ');
    expect(forceAddressGender('לשמוע אותך', 'f')).toBe('לשמוע אותאך');
    expect(forceAddressGender('לדבר איתך', 'f')).toBe('לדבר איתאך');
    expect(forceAddressGender('בשבילך', 'f')).toBe('בשבילֵךְ');
    expect(forceAddressGender('עבורך', 'f')).toBe('עבורֵךְ');
  });

  it('NEVER corrupts a word that merely CONTAINS the letters — in either gender', () => {
    // The trap: JS \b does not work on Hebrew (Hebrew letters are not word characters), so a naive
    // boundary would match inside "משלך" / "הלך" / "שלכם" and mangle them.
    for (const gender of ['m', 'f'] as const) {
      expect(forceAddressGender('הוא הלך הביתה', gender)).toBe('הוא הלך הביתה');
      expect(forceAddressGender('הצוות שלכם', gender)).toBe('הצוות שלכם');
      expect(forceAddressGender('משלך', gender)).toBe('משלך');
      expect(forceAddressGender('לכל הלקוחות', gender)).toBe('לכל הלקוחות');
    }
  });

  it('is idempotent — running the guard twice must not stack marks', () => {
    const once = forceMasculineAddress('אשלח לך');
    expect(forceMasculineAddress(once)).toBe(once);
  });

  it('רוצה follows the ADDRESSEE in second person — rotsE for him, rotsA for her', () => {
    expect(forceMasculineAddress('אתה רוצה לשמוע עוד?')).toBe('אתה רוצֶה לשמוע עוד?');
    expect(forceAddressGender('את רוצה לשמוע עוד?', 'f')).toBe('את רוצָה לשמוע עוד?');
    // Bare "רוצה?" — the implied subject is the caller.
    expect(forceMasculineAddress('רוצה שאשלח פרטים?')).toBe('רוצֶה שאשלח פרטים?');
    expect(forceAddressGender('רוצה שאשלח פרטים?', 'f')).toBe('רוצָה שאשלח פרטים?');
  });

  it('רוצה with an explicit OTHER subject is not the addressee\'s business', () => {
    // "אני רוצה" is the agent about herself; "הוא רוצה" a third person — the gender tables must
    // leave both alone (the subject-side dictionary fixes them, tested below).
    expect(forceMasculineAddress('אני רוצה לבדוק משהו')).toBe('אני רוצה לבדוק משהו');
    expect(forceAddressGender('הוא רוצה להצטרף', 'f')).toBe('הוא רוצה להצטרף');
  });

  it('never touches מרוצה — a different word that merely ends in the same letters', () => {
    for (const gender of ['m', 'f'] as const) {
      expect(forceAddressGender('הלקוחות שלנו מרוצים והוא מרוצה מאוד', gender)).toBe(
        'הלקוחות שלנו מרוצים והוא מרוצה מאוד',
      );
    }
  });

  it('leaves her OWN feminine speech untouched — only the ADDRESS changes', () => {
    // Three genders, three persons: she is feminine, the company is masculine plural, the lead is
    // his own gender. Only the last one is being fixed here.
    const t = 'אני יכולה לבדוק. אנחנו בונים סוכני AI.';
    expect(forceMasculineAddress(t)).toBe(t);
  });

  it('runs inside the live guard, so what Cartesia SAYS is masculine by default', () => {
    expect(guardSpeech('מה השם שלך? אשלח לך אישור.').text).toBe('מה השם שלךָ? אשלח לךָ אישור.');
  });
});

describe('the pronunciation dictionary — gender-neutral fixed words', () => {
  it('restores the swallowed final vowel of לוודא with one tsere', () => {
    // sonic-3.5 says "levad", dropping the final vowel. Round-3 winner: לוודֵא ("levadé"),
    // which Soniox round-trips back as the plain word.
    expect(applyPronunciationFixes('אני רוצה לוודא שהפרטים נכונים.')).toBe(
      'אני רוצָה לוודֵא שהפרטים נכונים.',
    );
  });

  it('does not touch other forms of the same root', () => {
    const t = 'אני מוודאת את הפרטים, והם וידאו את השעה.';
    expect(applyPronunciationFixes(t)).toBe(t);
  });

  it('runs inside the live guard', () => {
    expect(guardSpeech('רק לוודא, הפגישה מחר?').text).toBe('רק לוודֵא, הפגישה מחר?');
  });

  it('רוצה follows its SUBJECT: the agent is feminine about herself even on a masculine call', () => {
    // "אני רוצה" is Keren speaking — feminine (rotsA) regardless of who she is talking to.
    // When tenant agent_persona ships, this gender comes from it.
    expect(applyPronunciationFixes('אני רוצה לוודא שהבנתי')).toBe('אני רוצָה לוודֵא שהבנתי');
    expect(applyPronunciationFixes('אני לא רוצה להעמיס')).toBe('אני לא רוצָה להעמיס');
    expect(applyPronunciationFixes('הוא רוצה להצטרף והיא רוצה פרטים')).toBe(
      'הוא רוצֶה להצטרף והיא רוצָה פרטים',
    );
  });

  it('the two רוצה mechanisms compose in one guarded sentence', () => {
    expect(guardSpeech('אני רוצה לוודא — אתה רוצה שאשלח לך פרטים?').text).toBe(
      'אני רוצָה לוודֵא — אתה רוצֶה שאשלח לךָ פרטים?',
    );
  });
});

/**
 * ROUND 10, 2026-08-31 — KOREN'S POINTED FILLERS, AND THE STRIP THAT WOULD HAVE ERASED THEM.
 *
 * He picked `אֶממ...`, `רֶגַע...` and `אֶה...` by ear over their unpointed forms. Writing those
 * strings into THINKING_FILLERS_HE is NOT enough on its own and that is the whole point of this
 * block: the filler is injected by llmNode / withFiller INSIDE guardStream, so it meets the same
 * niqqud strip as the model's text and arrives at Cartesia unpointed, with nothing failing
 * anywhere. The verdict would be applied in the bank and reverted in the pipeline.
 *
 * These assertions are the end-to-end ones — what the TTS actually receives.
 */
describe('the thinking fillers reach the voice with the marks he chose', () => {
  const chunks = async function* (...c: string[]) { for (const x of c) yield x; };
  const drain = async (it: AsyncIterable<string>) => {
    const o: string[] = [];
    for await (const x of it) o.push(x);
    return o.join('');
  };

  it('every filler in the bank survives guardSpeech byte-for-byte', () => {
    for (const filler of THINKING_FILLERS_HE) {
      expect(guardSpeech(`${filler} בוא נבדוק.`).text, filler).toBe(`${filler} בוא נבדוק.`);
    }
  });

  it('and survives the STREAM, which is the path production actually uses', async () => {
    const out = await drain(guardStream(chunks('אֶממ... ', 'בוא נבדוק מה מתאים.')));
    expect(out).toContain('אֶממ...');
  });

  it('re-points an unpointed filler the model wrote itself', () => {
    // Same reasoning as every other row of the dictionary: a screened spelling is how the word is
    // said, whoever typed it.
    expect(guardSpeech('אממ... בוא נבדוק.').text).toBe('אֶממ... בוא נבדוק.');
    expect(guardSpeech('רגע... בוא נבדוק.').text).toBe('רֶגַע... בוא נבדוק.');
  });

  it('SCOPED TO THE ELLIPSIS: "רגע, בודקת." is not the filler and is left alone', () => {
    // A system-prompt opener the model writes constantly. Koren judged the hesitation, not the
    // word in every position it appears in.
    expect(guardSpeech('רגע, בודקת. יש לי כמה אפשרויות.').text).toBe(
      'רגע, בודקת. יש לי כמה אפשרויות.',
    );
    expect(guardSpeech('רגע.').text).toBe('רגע.');
  });

  it('AND IT MUST NOT REPOINT THE DICTATION NOD — that card has no verdict', () => {
    // Round-10 card `n1`: he rejected all four spellings of "אה אה.". A bare אה → אֶה rule would
    // have changed the nod on his behalf, which is exactly the kind of silent drift this round is
    // about. The nod is spoken alone, so it never carries the ellipsis the rule keys on.
    expect(guardSpeech(DICTATION_NOD).text).toBe('אה אה.');
  });
});

/**
 * THE GENDER TRACKER — the feminine table needs to know the lead is a woman, and only the
 * conversation knows that. The LLM already conjugates to the gender it believes it is addressing
 * ("תרצי" vs "תרצה"); the tracker reads that evidence and the suffix table follows it.
 *
 * Koren's rule: masculine by default (names are unreliable), flip on CLEAR feminine conjugation
 * only, and the flip is one-way — masculine 2nd-person future is spelled identically to 3rd-person
 * feminine ("היא תוכל"), so flipping back on it would misfire on a sentence about the agent herself.
 */
describe('AddressGenderTracker — her own conjugation decides the table', () => {
  const chunks = async function* (...c: string[]) {
    for (const x of c) yield x;
  };
  const drain = async (it: AsyncIterable<string>) => {
    const out: string[] = [];
    for await (const x of it) out.push(x);
    return out;
  };

  it('starts masculine — the default when nothing is known', () => {
    expect(new AddressGenderTracker().current).toBe('m');
  });

  it('flips on an unambiguous feminine future verb, and the SAME sentence is already feminine', async () => {
    const tracker = new AddressGenderTracker();
    const out = (await drain(guardStream(chunks('מתי תרצי שאחזור אליך?'), () => false, tracker))).join('');
    expect(tracker.current).toBe('f');
    expect(out).toContain('אלַיִךְ'); // the feminine table applied to the flipping sentence itself
  });

  it('flips on את + present-tense verb ("את יכולה")', () => {
    const tracker = new AddressGenderTracker();
    tracker.observe('אז את יכולה לספר לי קצת על העסק?');
    expect(tracker.current).toBe('f');
  });

  it('2026-08-26 call regressions: the forms the LLM ACTUALLY used, all must flip', () => {
    // Each of these was said on the test call while the tracker was watching a thinner list —
    // the flip came a full reply late and the caller heard masculine right after correcting her.
    for (const said of [
      'בואי נקבע שיחת דמו קצרה עם קורן שבה תראי איך זה עובד בפועל.',
      'כדי שלא תאבדי לידים בגלל עומס או איחור בתגובה.',
      'מה גורם לך להרגיש שזה אולי לא מה שאת רוצה?', // prefixed שאת
      'אני אפנה אליך בלשון נקבה.', // her explicit promise
    ]) {
      const tracker = new AddressGenderTracker();
      tracker.observe(said);
      expect(tracker.current, said).toBe('f');
    }
  });

  it('does NOT flip on the object-marker את ("את הפרטים")', () => {
    const tracker = new AddressGenderTracker();
    tracker.observe('אשלח לך את הפרטים למייל.');
    expect(tracker.current).toBe('m');
  });

  it('does NOT flip on her own feminine self-reference — "אני בודקת" is about HER', () => {
    const tracker = new AddressGenderTracker();
    tracker.observe('רגע, אני בודקת זמינות. אני שמחה לעזור.');
    expect(tracker.current).toBe('m');
  });

  it('flips BACK on unambiguous masculine — "אתה" and the explicit לשון-זכר promise', () => {
    // The first version was one-way sticky, and the 2026-08-26 caller asked to switch back to
    // masculine and could not get it — "שוב, אותה טעות". Latest signal wins now.
    const tracker = new AddressGenderTracker();
    tracker.observe('מתי תרצי לקבוע?');
    expect(tracker.current).toBe('f');
    tracker.observe('רגע, אתה עוד על הקו?'); // verbatim from the call
    expect(tracker.current).toBe('m');
    tracker.observe('אם תרצי, נמשיך.');
    tracker.observe('אני אדבר בלשון זכר.'); // her explicit promise, also from the call
    expect(tracker.current).toBe('m');
  });

  it('an AMBIGUOUS masculine form does not flip back — "היא תוכל" is 3rd-person feminine', () => {
    const tracker = new AddressGenderTracker();
    tracker.observe('מתי תרצי לקבוע?');
    tracker.observe('המנהלת שלנו תוכל לחזור אליך מחר.');
    expect(tracker.current).toBe('f');
  });

  it('within one sentence, the LATEST unambiguous marker wins', () => {
    const tracker = new AddressGenderTracker();
    tracker.observe('אתה אמרת שאדבר בלשון נקבה.'); // masc pronoun first, feminine promise later
    expect(tracker.current).toBe('f');
  });

  it('catches a prefixed feminine verb ("כשתרצי")', () => {
    const tracker = new AddressGenderTracker();
    tracker.observe('כשתרצי, נקבע פגישה.');
    expect(tracker.current).toBe('f');
  });

  it('the CALLER self-identifying flips immediately, both directions', () => {
    // Fed from the ConversationItemAdded hook, so the very next reply is already correct —
    // on the test call this correction was heard one full reply late.
    const tracker = new AddressGenderTracker();
    expect(tracker.observeUser('יכולים לפנות אליי בלשון נקבה, אני אישה.')).toBe('f'); // verbatim
    expect(tracker.current).toBe('f');
    expect(tracker.observeUser('בעצם עדיף בלשון זכר.')).toBe('m');
    expect(tracker.current).toBe('m');
  });

  it('a caller utterance with NO clear signal changes nothing', () => {
    const tracker = new AddressGenderTracker();
    expect(tracker.observeUser('אני מוכר אתרים לעסקים.')).toBe(null);
    expect(tracker.current).toBe('m');
  });

  it('without a tracker, guardStream keeps the pre-round-3 masculine behaviour', async () => {
    const out = (await drain(guardStream(chunks('מה השם שלך?')))).join('');
    expect(out).toContain('שלךָ');
  });
});

describe('withFiller — the hesitation goes FIRST, never last', () => {
  const chunks = async function* (...c: string[]) { for (const x of c) yield x; };
  const drain = async (it: AsyncIterable<string>) => { const o: string[] = []; for await (const x of it) o.push(x); return o.join(''); };

  it('puts the hesitation at the START of her reply', async () => {
    // The bug: session.say() QUEUED the filler, so it played AFTER she finished speaking.
    //   היא מדברת (1152ms)
    //   >>> FILLER: אה...        <- fired the instant she stopped
    // Prepending makes correct placement structural instead of a matter of timing.
    const out = await drain(withFiller('אממ...', chunks('כן, ', 'אנחנו בונים סוכני AI.')));
    expect(out.startsWith('אממ...')).toBe(true);
    expect(out).toContain('אנחנו בונים סוכני AI');
  });

  it('adds nothing at all when she did not need to think', async () => {
    expect(await drain(withFiller(null, chunks('כן, בשמחה.')))).toBe('כן, בשמחה.');
  });

  // ── The 2026-08-29 call: a hesitation with no reply behind it ────────────────────────────────
  //
  //   "אהה."   @ 29.3s   →  5.4 SECONDS OF NOTHING  →  "אוקיי. כמה פניות נכנסות אליךָ ביום…"
  //
  // ttsNode runs on the first text chunk of an inference STEP, and a step whose only real output
  // is a tool call carries no words at all. Prepending there produced one word, a hole, and then
  // the real sentence — Koren: "it sounds like she got something like script to say."

  it('DROPS the hesitation when the step carries no words of her own (the tool-call step)', async () => {
    let used = false;
    const out = await drain(
      withFiller('אממ...', chunks('אוקיי. '), { leadIn: 'אוקיי. ', onUsed: () => (used = true) }),
    );
    expect(out).toBe('אוקיי. '); // the acknowledgement, and nothing orphaned behind it
    expect(used).toBe(false); // ...so the call's hesitation budget is not spent either
  });

  it('drops it just the same when there is no acknowledgement and no reply', async () => {
    let used = false;
    expect(await drain(withFiller('אממ...', chunks(), { onUsed: () => (used = true) }))).toBe('');
    expect(used).toBe(false);
  });

  it('lets the acknowledgement out FIRST and unheld, then hesitates before her real words', async () => {
    // Order is the entire feature: holding the acknowledgement to inspect what follows would give
    // back the ~1s that instant-ack exists to win (dropAckEcho learned this the hard way).
    const out: string[] = [];
    for await (const chunk of withFiller('אממ...', chunks('אוקיי. ', 'כמה פניות ', 'נכנסות אליך?'), {
      leadIn: 'אוקיי. ',
    })) {
      out.push(chunk);
    }
    expect(out[0]).toBe('אוקיי. ');
    expect(out.join('')).toBe('אוקיי. אממ... כמה פניות נכנסות אליך?');
  });

  it('reports through onUsed only when the word actually reached the TTS', async () => {
    let used = 0;
    await drain(withFiller('אממ...', chunks('כן, בשמחה.'), { onUsed: () => (used += 1) }));
    expect(used).toBe(1);
  });

  it('still declines to double a word the opener repeats — and does not spend the budget', async () => {
    let used = false;
    const out = await drain(withFiller('רגע...', chunks('רגע, בודקת.'), { onUsed: () => (used = true) }));
    expect(out).toBe('רגע, בודקת.');
    expect(used).toBe(false);
  });
});

describe('notifyIfSilent — deliberate silence must be detectable', () => {
  const chunks = async function* (...c: string[]) { for (const x of c) yield x; };
  const drain = async (it: AsyncIterable<string>) => { const o: string[] = []; for await (const x of it) o.push(x); return o.join(''); };

  it('reports a reply that the guard emptied — the twenty-second silence', async () => {
    // The exact shape of the 2026-08-16 failure: the caller opened with a hold word, the model
    // answered with nothing but the control token, the guard stripped it, and she stayed mute
    // until HE rescued the call ("הלו, מישהו שם?"). Somebody has to notice.
    let silent = false;
    const out = await drain(notifyIfSilent(guardStream(chunks('NO_RESPONSE_NEEDED')), () => { silent = true; }));

    expect(out.trim()).toBe('');
    expect(silent).toBe(true);
  });

  it('stays quiet when she actually said something', async () => {
    let silent = false;
    const out = await drain(notifyIfSilent(guardStream(chunks('כן, ', 'אני כאן.')), () => { silent = true; }));

    expect(out).toContain('אני כאן');
    expect(silent).toBe(false);
  });

  it('does not count whitespace as speech', async () => {
    let silent = false;
    await drain(notifyIfSilent(chunks('   ', '\n'), () => { silent = true; }));

    expect(silent).toBe(true);
  });

  it('passes the reply through byte for byte — it observes, it does not edit', async () => {
    const spoken = 'מעולה. לפני הכל — עם מי אני מדברת?';
    expect(await drain(notifyIfSilent(chunks(spoken), () => {}))).toBe(spoken);
  });
});

describe('dropAckEcho — the acknowledgement must never be delayed', () => {
  const chunks = async function* (...c: string[]) { for (const x of c) yield x; };
  const drain = async (it: AsyncIterable<string>) => { const o: string[] = []; for await (const x of it) o.push(x); return o.join(''); };

  it('emits the acknowledgement before reading anything from the model', async () => {
    // THE WHOLE FEATURE. Holding "אוקיי." even briefly to inspect what follows gives back the ~1s
    // it exists to win, so it must leave on the first pull, ahead of any model token.
    let modelRead = false;
    const model = async function* () {
      modelRead = true;
      yield 'אוקיי. ';
      yield 'בשמחה. אנחנו בונים סוכני AI.';
    };
    const it = dropAckEcho('אוקיי.', model())[Symbol.asyncIterator]();
    const first = await it.next();

    expect(first.value).toBe('אוקיי. ');
    void modelRead; // the generator must have started, but the ack is out on the first yield
  });

  it('drops the model echoing our word', async () => {
    const out = await drain(dropAckEcho('אוקיי.', chunks('אוקיי. ', 'אוקיי, בהחלט. ', 'אנחנו בונים.')));
    expect(out).toBe('אוקיי. בהחלט. אנחנו בונים.');
  });

  it('keeps a different opener untouched', async () => {
    const out = await drain(dropAckEcho('אוקיי.', chunks('אוקיי. ', 'בשמחה. ', 'אנחנו בונים.')));
    expect(out).toBe('אוקיי. בשמחה. אנחנו בונים.');
  });

  it('passes everything through when no acknowledgement was spoken', async () => {
    expect(await drain(dropAckEcho(null, chunks('בשמחה. ', 'אנחנו בונים.')))).toBe('בשמחה. אנחנו בונים.');
  });

  it('emits the reply verbatim if the prefix never arrives', async () => {
    // llmNode decided not to inject (instant ack off, or a realtime model). Never guess.
    expect(await drain(dropAckEcho('אוקיי.', chunks('בשמחה. אנחנו בונים.')))).toBe('בשמחה. אנחנו בונים.');
  });

  // EVERY TEST ABOVE FEEDS THE ACK WITH ITS TRAILING SPACE, WHICH IS WHY THEY ALL PASSED WHILE
  // PRODUCTION WAS BROKEN. Text is re-chunked between llmNode and ttsNode, so the injected
  // "אוקיי. " arrives as "אוקיי." — the old `startsWith(ack + ' ')` missed, and the function then
  // waited for 60 characters of model text. Measured on the 2026-08-17 call: the acknowledgement
  // was held 743-1944ms and came out WITH the reply it was supposed to precede.
  it('recognises the acknowledgement however the SDK re-chunked it', async () => {
    for (const shape of [['אוקיי.'], ['אוקיי.', ' בשמחה. אנחנו בונים.'], ['או', 'קיי.', 'בשמחה. אנחנו בונים.']]) {
      const out = await drain(dropAckEcho('אוקיי.', chunks(...shape, ' אנחנו בונים.')));
      expect(out.startsWith('אוקיי. ')).toBe(true);
    }
  });

  it('does not wait for the model to produce its first word', async () => {
    // The failure this file missed, stated as a clock: the model takes 200ms to say anything and
    // the acknowledgement must already be gone. It is the entire <1s mechanism.
    const model = async function* () {
      yield 'אוקיי.'; // no trailing space — as production actually delivers it
      await new Promise((r) => setTimeout(r, 200));
      yield 'אנחנו בונים סוכני AI לשיחות קוליות ולוואטסאפ, שעוזרים לעסקים לענות לפניות.';
    };
    const startedAt = Date.now();
    const first = await dropAckEcho('אוקיי.', model())[Symbol.asyncIterator]().next();

    expect(first.value).toBe('אוקיי. ');
    expect(Date.now() - startedAt).toBeLessThan(100);
  });
});

/**
 * The number/time speech normalizer INSIDE the guard (VOICE_SPEECH_NUMBERS_ENABLED). The full
 * digits→words table lives in speech-numbers.test.ts; here we pin the wiring: opt-in flag,
 * ordering against the other fixes, and the streaming contract.
 */
describe('guardSpeech — digits become colloquial Hebrew words (opt-in)', () => {
  it('is OFF by default — legacy callers and the kill-switch keep digit read-out', () => {
    const t = 'הדמו נקבע ל-10:30 מחר בבוקר.';
    expect(guardSpeech(t).text).toBe(t);
  });

  it('ON: the complaint sentence — "16:30" is spoken "ארבע וחצי"', () => {
    const r = guardSpeech('נתראה מחר ב-16:30.', { spokenNumbers: true });
    expect(r.text).toBe('נתראה מחר בארבע וחצי.');
    expect(r.interventions).toContain('spoke digits as Hebrew words (time/phone/price)');
  });

  it('THE ORDER IS PINNED: normalizer runs BEFORE the gender tables, in one sentence', () => {
    // A time and an ambiguous suffix in the same sentence: both fixes must land. If the
    // normalizer ever moves after the tables, this still passes — but if it moves after
    // stripNiqqud's own position the dictionary stops seeing number words; keep it first.
    const r = guardSpeech('נדבר ב-16:30, מה השם שלך?', { spokenNumbers: true });
    expect(r.text).toBe('נדבר בארבע וחצי, מה השם שלךָ?');
  });

  it('model-emitted niqqud in the same sentence is still stripped, the words still convert', () => {
    const r = guardSpeech('שָׁלוֹם, נדבר ב-10:00.', { spokenNumbers: true });
    expect(r.text).toBe('שלום, נדבר בעשר.');
  });

  it('a false booking claim carrying a time is rewritten FIRST — no digits survive either way', () => {
    const r = guardSpeech('קבעתי לך שיחת דמו ל-16:30 מחר.', { spokenNumbers: true });
    expect(r.text).not.toMatch(/16:30|קבעתי/u);
    expect(r.text).toMatch(/אעביר את הבקשה לצוות/u);
  });
});

describe('guardStream — a time can never straddle a chunk boundary', () => {
  const chunks = async function* (...c: string[]) {
    for (const x of c) yield x;
  };
  const drain = async (it: AsyncIterable<string>) => {
    const out: string[] = [];
    for await (const x of it) out.push(x);
    return out;
  };

  it('a time split across LLM chunks is reassembled before it is normalized', async () => {
    // sentenceEnd refuses to flush at a mark without trailing whitespace, so the buffer holds
    // "…10:" until the rest arrives — the normalizer only ever sees whole sentences.
    const out = (
      await drain(guardStream(chunks('מ-10:', '30 עד 15:0', '0.'), () => false, undefined, true))
    ).join('');
    expect(out.trim()).toBe('מעשר וחצי עד שלוש.');
  });

  it('streaming still flushes sentence-by-sentence with the normalizer on', async () => {
    const out = await drain(
      guardStream(chunks('מעולה. ', 'נתראה ב-16:30.'), () => false, undefined, true),
    );
    expect(out.length).toBeGreaterThan(1);
    expect(out.join('')).toContain('בארבע וחצי');
  });
});

/**
 * "נעים מאוד" is the introduction, and there is exactly one introduction per call.
 *
 * The 2026-08-30 call said it at 35s (right) and again at 164s (wrong) — triggered by a surname
 * landing in capture_lead_info. Koren: "זה מיותר ומוזר, זה משהו שאומרים רק בתחילת השיחה". Every
 * sentence below is from that transcript.
 */
describe('guardSpeech — she introduces herself once', () => {
  it('drops a repeat greeting that is the whole sentence', () => {
    const r = guardSpeech('נעים מאוד.', { allowIntroduction: false });
    expect(r.text).toBe('');
    expect(r.silent).toBe(true);
    expect(r.interventions.join(' ')).toMatch(/repeat greeting/u);
  });

  it('takes the name that was riding on it — "נעים מאוד, קורן." is not "קורן."', () => {
    const r = guardSpeech('נעים מאוד, קורן.', { allowIntroduction: false, leadName: 'קורן' });
    expect(r.text).toBe('');
    expect(r.silent).toBe(true);
  });

  it('takes a full name, both tokens', () => {
    const r = guardSpeech('נעים מאוד, קורן שטרית.', {
      allowIntroduction: false,
      leadName: 'קורן שטרית',
    });
    expect(r.text).toBe('');
  });

  it('keeps the rest of the sentence when the greeting only opened it', () => {
    const r = guardSpeech('נעים מאוד, בוא נקבע דמו קצר.', { allowIntroduction: false });
    expect(r.text).toBe('בוא נקבע דמו קצר.');
    expect(r.silent).toBe(false);
  });

  it('leaves "נעים מאוד לשמוע" alone — that is a different sentence', () => {
    // The lookahead requires the phrase to STAND as a greeting: sentence end, comma or dash.
    const r = guardSpeech('נעים מאוד לשמוע את זה.', { allowIntroduction: false });
    expect(r.text).toBe('נעים מאוד לשמוע את זה.');
  });

  it('never touches a word that merely contains the letters', () => {
    const r = guardSpeech('זה נעים לשמוע, תודה.', { allowIntroduction: false });
    expect(r.text).toBe('זה נעים לשמוע, תודה.');
  });

  it('leaves the FIRST greeting completely alone — allowIntroduction defaults to true', () => {
    expect(guardSpeech('נעים מאוד, קורן.').text).toBe('נעים מאוד, קורן.');
    expect(guardSpeech('נעים מאוד, קורן.', { allowIntroduction: true }).text).toBe('נעים מאוד, קורן.');
  });

  /**
   * NOTE 2, 2026-08-31: *"פסיקים ונקודה… ב'נעים מאוד, כורן' יוצר ממש דיבור רובוטי. זה אמור לבוא
   * 'נעים מאוד כורן' במשפט חד בלי עצירות."* The prompt now teaches the comma-less form — and the
   * comma was the only thing telling the old lookahead where the greeting ended. Without these the
   * repeat-greeting guard would have gone on passing its tests while silently ceasing to fire on
   * the exact sentence she now says.
   */
  it('still recognises the greeting when the comma before the name is GONE', () => {
    const r = guardSpeech('נעים מאוד קורן.', { allowIntroduction: false, leadName: 'קורן' });
    expect(r.text).toBe('');
    expect(r.silent).toBe(true);
  });

  it('comma-less, full name, both tokens', () => {
    const r = guardSpeech('נעים מאוד קורן שטרית.', {
      allowIntroduction: false,
      leadName: 'קורן שטרית',
    });
    expect(r.text).toBe('');
  });

  it('comma-less needs the name to be a WHOLE word', () => {
    // Without the boundary, a lead called קורן would make "נעים מאוד קורנפלקס" a greeting.
    const r = guardSpeech('נעים מאוד קורנפלקס.', { allowIntroduction: false, leadName: 'קורן' });
    expect(r.text).toBe('נעים מאוד קורנפלקס.');
  });

  it('comma-less, and we do NOT know his name → nothing is removed', () => {
    // The name is what marks the end of the phrase. With no name there is no evidence this is a
    // standing greeting rather than "נעים מאוד לשמוע", and the guard stays out of it.
    const r = guardSpeech('נעים מאוד קורן.', { allowIntroduction: false });
    expect(r.text).toBe('נעים מאוד קורן.');
  });

  it('"נעים מאוד לשמוע" survives even when we hold a name', () => {
    const r = guardSpeech('נעים מאוד לשמוע את זה.', {
      allowIntroduction: false,
      leadName: 'קורן',
    });
    expect(r.text).toBe('נעים מאוד לשמוע את זה.');
  });
});

describe('guardStream — the first greeting passes, the second does not', () => {
  const chunks = async function* (...c: string[]) {
    for (const x of c) yield x;
  };
  const drain = async (it: AsyncIterable<string>) => {
    const out: string[] = [];
    for await (const x of it) out.push(x);
    return out;
  };

  it('lets the introduction through while the call has not had one', async () => {
    const out = (
      await drain(guardStream(chunks('אוקיי. נעים מאוד, קורן. במה אתה עוסק?'), undefined, undefined, false, () => true))
    ).join('');
    expect(out).toContain('נעים מאוד');
  });

  it('removes it once the call HAS had one — the FactMemory latch says so', async () => {
    // Exactly the 163.8s line: "אהה. נעים מאוד. רק לוודא — קורן שטרית, נכון?"
    const out = (
      await drain(
        guardStream(
          chunks('אהה. נעים מאוד. רק לוודא — קורן שטרית, נכון?'),
          undefined,
          undefined,
          false,
          () => false,
          () => 'קורן שטרית',
        ),
      )
    ).join('');
    expect(out).not.toContain('נעים מאוד');
    expect(out).toContain('אהה');
    expect(out).toContain('נכון');
  });

  it('does not let one reply greet him twice — the latch has not committed yet', async () => {
    // The FactMemory latch only moves when the utterance commits, i.e. after this whole reply has
    // been spoken. guardStream hands its own per-reply flag to the caller for exactly this case.
    let greetedBefore: boolean[] = [];
    const out = (
      await drain(
        guardStream(
          chunks('נעים מאוד, קורן. נעים מאוד.'),
          undefined,
          undefined,
          false,
          (greeted) => {
            greetedBefore.push(greeted);
            return !greeted;
          },
          () => 'קורן',
        ),
      )
    ).join('');
    expect(greetedBefore).toEqual([false, true]);
    expect(out.match(/נעים מאוד/gu)?.length).toBe(1);
  });

  it('the kill-switch path keeps BOTH — the closure ignores the per-reply flag', async () => {
    // VOICE_INTRO_ONCE_ENABLED=false makes the agent pass `() => true`, which must restore the
    // pre-2026-08-30 behaviour byte for byte, repeats included.
    const out = (
      await drain(guardStream(chunks('נעים מאוד, קורן. נעים מאוד.'), undefined, undefined, false, () => true))
    ).join('');
    expect(out.match(/נעים מאוד/gu)?.length).toBe(2);
  });
});
