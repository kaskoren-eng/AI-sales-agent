import { describe, expect, it } from 'vitest';
import { CallReport } from '../call-report.js';
import { hasAiDisclosure } from './ai-disclosure.js';
import { parseWavPcm16, pcmFrames } from './recording-notice.js';

describe('hasAiDisclosure — what counts as telling the caller she is an AI', () => {
  it('matches every phrasing the prompt or a natural goodbye would use', () => {
    for (const line of [
      'אני סוכנת AI, אבל אני יכולה להעביר הודעה לצוות שלנו.',
      'רק שתדע, אני העוזרת הדיגיטלית של קורן — היה כיף לדבר!',
      'אני עוזרת אוטומטית של קורן.',
      'אני סוכנת וירטואלית מטעם ClickScales.',
      'אני מבוססת בינה מלאכותית.',
      'אני ה-AI של ClickScales.',
    ]) {
      expect(hasAiDisclosure(line), line).toBe(true);
    }
  });

  it('does NOT fire on ordinary sales talk about AI agents — the product IS AI agents', () => {
    for (const line of [
      'אנחנו בונים סוכני AI לעסקים.', // about the product, not about herself
      'הסוכן מתחבר ל-CRM שלך.',
      'קבעתי לך פגישה ליום ראשון.',
    ]) {
      expect(hasAiDisclosure(line), line).toBe(false);
    }
  });
});

describe('CallReport — the ai_disclosure verdict is settled from the transcript', () => {
  const config = {
    sttProvider: 't',
    sttModel: 't',
    turnDetection: 't',
    llmModel: 't',
    ttsModel: 't',
  };

  it("'during_call' when she disclosed unprompted", () => {
    const r = new CallReport('room', null, config);
    r.recordTranscript('assistant', 'אני סוכנת AI, נעים מאוד.');
    r.resolveAiDisclosure(hasAiDisclosure);
    expect(r.toJson().compliance.ai_disclosure).toBe('during_call');
  });

  it("'at_end' when end_call had to ask for it and the goodbye delivered", () => {
    const r = new CallReport('room', null, config);
    r.recordTranscript('assistant', 'קבעתי לך פגישה.');
    r.markEndDisclosureRequested();
    r.recordTranscript('assistant', 'רק שתדע, אני העוזרת הדיגיטלית של קורן — היה כיף לדבר!');
    r.resolveAiDisclosure(hasAiDisclosure);
    expect(r.toJson().compliance.ai_disclosure).toBe('at_end');
  });

  it("'missed' when the goodbye instruction was ignored — the audit finding", () => {
    const r = new CallReport('room', null, config);
    r.recordTranscript('assistant', 'ביי, יום נעים!');
    r.markEndDisclosureRequested();
    r.resolveAiDisclosure(hasAiDisclosure);
    expect(r.toJson().compliance.ai_disclosure).toBe('missed');
  });

  it('a caller line never counts as the AGENT disclosing', () => {
    const r = new CallReport('room', null, config);
    r.recordTranscript('user', 'את בינה מלאכותית?');
    r.resolveAiDisclosure(hasAiDisclosure);
    expect(r.toJson().compliance.ai_disclosure).toBe('missed');
  });

  it('an explicit during_call record wins — resolve is idempotent', () => {
    const r = new CallReport('room', null, config);
    r.recordCompliance({ ai_disclosure: 'during_call' });
    r.markEndDisclosureRequested();
    r.resolveAiDisclosure(hasAiDisclosure);
    expect(r.toJson().compliance.ai_disclosure).toBe('during_call');
  });

  it('recording-notice facts ride the same compliance record', () => {
    const r = new CallReport('room', null, config);
    r.recordCompliance({ recording_notice_played: true, recording_notice_at: '2026-07-17T08:00:00.000Z' });
    expect(r.toJson().compliance).toMatchObject({ recording_notice_played: true });
  });
});

describe('parseWavPcm16 — the pre-roll asset parser', () => {
  /** Builds a minimal valid 16-bit PCM WAV in memory. */
  function makeWav(sampleRate: number, samples: number[]): Buffer {
    const data = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
  }

  it('parses rate, channels and every sample', () => {
    const wav = parseWavPcm16(makeWav(24_000, [0, 1000, -1000, 32767]));
    expect(wav.sampleRate).toBe(24_000);
    expect(wav.channels).toBe(1);
    expect([...wav.pcm]).toEqual([0, 1000, -1000, 32767]);
  });

  it('parses the REAL committed asset — the file the caller will actually hear', async () => {
    const { readFile } = await import('node:fs/promises');
    const wav = parseWavPcm16(await readFile('assets/recording-notice.wav'));
    expect(wav.sampleRate).toBe(24_000);
    expect(wav.channels).toBe(1);
    // ~2 seconds of actual speech, not an empty container.
    expect(wav.pcm.length).toBeGreaterThan(24_000);
    const peak = Math.max(...Array.from(wav.pcm.slice(0, 48_000), Math.abs));
    expect(peak).toBeGreaterThan(1000); // audible, not silence
  });

  it('refuses garbage instead of playing it into a call', () => {
    expect(() => parseWavPcm16(Buffer.from('not audio at all'))).toThrow();
  });
});

describe('pcmFrames — the framing that was choppy on the phone', () => {
  it('emits fixed-size frames with a short final frame, losing no samples', () => {
    const pcm = Int16Array.from({ length: 25 }, (_, i) => i);
    const frames = [...pcmFrames(pcm, 10)];
    expect(frames.map((f) => f.length)).toEqual([10, 10, 5]); // last frame is the remainder
    expect(frames.flatMap((f) => [...f])).toEqual([...pcm]); // concatenation is loss-free
  });

  it('handles an exact multiple (no empty trailing frame)', () => {
    expect([...pcmFrames(new Int16Array(20), 10)].length).toBe(2);
  });

  it('rejects a non-positive frame size instead of looping forever', () => {
    expect(() => [...pcmFrames(new Int16Array(4), 0)]).toThrow();
  });

  it('the REAL asset now frames at 10ms — telephony-friendly (aligns with 20ms packets), not 100ms', async () => {
    const { readFile } = await import('node:fs/promises');
    const wav = parseWavPcm16(await readFile('assets/recording-notice.wav'));
    const samplesPer10ms = Math.floor((wav.sampleRate * 10) / 1000); // 240 @ 24kHz
    const frames = [...pcmFrames(wav.pcm, samplesPer10ms)];
    // Every full frame is 240 samples = exactly 10ms, a clean divisor of the 20ms SIP packet.
    expect(frames.slice(0, -1).every((f) => f.length === samplesPer10ms)).toBe(true);
    // ~2s of audio → ~200 small frames, not ~20 oversized 100ms ones. Smooth, not stuttering.
    expect(frames.length).toBeGreaterThan(150);
  });
});
