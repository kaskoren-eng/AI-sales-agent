import { stt as sttBase } from '@livekit/agents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTurnDetection } from '../agent.config.js';
import { parseBiasTerms, withPausePreflight } from './soniox.stt.js';
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

/**
 * withPausePreflight — the sub-1s mechanism, under test.
 *
 * Preemptive generation is the ONLY route to a reply under a second: end-of-turn + LLM + TTS
 * measured 1466ms running serially, so the reply has to be WRITTEN during the end-of-turn wait.
 * The previous trigger (two consecutive interims with identical text) fired ONCE in a 135s call
 * because Soniox keeps revising its interim right up to the endpoint. These tests pin the pause
 * trigger that replaced it, and — just as importantly — pin that it never disturbs the plugin's
 * own event stream, since the first attempt at this feature broke the agent outright.
 */
const PAUSE_MS = 200;

function interim(text: string): sttBase.SpeechEvent {
  return {
    type: sttBase.SpeechEventType.INTERIM_TRANSCRIPT,
    alternatives: [{ text, language: 'he', startTime: 0, endTime: 0, confidence: 1 }],
  } as unknown as sttBase.SpeechEvent;
}

function final(text: string): sttBase.SpeechEvent {
  return {
    type: sttBase.SpeechEventType.FINAL_TRANSCRIPT,
    alternatives: [{ text, language: 'he', startTime: 0, endTime: 0, confidence: 1 }],
  } as unknown as sttBase.SpeechEvent;
}

/** A stand-in for the plugin's SpeechStream: all we depend on is a `queue` with a `put`. */
function fakeStt(): {
  put: (ev: sttBase.SpeechEvent) => void;
  seen: sttBase.SpeechEvent[];
  queue: { put: (ev: sttBase.SpeechEvent) => void; closed: boolean };
} {
  const seen: sttBase.SpeechEvent[] = [];
  const queue = { put: (ev: sttBase.SpeechEvent) => void seen.push(ev), closed: false };
  const stream = { queue };
  const inner = { stream: () => stream } as never;
  withPausePreflight(inner, PAUSE_MS);
  const patched = (inner as unknown as { stream: () => typeof stream }).stream();
  return { put: (ev) => patched.queue.put(ev), seen, queue };
}

const preflights = (seen: sttBase.SpeechEvent[]) =>
  seen.filter((e) => e.type === sttBase.SpeechEventType.PREFLIGHT_TRANSCRIPT);

const textOf = (ev: sttBase.SpeechEvent) => ev.alternatives?.[0]?.text;

describe('withPausePreflight', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drafts once the caller stops adding words for the pause window', () => {
    const { put, seen } = fakeStt();
    put(interim('כמה פניות'));
    expect(preflights(seen)).toHaveLength(0); // nothing yet — he may still be talking

    vi.advanceTimersByTime(PAUSE_MS);
    expect(preflights(seen)).toHaveLength(1);
    expect(textOf(preflights(seen)[0]!)).toBe('כמה פניות');
  });

  it('fires on REVISED text, which the old equality trigger could never do', () => {
    const { put, seen } = fakeStt();
    // Soniox revising the tail on every emit — three different strings, never a repeat. This is
    // the real-call pattern that made the settled-text trigger fire once in 135 seconds.
    put(interim('יש לי עסק'));
    put(interim('יש לי עסק של'));
    put(interim('יש לי עסק של בניית אתרים'));
    vi.advanceTimersByTime(PAUSE_MS);

    expect(preflights(seen)).toHaveLength(1);
    expect(textOf(preflights(seen)[0]!)).toBe('יש לי עסק של בניית אתרים');
  });

  it('cancels an armed draft when the caller keeps talking', () => {
    const { put, seen } = fakeStt();
    put(interim('אני עונה'));
    vi.advanceTimersByTime(PAUSE_MS - 50); // he resumes before the window closes
    put(interim('אני עונה לכולם'));
    vi.advanceTimersByTime(PAUSE_MS - 50);

    // The stale draft must never fire: it would be written from a sentence he has moved past.
    expect(preflights(seen)).toHaveLength(0);
    vi.advanceTimersByTime(50);
    expect(textOf(preflights(seen)[0]!)).toBe('אני עונה לכולם');
  });

  it('never drafts twice from the same text', () => {
    const { put, seen } = fakeStt();
    put(interim('פייסבוק ואינסטגרם'));
    vi.advanceTimersByTime(PAUSE_MS);
    put(interim('פייסבוק ואינסטגרם')); // Soniox re-emitting an unchanged interim
    vi.advanceTimersByTime(PAUSE_MS);

    expect(preflights(seen)).toHaveLength(1);
  });

  it('caps drafts per turn — a caller who pauses every other word cannot spend unbounded LLM calls', () => {
    const { put, seen } = fakeStt();
    for (const text of ['אחת', 'אחת שתיים', 'אחת שתיים שלוש', 'אחת שתיים שלוש ארבע', 'וחמש']) {
      put(interim(text));
      vi.advanceTimersByTime(PAUSE_MS);
    }
    expect(preflights(seen)).toHaveLength(3);
  });

  it('starts a fresh budget on the next turn', () => {
    const { put, seen } = fakeStt();
    for (const text of ['אחת', 'אחת שתיים', 'אחת שתיים שלוש', 'ארבע']) {
      put(interim(text));
      vi.advanceTimersByTime(PAUSE_MS);
    }
    expect(preflights(seen)).toHaveLength(3);

    put(final('אחת שתיים שלוש ארבע')); // turn over
    put(interim('ועכשיו משהו אחר'));
    vi.advanceTimersByTime(PAUSE_MS);
    expect(preflights(seen)).toHaveLength(4);
  });

  it('ignores interims too short to be worth an LLM call', () => {
    const { put, seen } = fakeStt();
    put(interim('אה'));
    vi.advanceTimersByTime(PAUSE_MS * 3);
    expect(preflights(seen)).toHaveLength(0);
  });

  it('treats an empty interim as a keep-alive, not as speech', () => {
    const { put, seen } = fakeStt();
    put(interim('   '));
    vi.advanceTimersByTime(PAUSE_MS * 3);
    expect(preflights(seen)).toHaveLength(0);
  });

  it('passes every original event through untouched, in order', () => {
    const { put, seen } = fakeStt();
    put(interim('שלום'));
    vi.advanceTimersByTime(PAUSE_MS);
    put(final('שלום עולם'));

    // The plugin's own events must survive verbatim — we only ever ADD a preflight alongside them.
    expect(seen.map((e) => e.type)).toEqual([
      sttBase.SpeechEventType.INTERIM_TRANSCRIPT,
      sttBase.SpeechEventType.PREFLIGHT_TRANSCRIPT,
      sttBase.SpeechEventType.FINAL_TRANSCRIPT,
    ]);
  });

  it('does not put to a closed queue when the caller hangs up mid-pause', () => {
    const { put, seen, queue } = fakeStt();
    put(interim('אני רוצה לק'));
    queue.closed = true; // hang-up inside the pause window
    vi.advanceTimersByTime(PAUSE_MS);

    expect(preflights(seen)).toHaveLength(0);
  });

  it('disables itself rather than throwing when the pause is configured to zero', () => {
    const seen: sttBase.SpeechEvent[] = [];
    const stream = { queue: { put: (ev: sttBase.SpeechEvent) => void seen.push(ev), closed: false } };
    const inner = { stream: () => stream } as never;
    withPausePreflight(inner, 0);
    (inner as unknown as { stream: () => typeof stream }).stream().queue.put(interim('בדיקה'));
    vi.advanceTimersByTime(1000);

    expect(preflights(seen)).toHaveLength(0);
    expect(seen).toHaveLength(1); // still delivers the caller's words
  });
});
