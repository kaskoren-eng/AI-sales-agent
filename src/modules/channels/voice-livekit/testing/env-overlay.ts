/**
 * HOW AN A/B VARIANT ACTUALLY REACHES THE AGENT.
 *
 * THE TRAP THIS EXISTS TO BEAT. `src/config/env.ts` runs `dotenv.config({ override: true })` at
 * module load, so `.env` WINS over the shell environment. `VOICE_TTS_SPEED=0.9 npm run voice:dev`
 * therefore does NOTHING, silently — the value is set, then overwritten a millisecond later, and
 * the agent runs the `.env` value while the terminal says otherwise. `voice-ab.ts` documents the
 * same trap for `CARTESIA_MODEL`. An A/B run that hits this produces two IDENTICAL clips labelled
 * A and B, which is worse than no A/B at all: it looks like "the change made no difference".
 *
 * THE MECHANISM. dotenv's override only clobbers keys that are PRESENT IN `.env`. A key that is
 * not in `.env` survives from the shell. `VOICE_TEST_OVERLAY` is such a key by construction — it
 * names a JSON file of `{ "ENV_KEY": "value" }` pairs, and this module writes those pairs into
 * `process.env` AFTER dotenv has run. Import order is what makes that true, and it is the whole
 * design:
 *
 *   1. this module imports `config/env.js` for its side effect  → dotenv runs, `.env` wins
 *   2. this module's body then writes the overlay into process.env → the overlay wins
 *   3. `agent.ts` imports THIS FILE FIRST, before anything that reads env → everyone downstream,
 *      including every later `loadEnv()` in every module, sees the overlaid values
 *
 * Because the values land in `process.env` (not just in one parsed `Env` object), the pipeline
 * observer reports them with `source: 'env'`, and the call report therefore proves, per call,
 * which variant actually ran. That proof is the point — see `ab-runner.ts`.
 *
 * A worker forks a child process per job and the child re-imports this file; `VOICE_TEST_OVERLAY`
 * is inherited through the fork, so the overlay applies in the child too.
 *
 * Costs nothing and does nothing when `VOICE_TEST_OVERLAY` is unset, which is always in production.
 */
import { readFileSync } from 'node:fs';

// Side-effect import, and it MUST stay above everything else in this file: it is what runs dotenv,
// and the overlay is only meaningful once dotenv has already had its turn.
import '../../../../config/env.js';

export const OVERLAY_ENV_VAR = 'VOICE_TEST_OVERLAY';

/**
 * Parses an overlay file into flat string pairs.
 *
 * Values are stringified because `process.env` only holds strings — `{ "VOICE_TTS_SPEED": 0.9 }`
 * and `{ "VOICE_TTS_SPEED": "0.9" }` must behave identically, or a variant file written the
 * obvious way would silently do nothing.
 */
export function parseOverlay(json: string, whereFrom: string): Record<string, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`${OVERLAY_ENV_VAR}: ${whereFrom} is not valid JSON — ${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${OVERLAY_ENV_VAR}: ${whereFrom} must be a JSON object of ENV_KEY -> value`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) {
      // A lowercase or hyphenated key is never an env var, so it would apply and do nothing —
      // exactly the silent-no-op this module exists to prevent. Refuse instead.
      throw new Error(`${OVERLAY_ENV_VAR}: "${key}" in ${whereFrom} is not a valid env var name`);
    }
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      throw new Error(`${OVERLAY_ENV_VAR}: "${key}" in ${whereFrom} must be a string, number or boolean`);
    }
    out[key] = String(value);
  }
  return out;
}

/**
 * Applies the overlay named by `VOICE_TEST_OVERLAY`, if any. Returns the keys it set.
 *
 * THROWS on a broken overlay rather than continuing. A test harness that quietly ignores its own
 * configuration is the failure this whole file is about.
 */
export function applyTestOverlay(processEnv: NodeJS.ProcessEnv = process.env): string[] {
  const path = processEnv[OVERLAY_ENV_VAR];
  if (!path) return [];

  const pairs = parseOverlay(readFileSync(path, 'utf8'), path);
  const applied: string[] = [];
  for (const [key, value] of Object.entries(pairs)) {
    processEnv[key] = value;
    applied.push(key);
  }
  return applied;
}

const applied = applyTestOverlay();
if (applied.length > 0) {
  // Deliberately loud and deliberately on stdout: this is the line that proves to a human which
  // variant this process is running, and the A/B runner greps for it as a first-line sanity check
  // long before the call report exists.
  console.log(
    `voice_test_overlay ${JSON.stringify({
      file: process.env[OVERLAY_ENV_VAR],
      applied: Object.fromEntries(applied.map((k) => [k, process.env[k]])),
    })}`,
  );
}
