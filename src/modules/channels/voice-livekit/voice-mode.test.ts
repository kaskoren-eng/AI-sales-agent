import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './prompts/system-prompt.he.js';
import { guardSpeech } from './speech-guard.js';
import { clampSpeed, readModeMarker, speedFor, stripStrayMarkers } from './voice-mode.js';

/**
 * THE THREE REGISTERS, AND THE ONE WAY THIS FEATURE CAN HURT A CALLER.
 *
 * Koren chose that the MODEL declares its own register rather than the code inferring it. That
 * choice has exactly one failure mode and it is loud: a marker the guard misses is a marker
 * Cartesia reads out to a lead. So most of this file is about the stripping, not about the speeds.
 */
describe('readModeMarker', () => {
  it('reads the two registers she can declare, and removes the marker', () => {
    expect(readModeMarker('[[H]]רֶגַע... אני בודקת.')).toEqual({
      mode: 'hesitant',
      text: 'רֶגַע... אני בודקת.',
    });
    expect(readModeMarker('[[E]] כן... זה באמת שואב.')).toEqual({
      mode: 'empathetic',
      text: 'כן... זה באמת שואב.',
    });
  });

  it('accepts the sloppy spellings a model actually produces', () => {
    // Lower case, inner spaces, leading whitespace. None of these are worth a missed declaration,
    // and every one of them is worth a caller not hearing brackets.
    expect(readModeMarker('  [[ h ]] טוב.').mode).toBe('hesitant');
    expect(readModeMarker('[[e]] כן.').mode).toBe('empathetic');
  });

  it('leaves an unmarked reply exactly as it was — the common case', () => {
    const plain = 'בטח. אנחנו עובדים עם עסקים בדיוק כמו שלך.';
    expect(readModeMarker(plain)).toEqual({ mode: null, text: plain });
  });

  it('does not read a marker that is not at the start', () => {
    // Mid-sentence is malformed, not a declaration. The wide net below takes it away instead.
    expect(readModeMarker('טוב [[H]] אני בודקת.').mode).toBeNull();
  });
});

describe('stripStrayMarkers — the net', () => {
  it('removes a marker the narrow reader was never going to catch', () => {
    const out = stripStrayMarkers('טוב [[H]] אני בודקת.');
    expect(out.text).toBe('טוב אני בודקת.');
    expect(out.leaked).toBe(true);
  });

  it('removes a marker we do not recognise, and one that is misspelled', () => {
    // The net is deliberately wider than the vocabulary: an unknown mode is still brackets, and
    // brackets at a caller have no acceptable version.
    expect(stripStrayMarkers('[[X]] טוב.').text).toBe('טוב.');
    expect(stripStrayMarkers('[[hesitant]] טוב.').text).toBe('טוב.');
    expect(stripStrayMarkers('טוב. [[H]][[E]] בסדר.').text).toBe('טוב. בסדר.');
  });

  it('leaves ordinary speech untouched and reports no leak', () => {
    const plain = 'אנחנו דואגים שכל פנייה תקבל שיחה תוך דקה.';
    expect(stripStrayMarkers(plain)).toEqual({ text: plain, leaked: false });
  });

  it('does not eat a runaway bracket that swallows the whole sentence', () => {
    // An unclosed `[[` is not a marker. Bounded length and no newline in the pattern means a
    // sentence that merely CONTAINS brackets cannot be deleted wholesale.
    const s = '[[ this is not a marker, it is a very long run of text with no closing bracket';
    expect(stripStrayMarkers(s).text).toBe(s.trim());
    expect(stripStrayMarkers(s).leaked).toBe(false);
  });
});

describe('speed', () => {
  it('slows only the hesitant register, because the others cannot be heard', () => {
    // Measured 2026-09-02 (known-issues §9): 1.00 and 0.90 differ by under 4%, less than the
    // engine's own take-to-take noise. A "confident = faster" setting would be a knob that does
    // nothing, and an empathetic 0.86 would be a feature nobody could hear.
    expect(speedFor('confident', 0.9, 0.87)).toBe(0.9);
    expect(speedFor('empathetic', 0.9, 0.87)).toBe(0.9);
    expect(speedFor('hesitant', 0.9, 0.87)).toBe(0.78);
  });

  it('multiplies the tenant base rather than overwriting it', () => {
    // A tenant tuned to 1.0 keeps their tuning and slows down relative to it.
    expect(speedFor('hesitant', 1, 0.87)).toBe(0.87);
    expect(speedFor('confident', 1.2, 0.87)).toBe(1.2);
  });

  it('clamps, because out of range is SILENCE and not an error', () => {
    // Cartesia returns an EMPTY audio stream with a DEBUG log for a speed outside 0.6..1.5. The
    // agent does not throw; it stops making sound at a live caller. See env.ts VOICE_TTS_SPEED.
    expect(clampSpeed(0.2)).toBe(0.6);
    expect(clampSpeed(9)).toBe(1.5);
    expect(clampSpeed(Number.NaN)).toBe(1);
    expect(speedFor('hesitant', 0.62, 0.5)).toBe(0.6);
  });
});

describe('the guard strips the marker before anything is spoken', () => {
  it('reads the register and hands on speech with no bracket in it', () => {
    const r = guardSpeech('[[H]] רגע, אני בודקת את היומן.', { voiceModes: true });
    expect(r.declaredMode).toBe('hesitant');
    expect(r.text).not.toContain('[');
    expect(r.modeMarkerLeaked).toBeFalsy();
  });

  it('counts a marker that only the net caught', () => {
    const r = guardSpeech('טוב [[H]] אני בודקת.', { voiceModes: true });
    expect(r.modeMarkerLeaked).toBe(true);
    expect(r.text).not.toContain('[');
  });

  it('keeps the declaration even when the sentence itself is dropped', () => {
    // A marker written on a sentence the self-narration guard then deletes was still a
    // declaration, and the rest of the reply should be delivered in the register she asked for.
    const r = guardSpeech('[[H]] אני מדברת ככה כי זה טבעי לי בשיחה.', {
      voiceModes: true,
      selfNarrationGuard: true,
    });
    expect(r.silent).toBe(true);
    expect(r.declaredMode).toBe('hesitant');
  });

  it('does not touch brackets when the feature is off', () => {
    // The OFF path must be the pre-feature guard exactly. With the flag off the model is never
    // asked for a marker, so anything bracket-shaped is the model doing something else entirely
    // and this guard has no business rewriting it.
    const r = guardSpeech('[[H]] רגע, אני בודקת.', {});
    expect(r.declaredMode).toBeUndefined();
    expect(r.text).toContain('[[H]]');
  });
});

describe('the prompt half', () => {
  const on = buildSystemPrompt({ toolsEnabled: true, voiceModes: true });
  const off = buildSystemPrompt({ toolsEnabled: true });

  it('teaches the three registers and asks for the marker', () => {
    expect(on).toContain('How You Sound When You Are Sure, And When You Are Not');
    expect(on).toContain('[[H]]');
    expect(on).toContain('[[E]]');
    expect(on).toContain('NO MARKER');
  });

  it('is a real kill-switch: OFF is the prompt that shipped without it', () => {
    expect(off).not.toContain('[[H]]');
    expect(off).not.toContain('How You Sound When You Are Sure');
    expect(buildSystemPrompt({ toolsEnabled: true, voiceModes: false })).toBe(off);
  });

  it('costs under 2% of the prompt, which is re-sent on every turn', () => {
    // 1.53% as written. The first draft was 2.32% and was cut in half before it shipped — this is
    // not inside the sales model's ±5% ceiling (different flag) but it is still text the caller
    // pays for in silence on every reply of every call, and a behaviour feature does not get a
    // free pass because its budget is a fresh one.
    const growth = on.length / off.length - 1;
    expect(growth).toBeGreaterThan(0);
    expect(growth).toBeLessThan(0.02);
  });
});

/**
 * THE WIRING, read out of the source — same reason as the Gate A tests next door.
 *
 * This feature has three halves behind one flag (prompt, stripper, rate). Any two of them without
 * the third is a defect, and the worst pairing has Cartesia reading double brackets at a lead.
 * Unit tests of each half pass in a world where they were never connected.
 */
describe('all three halves move on one flag', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('gates the prompt section, the stripper and the rate on VOICE_VOICE_MODES_ENABLED', () => {
    const agent = read('./agent.ts');
    expect(agent).toContain('voiceModes: env.VOICE_VOICE_MODES_ENABLED');
    expect(agent).toContain('if (env.VOICE_VOICE_MODES_ENABLED)');
    expect(agent).toContain('updateOptions?.(');
  });

  it('reports the registers and the leak counter', () => {
    expect(read('./agent.ts')).toContain('report.recordVoiceMode(');
    expect(read('./agent.ts')).toContain('report.recordModeMarkerLeak()');
    expect(read('./call-report.ts')).toContain('modeMarkerLeaks: number');
  });
});
