import { describe, expect, it } from 'vitest';
import { resolveTurnDetection } from '../agent.config.js';
import { parseBiasTerms } from './soniox.stt.js';
import type { Env } from '../../../../config/env.js';

/**
 * The guard test that matters.
 *
 * VOICE_TURN_DETECTION=stt against the OpenAI STT is a SILENT, TOTAL product failure: the caller
 * talks, gpt-realtime-whisper never emits END_OF_SPEECH (it is transcription-only — the same root
 * cause that makes it ignore semantic_vad), and the agent simply never replies. No error, no log,
 * no crash. We have already shipped one silent-agent bug to a live call — an invalid
 * reasoning_effort value — and heard about it from the other end of the phone
 * ("אף אחד לא מדבר איתי" — nobody is talking to me). Once is enough.
 */
const baseEnv = {
  STT_PROVIDER: 'openai',
  VOICE_TURN_DETECTION: 'vad',
  VOICE_STT_PROMPT: 'קורן, ClickScales, פגישה',
} as unknown as Env;

describe('resolveTurnDetection — the silent-agent guard', () => {
  it('allows the default: vad turn detection on the OpenAI STT', () => {
    expect(resolveTurnDetection(baseEnv)).toBe('vad');
  });

  it('allows stt turn detection on Soniox, which does emit an end-of-speech signal', () => {
    const env = { ...baseEnv, STT_PROVIDER: 'soniox', VOICE_TURN_DETECTION: 'stt' } as Env;
    expect(resolveTurnDetection(env)).toBe('stt');
  });

  it('REFUSES stt turn detection on the OpenAI STT — the agent would never answer', () => {
    const env = { ...baseEnv, VOICE_TURN_DETECTION: 'stt' } as unknown as Env;
    expect(() => resolveTurnDetection(env)).toThrow(/requires STT_PROVIDER=soniox/);
  });

  it('allows Soniox with the vad timer — a valid fallback if its endpoint disappoints', () => {
    const env = { ...baseEnv, STT_PROVIDER: 'soniox' } as unknown as Env;
    expect(resolveTurnDetection(env)).toBe('vad');
  });
});

describe('parseBiasTerms', () => {
  it('splits the Whisper-style prompt into the term array Soniox wants', () => {
    expect(parseBiasTerms('קורן, ClickScales, פגישה')).toEqual(['קורן', 'ClickScales', 'פגישה']);
  });

  it('drops empty terms rather than biasing the recogniser toward an empty string', () => {
    expect(parseBiasTerms('קורן,, ,פגישה')).toEqual(['קורן', 'פגישה']);
  });
});
