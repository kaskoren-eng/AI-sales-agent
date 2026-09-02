import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallReport } from './call-report.js';

/**
 * The dead-air stopwatch — the instrument we now steer latency by, so it gets tests.
 *
 * WHY THIS METRIC EXISTS. The report already carried `worstCaseMs`: end-of-turn + LLM + TTS
 * medians, added up. It reported 1466ms for a call whose real median silence was 2535ms, because
 * it is a sum of three medians that never co-occurred on one turn AND it is blind to preemptive
 * generation — the mechanism that decides the answer, since its whole job is to move the LLM and
 * TTS inside the end-of-turn wait. We spent a session optimising against an instrument that could
 * not see the thing being optimised. A wrong instrument is worse than none, so this one is pinned.
 */
const CONFIG = {
  sttProvider: 'soniox',
  sttModel: 'stt-rt-v5',
  turnDetection: 'stt',
  llmModel: 'gpt-5.4',
  ttsModel: 'sonic-3.5',
};

const newReport = () => new CallReport('call-test', '+972500000000', CONFIG);

describe('CallReport dead air', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('measures the silence between the caller stopping and the agent speaking', () => {
    const report = newReport();
    report.noteUserStartedSpeaking();
    report.noteUserStoppedSpeaking();
    vi.advanceTimersByTime(850);
    report.noteAgentStartedSpeaking();

    const { deadAir } = report.toJson().summary;
    expect(deadAir.samples).toBe(1);
    expect(deadAir.medianMs).toBe(850);
  });

  it('measures from the LAST stop when the turn detector shreds one sentence', () => {
    const report = newReport();
    // "אני." … "עונה לכולם." … "כמה שעות" — one thought, three turns, as happened on 2026-08-16.
    report.noteUserStoppedSpeaking();
    vi.advanceTimersByTime(3_000);
    report.noteUserStartedSpeaking();
    vi.advanceTimersByTime(500);
    report.noteUserStoppedSpeaking();
    vi.advanceTimersByTime(600);
    report.noteAgentStartedSpeaking();

    // 600, not 4100: the caller's own thinking pause is not the agent being slow.
    expect(report.toJson().summary.deadAir.medianMs).toBe(600);
  });

  it('scores one wait per reply, not one per audio segment', () => {
    const report = newReport();
    report.noteUserStoppedSpeaking();
    vi.advanceTimersByTime(700);
    report.noteAgentStartedSpeaking(); // first sentence
    vi.advanceTimersByTime(80);
    report.noteAgentStartedSpeaking(); // rest of the same answer — no new silence to measure

    const { deadAir } = report.toJson().summary;
    expect(deadAir.samples).toBe(1);
    expect(deadAir.maxMs).toBe(700);
  });

  it('ignores the greeting, which answers no one', () => {
    const report = newReport();
    report.noteAgentStartedSpeaking();

    expect(report.toJson().summary.deadAir.samples).toBe(0);
  });

  it('reports p90 as well as the median — the worst turns are what the caller remembers', () => {
    const report = newReport();
    for (const ms of [200, 250, 300, 350, 400, 450, 500, 600, 2_000, 6_000]) {
      report.noteUserStoppedSpeaking();
      vi.advanceTimersByTime(ms);
      report.noteAgentStartedSpeaking();
    }

    const { deadAir } = report.toJson().summary;
    expect(deadAir.samples).toBe(10);
    expect(deadAir.medianMs).toBe(425);
    // A median of 425ms would read as a solved problem. It is not: one turn in ten took 6s.
    expect(deadAir.p90Ms).toBe(2_000);
    expect(deadAir.maxMs).toBe(6_000);
  });

  it('reports nulls rather than a fabricated zero when nothing was measured', () => {
    const { deadAir } = newReport().toJson().summary;

    expect(deadAir).toEqual({ medianMs: null, p90Ms: null, minMs: null, maxMs: null, samples: 0 });
  });
});

describe('CallReport repeatedPhraseCount — the anti-repetition gate (2026-08-27)', () => {
  it('counts distinct 4-grams the agent said 2+ times, over the agent lines only', () => {
    const report = newReport();
    report.recordTranscript('assistant', 'נשמע מעולה, בוא נקבע שיחת דמו קצרה השבוע.');
    report.recordTranscript('user', 'בוא נקבע שיחת דמו קצרה'); // the CALLER echoing is not her repeat
    report.recordTranscript('assistant', 'אין בעיה, בוא נקבע שיחת דמו קצרה ליום שני.');
    expect(report.toJson().summary.repeatedPhraseCount).toBeGreaterThan(0);
  });

  it('is zero on a varied call — the gate is ≤2, the target is 0', () => {
    const report = newReport();
    report.recordTranscript('assistant', 'שלום, מדברת קרן מקליקסקיילס.');
    report.recordTranscript('assistant', 'איזה עסק יש לך בדיוק?');
    report.recordTranscript('assistant', 'מעולה, אז נתקדם לתיאום.');
    expect(report.toJson().summary.repeatedPhraseCount).toBe(0);
  });
});

/**
 * P1-2 — MEASUREMENT ONLY. Nothing here changes when she speaks; it changes what we can say about
 * when she spoke.
 *
 * The 2026-08-30 plan read two "post-tool gaps" of 5.7s and 6.2s off consecutive transcript
 * timestamps and concluded that more than half of each was unexplained. It is explained: those
 * timestamps are COMMIT times, the SDK commits an assistant message after its playout finishes, so
 * the interval between two of them is `silence + the whole of the second reply's speaking time`.
 * The reproduction below is the exact 2026-08-29 shape and shows both numbers side by side.
 */
describe('CallReport agentGap — silence INSIDE a reply', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const sec = (ms: number): number => ms / 1000;

  it('reproduces the 2026-08-29 shape: a 6.2s commit interval that is 2.2s of silence', () => {
    const report = newReport();
    const t0 = Date.now();
    // The receipt: spoken 90.300s → 90.896s into the call, committed when its playout ended.
    vi.setSystemTime(t0 + 90_896);
    report.recordTranscript('assistant', 'אוקיי.', {
      startedSpeakingAt: sec(t0 + 90_300),
      stoppedSpeakingAt: sec(t0 + 90_896),
    });
    // The tool runs inside the silence and finishes at 91.925s. recordToolCall stamps completion.
    vi.setSystemTime(t0 + 91_925);
    report.recordToolCall({ atMs: 0, name: 'capture_lead_info', durationMs: 979, ok: true });
    // The answer starts 2.2s after the receipt stopped, and takes 3.9s to say. Commit-to-commit:
    // 97_082 - 90_896 = 6.2s, which is the number the plan read and called mostly unexplained.
    vi.setSystemTime(t0 + 97_082);
    report.recordTranscript('assistant', 'ואיך אתה מקבל היום את הפניות שנכנסות אליך?', {
      startedSpeakingAt: sec(t0 + 93_100),
      stoppedSpeakingAt: sec(t0 + 97_082),
    });

    const json = report.toJson();
    const { agentGap } = json.summary;
    expect(agentGap.samples).toBe(1);
    expect(agentGap.medianMs).toBe(2204); // the silence…
    expect(json.transcript[1]!.atMs - json.transcript[0]!.atMs).toBe(6186); // …versus the interval
    expect(agentGap.gaps[0]?.tools.map((t) => t.name)).toEqual(['capture_lead_info']);
    expect(agentGap.gaps[0]?.toolMs).toBe(979);
    // What is left after the tool is the next inference step's TTFT plus TTS first byte — about
    // 1.2s on this stack, and the whole of what a caller experiences as the post-tool hole.
    expect(agentGap.gaps[0]!.gapMs - agentGap.gaps[0]!.toolMs).toBe(1225);
  });

  it('a gap across a CALLER turn is not a gap — that is a conversation, not a hole', () => {
    const report = newReport();
    const t0 = Date.now();
    report.recordTranscript('assistant', 'איזה עסק יש לך?', {
      startedSpeakingAt: sec(t0 + 1_000),
      stoppedSpeakingAt: sec(t0 + 2_000),
    });
    report.recordTranscript('user', 'יש לי מכון כושר');
    report.recordTranscript('assistant', 'מעולה, וכמה פניות ביום?', {
      startedSpeakingAt: sec(t0 + 9_000),
      stoppedSpeakingAt: sec(t0 + 10_000),
    });
    expect(report.toJson().summary.agentGap.samples).toBe(0);
  });

  it('contributes nothing rather than a wrong number when the SDK gave no timestamps', () => {
    const report = newReport();
    report.recordTranscript('assistant', 'אוקיי.');
    report.recordTranscript('assistant', 'ואיך מגיעים אליך לקוחות?');
    expect(report.toJson().summary.agentGap).toEqual({
      medianMs: null,
      maxMs: null,
      samples: 0,
      gaps: [],
    });
  });

  it('keeps atMs as the commit clock, so every report written before today still compares', () => {
    const report = newReport();
    const t0 = Date.now();
    report.recordTranscript('assistant', 'אוקיי.', {
      startedSpeakingAt: sec(t0 + 1_000),
      stoppedSpeakingAt: sec(t0 + 2_000),
    });
    const line = report.toJson().transcript[0]!;
    expect(line.spokeAtMs).toBe(1_000);
    expect(line.spokeUntilMs).toBe(2_000);
    expect(line.atMs).toBeLessThan(1_000); // stamped now, at commit — not when she started
  });

  /**
   * The 2026-08-31 shape. Two gaps of 15294ms and 15363ms arrived with `tools: []` and `toolMs: 0`
   * — fifteen seconds attributed to nothing, which reads exactly like a hung LLM. They were the
   * silence reflex finally speaking, at the end of the SDK's 15-second `userAwayTimeout`. Nobody
   * could tell those two things apart from the report, and that is the defect this closes.
   */
  it('names the reflex that ended a silence, so a timer never reads as a stall', () => {
    const report = newReport();
    const t0 = Date.now();
    report.recordTranscript('assistant', 'בערך כמה פניות נכנסות אליךָ ביום?', {
      startedSpeakingAt: sec(t0 + 111_351),
      stoppedSpeakingAt: sec(t0 + 117_112),
    });
    // The reflex fires at the end of the wait, just before the audio it triggers.
    vi.setSystemTime(t0 + 132_200);
    report.recordMetric('silence_reflex', { durationMs: 7_000 });
    vi.setSystemTime(t0 + 134_087);
    report.recordTranscript('assistant', 'רגע, אתה עוד על הקו?', {
      startedSpeakingAt: sec(t0 + 132_406),
      stoppedSpeakingAt: sec(t0 + 134_087),
    });

    const [gap] = report.toJson().summary.agentGap.gaps;
    expect(gap?.gapMs).toBe(15_294);
    expect(gap?.tools).toEqual([]);
    expect(gap?.endedBy).toBe('silence_reflex');
  });

  it('leaves an ordinary tool gap unattributed to any reflex — it was not one', () => {
    const report = newReport();
    const t0 = Date.now();
    report.recordTranscript('assistant', 'אוקיי.', {
      startedSpeakingAt: sec(t0 + 1_000),
      stoppedSpeakingAt: sec(t0 + 2_000),
    });
    vi.setSystemTime(t0 + 3_000);
    report.recordToolCall({ atMs: 0, name: 'capture_lead_info', durationMs: 900, ok: true });
    vi.setSystemTime(t0 + 4_500);
    report.recordTranscript('assistant', 'ומה שם המשפחה?', {
      startedSpeakingAt: sec(t0 + 3_500),
      stoppedSpeakingAt: sec(t0 + 4_500),
    });
    expect(report.toJson().summary.agentGap.gaps[0]?.endedBy).toBeUndefined();
  });
});

/**
 * The pipeline record. WHY IT IS IN THE REPORT AND NOT ONLY IN A LOG TAIL: `preemptiveTts` was set
 * as a cloud secret, `lk agent secrets` lists names only, nothing logged it and no report carried
 * it — so for weeks nobody could say whether preemptive TTS was on in production. A log line alone
 * would have repeated the mistake in a slower way: logs roll, and a call from last week is exactly
 * the one you want to attribute.
 */
describe('CallReport pipeline record', () => {
  const SNAPSHOT = {
    resolved: {
      turnDetection: 'vad',
      endpointingMode: 'fixed',
      endpointingMinDelayMs: 200,
      endpointingMaxDelayMs: 2_000,
      preemptiveGeneration: true,
      preemptiveTts: false,
      preemptiveMaxSpeechDurationMs: 10_000,
      preemptiveMaxRetries: 3,
      interruptionEnabled: true,
      userAwayTimeoutSec: 7,
      vadAttached: true,
      vadIsSdkDefault: false,
      sttLabel: 'soniox.STT',
      llmLabel: 'openai.LLM',
      ttsLabel: 'cartesia.TTS',
    },
    configured: { VOICE_PREEMPTIVE_TTS: { value: 'false', source: 'default' as const } },
    runningOnDefaults: ['VOICE_PREEMPTIVE_TTS'],
    noiseCancellation: {
      requested: 'TelephonyBackgroundVoiceCancellation',
      moduleId: 'livekit.plugins.noise_cancellation',
      modelPath: '/resources/inb.bvc.kef',
      modelFileExists: true,
      pluginLibPath: '/resources/liblivekit_nc_plugin.so',
      pluginLibExists: true,
      attached: true,
      engaged: 'unprovable' as const,
    },
  };

  it('is null until the session is up — a report must not invent a pipeline it never saw', () => {
    expect(newReport().toJson().pipeline).toBeNull();
  });

  it('persists the resolved pipeline, so a past call can still be attributed', () => {
    const report = newReport();
    report.recordPipeline(SNAPSHOT);
    const { pipeline } = report.toJson();
    expect(pipeline?.resolved.preemptiveTts).toBe(false);
    expect(pipeline?.resolved.turnDetection).toBe('vad');
    expect(pipeline?.runningOnDefaults).toContain('VOICE_PREEMPTIVE_TTS');
    expect(pipeline?.noiseCancellation.engaged).toBe('unprovable');
  });

  it('survives the JSON round-trip that is the only channel out of a cloud worker', () => {
    const report = newReport();
    report.recordPipeline(SNAPSHOT);
    const parsed = JSON.parse(JSON.stringify(report.toJson()));
    expect(parsed.pipeline.resolved.preemptiveTts).toBe(false);
  });
});

describe('CallReport preemptive counters', () => {
  const counters = (draftsStarted: number, draftsUsed: number) => ({
    generation: {
      draftsStarted,
      draftsUsed,
      draftsInvalidated: 0,
      draftsUnaccounted: draftsStarted - draftsUsed,
      leadTimeMedianMs: draftsUsed ? 400 : null,
      leadTimeMaxMs: draftsUsed ? 400 : null,
    },
    llm: { completed: 4, cancelled: 0, cancelledPromptTokens: 0 },
    tts: { completed: 4, cancelled: 0, charactersSynthesized: 400, charactersDiscarded: 0 },
  });

  it('is null when nothing was watching, which is not the same as zero drafts', () => {
    expect(newReport().toJson().summary.preemptive).toBeNull();
  });

  it('reads the counters LIVE, because the report is rewritten after every turn', () => {
    // A snapshot captured once at install time would pin every flush at zero and read exactly like
    // a dead feature. The report flushes per turn precisely so a killed worker loses nothing.
    const report = newReport();
    let started = 0;
    report.attachPreemptive(() => counters(started, started));
    expect(report.toJson().summary.preemptive?.generation.draftsStarted).toBe(0);
    started = 3;
    expect(report.toJson().summary.preemptive?.generation.draftsStarted).toBe(3);
  });

  it('separates a feature that worked from one that never ran — draftsDiscarded cannot', () => {
    const worked = newReport();
    worked.attachPreemptive(() => counters(5, 5));
    const dead = newReport();
    dead.attachPreemptive(() => counters(0, 0));

    // Identical on the old field...
    expect(worked.toJson().summary.draftsDiscarded).toBe(dead.toJson().summary.draftsDiscarded);
    // ...and finally distinguishable on the new one.
    expect(worked.toJson().summary.preemptive?.generation.draftsStarted).toBe(5);
    expect(dead.toJson().summary.preemptive?.generation.draftsStarted).toBe(0);
  });

  it('never loses a call report to a throwing counter', () => {
    const report = newReport();
    report.attachPreemptive(() => {
      throw new Error('counter exploded');
    });
    expect(report.toJson().summary.preemptive).toBeNull();
    expect(report.toJson().transcript).toEqual([]);
  });
});

/**
 * SPEECH PACE — the instrument that has to exist before any rhythm feature can be judged.
 *
 * `phase-4-known-issues.md` §9: Cartesia's Hebrew is not deterministic (2.9s / 4.1s / 4.5s / 7.1s
 * for one sentence across four takes). Nobody had measured that against text length, so nobody
 * could say whether a deliberate speed change is audible above the engine's own variation. These
 * tests pin the arithmetic; the number itself comes off real calls.
 */
describe('CallReport speech pace', () => {
  const tts = (charactersCount: number, audioDurationMs: number, cancelled = false) => ({
    ttfbMs: 200,
    durationMs: 300,
    audioDurationMs,
    charactersCount,
    cancelled,
  });

  it('is empty, not zero, on a call that synthesized nothing', () => {
    const pace = newReport().toJson().summary.speechPace;
    expect(pace).toEqual({
      samples: 0,
      medianMsPerChar: null,
      minMsPerChar: null,
      maxMsPerChar: null,
      spread: null,
    });
  });

  it('reports ms per character and the spread between best and worst turn', () => {
    const report = newReport();
    report.recordMetric('tts', tts(100, 5_000)); // 50 ms/char
    report.recordMetric('tts', tts(100, 10_000)); // 100 ms/char
    report.recordMetric('tts', tts(200, 15_000)); // 75 ms/char
    const pace = report.toJson().summary.speechPace;
    expect(pace.samples).toBe(3);
    expect(pace.medianMsPerChar).toBe(75);
    expect(pace.minMsPerChar).toBe(50);
    expect(pace.maxMsPerChar).toBe(100);
    // The number that decides whether a 7% speed change could ever be heard on one call.
    expect(pace.spread).toBe(2);
  });

  it('excludes a synthesis nobody heard', () => {
    // A preemptive draft the caller's next word invalidated was paid for and thrown away. It is
    // Cartesia's bill, not the caller's experience, and counting it would widen the spread with
    // audio that never played.
    const report = newReport();
    report.recordMetric('tts', tts(100, 5_000));
    report.recordMetric('tts', tts(100, 40_000, true));
    const pace = report.toJson().summary.speechPace;
    expect(pace.samples).toBe(1);
    expect(pace.maxMsPerChar).toBe(50);
  });

  it('ignores a synthesis with no characters or no audio rather than scoring it zero', () => {
    const report = newReport();
    report.recordMetric('tts', tts(0, 5_000));
    report.recordMetric('tts', tts(100, 0));
    report.recordMetric('llm', { ttftMs: 900 });
    expect(report.toJson().summary.speechPace.samples).toBe(0);
  });
});
