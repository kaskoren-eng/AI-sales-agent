import { describe, expect, it } from 'vitest';
import {
  EmailDictation,
  readbackCandidate,
  spelledLetters,
  spokenDomain,
} from './email-dictation.js';

describe('spelledLetters — the stitching claim', () => {
  it('pulls a dashed run in order', () => {
    expect(spelledLetters('K-O-R-E-N.')).toEqual(['K', 'O', 'R', 'E', 'N']);
  });

  it('pulls a run the STT punctuated as sentences — "K. A-F."', () => {
    expect(spelledLetters('זה בהתחלה.  K.  A-F.')).toEqual(['K', 'A', 'F']);
  });

  it('reads letters out of a turn that also carries the spoken domain', () => {
    expect(spelledLetters("K-O-R-E-N שטרודל ג'ימייל נקודה קום.")).toEqual([
      'K',
      'O',
      'R',
      'E',
      'N',
    ]);
  });

  it('is NOT fooled by ordinary code-switching — "AI" and "CRM" are words, not spelling', () => {
    expect(spelledLetters('אני מבינה, זה תחום של AI ו-CRM.')).toEqual([]);
    expect(spelledLetters('אוקיי, בסדר גמור.')).toEqual([]);
  });
});

describe('spokenDomain', () => {
  it("resolves the Hebrew furniture — ג'ימייל נקודה קום", () => {
    expect(spokenDomain("קו קורן שטרודל ג'ימייל נקודה קום.")).toBe('gmail.com');
  });

  it('resolves the English form too, because Soniox produces both', () => {
    expect(spokenDomain('k o r e n at gmail dot com')).toBe('gmail.com');
  });

  it('says nothing when no domain was named', () => {
    expect(spokenDomain('קוראים לי קורן שטרית')).toBeNull();
  });
});

describe('readbackCandidate — what she just proposed out loud', () => {
  it('reads a written address', () => {
    expect(readbackCandidate('רק לוודֵא — kaskoren@gmail.com, נכון?')).toBe('kaskoren@gmail.com');
  });

  it('reads a SPELLED address with the English "at"', () => {
    expect(readbackCandidate('הבנתי אותךָ. רק לוודֵא. k o r e n at gmail dot com, נכון?')).toBe(
      'koren@gmail.com',
    );
  });

  it('reads a SPELLED address with the Hebrew prefix and no "at" at all', () => {
    // The read-back he actually rejected. A pattern that required the separator would miss it.
    expect(readbackCandidate("אוקיי. רק שאדייק. זה k o r e n בג'ימייל נקודה קום?")).toBe(
      'koren@gmail.com',
    );
  });

  it('finds nothing in an ordinary sentence, or in a phone-number read-back', () => {
    expect(readbackCandidate('טוב, הבנתי. יופי. מה המייל שלךָ?')).toBeNull();
    expect(readbackCandidate('אז זה 050-9788845, נכון?')).toBeNull();
  });

  it('is not fooled by a PROGRESS report on a partial spelling — she is not proposing an address', () => {
    // The 2026-08-31 local run. Without the domain requirement, the next "לא נכון" recorded «kas»
    // as a value the lead had ruled out — a value he had in fact just given her.
    expect(readbackCandidate('טוב, הבנתי. רשמתי K-A-S. תמשיך בבקשה את כל הכתובת.')).toBeNull();
  });
});

/**
 * The 2026-08-31 production call, turn for turn. This is the regression: it is the exchange that
 * ran 54 seconds, ended the call, and lost the booking.
 */
describe('EmailDictation — replaying the call that lost the booking', () => {
  const play = (): EmailDictation => {
    const d = new EmailDictation();
    let t = 0;
    const agent = (text: string): void => d.observeAgentUtterance(text, (t += 3000));
    const caller = (text: string): string | null => d.observeCallerUtterance(text, (t += 3000));

    agent('טוב, הבנתי. יופי. מה המייל שלךָ?');
    caller("קו קורן שטרודל ג'ימייל נקודה קום.");
    agent("אוקיי. רק שאדייק. זה k o r e n בג'ימייל נקודה קום?");
    caller('זה בהתחלה.  K.  A-F.');
    agent('אוקיי. צריך את כל הכתובת. תגיד לי אותה מההתחלה עד הסוף, לאט אם נוח לךָ.');
    caller("K-O-R-E-N שטרודל ג'ימייל נקודה קום.");
    agent('הבנתי אותךָ. רק לוודֵא. k o r e n at gmail dot com, נכון?');
    caller('לא נכון.');
    agent('טוב, הבנתי. אז בוא נדייק את זה. תגיד לי את המייל שוב מההתחלה עד הסוף.');
    caller('K-A.  F.');
    agent('הבנתי');
    caller('K-O-R-E-N.');
    caller("שטרודל.  ג'ימייל נקודה.  קום.");
    return d;
  };

  it('records the value the lead contradicted, and reports it to the caller of observeCallerUtterance', () => {
    const d = new EmailDictation();
    d.observeAgentUtterance('רק לוודֵא. k o r e n at gmail dot com, נכון?', 1000);
    expect(d.observeCallerUtterance('לא נכון.', 2000)).toBe('koren@gmail.com');
    expect(d.snapshot().rejected).toEqual(['koren@gmail.com']);
  });

  it('stitches the letters he spelled across three separate turns into one ordered run', () => {
    // "K-A." / "F." / "K-O-R-E-N." are one address the endpointer shredded. Before this, the model
    // saw them as rival readings and said so out loud: "שמעתי גם k a f וגם k o r e n".
    expect(play().snapshot().letters).toEqual(['K', 'A', 'F', 'K', 'O', 'R', 'E', 'N']);
  });

  it('resolves the domain and keeps the rejection across the rest of the exchange', () => {
    const snap = play().snapshot();
    expect(snap.domain).toBe('gmail.com');
    expect(snap.rejected).toEqual(['koren@gmail.com']);
    expect(snap.collecting).toBe(true);
  });

  it('the note names the rejected value and the stitched letters, and asks for a Hebrew read-back', () => {
    const note = play().note() ?? '';
    expect(note).toContain('K A F K O R E N');
    expect(note).toContain('«koren@gmail.com»');
    expect(note).toContain('gmail.com');
    expect(note).toMatch(/HEBREW/u);
  });

  it('a rejection RESETS the letter buffer — the wrong reading must not concatenate onto the right one', () => {
    const d = new EmailDictation();
    d.observeAgentUtterance('מה המייל שלךָ?', 1000);
    d.observeCallerUtterance('K-O-R-E-N.', 2000);
    d.observeAgentUtterance('רק לוודֵא. k o r e n at gmail dot com, נכון?', 3000);
    d.observeCallerUtterance('לא נכון.', 4000);
    expect(d.snapshot().letters).toEqual([]);
  });
});

describe('EmailDictation — the bounds that keep a stateful classifier from getting stuck', () => {
  it('collects nothing until she has asked for the email', () => {
    const d = new EmailDictation();
    d.observeCallerUtterance('K-O-R-E-N.', 1000);
    expect(d.snapshot()).toMatchObject({ collecting: false, letters: [] });
    expect(d.note()).toBeNull();
  });

  it('stops collecting once he confirms the read-back', () => {
    const d = new EmailDictation();
    d.observeAgentUtterance('מה המייל שלךָ?', 1000);
    d.observeCallerUtterance('K-O-R-E-N.', 2000);
    d.observeAgentUtterance('רק לוודֵא. k o r e n at gmail dot com, נכון?', 3000);
    d.observeCallerUtterance('כן, נכון.', 4000);
    expect(d.snapshot()).toMatchObject({ collecting: false, letters: [] });
    expect(d.note()).toBeNull();
  });

  it('does not read "לא, תמשיכי" as a rejection — a false rejection would bin a confirmed value', () => {
    const d = new EmailDictation();
    d.observeAgentUtterance('רק לוודֵא. k o r e n at gmail dot com, נכון?', 1000);
    expect(d.observeCallerUtterance('לא, תמשיכי בבקשה, אני מקשיב לךָ עכשיו.', 2000)).toBeNull();
    expect(d.snapshot().rejected).toEqual([]);
  });

  it('ignores the preemptive-draft echo — the same committed line arrives twice', () => {
    const d = new EmailDictation();
    d.observeAgentUtterance('מה המייל שלךָ?', 1000);
    d.observeCallerUtterance('K-A.  F.', 2000);
    d.observeCallerUtterance('K-A.  F.', 2400);
    expect(d.snapshot().letters).toEqual(['K', 'A', 'F']);
  });

  it('takes a LONE letter turn while collecting — "S." on its own is the endpointer, not a word', () => {
    const d = new EmailDictation();
    d.observeAgentUtterance('מה המייל שלךָ?', 1000);
    d.observeCallerUtterance('K-A.', 2000);
    d.observeCallerUtterance('S.', 3000);
    d.observeCallerUtterance("K-O-R-E-N שטרודל ג'ימייל נקודה קום", 4000);
    expect(d.snapshot().letters).toEqual(['K', 'A', 'S', 'K', 'O', 'R', 'E', 'N']);
  });

  it('holds at most MAX_LETTERS, so a stuck collector can never grow without bound', () => {
    const d = new EmailDictation();
    d.observeAgentUtterance('מה המייל שלךָ?', 1000);
    for (let i = 0; i < 30; i++) {
      d.observeCallerUtterance(`A-B-C ${i}`, 2000 + i * 100);
    }
    expect(d.snapshot().letters.length).toBeLessThanOrEqual(40);
  });
});
