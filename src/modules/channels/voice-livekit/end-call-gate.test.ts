import { describe, expect, it } from 'vitest';
import { CallReport } from './call-report.js';
import {
  DISQUALIFYING_END_REASONS,
  END_CALL_CONFIRM_HE,
  MAX_REFUSALS,
  echoesAgentTail,
  isDisqualifyingEndReason,
  judgeEndCall,
  saysExplicitDecline,
} from './end-call-gate.js';

/**
 * THE 260-SECOND HANG-UP, REPLAYED.
 *
 * The first test below is the actual sequence from `call-reports/2026-08-31T19-54-51-237Z.json`,
 * with the real transcript text and the real speaking timestamps, driven through the real
 * `CallReport` rather than through a hand-built input object. That matters: the whole gate rests on
 * `spokeAtMs`/`spokeUntilMs`, and a test that hand-fed `overlappedAgentSpeech: true` would prove
 * only that the branch works, never that the report can actually see the overlap.
 */

const AGENT_LINE =
  'אמ. אני מבינה.. זה באמת החשש המרכזי אצל הרבה בעלי עסקים. בפועל אנחנו בונים סוכנים שמדברים בצורה טבעית מאוד, עם תשובות דינמיות ולא טקסט קבוע, ובדמו אתה שומע את זה חי על שיחה אמיתית. אם זה עדיין מרגיש לךָ לא נכון';
const CALLER_ECHO = 'כן, מרגיש לך.';

/** The SDK reports speaking timestamps in EPOCH SECONDS; CallReport converts against its own start. */
function replay19h54(): CallReport {
  const report = new CallReport('room-19-54', '+972509788845', {
    sttProvider: 'soniox',
    sttModel: 'stt-rt-v5',
    turnDetection: 'vad',
    llmModel: 'gpt-5.4',
    ttsModel: 'sonic-3.5',
  });
  const start = Date.now() / 1000;
  const at = (ms: number): number => start + ms / 1000;
  report.recordTranscript(
    'user',
    'לא יודע. נשמע לי...  שאני מדבר עם רובוט כרגע. אני חושב שזה יכול להבהיל את הלידים שלי.',
    { startedSpeakingAt: at(236166), stoppedSpeakingAt: at(240943) },
  );
  report.recordTranscript('assistant', AGENT_LINE, {
    startedSpeakingAt: at(243477),
    stoppedSpeakingAt: at(260013),
  });
  // 259248-259693: his entire turn happened INSIDE her speech window. This is the measurement.
  report.recordTranscript('user', CALLER_ECHO, {
    startedSpeakingAt: at(259248),
    stoppedSpeakingAt: at(259693),
  });
  return report;
}

describe('the 260-second hang-up cannot happen again', () => {
  it('refuses end_call(not_qualified) on the real 19:54 sequence, and says what to ask instead', () => {
    const report = replay19h54();
    const last = report.lastCallerTurn();

    // The report can SEE it — the three facts the gate is built on, read off real timestamps.
    expect(last).not.toBeNull();
    expect(last!.text).toBe(CALLER_ECHO);
    expect(last!.overlappedAgentSpeech).toBe(true);
    expect(last!.agentTurnUnfinished).toBe(true); // her conditional never got a terminator

    const verdict = judgeEndCall({
      reason: 'not_qualified',
      lastCallerTurn: last,
      confirmationAsked: false,
      refusals: 0,
      recordedQualification: 'hot', // capture_lead_info said so at 175.7s of the same call
    });

    expect(verdict.allow).toBe(false);
    if (verdict.allow) return;
    expect(verdict.code).toBe('overlapped_speech');
    // The model must not write a goodbye, and it must be given the sentence to say instead.
    expect(verdict.instruction).toContain('The call is NOT ending');
    expect(verdict.instruction).toContain(END_CALL_CONFIRM_HE);
    expect(verdict.instruction).toContain('never finished');
    // Her own tool call contradicted the ending she asked for. That is the strongest argument
    // available and it is hers, so it is quoted back at her.
    expect(verdict.instruction).toContain('"hot"');
  });

  it('the echo test catches it too, independently of the overlap', () => {
    // If the speaking metrics were missing (console mode, an interrupted reply with no audio) the
    // overlap is unprovable and reads false. The second condition still holds: his words are the
    // tail of hers with the negation gone.
    expect(echoesAgentTail(CALLER_ECHO, AGENT_LINE)).toBe(true);

    const verdict = judgeEndCall({
      reason: 'not_qualified',
      lastCallerTurn: {
        text: CALLER_ECHO,
        overlappedAgentSpeech: false,
        agentTurnBefore: AGENT_LINE,
        agentTurnUnfinished: true,
      },
      confirmationAsked: false,
      refusals: 0,
    });
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) expect(verdict.code).toBe('echoed_her_own_words');
  });

  it('and a third condition catches it even with neither: he never said no', () => {
    const verdict = judgeEndCall({
      reason: 'not_qualified',
      lastCallerTurn: {
        text: 'כן, מרגיש לך.',
        overlappedAgentSpeech: false,
        agentTurnBefore: null,
        agentTurnUnfinished: false,
      },
      confirmationAsked: false,
      refusals: 0,
    });
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) expect(verdict.code).toBe('no_explicit_decline');
  });
});

describe('what the gate must never block', () => {
  it('opt_out fires immediately — it is a legal instruction, not a sales judgement', () => {
    // The worst possible input for every other reason: an overlap, an echo, no decline.
    expect(
      judgeEndCall({
        reason: 'opt_out',
        lastCallerTurn: {
          text: CALLER_ECHO,
          overlappedAgentSpeech: true,
          agentTurnBefore: AGENT_LINE,
          agentTurnUnfinished: true,
        },
        confirmationAsked: false,
        refusals: 0,
      }).allow,
    ).toBe(true);
  });

  it('every reason the caller himself chose passes untouched', () => {
    for (const reason of ['meeting_booked', 'callback_requested', 'bad_time', 'wrong_person', 'other']) {
      expect(isDisqualifyingEndReason(reason), reason).toBe(false);
      expect(
        judgeEndCall({
          reason,
          lastCallerTurn: {
            text: CALLER_ECHO,
            overlappedAgentSpeech: true,
            agentTurnBefore: AGENT_LINE,
            agentTurnUnfinished: true,
          },
          confirmationAsked: false,
          refusals: 0,
        }).allow,
        reason,
      ).toBe(true);
    }
    expect([...DISQUALIFYING_END_REASONS]).toEqual(['not_qualified', 'not_interested']);
  });

  it('a caller who says he is done gets off the phone on the first attempt', () => {
    for (const said of [
      'לא מעוניין, תודה.',
      'תודה, לא.',
      'זה לא מתאים לי כרגע.',
      'בוא נסיים כאן.',
      'אל תתקשרו אליי יותר.',
      "I'm not interested.",
    ]) {
      expect(saysExplicitDecline(said), said).toBe(true);
      expect(
        judgeEndCall({
          reason: 'not_interested',
          lastCallerTurn: {
            text: said,
            // Even talking over her: a man saying "לא מעוניין" over the top of a pitch means it.
            overlappedAgentSpeech: true,
            agentTurnBefore: AGENT_LINE,
            agentTurnUnfinished: true,
          },
          confirmationAsked: false,
          refusals: 0,
        }).allow,
        said,
      ).toBe(true);
    }
  });

  it('never traps anybody — the gate stops refusing after MAX_REFUSALS', () => {
    const worst = {
      reason: 'not_qualified',
      lastCallerTurn: {
        text: CALLER_ECHO,
        overlappedAgentSpeech: true,
        agentTurnBefore: AGENT_LINE,
        agentTurnUnfinished: true,
      },
      confirmationAsked: true,
    };
    expect(judgeEndCall({ ...worst, refusals: MAX_REFUSALS - 1 }).allow).toBe(false);
    expect(judgeEndCall({ ...worst, refusals: MAX_REFUSALS }).allow).toBe(true);
  });

  it('once she has asked and he answered without talking over her, the answer stands', () => {
    // He has been asked "שאסגור את זה כרגע?" directly. Whatever he said next is his decision, and
    // pressing him a second time would be the agent arguing with a man who wants to hang up.
    expect(
      judgeEndCall({
        reason: 'not_qualified',
        lastCallerTurn: {
          text: 'כן, בוא נעצור פה.',
          overlappedAgentSpeech: false,
          agentTurnBefore: `רגע לפני שנסיים — ${END_CALL_CONFIRM_HE}`,
          agentTurnUnfinished: false,
        },
        confirmationAsked: true,
        refusals: 1,
      }).allow,
    ).toBe(true);
  });

  it('a call where the lead never spoke is not this gate’s business', () => {
    expect(
      judgeEndCall({
        reason: 'not_qualified',
        lastCallerTurn: null,
        confirmationAsked: false,
        refusals: 0,
      }).allow,
    ).toBe(true);
  });
});

describe('the two crude tests, at their edges', () => {
  it('"לא" alone is never a decline — it answers whatever she asked', () => {
    // This is the whole lesson of the 19:54 call: her question was an unfinished conditional, so
    // "yes" to it means nothing at all. Nor is "לא יודע", which he said at 241s while continuing
    // to engage for another twenty seconds.
    for (const said of ['לא.', 'לא', 'כן.', 'לא יודע.', 'אממ.']) {
      expect(saysExplicitDecline(said), said).toBe(false);
    }
  });

  it('an echo needs two content words, so a bare backchannel is never called one', () => {
    expect(echoesAgentTail('כן.', AGENT_LINE)).toBe(false);
    expect(echoesAgentTail('כן, זה.', AGENT_LINE)).toBe(false);
  });

  it('a real answer that happens to reuse one of her words is not an echo', () => {
    // "אין לי בעיה עם המחיר" against a sentence about price: the content words are his.
    expect(echoesAgentTail('אין לי בעיה עם המחיר שלכם', 'בוא נדבר על המחיר בדמו עצמו.')).toBe(false);
  });

  it('niqqud does not hide an echo — לךָ and לך are one word', () => {
    expect(echoesAgentTail('מרגיש לך', 'אם זה עדיין מרגיש לךָ לא נכון')).toBe(true);
  });
});
