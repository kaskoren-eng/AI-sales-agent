import { describe, expect, it } from 'vitest';
import { forceMasculineAddress, guardSpeech, guardStream, notifyIfSilent, withFiller } from './speech-guard.js';

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

describe('speech guard — niqqud is stripped so Cartesia gets clean consonantal Hebrew', () => {
  it('removes niqqud/cantillation the model may emit', () => {
    const r = guardSpeech('שָׁלוֹם, מְדַבֶּרֶת קֶרֶן.');
    expect(r.text).toBe('שלום, מדברת קרן.');
    expect(r.interventions).toContain('stripped niqqud (Cartesia mispronounces vowel points)');
  });

  it('is a silent no-op on ordinary unpointed Hebrew', () => {
    const t = 'שלום, מדברת קרן. איך אפשר לעזור?';
    expect(guardSpeech(t).text).toBe(t);
    expect(guardSpeech(t).interventions).toHaveLength(0);
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
    // The claim SURVIVES (as "קבעתי לכה" — the pronunciation fix still applies, see below)...
    expect(out).toMatch(/קבעתי לכה/u);
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
    expect(out[1]).toMatch(/קבעתי לכה/u); // survives (pronunciation-fixed, not censored)
  });

  it('NO_RESPONSE_NEEDED and the pronunciation fix stay armed even after a booking', async () => {
    const out = (
      await drain(guardStream(chunks('NO_RESPONSE_NEEDED שלחתי לך אישור למייל שלך.'), () => true))
    ).join('');
    expect(out).not.toMatch(/NO_RESPONSE_NEEDED/u);
    expect(out).toMatch(/שלכה/u); // forceMasculineAddress is unconditional
  });

  it('guardSpeech honours the flag directly', () => {
    const claim = 'קבעתי לך שיחת דמו למחר.';
    expect(guardSpeech(claim, { allowBookingClaims: true }).text).toMatch(/קבעתי לכה/u);
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
describe('forceMasculineAddress — fixing pronunciation, not vocabulary', () => {
  it('forces שלך to be pronounced shel-KHA (masculine)', () => {
    // Verified against the real TTS: "שלכה" synthesized and transcribed back by Soniox as "שלך" —
    // a correct masculine Hebrew word. The spelling is non-standard and nobody ever sees it.
    expect(forceMasculineAddress('מה מספר הטלפון שלך?')).toBe('מה מספר הטלפון שלכה?');
  });

  it('fixes every ambiguous suffix', () => {
    expect(forceMasculineAddress('אשלח לך')).toBe('אשלח לכה');
    expect(forceMasculineAddress('אחזור אליך')).toBe('אחזור אליכה');
    expect(forceMasculineAddress('לשמוע אותך')).toBe('לשמוע אותכה');
    expect(forceMasculineAddress('לדבר איתך')).toBe('לדבר איתכה');
    expect(forceMasculineAddress('בשבילך')).toBe('בשבילכה');
  });

  it('NEVER corrupts a word that merely CONTAINS the letters', () => {
    // The trap: JS \b does not work on Hebrew (Hebrew letters are not word characters), so a naive
    // boundary would match inside "משלך" / "הלך" / "שלכם" and mangle them.
    expect(forceMasculineAddress('הוא הלך הביתה')).toBe('הוא הלך הביתה');
    expect(forceMasculineAddress('הצוות שלכם')).toBe('הצוות שלכם');
    expect(forceMasculineAddress('משלך')).toBe('משלך');
    expect(forceMasculineAddress('לכל הלקוחות')).toBe('לכל הלקוחות');
  });

  it('leaves her OWN feminine speech untouched — only the ADDRESS changes', () => {
    // Three genders, three persons: she is feminine, the company is masculine plural, the lead is
    // his own gender. Only the last one is being fixed here.
    const t = 'אני יכולה לבדוק. אנחנו בונים סוכני AI.';
    expect(forceMasculineAddress(t)).toBe(t);
  });

  it('runs inside the live guard, so what Cartesia SAYS is masculine', () => {
    expect(guardSpeech('מה השם שלך? אשלח לך אישור.').text).toBe('מה השם שלכה? אשלח לכה אישור.');
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
