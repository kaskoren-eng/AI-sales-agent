import { describe, expect, it } from 'vitest';
import { forceMasculineAddress, guardSpeech, guardStream } from './speech-guard.js';

/**
 * These are the ACTUAL sentences the agent said to Koren on a real call. Not hypotheticals.
 */
describe('speech guard — the Retell control token', () => {
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
