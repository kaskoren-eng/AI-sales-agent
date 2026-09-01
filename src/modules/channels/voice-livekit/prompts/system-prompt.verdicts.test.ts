import { describe, expect, it } from 'vitest';
import { REGISTER_VOCABULARY, SPOKEN_REGISTER_SLANG } from './system-prompt.he.js';
import { GREETING_HE, SYSTEM_PROMPT_HE, buildSystemPrompt } from './system-prompt.he.js';

/**
 * WHAT KOREN CONFIRMED, PINNED SO THE NEXT CHANGE CANNOT QUIETLY UNDO IT.
 *
 * Round 7 put fifteen cards in front of him — every one a moment of the 2026-08-31 production call
 * played twice, A as he heard it and B as the agent says it after the change. **Eleven confirmed
 * the change; four did not**, and the four are handled in `system-prompt.test.ts` next to the rules
 * they moved.
 *
 * This file is the other eleven. Every assertion here is something he listened to and approved, and
 * every one of them was at some point the OPPOSITE of what a reasonable session would have done —
 * removing a politeness, keeping a filler, letting her open with slang. A future session reading
 * only the code will find good reasons to change several of them back. The reason not to is that a
 * native Hebrew speaker heard both versions on a phone line and chose these.
 *
 * The rule this file encodes: on a question of how she SOUNDS, his ear is the acceptance test, and
 * a test is the only way an ear verdict survives contact with the next refactor.
 */
const TOOLS_PROMPT = buildSystemPrompt({ toolsEnabled: true });
const BOTH = [SYSTEM_PROMPT_HE, TOOLS_PROMPT];

describe('round 7 — the eleven cards he confirmed', () => {
  /**
   * Every occurrence of a banned phrase must sit inside a sentence that forbids it. A blunt
   * `not.toContain` cannot express that — the prompt has to NAME the wrong form or the model
   * cannot recognise it is producing one — so this walks the occurrences instead.
   */
  const everyOccurrenceIsProhibited = (prompt: string, phrase: string): void => {
    let from = 0;
    let found = 0;
    for (;;) {
      const at = prompt.indexOf(phrase, from);
      if (at === -1) break;
      found++;
      const context = prompt.slice(Math.max(0, at - 200), at + phrase.length);
      expect(context, `${phrase} @${at}`).toMatch(/never|Not |not "|do not|Never/u);
      from = at + phrase.length;
    }
    // …and it must appear at least once, because a rule that never names the wrong form is a rule
    // the model cannot apply.
    expect(found, phrase).toBeGreaterThan(0);
  };

  it('n1 — the verification preamble appears ONLY where it is forbidden', () => {
    // Cards n1a / n1b / n1c. It is also unspeakable rather than merely wordy: "רק לוודא" arrives
    // through the 8kHz band as "רק לוועדה" in 2 of 3 measured carriers, which is why note 1 is a
    // deletion and not a fourth attempt at spelling it.
    for (const prompt of BOTH) {
      for (const banned of ['רק לוודא', 'רק שאדע', 'רק שאדייק', 'אני רוצה לוודא']) {
        everyOccurrenceIsProhibited(prompt, banned);
      }
    }
  });

  it('n1 — the name read-back is the detail itself, with nothing in front of it', () => {
    for (const prompt of BOTH) {
      expect(prompt).toContain('just say it back to him: "קורן שטרית, נכון?"');
      expect(prompt).toMatch(/\*\*Read it back with no preamble in front of it\.\*\*/u);
    }
  });

  it('n1b — his own phone read-back wording, kept verbatim', () => {
    for (const p of BOTH) {
      expect(p).toContain('חוזרת על המספר — אפס חמש אפס, תשע שבע, שמונה שמונה, ארבע חמש?');
    }
  });

  it('n2 — "נעים מאוד קורן" has no comma, and the comma form is named as the mistake', () => {
    for (const prompt of BOTH) {
      expect(prompt).toContain('("נעים מאוד קורן"');
      // The comma version survives ONLY as the counter-example inside its own rule. It also has a
      // code half: speech-guard's repeat-greeting regex used the comma as the terminator, so
      // teaching her the comma-less form nearly disabled that guard silently.
      everyOccurrenceIsProhibited(prompt, '"נעים מאוד, קורן"');
      expect(prompt).toContain('A short set phrase is ONE phrase');
    }
  });

  it('n3 — his line of work is not a surprise, and the surprise beat says so', () => {
    for (const p of BOTH) {
      expect(p).toContain('**His line of work is not a surprise.**');
      expect(p).toMatch(/reacting to it as though it were remarkable is flattery/u);
    }
  });

  it('n5 — the empathy beat SURVIVES: he asked to keep it and it is still here', () => {
    // The single most likely casualty of a "stop saying preambles" change, and the one he was
    // most explicit about keeping.
    for (const p of BOTH) {
      expect(p).toContain('אוף... זה באמת מבאס.');
      expect(p).toContain('אני מבינה... זה באמת מתסכל.');
      expect(p).toContain('## Emotional Color');
    }
  });

  it('n5 — the opening slang SURVIVES, including at the start of the call', () => {
    for (const p of BOTH) {
      expect(p).toContain('## Spoken Register');
      expect(p).toMatch(/The everyday register, including at the start of the call/u);
      for (const word of REGISTER_VOCABULARY) expect(p, word).toContain(word);
      expect(p).toContain('These nine are the whole vocabulary');
    }
    expect(SPOKEN_REGISTER_SLANG).toHaveLength(6);
  });

  it('n6 — a comprehension claim has to be earned, and never twice running', () => {
    for (const p of BOTH) {
      expect(p).toMatch(/\*\*"הבנתי" has to be earned\.\*\*/u);
      expect(p).toMatch(/Never two replies in a row/u);
    }
  });

  it('n9 — the price answer opens with the answer, not with "מחיר זה חשוב"', () => {
    expect(TOOLS_PROMPT).toMatch(/Go straight to the answer/u);
    expect(TOOLS_PROMPT).toContain('אל תפתחי במשפט על כך שהמחיר חשוב');
  });

  it('the No Preamble section is present and its kill-switch removes ONLY it', () => {
    for (const p of BOTH) expect(p).toContain('## No Preamble');
    const off = buildSystemPrompt({ toolsEnabled: true, noPreamble: false });
    expect(off).not.toContain('## No Preamble');
    // Everything he confirmed lives in other sections and must survive the rollback.
    expect(off).toContain('## Emotional Color');
    expect(off).toContain('## Spoken Register');
    expect(off).toContain('אוף... זה באמת מבאס.');
    expect(off).toContain('חוזרת על המספר — אפס חמש אפס, תשע שבע, שמונה שמונה, ארבע חמש?');
  });
});

/**
 * ROUND 8 — the one card he confirmed, and the four he reversed.
 *
 * `e5`'s field-release is the only part of the email branch his ear kept, and it is the
 * commercially important one: the 2026-08-31 call agreed a demo at 450s and ended at 602s with no
 * booking, having spent its last 54 seconds on this field. The reversals are pinned in
 * system-prompt.test.ts.
 */
describe('round 8 — the permission to let the email go', () => {
  /**
   * ⚠️ RESCOPED 2026-08-31 EVENING, AND HIS VERDICT IS UNCHANGED BY IT.
   *
   * What he approved on card `e5` is the PERMISSION — she may keep the meeting and drop the field.
   * That is still here and `VOICE_BOOK_WITHOUT_EMAIL` still governs it. What changed is what the
   * permission attaches to: the wording that shipped named no field ("let the field go"), asserted
   * a phone number it never checked ("יש לי את הנייד שלךָ"), and ended "close the call". On the
   * 16:51 production call the model applied all three to the SURNAME and hung up on a lead who had
   * agreed to a time, with `book_meeting` never called.
   *
   * So the suggested Hebrew tail he heard is kept — "הצוות יחזור אליך עם הפרטים" — and the clause
   * in front of it that made a claim about a field we did not hold is gone.
   */
  it('e5 — she may keep the meeting and drop the field, and the tool agrees', () => {
    expect(TOOLS_PROMPT).toMatch(/let THE EMAIL go — and book the meeting anyway/u);
    expect(TOOLS_PROMPT).toMatch(/`email` set to \*\*null\*\*/u);
    expect(TOOLS_PROMPT).toContain('אני קובעת את זה עכשיו — הצוות יחזור אליך עם הפרטים');
    // The clause that lost the 16:51 call is not offered to her as a line to say.
    expect(TOOLS_PROMPT).not.toContain('יש לי את הנייד שלךָ וזה מספיק');
  });

  it('e5 — the no-tools prompt lets it go too, pointed at the handover', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/let THE EMAIL go/u);
    expect(SYSTEM_PROMPT_HE).toContain('הצוות יחזור אליך עם הפרטים');
    expect(SYSTEM_PROMPT_HE).not.toContain('יש לי את הנייד שלךָ וזה מספיק');
  });
});

/**
 * ROUND 13 — the five cards he judged on 2026-08-31, and the twelfth conclusion that followed.
 *
 * Same rule as the round-7 block above: these are things a native speaker heard through the 8kHz
 * phone band and chose, and several of them are the OPPOSITE of what a reasonable session would do
 * reading only the code. Three of them also sit on top of a rule he confirmed EARLIER, so the
 * assertions below pin the BOUNDARY as much as the rule — a future session that keeps only one half
 * has reversed a verdict without knowing it.
 *
 * What no test in this repo can do is prove gpt-5.4 obeys any of this on turn thirty of a real call.
 * These prove the instruction is present. His ear is the acceptance test.
 */
describe('round 13 — the five listening verdicts and the six behavioural notes', () => {
  const everyOccurrenceIsProhibited = (prompt: string, phrase: string): void => {
    let from = 0;
    let found = 0;
    for (;;) {
      const at = prompt.indexOf(phrase, from);
      if (at === -1) break;
      found++;
      const context = prompt.slice(Math.max(0, at - 240), at + phrase.length);
      expect(context, `${phrase} @${at}`).toMatch(/never|Not |not "|no "|do not|Never|[Bb]anned/u);
      from = at + phrase.length;
    }
    expect(found, phrase).toBeGreaterThan(0);
  };

  it('g1 — the greeting lost its two commas and kept its full stop', () => {
    expect(GREETING_HE).toBe('שלום מדברת קרן העוזרת הדיגיטלית של ClickScales. איך אני יכולה לעזור?');
    // Variant A (today's) and variant C (the em-dash) both lost. Neither may creep back.
    expect(GREETING_HE).not.toContain('שלום, מדברת');
    expect(GREETING_HE).not.toContain('קרן, העוזרת');
    expect(GREETING_HE).toContain('ClickScales. איך');
  });

  it('p1 — sentence SHAPE, with his chosen example and the measured comma fact', () => {
    for (const p of BOTH) {
      expect(p).toContain(
        'אנחנו בונים סוכני AI לקול ולוואטסאפ. הם עונים לפניות של לקוחות וקובעים שיחות. ככה כל ליד מקבל מענה מהר.',
      );
      // It must not read as "delete the commas from one long sentence" — that is not what he picked.
      expect(p).toContain('cutting the thought into pieces that each end');
      expect(p).toMatch(/Two commas in one sentence is your limit/u);
    }
  });

  it('s1 — the slang bank is glossed for MEANING, and בקטנה is corrected in his words', () => {
    for (const p of BOTH) {
      expect(p).toContain('אז ספר לי בקצרה — איזה עסק יש לךָ?');
      expect(p).toMatch(/It does NOT mean "briefly"/u);
      // Every word in the bank has to carry a gloss, or the audit was partial.
      for (const word of REGISTER_VOCABULARY) {
        expect(p, word).toContain(`**${word}**`);
      }
    }
    // And nothing he approved was deleted from the bank to "fix" it.
    expect([...SPOKEN_REGISTER_SLANG]).toContain('בקטנה');
  });

  it('s2 — a product claim takes an unambiguous positive, never slang', () => {
    for (const p of BOTH) {
      expect(p).toMatch(/say \*\*מעולה\*\*, \*\*מצוין\*\* or \*\*טוב מאוד\*\* — never slang/u);
      expect(p).toContain('רגע, זה עובד אחלה או שזה עובד מעולה?');
      // The Spoken Register quota is NARROWED by this, not cancelled.
      expect(p).toContain('The quota still stands');
    }
  });

  it('e1 — empathy-first on a FEAR, and the round-7 ban on commenting on a TOPIC survives intact', () => {
    for (const p of BOTH) {
      expect(p).toContain(
        'זה חשש הגיוני, ואתה לא היחיד ששואל את זה. בוא אני אראה לךָ בדמו איך זה נשמע בפועל ותחליט בעצמךָ.',
      );
      // The boundary is the whole point: both of his rules are named, in one place.
      expect(p).toMatch(/Banned — a comment on his TOPIC/u);
      expect(p).toMatch(/Required — recognition of his FEAR/u);
      everyOccurrenceIsProhibited(p, 'מחיר זה חשוב');
    }
    // …and the playbook, which used to say the opposite, now draws the same line.
    expect(TOOLS_PROMPT).toMatch(
      /Where you START depends on whether he asked a question or expressed a fear/u,
    );
  });

  it('note 3 — discovery establishes whether there IS a business before asking about it', () => {
    for (const p of BOTH) {
      expect(p).toContain('איך את יודעת שיש לי עסק, למשל?');
      expect(p).toContain('יש לךָ עסק משלךָ?');
      expect(p).toMatch(/does not have one yet, that is an ANSWER/u);
    }
  });

  it('note 5 — a mandatory question persists, and the Call Memory ceiling is named as the same rule', () => {
    for (const p of BOTH) {
      expect(p).toMatch(/Never open a NEW topic while a mandatory question is still unanswered/u);
      expect(p).toMatch(/At most two asks, in the whole call/u);
      // The boundary with Call Memory, stated rather than left to the model.
      expect(p).toContain('ask at most ONE more time');
      // An unanswered mandatory question must never become a disqualifier.
      expect(p).toMatch(/not a reason to disqualify anybody/u);
    }
  });

  it('note 6 — one question per turn, and the prompt says it is enforced in code', () => {
    for (const p of BOTH) {
      expect(p).toMatch(/\*\*This one is enforced in code\*\*/u);
      expect(p).toContain('יש אצלך פניות מלקוחות כל יום? ומה הכי היית רוצֶה לשפר שם?');
      // The either/or form he approved is explicitly exempted.
      expect(p).toContain('בבוקר, או אחר הצהריים?');
    }
  });

  it('note 8 — her register is part of her instructions, and saying she is an AI is not', () => {
    for (const p of BOTH) {
      expect(p).toContain('אני מדברת ככה כי זה טבעי לי בשיחה.');
      expect(p).toMatch(/all of it is part of your instructions/u);
      expect(p).toMatch(/This does not touch honesty about what you are/u);
      expect(p).toContain("ClickScales's digital assistant");
    }
  });

  it('the hang-up — a conditional built on לא, and an unfinished sentence, are both named', () => {
    for (const p of BOTH) {
      expect(p).toContain('אם זה עדיין מרגיש לךָ לא נכון');
      expect(p).toMatch(/If he spoke while you were still talking, what came back is not an answer/u);
      expect(p).toContain('אתה רוצה שנעצור כאן?');
    }
  });

  it('conclusion 12 — the opener is conditional, and the prompt says WHY it is faster', () => {
    // The own-opener variant (VOICE_INSTANT_ACK off) — what the default fixtures build.
    for (const p of BOTH) {
      expect(p).toMatch(/when you need the time, and not otherwise/u);
      expect(p).toMatch(/On a SHORT reply there is nothing to cover/u);
      expect(p).not.toMatch(/Begin EVERY reply with a very short first sentence/u);
    }
    // The instant-ack variant — the one that is actually live in production.
    const injected = buildSystemPrompt({ toolsEnabled: true, instantAck: true });
    expect(injected).toMatch(/On a turn where your answer is going to be LONG or COMPLEX/u);
    expect(injected).toMatch(/nothing is spoken for you/u);
    // The ban on writing her own opener is untouched: with the receipt conditional it matters more,
    // not less — on a silent turn a word of hers is an unwanted FIRST receipt.
    expect(injected).toContain('**Do NOT begin your reply with an acknowledgment');
  });

  it('the kill-switch removes the whole section and its counter-rule together', () => {
    const off = buildSystemPrompt({ toolsEnabled: true, call4: false });
    expect(off).not.toContain('What The Man On The Phone Told Us');
    // The playbook goes back to the 2026-08-31 paragraph, so the prompt never carries the empathy
    // rule and the sentence forbidding it at the same time.
    expect(off).toMatch(/\*\*Go straight to the answer\*\* — no sentence in front of it/u);
    expect(off).not.toMatch(/Where you START depends on/u);
    // …and nothing else moved.
    expect(off).toContain('## Objection Handling');
    expect(off).toContain('## Step 3: Qualification');
  });

  it('the opener switch restores the every-turn wording, in both variants', () => {
    const off = buildSystemPrompt({ toolsEnabled: true, conditionalOpener: false });
    expect(off).toMatch(/Begin EVERY reply with a very short first sentence/u);
    const offInjected = buildSystemPrompt({
      toolsEnabled: true,
      instantAck: true,
      conditionalOpener: false,
    });
    expect(offInjected).toMatch(
      /is ALREADY spoken in your voice the moment the caller stops talking/u,
    );
  });
});
