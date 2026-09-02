import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './prompts/system-prompt.he.js';
import { guardSpeech } from './speech-guard.js';
import { hasPause, normalisePauses, pauseTag, PAUSE_SECONDS } from './voice-mode.js';

/**
 * THE PAUSE, AND THE ONE WAY IT CAN HURT A CALLER.
 *
 * The first version of this feature changed Cartesia's SPEED, and round 16 killed it: Koren cannot
 * hear 0.90 from 0.78, and on the transition card he chose the clip with no rate change at all. The
 * duration table that justified it was correct and measured the wrong thing.
 *
 * `<break time="…"/>` replaced it, at three lengths that each won a card. The risk moved with the
 * mechanism: a tag Cartesia does NOT recognise is one it reads out loud, so most of this file is
 * about which tags are allowed through and what happens to the rest.
 */
describe('normalisePauses', () => {
  it('lets through the three lengths that were actually heard', () => {
    for (const s of PAUSE_SECONDS) {
      const r = normalisePauses(`רגע ${pauseTag(s)} אני בודקת.`);
      expect(r.pauses).toBe(1);
      expect(r.dropped).toBe(0);
      expect(r.text).toContain(pauseTag(s));
    }
  });

  it('deletes a duration nobody has ever listened to', () => {
    // Not a smaller mistake than a typo. known-issues §16 kept the tag unshipped for a month
    // precisely because a length Cartesia silently ignores would be READ ALOUD, and the only
    // lengths anyone has heard are the three above.
    const r = normalisePauses('רגע <break time="1.5s"/> אני בודקת.');
    expect(r.pauses).toBe(0);
    expect(r.dropped).toBe(1);
    expect(r.text).toBe('רגע אני בודקת.');
  });

  it('deletes any other tag the model invents', () => {
    for (const bad of ['<pause>', '<emotion value="calm"/>', '<break>', '<break time=']) {
      const r = normalisePauses(`טוב ${bad} בסדר.`);
      expect(r.text).not.toContain('<');
      expect(r.dropped).toBeGreaterThan(0);
    }
  });

  it('accepts the spacing the model actually writes, and normalises it', () => {
    const r = normalisePauses('רגע <break  time="0.25s" /> אני בודקת.');
    expect(r.pauses).toBe(1);
    expect(r.text).toContain('<break time="0.25s"/>');
  });

  it('does not swallow a sentence that merely contains an angle bracket', () => {
    // Bounded length, no newline. `<` is not a character she speaks, but a runaway pattern that
    // ate the rest of the reply would be a far louder defect than a stray bracket.
    const long = 'זה עולה פחות מ<' + 'א'.repeat(60) + ' שקלים.';
    const r = normalisePauses(long);
    expect(r.text).toContain('שקלים');
    expect(r.dropped).toBe(0);
  });

  it('costs nothing on the sentence that has no tag, which is almost all of them', () => {
    const plain = 'אנחנו דואגים שכל פנייה תקבל שיחה תוך דקה.';
    expect(normalisePauses(plain)).toEqual({ text: plain, pauses: 0, dropped: 0 });
  });

  it('DELETES approved tags too when the feature is off', () => {
    // The kill switch is total by design. With the flag down she is never asked for a pause, so a
    // tag is the model doing something nobody sanctioned — skipping the stage would send it on.
    const r = normalisePauses(`רגע ${pauseTag('0.25')} אני בודקת.`, { enabled: false });
    expect(r.text).toBe('רגע אני בודקת.');
    expect(r.pauses).toBe(0);
    expect(r.dropped).toBe(1);
  });

  it('hasPause sees an approved pause and not an invented one', () => {
    expect(hasPause(`רגע ${pauseTag('0.15')} אני בודקת.`)).toBe(true);
    expect(hasPause('רגע <break time="2s"/> אני בודקת.')).toBe(false);
  });
});

describe('the guard', () => {
  it('passes an approved pause through to Cartesia untouched', () => {
    const r = guardSpeech(`רגע ${pauseTag('0.25')} אני בודקת את היומן.`, { voiceModes: true });
    expect(r.text).toContain(pauseTag('0.25'));
    expect(r.pauses).toBe(1);
    expect(r.pauseTagsDropped).toBe(0);
  });

  it('counts and removes one the model invented', () => {
    const r = guardSpeech('רגע <break time="3s"/> אני בודקת.', { voiceModes: true });
    expect(r.text).not.toContain('<');
    expect(r.pauseTagsDropped).toBe(1);
  });

  it('strips every tag when the feature is off', () => {
    const r = guardSpeech(`רגע ${pauseTag('0.25')} אני בודקת.`, {});
    expect(r.text).not.toContain('<');
    expect(r.pauses).toBe(0);
  });

  it('KEEPS THE FILLER POINTED when the pause is a tag and not an ellipsis', () => {
    // The first guarded render of round 17's winning sentence came out as bare `אה`: the niqqud is
    // stripped by the guard and re-applied by PRONUNCIATION_FIXES, whose rows were scoped to a
    // FOLLOWING ELLIPSIS — and the ellipsis had just been replaced by a tag. Bare `אה` is the
    // spelling Koren rejected on round 10 (card f2, verdict D), so the tag would have silently
    // undone an earlier verdict.
    const r = guardSpeech(`אז, אֶה ${pauseTag('0.15')} זה תלוי בכמות השיחות.`, { voiceModes: true });
    expect(r.text).toContain('אֶה');
  });

  it('still leaves the bare dictation nod unpointed', () => {
    // The scope was WIDENED, not removed. DICTATION_NOD is a bare `אה` with no pause after it and
    // has no verdict — round 10 card n1, he rejected all four spellings — so pointing it here
    // would be deciding it on his behalf.
    const r = guardSpeech('אה אה.', { voiceModes: true });
    expect(r.text).not.toContain('אֶה');
  });

  it('does not treat a pause as a tool-call leak', () => {
    // The pause stage runs BEFORE the leak scrub for exactly this reason: a tag is not a payload,
    // and counting it as one would put a false reading into the metric that means the model
    // malfunctioned.
    const r = guardSpeech(`רגע ${pauseTag('0.25')} אני בודקת.`, { voiceModes: true });
    expect(r.leakReasons ?? []).toEqual([]);
  });
});

describe('the prompt half', () => {
  const on = buildSystemPrompt({ toolsEnabled: true, voiceModes: true });
  const off = buildSystemPrompt({ toolsEnabled: true });

  it('teaches the three lengths in the three places that won their cards', () => {
    expect(on).toContain('When You Pause, And When You Do Not');
    expect(on).toContain('0.15s');
    expect(on).toContain('0.25s');
    expect(on).toContain('0.35s');
  });

  it('draws the line at what she already knows, not at how important the sentence is', () => {
    // ROUND 18 REPLACED THE RULE. Round 17 framed it as "a question that deserves thought", and
    // round 18 put that framing on the price answer — card `pr` — where Koren chose A, the version
    // with NO pause. His prose said why: *"אם זה אמירה חד משמעית שהסוכן לא צריך לחשוב בנוגע אליה
    // אז אין צורך בפאוזות, כי אין הגיון לעצור לחשוב באמצע משפט שידוע מראש."*
    //
    // The price question deserves thought and the ANSWER does not — it comes out of her settings.
    // So the test is not the weight of the question, it is whether she already holds the answer.
    expect(on).toContain('whether you already know what you are about to say');
    expect(on).toContain('Never on anything you already hold');
    expect(on).toContain('a price from your own settings');
    expect(on).toContain('never two replies running');
  });

  it('offers no speed and no marker, because both were replaced by the pause', () => {
    // Scoped to the section: "speed" appears elsewhere in the prompt for unrelated reasons, and an
    // assertion over the whole thing was testing the rest of the file rather than this feature.
    const section = on.slice(on.indexOf('## When You Pause'), on.indexOf('## When You Pause') + 1400);
    expect(section).not.toContain('speed');
    expect(on).not.toContain('[[H]]');
  });

  it('is a real kill-switch: OFF is the prompt that shipped without it', () => {
    expect(off).not.toContain('When You Pause');
    expect(off).not.toContain('break time');
    expect(buildSystemPrompt({ toolsEnabled: true, voiceModes: false })).toBe(off);
  });

  it('costs under 2% of the prompt, which is re-sent on every turn', () => {
    const growth = on.length / off.length - 1;
    expect(growth).toBeGreaterThan(0);
    expect(growth).toBeLessThan(0.02);
  });
});

/**
 * THE WIRING, read out of the source.
 *
 * Three separate producers in this repo have been built and never called — `observeAgentSpeech`,
 * `gateAViolations`, `registerTracker.note()` — so a unit test that passes in a world where
 * nobody invokes the thing is not enough on its own. The supervisor is building a structural
 * reachability test; until it lands these stay, because a brittle test that catches the bug beats
 * no test that catches it.
 */
describe('both halves move on one flag', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('gates the prompt section and the validator on VOICE_VOICE_MODES_ENABLED', () => {
    expect(read('./agent.ts')).toContain('voiceModes: env.VOICE_VOICE_MODES_ENABLED');
  });

  it('reports the pauses and the tags that had to be deleted', () => {
    const agent = read('./agent.ts');
    expect(agent).toContain('report.recordPauses(');
    expect(agent).toContain('report.recordPauseTagDropped(');
    expect(read('./call-report.ts')).toContain('pauseTagsDropped: number');
  });

  it('has no speed handling left anywhere in the feature', () => {
    // Round 16 killed it. `VOICE_HESITANT_SPEED_FACTOR` was removed rather than set to 1, because
    // a knob that does nothing is worse than an absent one — the next person would tune it.
    expect(read('./voice-mode.ts')).not.toContain('updateOptions');
    expect(read('./agent.ts')).not.toContain('VOICE_HESITANT_SPEED_FACTOR');
  });
});
