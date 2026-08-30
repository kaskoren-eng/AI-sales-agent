import { describe, expect, it } from 'vitest';
import { Mixer } from './synthetic-caller.js';
import { buildExchange } from './report-html.js';
import { trimSilenceWithOffset } from './wav.js';

const RATE = 24_000;
const tone = (ms: number, amp = 8000): Int16Array => {
  const n = Math.round((ms / 1000) * RATE);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((i / RATE) * 2 * Math.PI * 220) * amp);
  return out;
};
const silence = (ms: number): Int16Array => new Int16Array(Math.round((ms / 1000) * RATE));
const join = (...parts: Int16Array[]): Int16Array => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

/**
 * THE BUG THIS FILE EXISTS FOR (2026-08-30). The whole-call recording was placed one RECEIVED FRAME
 * at a time, at `arrivalTime - frameDuration`. Frames come out of the jitter buffer in bursts, so
 * dozens of them got near-identical offsets and were summed on top of one another. Measured on a
 * real 31-second call: 2734 segments, 1790 of them overlapping, 13.7 seconds of doubled audio and
 * 882 clipped samples — "the voice was not clear at all", in Koren's words.
 *
 * The fix is not in the Mixer: it is that the caller now hands it ONE CONTIGUOUS SEGMENT PER TURN
 * instead of one per frame. These tests pin both halves — that bursty per-frame placement really
 * does overlap, and that per-run placement does not while still keeping the silence between turns.
 */
describe('Mixer', () => {
  it('reports the overlap that bursty per-frame placement produces', () => {
    const mix = new Mixer(0, RATE);
    // Ten 20ms frames that all "arrived" within 4ms of each other — a burst.
    for (let i = 0; i < 10; i++) mix.add(100 + i * 0.4, tone(20));
    const stats = mix.stats();
    expect(stats.segments).toBe(10);
    expect(stats.overlappingSegments).toBe(9);
    expect(stats.overlapMs).toBeGreaterThan(150);
  });

  it('places one contiguous run per turn with no overlap, and keeps the silence between turns', () => {
    const mix = new Mixer(0, RATE);
    mix.add(0, tone(1_000)); // caller
    mix.add(2_500, tone(1_500)); // agent, after 1.5s of dead air
    const stats = mix.stats();
    expect(stats.overlappingSegments).toBe(0);
    expect(stats.overlapMs).toBe(0);

    const pcm = mix.render();
    expect(Math.round((pcm.length / RATE) * 1000)).toBe(4_000);
    // The dead air is still IN the recording — deleting it is what a concatenated mix does, and it
    // deletes exactly the thing being judged.
    const midGap = pcm[Math.round(1.7 * RATE)];
    expect(midGap).toBe(0);
  });

  it('keeps a genuine cut-off audible as an overlap', () => {
    const mix = new Mixer(0, RATE);
    mix.add(0, tone(1_000));
    mix.add(600, tone(1_000)); // the agent started talking over the caller
    expect(mix.stats().overlappingSegments).toBe(1);
    expect(mix.stats().overlapMs).toBe(400);
  });
});

describe('trimSilenceWithOffset', () => {
  it('finds where the speech started, so the clip can be put back on the timeline', () => {
    const pcm = join(silence(2_000), tone(500), silence(1_000));
    const { startSample, hasSpeech, pcm: trimmed } = trimSilenceWithOffset(pcm, RATE, 100);
    expect(hasSpeech).toBe(true);
    // 2s of silence minus the 100ms pad that is deliberately kept.
    expect(startSample / RATE).toBeCloseTo(1.9, 1);
    expect(trimmed.length / RATE).toBeCloseTo(0.7, 1);
  });

  it('says so when there is no speech at all, instead of returning a clip of nothing', () => {
    // The agent publishes a track for the WHOLE call, so a bucket collected while nobody spoke is
    // pure silence. Placing that on the timeline would stretch the recording with dead weight.
    const { hasSpeech } = trimSilenceWithOffset(silence(3_000), RATE, 100);
    expect(hasSpeech).toBe(false);
  });
});

describe('buildExchange', () => {
  it('plays the caller, then the REAL gap, then the reply', () => {
    const caller = tone(1_000);
    const agent = tone(800);
    const out = buildExchange(caller, 1_400, agent);
    expect(Math.round((out.length / RATE) * 1000)).toBe(3_200);
    // The reply starts exactly one measured dead-air after the caller stopped.
    expect(out[caller.length + Math.round(1.2 * RATE)]).toBe(0);
    expect(out.slice(caller.length + Math.round(1.4 * RATE)).some((v) => v !== 0)).toBe(true);
  });

  it('still produces a clip when the agent never replied', () => {
    const out = buildExchange(tone(500), null, new Int16Array(0));
    expect(out.length).toBeGreaterThan(0);
  });

  it('is empty when there is nothing to play', () => {
    expect(buildExchange(new Int16Array(0), 500, new Int16Array(0)).length).toBe(0);
  });
});
