import { describe, expect, it } from 'vitest';
import { CallReport } from './call-report.js';
import {
  MIN_RESTART_TOKENS,
  SpokenSentenceLedger,
  callerAskedToRepeat,
  isRestartOf,
  replyTokens,
} from './repeat-guard.js';
import { SlotMemory } from './slot-memory.js';
import {
  announcesStop,
  guardSpeech,
  guardStream,
  stripNiqqud,
  unambiguousProductClaim,
} from './speech-guard.js';
import { END_CALL_CONFIRM_HE } from './end-call-gate.js';

/**
 * THE 2026-09-01 09:29 CALL, DEFECT BY DEFECT — the CODE half of seven findings.
 *
 * Same rule as call4-conclusions.test.ts, and it is worth repeating because it is the honest limit
 * of this file: the PROMPT half is invisible to every test in this repo. `system-prompt.*.test.ts`
 * can pin that a sentence is present in the instructions; nothing here can show that gpt-5.4 obeys
 * it on turn thirty of a real call, which is exactly where these defects happened. What is provable
 * is what happens in code — which sentence reaches Cartesia, what the report counts, and what the
 * turn-boundary note says — so every block below replays the real transcript rather than an
 * invented example.
 */

const CONFIG = {
  sttProvider: 'soniox',
  sttModel: 'stt-rt-v5',
  turnDetection: 'vad',
  llmModel: 'gpt-5.4',
  ttsModel: 'sonic-3.5',
};

const newReport = () => new CallReport('call5-test', '+972509788845', CONFIG);

/**
 * The three replies at 205.3s, 209.7s and 212.4s, verbatim from
 * `call-reports/2026-09-01T06-29-49-579Z.json`, with the caller interjections that cut each one
 * off. The first carries the acknowledgement `llmNode` injects ("אוקי. "); the second and third do
 * not, and they stop one word apart. Those two differences are the whole reason `duplicateReplies`
 * read 0.
 */
const EMPATHY_RESTARTS = {
  first: 'אוקי. זה חשש הגיוני, והרבה בעלי עסקים שואלים את זה בדיוק ככה. אנחנו',
  second: 'זה חשש הגיוני, והרבה בעלי עסקים שואלים את זה בדיוק ככה. אנחנו',
  third: 'זה חשש הגיוני, והרבה בעלי עסקים שואלים את זה בדיוק ככה. לא,',
  interjections: [
    'לשתף איתו פרטים.',
    'ירצו לדבר ישירות עם בן אדם.',
    'זה לא יעשה לי עבודה כפולה?',
  ],
};

describe('defect 1 — the counter that read ZERO through three identical openings', () => {
  it('replays 205/209/212s and the report now SEES it', () => {
    const report = newReport();
    report.recordTranscript('user', 'אני מפחד שזה יישמע קצת רובוטי ואנשים לא ירצו.');
    report.recordTranscript('assistant', EMPATHY_RESTARTS.first);
    report.recordTranscript('user', EMPATHY_RESTARTS.interjections[0]!);
    report.recordTranscript('assistant', 'זה');
    report.recordTranscript('user', EMPATHY_RESTARTS.interjections[1]!);
    report.recordTranscript('assistant', EMPATHY_RESTARTS.second);
    report.recordTranscript('user', EMPATHY_RESTARTS.interjections[2]!);
    report.recordTranscript('assistant', EMPATHY_RESTARTS.third);

    const { summary } = report.toJson();
    // Two restarts: the second reply restarts the first, the third restarts the second.
    expect(summary.restartedReplies).toBe(2);
    // And they are folded into the number that is supposed to be zero, which on the live call was.
    expect(summary.duplicateReplies).toBe(2);
  });

  it('the OLD test — exact string equality — is still zero on the same three replies', () => {
    // Not a curiosity. This is the reason the metric was green: three re-emissions of one sentence
    // are three different strings, because the interruption picks the stopping point.
    const texts = [EMPATHY_RESTARTS.first, EMPATHY_RESTARTS.second, EMPATHY_RESTARTS.third];
    expect(new Set(texts).size).toBe(3);
  });

  it('strips the injected acknowledgement before comparing — it is our token, not hers', () => {
    expect(replyTokens(EMPATHY_RESTARTS.first)).toEqual(replyTokens(EMPATHY_RESTARTS.second));
  });

  it('a restart is not "one is a prefix of the other" — 209 and 212 diverge at the last word', () => {
    const a = replyTokens(EMPATHY_RESTARTS.second);
    const b = replyTokens(EMPATHY_RESTARTS.third);
    expect(a.at(-1)).not.toBe(b.at(-1)); // «אנחנו» vs «לא»
    expect(isRestartOf(EMPATHY_RESTARTS.second, EMPATHY_RESTARTS.third)).toBe(true);
  });

  it('does not call two replies that merely OPEN alike a restart — that is a repeated phrase', () => {
    const a = 'אנחנו בונים סוכני AI לקול ולוואטסאפ. הם עונים לפניות של לקוחות וקובעים שיחות ככה כל ליד מקבל מענה מהר וגם זה חוסך לך זמן.';
    const b = 'אנחנו בונים סוכני AI לקול ולוואטסאפ. הוא יכול לדבר עם הלקוח להבין מה הוא צריך ולתאם שיחה או צעד הבא לפי איך שאתה עובד היום.';
    expect(isRestartOf(a, b)).toBe(false);
  });

  it('needs real shared text — a couple of words in common is not a restart', () => {
    expect(MIN_RESTART_TOKENS).toBeGreaterThan(2);
    expect(isRestartOf('אוקי. בוא נתקדם.', 'אוקי. בוא נמשיך הלאה ונראה מה מתאים לךָ.')).toBe(false);
  });
});

describe('defect 1 + 4 — one sentence, spoken once', () => {
  const drain = async (chunks: string[], ledger: SpokenSentenceLedger, dropped: string[]) => {
    const out: string[] = [];
    const stream = guardStream(
      (async function* () {
        for (const c of chunks) yield c;
      })(),
      () => false,
      undefined,
      false,
      () => true,
      () => null,
      {},
      {},
      {},
      { enabled: true, ledger, onDropped: (s) => dropped.push(s) },
    );
    for await (const piece of stream) out.push(piece);
    return out.join('');
  };

  it('the restarted empathy opener is spoken once and then suppressed', async () => {
    const ledger = new SpokenSentenceLedger();
    const dropped: string[] = [];

    const firstTry = await drain([EMPATHY_RESTARTS.first], ledger, dropped);
    expect(firstTry).toContain('זה חשש הגיוני');
    expect(dropped).toHaveLength(0);

    const secondTry = await drain([EMPATHY_RESTARTS.second, ' אנחנו לא מחליפים אדם בשיחה.'], ledger, dropped);
    expect(secondTry).not.toContain('זה חשש הגיוני');
    // The substance behind it still goes out — the suppression is of the repeat, not of the turn.
    expect(secondTry).toContain('אנחנו לא מחליפים אדם בשיחה');
    expect(dropped).toHaveLength(1);
  });

  it('the two booking apologies become one — their second halves were word-for-word identical', async () => {
    const ledger = new SpokenSentenceLedger();
    const dropped: string[] = [];
    // Verbatim from 462s and 468s. Neither is a fixed string in this repo: both are the model
    // paraphrasing one prompt instruction, twice, because `book_meeting` failed twice.
    await drain(['קרה לי תקלה קטנה. אני אעביר את זה לצוות שלנו והם יחזרו אליך לתיאום מדויק.'], ledger, dropped);
    const second = await drain(
      ['יש תקלה רגעית במערכת. אני אעביר את זה לצוות שלנו והם יחזרו אליך לתיאום מדויק.'],
      ledger,
      dropped,
    );
    expect(second).toContain('יש תקלה רגעית במערכת');
    expect(second).not.toContain('יחזרו אליך לתיאום מדויק');
    expect(dropped).toHaveLength(1);
  });

  it('never goes silent: a reply that is ENTIRELY a repeat is spoken rather than dropped', async () => {
    const ledger = new SpokenSentenceLedger();
    const dropped: string[] = [];
    const line = 'אני אעביר את זה לצוות שלנו והם יחזרו אליך לתיאום מדויק.';
    await drain([line], ledger, dropped);
    const again = await drain([line], ledger, dropped);
    // Counted as a suppression AND still spoken — dead air is the worse of the two defects.
    expect(dropped).toHaveLength(1);
    // stripNiqqud, because the gender table has already pointed «אליךָ» by this point.
    expect(stripNiqqud(again)).toContain('יחזרו אליך לתיאום מדויק');
  });

  it('leaves her short reactions alone — repeating "בסדר." is speech, not repetition', async () => {
    const ledger = new SpokenSentenceLedger();
    const dropped: string[] = [];
    await drain(['בסדר. מה השם המלא שלך?'], ledger, dropped);
    const again = await drain(['בסדר. ומה כתובת המייל?'], ledger, dropped);
    expect(again).toContain('בסדר.');
    expect(dropped).toHaveLength(0);
  });

  it('gives him the repeat when he ASKS for it', () => {
    for (const turn of ['לא שמעתי, תגידי שוב', 'מה אמרת?', 'עוד פעם בבקשה']) {
      expect(callerAskedToRepeat(turn), turn).toBe(true);
    }
    expect(callerAskedToRepeat('כן, מעולה.')).toBe(false);
  });

  it('forgets a sentence once it is out of the window', () => {
    const ledger = new SpokenSentenceLedger(30_000);
    ledger.observe('אני אעביר את זה לצוות שלנו והם יחזרו אליך.', 1_000);
    expect(ledger.wasSaidRecently('אני אעביר את זה לצוות שלנו והם יחזרו אליך.', 20_000)).toBe(true);
    expect(ledger.wasSaidRecently('אני אעביר את זה לצוות שלנו והם יחזרו אליך.', 40_000)).toBe(false);
  });
});

describe('defect 2 — the scheduling loop: he answered, and she asked again', () => {
  /** Her four asks and his answers, in order, verbatim from the 09:29 transcript. */
  it('replays 161-293s and knows he has answered by the time she asks the third time', () => {
    const slot = new SlotMemory();
    let t = 0;
    const agent = (text: string) => slot.observeAgentUtterance(text, (t += 1000));
    const caller = (text: string) => slot.observeCallerUtterance(text, (t += 1000));

    agent('אוקי. מחר יש כמה חלונות פנויים. אני יכולה לבדוק לך עכשיו מה פתוח — בוקר, או אחר הצהריים?');
    // Before he has answered there is nothing to say — the first ask is legitimate.
    expect(slot.note()).toBeNull();

    caller('ב. שעות מחר?');
    agent('בסדר. אני יכולה לבדוק את הזמינות עכשיו. מתי יותר נוח לך — בבוקר, או אחר הצהריים?');
    caller('באיזה שעות בבוקר?');

    const note = slot.note();
    expect(note).not.toBeNull();
    expect(note).toContain('בבוקר');
    expect(note).toContain('Do NOT ask any of these again');
  });

  it('records the day, the part of the day and the hour he actually named', () => {
    const slot = new SlotMemory();
    slot.observeAgentUtterance('מתי יותר נוח לך — בבוקר, או אחר הצהריים?');
    slot.observeCallerUtterance('דיברנו על זה כבר, שיהיה נוח לי מחר בבוקר.');
    slot.observeCallerUtterance('11 יכול לעבוד טוב.');

    const snap = slot.snapshot();
    expect(snap.day).toBe('מחר');
    expect(snap.partOfDay).toBe('בבוקר');
    expect(snap.hour).toBe('11');
  });

  it('counts HER asks, so the note can say how many times he has been asked', () => {
    const slot = new SlotMemory();
    let t = 0;
    slot.observeAgentUtterance('בוקר, או אחר הצהריים?', (t += 1000));
    slot.observeAgentUtterance('מתי יותר נוח לך — בבוקר, או אחר הצהריים?', (t += 1000));
    expect(slot.asks('partOfDay')).toBe(2);
  });

  it('does NOT read an incidental "מחר" as a booking preference before scheduling starts', () => {
    const slot = new SlotMemory();
    slot.observeCallerUtterance('מחר יש לי יום עמוס, אבל ספרי לי מה אתם עושים.');
    expect(slot.snapshot().day).toBeNull();
    expect(slot.note()).toBeNull();
  });

  it('does not double-count the preemptive-draft echo of one ask', () => {
    const slot = new SlotMemory();
    slot.observeAgentUtterance('בוקר, או אחר הצהריים?', 1000);
    slot.observeAgentUtterance('בוקר, או אחר הצהריים?', 1500);
    expect(slot.asks('partOfDay')).toBe(1);
  });
});

describe('defect 3 — she accepted the ending and reversed it eleven seconds later', () => {
  it('rewrites the 320s sentence into the question the end-call gate already asks', () => {
    const spoken = guardSpeech('אם זה מה שיושב עליך, עדיף שנעצור כאן.', { bookingPossible: true });
    expect(spoken.stopAnnouncementRewritten).toBe(true);
    // The gender table points «רוצֶה» downstream of the rewrite, which is the correct ordering.
    expect(stripNiqqud(spoken.text)).toBe(END_CALL_CONFIRM_HE);
  });

  it('catches the shapes she reaches for, and leaves a farewell alone', () => {
    for (const line of [
      'עדיף שנעצור כאן.',
      'בוא נסיים פה.',
      'אז נעצור כאן.',
      'אני אסיים כאן את השיחה.',
    ]) {
      expect(announcesStop(line), line).toBe(true);
    }
    for (const line of [
      'תודה קורן, נדבר בקרוב.',
      'שיהיה יום נעים.',
      'אני אעביר את זה לצוות שלנו.',
      'בוא נתקדם לשעה מדויקת.',
    ]) {
      expect(announcesStop(line), line).toBe(false);
    }
  });

  it('says nothing once the ending is REAL — a booked call may close itself', () => {
    const spoken = guardSpeech('אז נסיים כאן, תודה רבה.', { endingRequested: true });
    expect(spoken.stopAnnouncementRewritten).toBeFalsy();
    expect(spoken.text).toContain('נסיים כאן');
  });

  it('OFF restores the 2026-09-01 sentence exactly', () => {
    const spoken = guardSpeech('אם זה מה שיושב עליך, עדיף שנעצור כאן.', {
      stopAnnounceGuard: false,
    });
    expect(spoken.stopAnnouncementRewritten).toBeFalsy();
    expect(spoken.text).toContain('עדיף שנעצור כאן');
  });
});

describe('defect 5 — אחלה inside a claim about the product', () => {
  it('rewrites the sentence she actually said on the 09:43 call', () => {
    expect(unambiguousProductClaim('זה עובד אחלה למי שמקבל פניות')).toBe(
      'זה עובד מעולה למי שמקבל פניות',
    );
  });

  it('leaves slang for RAPPORT alone — an arrangement is not a product claim', () => {
    // 293s. His own note: "Fine about an arrangement or an answer."
    const line = 'מחר בבוקר יכול לעבוד אחלה.';
    expect(unambiguousProductClaim(line)).toBe(line);
    expect(guardSpeech(line).productClaimSlangRewritten).toBeFalsy();
  });

  it('is wired into guardSpeech and reported', () => {
    const spoken = guardSpeech('זה עובד אחלה בדיוק במקרים כמו שלך.');
    expect(spoken.productClaimSlangRewritten).toBe(true);
    expect(spoken.text).toContain('עובד מעולה');
  });

  it('OFF restores the 2026-09-01 wording exactly', () => {
    const spoken = guardSpeech('זה עובד אחלה למי שמקבל פניות.', { productClaimSlangGuard: false });
    expect(spoken.text).toContain('עובד אחלה');
  });
});

describe('defect 7 — the fragmentation instrument, before anyone touches the threshold', () => {
  /**
   * The five measurable fragments from the 09:29 call, as `spokeUntilMs` → `spokeAtMs` pairs. Two
   * of the eleven produced nonsense (165s and -451s) because a stitched STT hypothesis carries a
   * start time from a minute earlier; those must not reach the median.
   */
  it('measures the pause INSIDE each chopped thought, and drops the impossible ones', () => {
    const report = newReport();
    const say = (role: string, text: string, from: number, to: number) =>
      report.recordTranscript(role, text, {
        startedSpeakingAt: from / 1000,
        stoppedSpeakingAt: to / 1000,
      });
    // Real pairs: 705ms, 605ms, 1086ms — plus one whose start time is a minute in the past.
    say('user', 'לא יודע.', 66_000, 66_500);
    say('user', 'חלק.', 67_205, 67_700);
    say('user', '15.', 68_305, 68_800);
    say('user', 'לא יודע, זה נשמע קצת לא משהו.', 310_000, 314_000);
    say('user', 'את שואלת אותי כל פעם את אותן שאלות.', 315_086, 316_800);
    say('user', 'ב. שעות מחר?', 1_000, 2_000); // the stitched hypothesis — gap is negative

    const { fragmentation, fragmentedTurns } = report.toJson().summary;
    expect(fragmentedTurns).toBeGreaterThanOrEqual(4);
    // Three of the five pairs are measurable: 705ms, 605ms, 1086ms. The other two are the
    // 241-second jump between two unrelated stretches of the call and the stitched hypothesis
    // whose start time precedes the turn before it — neither is a pause anybody sat through.
    expect(fragmentation.samples).toBe(3);
    expect(fragmentation.medianMs).toBe(705);
    expect(fragmentation.maxMs).toBe(1_086);
    // The sizing table: what each candidate min-silence would have held together.
    expect(fragmentation.caughtAt['500']).toBe(0);
    expect(fragmentation.caughtAt['700']).toBe(1);
    expect(fragmentation.caughtAt['1200']).toBe(3);
  });

  it('reports nulls rather than a fabricated zero when nothing was measurable', () => {
    const { fragmentation } = newReport().toJson().summary;
    expect(fragmentation).toEqual({
      samples: 0,
      medianMs: null,
      maxMs: null,
      caughtAt: { 500: 0, 700: 0, 900: 0, 1200: 0 },
    });
  });
});
