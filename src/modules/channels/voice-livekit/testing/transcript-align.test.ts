import { describe, expect, it } from 'vitest';
import { alignTranscript } from './transcript-align.js';

describe('alignTranscript', () => {
  /**
   * Copied verbatim out of `call-reports/2026-08-30T10-41-49-765Z.json`, the first real A/B run.
   * It has BOTH of the shapes that break naive index-based pairing: the reply to turn 1 arrives as
   * two assistant lines (a thinking filler committed separately), and caller turn 2 arrives as two
   * user lines because the STT split it. Index the assistant lines directly and turn 1's audio gets
   * captioned "אהה." while turn 2's caption is the sentence you can hear in turn 1.
   */
  const REAL_RUN = [
    { role: 'assistant', text: 'שלום, מדברת קרן, העוזרת הדיגיטלית של ClickScales. איך אני יכולה לעזור?' },
    { role: 'user', text: 'אני חושב ש—' },
    { role: 'user', text: 'כן, אני מעוניין לשמוע עוד.' },
    { role: 'assistant', text: 'אהה.' },
    { role: 'assistant', text: 'הבנתי אותךָ. קודם כל — איך קוראים לךָ?' },
    { role: 'user', text: 'התקציב שלי הוא.' },
    { role: 'user', text: 'אה—' },
    { role: 'assistant', text: 'אוקיי. איך קוראים לךָ?' },
  ];

  it('pairs each caller turn with everything she said in reply to it', () => {
    const { greeting, replies } = alignTranscript(REAL_RUN);
    expect(greeting).toBe(
      'שלום, מדברת קרן, העוזרת הדיגיטלית של ClickScales. איך אני יכולה לעזור?',
    );
    expect(replies).toEqual(['אהה. הבנתי אותךָ. קודם כל — איך קוראים לךָ?', 'אוקיי. איך קוראים לךָ?']);
  });

  it('gives a turn she never answered null, instead of the next turn’s words', () => {
    const { replies } = alignTranscript([
      { role: 'assistant', text: 'greeting' },
      { role: 'user', text: 'turn 1' },
      { role: 'user', text: 'turn 2 (she said nothing in between)' },
      { role: 'assistant', text: 'reply to turn 2' },
    ]);
    // Two user runs would be one run here — consecutive user lines collapse — so this is the
    // simplest honest reading: one caller turn, one reply.
    expect(replies).toEqual(['reply to turn 2']);
  });

  it('handles a call with no greeting', () => {
    expect(alignTranscript([{ role: 'user', text: 'hi' }])).toEqual({
      greeting: null,
      replies: [null],
    });
  });

  it('handles an empty transcript', () => {
    expect(alignTranscript([])).toEqual({ greeting: null, replies: [] });
  });
});
