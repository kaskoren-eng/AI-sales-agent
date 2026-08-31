import { describe, expect, it } from 'vitest';
import { REGISTER_VOCABULARY, SPOKEN_REGISTER_SLANG } from './system-prompt.he.js';
import { SYSTEM_PROMPT_HE, buildSystemPrompt } from './system-prompt.he.js';

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
  it('e5 — she may keep the meeting and drop the field, and the tool agrees', () => {
    expect(TOOLS_PROMPT).toMatch(
      /After two read-backs have failed, let the field go and keep the meeting/u,
    );
    expect(TOOLS_PROMPT).toMatch(/`email` set to \*\*null\*\*/u);
    expect(TOOLS_PROMPT).toContain('יש לי את הנייד שלךָ וזה מספיק — הצוות יחזור אליך עם הפרטים');
  });

  it('e5 — the no-tools prompt lets it go too, pointed at the handover', () => {
    expect(SYSTEM_PROMPT_HE).toMatch(/After two read-backs have failed, let the field go/u);
    expect(SYSTEM_PROMPT_HE).toContain('יש לי את הנייד שלךָ וזה מספיק');
  });
});
