import { describe, it, expect } from 'vitest';
import { CallReport } from './call-report.js';

/**
 * `duplicateReplies` — does she actually say the same thing twice?
 *
 * This metric has a history that is the whole reason it is tested this carefully. It once read 4 on a
 * call where she had repeated nothing: `ConversationItemAdded` fires twice per reply under preemptive
 * generation (draft, then confirmed), the transcript doubled, and preemptive TTS was switched off on
 * the strength of it. The person who had been on the call said she never repeated herself, and he was
 * right. `recordTranscript` now drops the echo.
 *
 * So this file pins BOTH failure directions, because the metric is dangerous in each:
 *   - reads high  -> a real feature gets disabled to fix a bug that does not exist
 *   - reads zero  -> a real defect is invisible, and the zero is trusted
 *
 * The second is what happened on 2026-08-22. She spoke a 40-word sentence, the caller asked something
 * else, and 18 seconds later she began the identical sentence again and was cut off mid-way. Two
 * speech handles, two playouts, the first `completed without interruption` — a genuine repeat. The
 * report said `duplicateReplies: 0`, because the truncated second copy was not string-equal to the
 * first.
 */

const config = { sttProvider: 'soniox', sttModel: 'stt-rt-v5', turnDetection: 'vad', llmModel: 'gpt-5.4', ttsModel: 'sonic-3.5' };
const report = () => new CallReport('room-1', '+972500000000', config as never);

/** Verbatim from the 2026-08-22 call. */
const FULL =
  'מעולה. נשמע שאתה רואה בזה גם דרך לטפל בלידים מהר יותר וגם פוטנציאל לשיתוף פעולה עסקי, וזה בהחלט יכול להיות רלוונטי. כדי לבדוק את זה נכון ולראות איך זה עובד בפועל אצלך, הכי טוב לקבוע דמו קצר. נוח לכה מחר?';
const CUT_OFF = 'מעולה. נשמע שאתה רואה בזה גם דרך לטפל בלידים מהר יותר וגם פוטנציאל לשיתוף פעולה עסקי, וזה בהחלט יכול להיות';

describe('duplicateReplies — a repeat that got cut off is still a repeat', () => {
  it('counts the 2026-08-22 case, which read zero before', () => {
    const r = report();
    r.recordTranscript('assistant', FULL);
    r.recordTranscript('user', 'כן, שאלתי שאלה: איך אני יודע שהסוכן הזה לא הולך לתפוס לי לידים?');
    r.recordTranscript('assistant', CUT_OFF);

    expect(r.toJson().summary.duplicateReplies).toBe(1);
  });

  it('counts it in either order — the cut-off copy may come first', () => {
    const r = report();
    r.recordTranscript('assistant', CUT_OFF);
    r.recordTranscript('user', 'רגע.');
    r.recordTranscript('assistant', FULL);

    expect(r.toJson().summary.duplicateReplies).toBe(1);
  });
});

describe('duplicateReplies — the ways it must NOT read high', () => {
  /**
   * The prompt tells her to open every reply with a 2-4 word acknowledgement, so consecutive answers
   * routinely share their first several characters. Flagging those would recreate the original false
   * alarm with a new mechanism.
   */
  it('does not flag two different answers that share an opener', () => {
    const r = report();
    r.recordTranscript('assistant', 'מעולה. השירות נכנס לפעולה תוך חמישה ימי עסקים.');
    r.recordTranscript('user', 'והמחיר?');
    r.recordTranscript('assistant', 'מעולה. אני אבדוק ואחזור אליכה עם תשובה מדויקת.');

    expect(r.toJson().summary.duplicateReplies).toBe(0);
  });

  it('does not flag short replies at all', () => {
    const r = report();
    r.recordTranscript('assistant', 'בטח.');
    r.recordTranscript('user', 'כן.');
    r.recordTranscript('assistant', 'בטח.');

    expect(r.toJson().summary.duplicateReplies).toBe(0);
  });

  /**
   * THE ORIGINAL ARTEFACT. One reply, logged twice with identical text, milliseconds apart. It must
   * stay invisible — `recordTranscript` drops it before the counter ever sees it.
   */
  it('still ignores the preemptive draft echo', () => {
    const r = report();
    r.recordTranscript('assistant', FULL);
    r.recordTranscript('assistant', FULL); // the confirmed message, same text, same breath

    const json = r.toJson();
    expect(json.summary.duplicateReplies).toBe(0);
    expect(json.transcript.filter((t) => t.role === 'assistant')).toHaveLength(1);
  });

  it('does not flag the caller repeating himself — this metric is about her', () => {
    const r = report();
    r.recordTranscript('user', FULL);
    r.recordTranscript('assistant', 'הבנתי לגמרי, וזה בדיוק מה שאנחנו פותרים עבור עסקים כמו שלכה.');
    r.recordTranscript('user', CUT_OFF);

    expect(r.toJson().summary.duplicateReplies).toBe(0);
  });
});
