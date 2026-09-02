/**
 * SHE SOUNDS THE SAME AT MINUTE SIX AS SHE DID AT SECOND FOUR.
 *
 * Koren, 2026-09-02: *"השיחה כרגע מתבצעת שהסוכן מדבר באותו מקצב ואותו טון דיבור... אם הסוכן הוא
 * קצת יותר בטוח במה שהוא אומר אז המקצב שלו יהיה יותר אחיד ויותר קצבי, לעומת זאת אם הוא מהסס או
 * חושב על משהו שהוא נשאל והוא צריך לבדוק, אז התשובה שלו תהיה קצת יותר מהוססת והקצב שלו ירד."*
 *
 * Nothing in the system varies how she sounds inside a call. `VOICE_TTS_SPEED` is read once when
 * the TTS is constructed (`testing/speech.ts` → `agent.config.ts`) and never moves again. What
 * varies today is only which WORD opens a turn (`turn-opener.ts`), never the delivery.
 *
 * ── Two layers, two clocks, and the split is forced by the plugin ─────────────────────────────
 *
 * Cartesia's `speed` is fixed per `SynthesizeStream`, and the stream is created inside `ttsNode`
 * BEFORE the model has emitted a token (`agent.ts` → `voice.Agent.default.ttsNode`, and
 * `@livekit/agents-plugin-cartesia/dist/tts.js` builds its request packet once, above the token
 * loop). Waiting for the first token before returning the stream would put the LLM's ~930ms in
 * front of the instant acknowledgement, i.e. in front of the caller's silence. That is the one
 * budget on this project that is not negotiable.
 *
 * So:
 *
 *   TEXT  — the filler word, the punctuation, the sentence length. The model writes it, it lands
 *           on the very next sentence, and it is the STRONGER lever of the two.
 *   RATE  — `speed`. Certain-from-code modes (a tool call just ran) apply on the same turn;
 *           a mode the model declared applies from the next inference step of that turn.
 *
 * The research says that ordering is right, not merely convenient. Kirkland et al., Interspeech
 * 2022, measured filled-pause location, speech rate and f0 separately against perceived
 * confidence: most confident = no filler + low f0 + fast rate; least confident = a MEDIAL filled
 * pause + high f0 + slow rate — and *insertion of the filled pause had the strongest influence*,
 * with rate and pitch as finer controls on top. We cannot touch pitch at all on Cartesia. The
 * strongest lever is therefore the one the model already controls by writing, and it is already
 * built here (`prompts/thinking-fillers.he.ts`, every spelling passed by ear).
 *
 * ── Why these speeds and not rounder ones ─────────────────────────────────────────────────────
 *
 * Measured 2026-09-02 against Cartesia directly, sonic-3.5 over the websocket path at the
 * production volume, four takes per setting (the table is in `phase-4-known-issues.md` §9):
 *
 *   1.00 → 4000ms   (−3.8% vs 0.90, i.e. BELOW the noise floor)
 *   0.90 → 4160ms   production today
 *   0.84 → 4720ms   +13.5%, against a 1.11× take-to-take noise band — marginal
 *   0.75 → 5360ms   +28.8%, unambiguous
 *
 * Two consequences, both of which overrode what I would have picked by taste:
 *
 * 1. **There is no faster mode.** 1.00 and 0.90 differ by less than the engine's own variation, so
 *    a "confident = quicker" setting would be a knob that does nothing, and the 8kHz
 *    intelligibility argument (`env.ts` VOICE_TTS_SPEED) says do not try anyway. Confident is
 *    production speed, unchanged.
 * 2. **Empathetic gets no speed of its own.** Anything in 0.85–1.00 is inside the noise. Slowing
 *    an empathetic line to 0.86 would have looked like a feature and been inaudible. The
 *    empathetic beat is bought with PUNCTUATION instead — an ellipsis is worth 0.25–0.5s and
 *    survives streaming, where a comma is worth ~0.18s and often vanishes (known-issues §16).
 *
 * That leaves two speeds and three registers, and saying so plainly is better than shipping a
 * third number that cannot be heard.
 */

/** The three registers. `confident` is the default and carries no marker. */
export const VOICE_MODES = ['confident', 'hesitant', 'empathetic'] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];

/**
 * Cartesia's hard range. **Out of range is not an error** — Cartesia returns an EMPTY audio
 * stream with a DEBUG log and the agent simply goes silent at the caller (`env.ts`
 * VOICE_TTS_SPEED). The clamp is not politeness; it is the thing standing between a typo and a
 * dead call.
 */
export const SPEED_MIN = 0.6;
export const SPEED_MAX = 1.5;

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
}

/**
 * Speed per mode, as a delta applied to whatever the call's base speed is.
 *
 * A MULTIPLIER rather than an absolute number, because the base is a per-tenant setting
 * (`PersonaTts.speed` → `resolveVoiceProfile`) and an absolute 0.78 would silently overwrite a
 * tenant who had been tuned to something else. 0.87 × 0.90 ≈ 0.78, which is the reading from the
 * table above; on a tenant at 1.0 the same multiplier lands on 0.87.
 */
function speedFactor(mode: VoiceMode, hesitantFactor: number): number {
  return mode === 'hesitant' ? hesitantFactor : 1;
}

export function speedFor(mode: VoiceMode, baseSpeed: number, hesitantFactor: number): number {
  return clampSpeed(Math.round(baseSpeed * speedFactor(mode, hesitantFactor) * 100) / 100);
}

/**
 * THE MARKER, AND THE FACT THAT IT CAN BE SPOKEN.
 *
 * Koren chose that the model declares its own state rather than the code inferring it. The cost of
 * that choice is exactly one failure mode: a marker the guard misses is a marker Cartesia reads
 * out to a lead. This repo has the scar already — an unscreened `חח` came out as the letter khet,
 * and `אוו` vanished; whatever `[[H]]` would sound like in Hebrew, nobody wants to find out on a
 * customer's call.
 *
 * So the marker is stripped in `guardSpeech`, FIRST, before the tool-call scrub — and the pattern
 * is deliberately wider than the markers it is meant to match. `[[anything short]]` goes, whether
 * or not it is a mode we know, whether or not it is spelled correctly. A stray double bracket in
 * her speech has no legitimate meaning; a stray double bracket at a caller does.
 *
 * The narrow pattern (`MODE_MARKER`) reads the mode. The wide one (`ANY_MARKER`) is the net.
 */
const MODE_MARKER = /^\s*\[\[\s*(H|E|C)\s*\]\]\s*/iu;
const ANY_MARKER = /\[\[[^\]\n]{0,24}\]\]/gu;

const MARKER_TO_MODE: Record<string, VoiceMode> = {
  h: 'hesitant',
  e: 'empathetic',
  c: 'confident',
};

/**
 * Reads a leading mode marker off a sentence and removes it.
 *
 * `mode` is null when there was no marker — which is the common case and means `confident`. The
 * caller distinguishes "she declared confident" from "she declared nothing" only if it wants to;
 * both behave the same.
 */
export function readModeMarker(text: string): { mode: VoiceMode | null; text: string } {
  const m = MODE_MARKER.exec(text);
  if (!m) return { mode: null, text };
  const mode = MARKER_TO_MODE[m[1]!.toLowerCase()] ?? null;
  return { mode, text: text.slice(m[0].length) };
}

/**
 * The safety net: remove ANY double-bracketed token, anywhere in the sentence.
 *
 * Returns `leaked` when it had to remove something the narrow reader had already been given a
 * chance at — i.e. a marker that was malformed, mid-sentence, or repeated. That is counted on the
 * call report (`modeMarkerLeaks`) and it must be zero. A non-zero reading does not mean a caller
 * heard anything; it means the narrow path missed and only the net saved it, which is one failure
 * away from being audible.
 */
export function stripStrayMarkers(text: string): { text: string; leaked: boolean } {
  if (!text.includes('[[')) return { text, leaked: false };
  const cleaned = text.replace(ANY_MARKER, '').replace(/\s{2,}/gu, ' ').trim();
  return { text: cleaned, leaked: cleaned !== text.trim() };
}
