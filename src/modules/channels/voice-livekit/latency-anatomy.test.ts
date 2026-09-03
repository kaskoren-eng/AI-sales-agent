import { describe, expect, it } from 'vitest';
import {
  buildTurnAnatomy,
  summarizeLatency,
  type AnatomyMetric,
  type AnatomyToolCall,
} from './latency-anatomy.js';

/** A metric with only the fields a case cares about — the rest are genuinely absent. */
const m = (atMs: number, stage: string, extra: Partial<AnatomyMetric> = {}): AnatomyMetric => ({
  atMs,
  stage,
  ...extra,
});

describe('buildTurnAnatomy — grouping', () => {
  it('opens a turn at every end-of-turn event, and calls what precedes the first one the greeting', () => {
    const turns = buildTurnAnatomy([
      m(400, 'tts_metrics', { ttfbMs: 451 }),
      m(1000, 'eou_metrics', { endOfUtteranceDelayMs: 349 }),
      m(1500, 'model_ttft', { durationMs: 851 }),
      m(9000, 'eou_metrics', { endOfUtteranceDelayMs: 351 }),
      m(9500, 'model_ttft', { durationMs: 1418 }),
    ]);

    expect(turns.map((t) => t.index)).toEqual([0, 1, 2]);
    expect(turns[0]!.atMs).toBe(0);
    expect(turns[0]!.eouMs).toBeNull();
    // The greeting's TTS belongs to the greeting, not to turn 1.
    expect(turns[0]!.ttsTtfbMs).toBe(451);
    expect(turns[1]!.modelTtftMs).toBe(851);
    expect(turns[2]!.modelTtftMs).toBe(1418);
  });

  it('gives the boundary event to the turn it opens, not the one it closes', () => {
    const turns = buildTurnAnatomy([
      m(1000, 'eou_metrics', { endOfUtteranceDelayMs: 350 }),
      m(2000, 'eou_metrics', { endOfUtteranceDelayMs: 400 }),
    ]);
    expect(turns[1]!.eouMs).toBe(350);
    expect(turns[2]!.eouMs).toBe(400);
  });

  it('treats a whole call with no end-of-turn as one row — the caller never spoke', () => {
    const turns = buildTurnAnatomy([m(500, 'tts_metrics', { ttfbMs: 300 })]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.index).toBe(0);
  });

  it('reports an end-of-utterance of 0 as null, so a barge-in cannot halve the median', () => {
    const turns = buildTurnAnatomy([m(1000, 'eou_metrics', { endOfUtteranceDelayMs: 0 })]);
    expect(turns[1]!.eouMs).toBeNull();
  });

  it('takes the FIRST sample of each stage in a turn — a long reply must not flatter the wait', () => {
    const turns = buildTurnAnatomy([
      m(1000, 'eou_metrics', { endOfUtteranceDelayMs: 350 }),
      m(1600, 'tts_metrics', { ttfbMs: 300 }),
      m(3000, 'tts_metrics', { ttfbMs: 90 }),
    ]);
    expect(turns[1]!.ttsTtfbMs).toBe(300);
  });

  it('skips a cancelled synthesis when reading the turn first-byte', () => {
    const turns = buildTurnAnatomy([
      m(1000, 'eou_metrics', { endOfUtteranceDelayMs: 350 }),
      m(1200, 'tts_metrics', { ttfbMs: 40, cancelled: true }),
      m(1600, 'tts_metrics', { ttfbMs: 300 }),
    ]);
    expect(turns[1]!.ttsTtfbMs).toBe(300);
  });
});

describe('buildTurnAnatomy — classification', () => {
  const turnWith = (firstAudio: number, modelTtft: number, tools: AnatomyToolCall[] = []) =>
    buildTurnAnatomy(
      [
        m(1000, 'eou_metrics', { endOfUtteranceDelayMs: 350 }),
        m(1100, 'first_audio_frame', { durationMs: firstAudio }),
        m(1200, 'model_ttft', { durationMs: modelTtft }),
      ],
      tools,
    )[1]!;

  it('calls a turn receipt_early when audio beat the model to the wire', () => {
    const t = turnWith(552, 851);
    expect(t.audioBeforeFirstToken).toBe(true);
    expect(t.klass).toBe('receipt_early');
  });

  it('calls it no_receipt when the audio did not', () => {
    const t = turnWith(1578, 1068);
    expect(t.audioBeforeFirstToken).toBe(false);
    expect(t.klass).toBe('no_receipt');
  });

  it('lets tool_step win over both, because a tool turn pays a second inference', () => {
    const t = turnWith(2877, 1418, [{ name: 'capture_lead_info', atMs: 1500, durationMs: 1081 }]);
    expect(t.klass).toBe('tool_step');
    expect(t.toolNames).toEqual(['capture_lead_info']);
    expect(t.toolMs).toBe(1081);
    // The receipt question is still answered on a tool turn; it is just not what names the class.
    expect(t.audioBeforeFirstToken).toBe(false);
  });

  it('says unknown rather than guessing when the build recorded no first audio frame', () => {
    const turns = buildTurnAnatomy([
      m(1000, 'eou_metrics', { endOfUtteranceDelayMs: 350 }),
      m(1200, 'model_ttft', { durationMs: 900 }),
    ]);
    expect(turns[1]!.audioBeforeFirstToken).toBeNull();
    expect(turns[1]!.klass).toBe('unknown');
  });

  it('ignores a first audio frame of -1 — the caller had not stopped, so there is no wait', () => {
    const turns = buildTurnAnatomy([
      m(1000, 'eou_metrics', { endOfUtteranceDelayMs: 350 }),
      m(1100, 'first_audio_frame', { durationMs: -1 }),
      m(1150, 'first_audio_frame', { durationMs: 800 }),
      m(1200, 'model_ttft', { durationMs: 900 }),
    ]);
    expect(turns[1]!.firstAudioMs).toBe(800);
    expect(turns[1]!.klass).toBe('receipt_early');
  });

  it('assigns a tool to the turn whose window contains it, not to the next one', () => {
    const turns = buildTurnAnatomy(
      [
        m(1000, 'eou_metrics', { endOfUtteranceDelayMs: 350 }),
        m(5000, 'eou_metrics', { endOfUtteranceDelayMs: 350 }),
      ],
      [{ name: 'capture_lead_info', atMs: 4999, durationMs: 900 }],
    );
    expect(turns[1]!.klass).toBe('tool_step');
    expect(turns[2]!.klass).not.toBe('tool_step');
  });
});

describe('buildTurnAnatomy — the numbers that used to lie', () => {
  it('does not read a cancelled draft as this turn having sent no prompt', () => {
    const turns = buildTurnAnatomy([
      m(1000, 'eou_metrics', { endOfUtteranceDelayMs: 350 }),
      // LiveKit's shape for a draft the caller's next word invalidated.
      m(1100, 'llm_metrics', { ttftMs: -1, promptTokens: 0, promptCachedTokens: 0 }),
      m(1400, 'llm_metrics', { ttftMs: 900, promptTokens: 16283, promptCachedTokens: 16000 }),
    ]);
    expect(turns[1]!.promptTokens).toBe(16283);
    expect(turns[1]!.promptCachedTokens).toBe(16000);
    expect(turns[1]!.draftsDiscarded).toBe(1);
    // The discarded draft is not an inference step — counting it would report a tool turn that
    // never happened.
    expect(turns[1]!.inferenceSteps).toBe(1);
  });

  it('counts the second generation a tool forces as a second inference step', () => {
    const turns = buildTurnAnatomy([
      m(1000, 'eou_metrics', { endOfUtteranceDelayMs: 350 }),
      m(1400, 'llm_metrics', { ttftMs: 900, promptTokens: 100 }),
      m(2600, 'llm_metrics', { ttftMs: 700, promptTokens: 120 }),
    ]);
    expect(turns[1]!.inferenceSteps).toBe(2);
  });

  it('computes the unexplained remainder, and refuses to when a term is missing', () => {
    const [, withAll, withoutTts] = buildTurnAnatomy([
      m(1000, 'eou_metrics', { endOfUtteranceDelayMs: 350 }),
      m(1100, 'dead_air', { durationMs: 1479 }),
      m(1200, 'model_ttft', { durationMs: 1090 }),
      m(1300, 'tts_metrics', { ttfbMs: 224 }),
      m(5000, 'eou_metrics', { endOfUtteranceDelayMs: 350 }),
      m(5100, 'dead_air', { durationMs: 1479 }),
      m(5200, 'model_ttft', { durationMs: 1090 }),
    ]);
    expect(withAll!.unexplainedMs).toBe(1479 - 1090 - 224);
    expect(withoutTts!.unexplainedMs).toBeNull();
  });

  it('carries the opener decision and its inputs through when the build records them', () => {
    const turns = buildTurnAnatomy([
      m(1000, 'eou_metrics', { endOfUtteranceDelayMs: 350 }),
      m(1050, 'turn_opener', { kind: 'silent', reason: 'asked=1 needsTime=1 shared=0' }),
    ]);
    expect(turns[1]!.opener).toBe('silent');
    expect(turns[1]!.openerReason).toBe('asked=1 needsTime=1 shared=0');
  });
});

describe('summarizeLatency', () => {
  /**
   * The six turns of the 2026-09-03 15:12 production call, as its report recorded them. This is a
   * REGRESSION FIXTURE, not an illustration: the pooled median over these is 1479ms and describes
   * none of them, which is the entire reason this module exists. If a change to the grouping
   * restates that call, this fails.
   */
  const realCall = (): AnatomyMetric[] => {
    const out: AnatomyMetric[] = [m(400, 'tts_metrics', { ttfbMs: 451 })];
    const turns: Array<[number, number, number, number, number]> = [
      // at, eou, deadAir, firstAudio, modelTtft
      [17441, 349, 553, 552, 851],
      [24831, 351, 2877, 2877, 1418],
      [35675, 376, 3114, 3113, 1570],
      [49789, 350, 1579, 1578, 1068],
      [62789, 350, 1439, 1438, 829],
      [85149, 350, 1479, 1478, 1090],
    ];
    for (const [at, eou, dead, audio, ttft] of turns) {
      out.push(m(at, 'eou_metrics', { endOfUtteranceDelayMs: eou }));
      out.push(m(at + 10, 'dead_air', { durationMs: dead }));
      out.push(m(at + 20, 'first_audio_frame', { durationMs: audio }));
      out.push(m(at + 30, 'model_ttft', { durationMs: ttft }));
      out.push(m(at + 40, 'llm_metrics', { ttftMs: ttft, promptTokens: 16283, promptCachedTokens: 16000 }));
      out.push(m(at + 50, 'tts_metrics', { ttfbMs: 290 }));
    }
    return out;
  };
  const realTools: AnatomyToolCall[] = [
    { name: 'capture_lead_info', atMs: 27254, durationMs: 1081 },
    { name: 'capture_lead_info', atMs: 37452, durationMs: 310 },
  ];

  it('splits the real call into the three populations behind its 1479ms median', () => {
    const sum = summarizeLatency(buildTurnAnatomy(realCall(), realTools));

    expect(sum.turns).toBe(6);
    expect(sum.byClass.receipt_early.n).toBe(1);
    expect(sum.byClass.receipt_early.deadAirP50).toBe(553);
    expect(sum.byClass.no_receipt.n).toBe(3);
    expect(sum.byClass.no_receipt.deadAirP50).toBe(1479);
    expect(sum.byClass.tool_step.n).toBe(2);
    expect(sum.byClass.tool_step.deadAirP50).toBe(2877);
    // The pooled figure the summary already reports, reproduced — so the two cannot drift apart
    // without one of them failing.
    expect(sum.all.deadAirP50).toBe(1479);
    expect(sum.audioBeforeFirstTokenPct).toBe(17);
    expect(sum.audioBeforeFirstTokenSamples).toBe(6);
  });

  it('excludes the greeting, which has no caller waiting behind it', () => {
    const sum = summarizeLatency(
      buildTurnAnatomy([
        // A cold-start greeting: slow, and nobody was waiting for it.
        m(400, 'dead_air', { durationMs: 9999 }),
        m(1000, 'eou_metrics', { endOfUtteranceDelayMs: 350 }),
        m(1100, 'dead_air', { durationMs: 500 }),
      ]),
    );
    expect(sum.turns).toBe(1);
    expect(sum.all.deadAirP50).toBe(500);
  });

  it('reports the receipt question as unanswerable rather than 0% on an older report', () => {
    const sum = summarizeLatency(
      buildTurnAnatomy([
        m(1000, 'eou_metrics', { endOfUtteranceDelayMs: 350 }),
        m(1200, 'model_ttft', { durationMs: 900 }),
      ]),
    );
    expect(sum.audioBeforeFirstTokenPct).toBeNull();
    expect(sum.audioBeforeFirstTokenSamples).toBe(0);
  });

  it('has no samples and no crash on an empty call', () => {
    const sum = summarizeLatency(buildTurnAnatomy([]));
    expect(sum.turns).toBe(0);
    expect(sum.all.deadAirP50).toBeNull();
    expect(sum.audioBeforeFirstTokenPct).toBeNull();
  });
});
