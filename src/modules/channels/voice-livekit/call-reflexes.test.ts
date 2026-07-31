import { describe, expect, it } from 'vitest';
import { decideSilenceAction, decideVoicemailAction } from './call-reflexes.js';
import { SILENCE_NUDGE_HE, SILENCE_WRAP_HE, VOICEMAIL_MESSAGE_HE } from './call-state-lines.he.js';

describe('decideSilenceAction', () => {
  it('strike 1 is a stage-scoped nudge that does NOT hang up', () => {
    const a = decideSilenceAction(1, 'scheduling');
    expect(a.say).toBe(SILENCE_NUDGE_HE.scheduling);
    expect(a.teardown).toBe(false);
    expect(a.endReason).toBeUndefined();
  });

  it('uses a different line per stage', () => {
    expect(decideSilenceAction(1, 'discovery').say).toBe(SILENCE_NUDGE_HE.discovery);
    expect(decideSilenceAction(1, 'closing').say).toBe(SILENCE_NUDGE_HE.closing);
  });

  it('strike 2+ wraps and hangs up with end reason no_answer', () => {
    const a = decideSilenceAction(2, 'discovery');
    expect(a.say).toBe(SILENCE_WRAP_HE);
    expect(a.teardown).toBe(true);
    expect(a.endReason).toBe('no_answer');
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
