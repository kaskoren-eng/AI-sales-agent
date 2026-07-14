import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ShadowSttTranscript } from '../../../db/schema/call-learnings.js';

/**
 * A durable record of one call: what was heard, what was said, and how slow it was.
 *
 * WHY THIS EXISTS. Everything the agent knew about a call used to go to stdout and nowhere else —
 * so the only way anyone saw it was if a developer happened to be tailing the process and
 * hand-summarised it afterwards. Koren, whose calls these are, could not look at his own data.
 * That is not a logging gap, it is a product gap: the agent is an experiment right now, and an
 * experiment you cannot read the results of is not an experiment.
 *
 * Writes one JSON file per call to `call-reports/`. Read it with `npm run call:report`.
 *
 * This is the STOPGAP, and deliberately so. The real home for this is the `call_learnings` table
 * (that is what `shadow_stt_transcript` is for, and what `scripts/analyze-shadow-stt.mjs` reads),
 * but nothing writes a call_learnings row for a LiveKit call yet — that is Phase 4. The payload
 * shape here matches the DB column exactly, so when Phase 4 lands, persistence is a one-line change
 * and nothing downstream has to be rewritten.
 */
export interface TurnMetric {
  /** ms since call start. */
  atMs: number;
  /** eou | llm | tts — which stage of the pipeline reported this. */
  stage: string;
  endOfUtteranceDelayMs?: number;
  ttftMs?: number;
  ttfbMs?: number;
  durationMs?: number;
}

/** One line of the conversation, either side of it. */
export interface TranscriptLine {
  atMs: number;
  /** 'user' = the caller, 'assistant' = the agent. */
  role: string;
  text: string;
}

export interface CallReportJson {
  room: string;
  callerPhone: string | null;
  startedAt: string;
  durationSec: number;
  config: {
    sttProvider: string;
    sttModel: string;
    turnDetection: string;
    llmModel: string;
    ttsModel: string;
  };
  summary: {
    /** Turns where the agent decided the caller had finished speaking. */
    turnsHeard: number;
    /** Speech segments the agent synthesized. */
    ttsSegments: number;
    /**
     * Times the STT declared the caller finished WHILE THE VAD STILL HEARD SPEECH — i.e. she cut
     * him off mid-sentence.
     *
     * THE NUMBER THAT CATCHES A BROKEN CALL, and the only trustworthy one. Latency cannot see this:
     * a turn chopped in half FINALISES FASTER, so a cut-off call reports a BETTER end-of-turn
     * median. We measured our best-ever 259ms in precisely the call where the agent went silent on
     * the caller three times. The instrument said we had won while he was being talked over.
     *
     * (An earlier version of this file tried to infer cut-offs from turnsHeard - ttsSegments. That
     * is NOT a valid subtraction — TTS segments include the greeting and preemptive drafts, so it
     * goes NEGATIVE on a healthy call. Do not resurrect it.)
     */
    cutOffs: number;
    /**
     * Times the agent CHOPPED ONE SENTENCE INTO SEVERAL TURNS — she decided the caller had finished
     * while he was mid-thought, and he had to keep going.
     *
     * THIS IS THE REAL CUT-OFF DETECTOR, and `cutOffs` above is nearly useless without it. That
     * counter watches for a LiveKit warning that ONLY EXISTS IN `stt` TURN-DETECTION MODE. In `vad`
     * mode — which is what we actually run — it can never fire, so it reports a serene 0 on a call
     * where the agent talked over the caller from start to finish. I reported "cut-offs: 0" on
     * exactly such a call.
     *
     * Detected instead from the transcript itself: two CALLER turns in a row, close together, with
     * no agent reply between them, means one utterance was split in half. On the call that broke
     * phone-number capture this fired repeatedly — "050." / "888-45." / "רשמת?" are one sentence
     * that the turn detector shredded.
     *
     * A booking agent that cannot receive a phone number in one breath is not a slow agent. It is a
     * broken one.
     */
    fragmentedTurns: number;
    /**
     * Times the agent spoke the same reply twice. SHOULD ALWAYS BE ZERO — and if it is not, verify
     * against the AUDIO before believing it.
     *
     * This metric exists because of a mistake, and the mistake is the point. `ConversationItemAdded`
     * fires TWICE for one reply when preemptive generation is on: once for the draft, once for the
     * confirmed message, same text. The transcript therefore showed four paragraph-length answers
     * "delivered twice". I concluded the agent was repeating itself to callers, told Koren that was
     * the root cause of everything he disliked about it, and disabled preemptive TTS.
     *
     * She had never repeated herself. He had been on the call and said so. The audio agreed: 20 TTS
     * segments against 19 transcript lines — a real double would be ~30.
     *
     * recordTranscript() now drops the draft echo, so this counts SPOKEN repeats only. If it ever
     * goes above zero, check `ttsSegments` against the number of unique replies before acting.
     * A log line is not evidence of a sound.
     */
    duplicateReplies: number;
    endOfTurnMedianMs: number | null;
    llmTtftMedianMs: number | null;
    ttsTtfbMedianMs: number | null;
    /** Sum of the three medians: the worst case, if no stage overlapped any other. */
    worstCaseMs: number | null;
  };
  /**
   * THE ACTUAL CONVERSATION — both sides of it.
   *
   * This was missing until someone asked for "the full transcription of the call" and it turned out
   * we had never recorded the agent's own replies, only what she heard. A record of a conversation
   * with half the conversation missing is not a record of a conversation.
   */
  transcript: TranscriptLine[];
  metrics: TurnMetric[];
  /** Provider usage as LiveKit tallied it — so cost is measured, not guessed. */
  usage: unknown;
  /** Both engines' transcripts, when SHADOW_STT_ENABLED. Same shape as the DB column. */
  shadow: ShadowSttTranscript | null;
}

/**
 * The exact LiveKit warning that means "she started replying while he was still talking".
 * Emitted by the agent framework when the STT's end-of-speech lands inside a VAD speech segment.
 */
const CUT_OFF_WARNING = 'stt end of speech received while vad is still in a speech segment';

export class CallReport {
  #startedAt = Date.now();
  #room: string;
  #callerPhone: string | null;
  #config: CallReportJson['config'];
  #metrics: TurnMetric[] = [];
  #transcript: TranscriptLine[] = [];
  #usage: unknown = null;
  #shadow: ShadowSttTranscript | null = null;
  #cutOffs = 0;
  #restoreStderr: (() => void) | null = null;

  constructor(room: string, callerPhone: string | null, config: CallReportJson['config']) {
    this.#room = room;
    this.#callerPhone = callerPhone;
    this.#config = config;
    this.#watchForCutOffs();
  }

  /**
   * Counts cut-offs by watching what LiveKit logs.
   *
   * Yes, this reads the framework's log output, which is not how one would normally detect
   * something. It is the honest option available: LiveKit emits no EVENT for this, and it is the
   * single most important health signal we have — the difference between "fast" and "she talked
   * over the customer" is invisible in every metric the framework does expose. The alternative was
   * to infer it by subtracting event counts, which produced NEGATIVE cut-offs on a healthy call.
   *
   * Wrapped in a try so a change in LiveKit's logging can never do worse than lose the counter.
   */
  #watchForCutOffs(): void {
    try {
      const original = process.stderr.write.bind(process.stderr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      process.stderr.write = ((chunk: any, ...rest: any[]) => {
        try {
          if (typeof chunk === 'string' && chunk.includes(CUT_OFF_WARNING)) this.#cutOffs++;
        } catch {
          // Counting must never break the log line itself.
        }
        return original(chunk, ...rest);
      }) as typeof process.stderr.write;
      this.#restoreStderr = () => {
        process.stderr.write = original;
      };
    } catch {
      this.#restoreStderr = null;
    }
  }

  recordMetric(stage: string, m: Record<string, unknown>): void {
    const pick = (k: string): number | undefined =>
      typeof m[k] === 'number' ? Math.round(m[k] as number) : undefined;

    this.#metrics.push({
      atMs: Date.now() - this.#startedAt,
      stage,
      endOfUtteranceDelayMs: pick('endOfUtteranceDelayMs'),
      ttftMs: pick('ttftMs'),
      ttfbMs: pick('ttfbMs'),
      durationMs: pick('durationMs'),
    });
  }

  /**
   * One line of the conversation — the caller's or the agent's.
   *
   * DEDUPES THE AGENT'S OWN LINES, because `ConversationItemAdded` fires TWICE for one reply when
   * preemptive generation is on: once for the DRAFT message and again for the confirmed one, same
   * text. She says it once; the log recorded it twice.
   *
   * That artefact cost real credibility. I read the doubled lines, concluded the agent was speaking
   * every answer twice to the caller, told Koren it was the root cause of everything he disliked,
   * and switched off preemptive TTS on the strength of it. He had been ON the call — she never
   * repeated herself. The audio said so too (20 TTS segments for 19 transcript lines; a genuine
   * double would be ~30).
   *
   * The lesson is not "add a dedupe". It is that a log line is not evidence of a sound. When the
   * transcript and the person who was actually on the phone disagree, the person wins.
   */
  recordTranscript(role: string, text: string): void {
    const trimmed = text?.trim();
    if (!trimmed) return;

    if (role === 'assistant') {
      const isDraftEcho = this.#transcript.some(
        (x) =>
          x.role === 'assistant' &&
          x.text === trimmed &&
          Date.now() - this.#startedAt - x.atMs < 20_000,
      );
      if (isDraftEcho) return;
    }

    this.#transcript.push({ atMs: Date.now() - this.#startedAt, role, text: trimmed });
  }

  recordUsage(usage: unknown): void {
    this.#usage = usage;
  }

  attachShadow(shadow: ShadowSttTranscript): void {
    this.#shadow = shadow;
  }

  toJson(): CallReportJson {
    // Zeroes are barge-in artefacts, not turns — the caller cut her off, so there was no wait to
    // measure. Averaging them in would silently halve the end-of-turn figure.
    const eou = this.#metrics
      .map((m) => m.endOfUtteranceDelayMs)
      .filter((v): v is number => typeof v === 'number' && v > 0);
    const ttft = this.#metrics
      .map((m) => m.ttftMs)
      .filter((v): v is number => typeof v === 'number');
    const ttfb = this.#metrics
      .map((m) => m.ttfbMs)
      .filter((v): v is number => typeof v === 'number');

    const eouMed = median(eou);
    const ttftMed = median(ttft);
    const ttfbMed = median(ttfb);

    // Two caller turns in a row, within 3s, with no agent reply between them: one sentence that the
    // turn detector cut in half. See `fragmentedTurns` above for why this, and not `cutOffs`, is the
    // signal that matters on a vad-mode call.
    let fragmentedTurns = 0;
    let duplicateReplies = 0;
    for (let i = 1; i < this.#transcript.length; i++) {
      const prev = this.#transcript[i - 1]!;
      const curr = this.#transcript[i]!;
      if (prev.role === 'user' && curr.role === 'user' && curr.atMs - prev.atMs < 3_000) {
        fragmentedTurns++;
      }
      // The same answer, twice. Compared against the last few agent turns rather than only the
      // previous line, because a caller interjection often lands between the draft and the repeat.
      if (curr.role === 'assistant' && curr.text.length > 15) {
        const recent = this.#transcript
          .slice(Math.max(0, i - 4), i)
          .filter((x) => x.role === 'assistant');
        if (recent.some((x) => x.text.trim() === curr.text.trim())) duplicateReplies++;
      }
    }

    return {
      room: this.#room,
      callerPhone: this.#callerPhone,
      startedAt: new Date(this.#startedAt).toISOString(),
      durationSec: Math.round((Date.now() - this.#startedAt) / 1000),
      config: this.#config,
      summary: {
        turnsHeard: eou.length,
        ttsSegments: this.#metrics.filter((m) => m.stage === 'tts_metrics').length,
        cutOffs: this.#cutOffs,
        fragmentedTurns,
        duplicateReplies,
        endOfTurnMedianMs: eouMed,
        llmTtftMedianMs: ttftMed,
        ttsTtfbMedianMs: ttfbMed,
        worstCaseMs:
          eouMed === null || ttftMed === null || ttfbMed === null
            ? null
            : Math.round(eouMed + ttftMed + ttfbMed),
      },
      transcript: this.#transcript,
      metrics: this.#metrics,
      usage: this.#usage,
      shadow: this.#shadow,
    };
  }

  /** Writes the report and returns its path. Never throws — losing a report must not fail a call. */
  async write(dir: string): Promise<string | null> {
    this.#restoreStderr?.();
    try {
      await mkdir(dir, { recursive: true });
      const stamp = new Date(this.#startedAt).toISOString().replace(/[:.]/gu, '-');
      const path = join(dir, `${stamp}.json`);
      await writeFile(path, `${JSON.stringify(this.toJson(), null, 2)}\n`);
      return path;
    } catch (err) {
      console.error('call_report_write_failed', err instanceof Error ? err.message : String(err));
      return null;
    }
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!);
}
