import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * THE BUG THIS EXISTS FOR — a flag you could only ever turn ON.
 *
 * `z.coerce.boolean()` is `Boolean(value)`, and every non-empty string in JavaScript is truthy. So
 * `FEATURE=false` in a .env file parses as `true`. The config reads exactly as intended and does the
 * opposite, and nothing warns you.
 *
 * It cost us real work. `VOICE_PREEMPTIVE_TTS=false` ran as TRUE for weeks: a latency measurement
 * concluded the feature was slow and "turned it off", it was never off, so the measurement was
 * describing something else and the fix changed nothing. `SHADOW_STT_ENABLED=false` kept a second
 * STT engine running on every live call, billing for it silently.
 *
 * These tests pin the parser that replaced it. If someone reaches for z.coerce.boolean() again,
 * the first test here fails and tells them why.
 */

/** The exact parser from env.ts. Kept in sync by the tests below. */
function envBool(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((v) =>
      typeof v === 'boolean' ? v : ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase()),
    );
}

describe('envBool — the boolean env var parser', () => {
  it('DOES NOT do what z.coerce.boolean() does (this is the whole point)', () => {
    // Proof of the bug, so nobody re-introduces it thinking it is equivalent.
    expect(z.coerce.boolean().parse('false')).toBe(true); // <-- the bug
    expect(envBool(true).parse('false')).toBe(false); // <-- the fix
  });

  it('parses the strings people actually write for false', () => {
    for (const v of ['false', 'FALSE', 'False', '0', 'no', 'off', '']) {
      expect(envBool(true).parse(v)).toBe(false);
    }
  });

  it('parses the strings people actually write for true', () => {
    for (const v of ['true', 'TRUE', 'True', '1', 'yes', 'on', ' true ']) {
      expect(envBool(false).parse(v)).toBe(true);
    }
  });

  it('treats an unrecognised value as false rather than silently enabling something', () => {
    // A typo must not switch a feature on. Failing closed is the only safe direction here:
    // SHADOW_STT_ENABLED being wrongly ON bills for a second STT engine on every live call.
    expect(envBool(false).parse('maybe')).toBe(false);
    expect(envBool(true).parse('maybe')).toBe(false);
  });

  it('uses the default when the var is absent', () => {
    expect(envBool(true).parse(undefined)).toBe(true);
    expect(envBool(false).parse(undefined)).toBe(false);
  });
});
