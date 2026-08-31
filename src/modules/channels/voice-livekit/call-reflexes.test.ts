import { describe, expect, it } from 'vitest';
import { decideSilenceAction, decideVoicemailAction, silenceNudgeWaitMs } from './call-reflexes.js';
import { SILENCE_NUDGE_HE, SILENCE_WRAP_HE, VOICEMAIL_MESSAGE_HE } from './call-state-lines.he.js';

describe('decideSilenceAction', () => {
  it('strike 1 is a stage-scoped nudge that does NOT hang up', () => {
    const a = decideSilenceAction(1, 'scheduling');
    expect(a).not.toBeNull();
    expect(a!.say).toBe(SILENCE_NUDGE_HE.scheduling);
    expect(a!.teardown).toBe(false);
    expect(a!.endReason).toBeUndefined();
  });

  it('uses a different line per stage', () => {
    expect(decideSilenceAction(1, 'discovery')!.say).toBe(SILENCE_NUDGE_HE.discovery);
    expect(decideSilenceAction(1, 'closing')!.say).toBe(SILENCE_NUDGE_HE.closing);
  });

  it('strike 2 reassures and holds the line — NEVER hangs up on silence', () => {
    const a = decideSilenceAction(2, 'discovery');
    expect(a).not.toBeNull();
    expect(a!.say).toBe(SILENCE_WRAP_HE);
    expect(a!.teardown).toBe(false);
    expect(a!.endReason).toBeUndefined();
  });

  it('past the nudge cap it returns null — Keren waits quietly, no hang-up', () => {
    expect(decideSilenceAction(3, 'discovery')).toBeNull();
    expect(decideSilenceAction(9, 'qualifying')).toBeNull();
  });
});

describe('silenceNudgeWaitMs — the nudge that fired into a man who was thinking', () => {
  const DEFAULT = 20_000;

  it('would have refused BOTH nudges on the 2026-08-31 13:52 call', () => {
    // The two `endedBy: silence_reflex` gaps from that call's report, to the millisecond.
    expect(silenceNudgeWaitMs(7287, DEFAULT)).toBe(12_713);
    expect(silenceNudgeWaitMs(7345, DEFAULT)).toBe(12_655);
  });

  it('still allows it once the silence is longer than any pause we have measured', () => {
    // The longest genuine caller pause across the two instrumented production calls was ~18s
    // (08:37, she stopped at 117.1s and he spoke at ~135s).
    expect(silenceNudgeWaitMs(20_000, DEFAULT)).toBe(0);
    expect(silenceNudgeWaitMs(25_000, DEFAULT)).toBe(0);
  });

  it('re-arms for exactly the REMAINDER, so the nudge lands on time and not an interval late', () => {
    expect(silenceNudgeWaitMs(12_000, DEFAULT)).toBe(8_000);
  });

  it('0 restores the 2026-08-31 behaviour exactly — nudge the moment the SDK says away', () => {
    expect(silenceNudgeWaitMs(0, 0)).toBe(0);
    expect(silenceNudgeWaitMs(7287, 0)).toBe(0);
  });

  it('a missing quiet-clock reading never suppresses the nudge forever', () => {
    // `quietSince === null` means somebody is making a sound, and the caller passes 0. It must
    // read as "wait the full window", not as "wait for ever".
    expect(silenceNudgeWaitMs(0, DEFAULT)).toBe(DEFAULT);
  });
});

describe('decideVoicemailAction', () => {
  it('leaves the voicemail message and hangs up with end reason voicemail', () => {
    const a = decideVoicemailAction('machine_end_beep');
    expect(a.say).toBe(VOICEMAIL_MESSAGE_HE);
    expect(a.teardown).toBe(true);
    expect(a.endReason).toBe('voicemail');
  });
});
