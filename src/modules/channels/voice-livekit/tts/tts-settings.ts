/**
 * Per-tenant agent persona and TTS prosody (`tenants.settings.agent_persona`).
 *
 * WHY THIS EXISTS. Until now every tenant spoke with the SAME voice: `CARTESIA_VOICE_ID_PRIMARY`,
 * `VOICE_TTS_SPEED` and `VOICE_TTS_VOLUME` are process-wide env vars, so a second tenant on the
 * same worker would have been indistinguishable from ClickScales. The env values stay — they are
 * the DEFAULTS — and a tenant may override any subset of them.
 *
 * THE FAILURE MODE THIS FILE EXISTS TO PREVENT. An out-of-range Cartesia parameter does not throw
 * and does not warn: Cartesia returns an EMPTY audio stream with a DEBUG log, and the agent simply
 * goes mute on a live call (see env.ts on VOICE_TTS_SPEED, and known-issues §2). Env vars are gated
 * by Zod at boot; a value typed into `tenants.settings` by a dashboard, a script or raw SQL is not.
 * So every value is re-validated HERE, against Cartesia's documented limits, before it can reach
 * the wire.
 *
 * TWO VALIDATORS, DELIBERATELY:
 *   - `resolveAgentPersona()` NEVER THROWS. It runs mid-call, after the caller has been answered
 *     and the legal recording notice has played. Throwing there would drop a live call over a
 *     cosmetic setting — a strictly worse outcome than the default voice. It falls back per FIELD
 *     (a bad `speed` must not discard a good `voiceId`) and reports every rejection in `warnings`.
 *   - `assertAgentPersona()` THROWS. It guards the write paths (settings API, the `voice:sample`
 *     CLI) so a bad value is rejected at the point a human can still fix it, loudly, instead of
 *     being discovered as silence on a customer call.
 *
 * `tts-settings.test.ts` asserts they cannot drift: resolve(assert(x)) always yields zero warnings.
 *
 * Pure module — no plugin, DB or network imports. Applying the result to a live TTS object is
 * `applyTenantTts()` in agent.config.ts, which is the only place that knows the provider routes.
 */

/** The settings key. Claimed by VOICE in CLAUDE.md. */
export const AGENT_PERSONA_KEY = 'agent_persona';

/**
 * The emotions Cartesia's TTS WEBSOCKET accepts in `generation_config.emotion`.
 *
 * THIS LIST IS SHORTER THAN IT LOOKS ELSEWHERE, and the difference matters. Cartesia's capability
 * guide advertises 60+ emotion words (happy, excited, sarcastic…), but those belong to the SSML
 * tag / playground surface. The websocket API reference — the path this agent actually uses —
 * restricts `generation_config.emotion` to exactly these five, and says results for anything
 * outside the list are not guaranteed and may change without notice.
 *
 * Anything else is REJECTED rather than passed through, because "not guaranteed" against a vendor
 * whose rejection mode is silence means a mute agent, not a slightly-off tone. The documented
 * escape hatch for richer expression is an inline `<emotion value="…"/>` SSML tag in the transcript
 * — deliberately NOT built here: it is documented as highly experimental and requires buffering a
 * whole tag before flushing, which fights the stream-every-stage rule (methodology principle #3).
 */
export const CARTESIA_EMOTIONS = ['neutral', 'calm', 'angry', 'content', 'sad'] as const;
export type CartesiaEmotion = (typeof CARTESIA_EMOTIONS)[number];

/**
 * Cartesia's documented ranges for sonic-3 / sonic-3.5.
 *
 * NOTE the plugin is LOOSER than the vendor: agents-plugin-cartesia warns only outside 0.6–2.0 for
 * speed, where Cartesia's own API reference caps it at 1.5. That gap is exactly the band where a
 * value passes every local check and comes back as silence, so these constants — not the plugin's
 * — are the ones enforced. They mirror the Zod bounds on VOICE_TTS_SPEED / VOICE_TTS_VOLUME.
 */
export const TTS_LIMITS = {
  speed: { min: 0.6, max: 1.5 },
  volume: { min: 0.5, max: 2.0 },
} as const;

/** Agent gender — drives Hebrew verb inflection ("קרן סיימה" / "דניאל סיים"). */
export type AgentGender = 'female' | 'male';

/** The `agent_persona.tts` sub-object: how this tenant's agent sounds. */
export interface AgentPersonaTts {
  /** Cartesia voice id. Placeholder `HE_VOICE_ID` until voices are selected. */
  voiceId?: string;
  emotion?: CartesiaEmotion;
  speed?: number;
  volume?: number;
}

/**
 * `tenants.settings.agent_persona`.
 *
 * `name` and `gender` are validated and stored but NOT yet consumed — the system prompt and
 * greeting still carry a hardcoded "קרן". Wiring them in changes Hebrew grammar across three
 * grammatical persons and belongs in its own commit with its own prompt regression tests
 * (methodology rule #2). They live here now so the settings key is claimed and shaped once.
 *
 * `model` is deliberately NOT a tenant knob. Which Cartesia model speaks Hebrew is a measured
 * finding, not a preference: sonic-turbo, sonic-2 and sonic-lite all return zero audio for `he`,
 * so a tenant able to choose one could silently mute their own agent.
 */
export interface AgentPersona {
  name: string | null;
  gender: AgentGender | null;
  tts: AgentPersonaTts;
}

/** TTS option overrides, named as the Cartesia plugin names them (`voice`, not `voiceId`). */
export interface TtsOverrides {
  voice?: string;
  emotion?: CartesiaEmotion;
  speed?: number;
  volume?: number;
}

export type TtsField = 'voice' | 'emotion' | 'speed' | 'volume';

export interface ResolvedAgentPersona {
  /** Only the fields this tenant actually set AND that survived validation. Empty means
   * "everything comes from env" — the callsite then skips updateOptions entirely. */
  overrides: TtsOverrides;
  /** Where each field's effective value came from. `'default'` = the env/plugin value. */
  sources: Record<TtsField, 'tenant' | 'default'>;
  /** One human-readable line per rejected field. Empty on a clean config. Never swallowed:
   * logged as `voice_tts_config` and persisted in the call report, because raw-SQL edits bypass
   * every validator and this is the only way they surface. */
  warnings: string[];
  persona: { name: string | null; gender: AgentGender | null };
}

/**
 * Does this model accept `generation_config.emotion`?
 *
 * The plugin only builds a generation_config for sonic-3-family models (`isSonic3`, a
 * `startsWith('sonic-3')` check that covers sonic-3.5); on anything else it drops speed/emotion
 * with a warn. Mirrored here so the rejection is REPORTED to us rather than buried in plugin logs.
 */
export function supportsEmotion(model: string): boolean {
  return model.startsWith('sonic-3');
}

const DEFAULT_SOURCES: Record<TtsField, 'tenant' | 'default'> = {
  voice: 'default',
  emotion: 'default',
  speed: 'default',
  volume: 'default',
};

function isEmotion(value: unknown): value is CartesiaEmotion {
  return typeof value === 'string' && (CARTESIA_EMOTIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * settings blob -> validated TTS overrides. NEVER THROWS — see the file header.
 *
 * Per-FIELD fallback is the whole point: a tenant with a good voice id and a typo'd speed keeps
 * their voice and loses only the speed. All-or-nothing would turn one bad character into a
 * completely different-sounding agent.
 */
export function resolveAgentPersona(
  settings: unknown,
  env: { CARTESIA_MODEL: string },
): ResolvedAgentPersona {
  const overrides: TtsOverrides = {};
  const sources: Record<TtsField, 'tenant' | 'default'> = { ...DEFAULT_SOURCES };
  const warnings: string[] = [];
  const persona: { name: string | null; gender: AgentGender | null } = { name: null, gender: null };

  const raw = isRecord(settings) ? settings[AGENT_PERSONA_KEY] : undefined;
  if (raw === undefined) return { overrides, sources, warnings, persona };
  if (!isRecord(raw)) {
    warnings.push(`agent_persona is ${describe(raw)}, expected an object — using env defaults`);
    return { overrides, sources, warnings, persona };
  }

  // `null` means "not set", not "malformed" — assertAgentPersona() normalizes an omitted name or
  // gender to null, so warning on it would make every persona written through the API report a
  // warning on every call. (The round-trip test in tts-settings.test.ts catches exactly this.)
  if (typeof raw.name === 'string' && raw.name.trim().length > 0) persona.name = raw.name.trim();
  else if (raw.name !== undefined && raw.name !== null) warnings.push(`agent_persona.name is ${describe(raw.name)} — ignored`);

  if (raw.gender === 'female' || raw.gender === 'male') persona.gender = raw.gender;
  else if (raw.gender !== undefined && raw.gender !== null) warnings.push(`agent_persona.gender is ${describe(raw.gender)}, expected 'female' | 'male' — ignored`);

  const tts = raw.tts;
  if (tts === undefined) return { overrides, sources, warnings, persona };
  if (!isRecord(tts)) {
    warnings.push(`agent_persona.tts is ${describe(tts)}, expected an object — using env defaults`);
    return { overrides, sources, warnings, persona };
  }

  if (typeof tts.voiceId === 'string' && tts.voiceId.trim().length > 0) {
    overrides.voice = tts.voiceId.trim();
    sources.voice = 'tenant';
  } else if (tts.voiceId !== undefined) {
    warnings.push(`agent_persona.tts.voiceId is ${describe(tts.voiceId)}, expected a non-empty string — using env voice`);
  }

  if (tts.emotion !== undefined) {
    if (!isEmotion(tts.emotion)) {
      warnings.push(
        `agent_persona.tts.emotion is ${describe(tts.emotion)}, expected one of ${CARTESIA_EMOTIONS.join(' | ')} — dropped`,
      );
    } else if (!supportsEmotion(env.CARTESIA_MODEL)) {
      // Not the tenant's mistake: the model changed underneath a valid setting. Say which.
      warnings.push(`agent_persona.tts.emotion is set but model '${env.CARTESIA_MODEL}' has no emotion control — dropped`);
    } else {
      overrides.emotion = tts.emotion;
      sources.emotion = 'tenant';
    }
  }

  const speed = validateNumber(tts.speed, 'speed', warnings);
  if (speed !== undefined) {
    overrides.speed = speed;
    sources.speed = 'tenant';
  }

  const volume = validateNumber(tts.volume, 'volume', warnings);
  if (volume !== undefined) {
    overrides.volume = volume;
    sources.volume = 'tenant';
  }

  return { overrides, sources, warnings, persona };
}

function validateNumber(value: unknown, field: 'speed' | 'volume', warnings: string[]): number | undefined {
  if (value === undefined) return undefined;
  const { min, max } = TTS_LIMITS[field];
  // Strings are rejected rather than coerced. '0.9' in a jsonb blob means someone's write path is
  // not validating; coercing it hides that until the day the value is 'fast'.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    warnings.push(`agent_persona.tts.${field} is ${describe(value)}, expected a number — using env ${field}`);
    return undefined;
  }
  if (value < min || value > max) {
    warnings.push(
      `agent_persona.tts.${field}=${value} is outside Cartesia's ${min}–${max} range — using env ${field} ` +
        '(out-of-range values make Cartesia return an empty stream and the agent go silent)',
    );
    return undefined;
  }
  return value;
}

/** Type name for a warning message, without ever printing the value itself (it may be PII). */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `'${value.slice(0, 40)}'`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `a ${typeof value}`;
}

/**
 * WRITE-PATH validator. THROWS on anything `resolveAgentPersona` would silently drop.
 *
 * Used by the settings service/route (→ 400) and by `npm run voice:sample` (fails in milliseconds,
 * before the first Cartesia call, instead of returning an empty stream you then have to diagnose).
 * Returns the normalized persona so callers store exactly what was validated.
 */
export function assertAgentPersona(input: unknown): AgentPersona {
  if (!isRecord(input)) throw new Error(`agent_persona must be an object, got ${describe(input)}`);

  let name: string | null = null;
  if (input.name !== undefined && input.name !== null) {
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new Error(`agent_persona.name must be a non-empty string, got ${describe(input.name)}`);
    }
    name = input.name.trim();
  }

  let gender: AgentGender | null = null;
  if (input.gender !== undefined && input.gender !== null) {
    if (input.gender !== 'female' && input.gender !== 'male') {
      throw new Error(`agent_persona.gender must be 'female' or 'male', got ${describe(input.gender)}`);
    }
    gender = input.gender;
  }

  const rawTts = input.tts;
  if (rawTts !== undefined && !isRecord(rawTts)) {
    throw new Error(`agent_persona.tts must be an object, got ${describe(rawTts)}`);
  }
  const src = (rawTts ?? {}) as Record<string, unknown>;
  const tts: AgentPersonaTts = {};

  if (src.voiceId !== undefined) {
    if (typeof src.voiceId !== 'string' || src.voiceId.trim().length === 0) {
      throw new Error(`agent_persona.tts.voiceId must be a non-empty string, got ${describe(src.voiceId)}`);
    }
    tts.voiceId = src.voiceId.trim();
  }

  if (src.emotion !== undefined) {
    if (!isEmotion(src.emotion)) {
      throw new Error(
        `agent_persona.tts.emotion must be one of ${CARTESIA_EMOTIONS.join(' | ')}, got ${describe(src.emotion)}. ` +
          'Cartesia\'s websocket accepts no other value; richer expression needs inline SSML tags.',
      );
    }
    tts.emotion = src.emotion;
  }

  for (const field of ['speed', 'volume'] as const) {
    const value = src[field];
    if (value === undefined) continue;
    const { min, max } = TTS_LIMITS[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`agent_persona.tts.${field} must be a number, got ${describe(value)}`);
    }
    if (value < min || value > max) {
      throw new Error(`agent_persona.tts.${field} must be between ${min} and ${max}, got ${value}`);
    }
    tts[field] = value;
  }

  return { name, gender, tts };
}
