import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  type RemoteParticipant,
  RoomEvent,
  Room,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import { AccessToken } from 'livekit-server-sdk';
import type { Env } from '../../../../config/env.js';
import { synthesizeHebrew } from './speech.js';
import { concatFrames, trimSilenceWithOffset } from './wav.js';

/** Everything in this harness lives at one rate so caller and agent audio can be mixed directly. */
export const CAPTURE_RATE = 24_000;

/** The attribute LiveKit stamps on an agent participant, = the worker's registered agentName. */
const AGENT_NAME_ATTRIBUTE = 'lk.agent.name';

/** One caller utterance and what the agent did about it. */
export interface TurnResult {
  /** What the synthetic caller said (Hebrew). */
  said: string;
  /**
   * Dead air, in ms: from the last frame of caller audio to the first frame of agent audio.
   * This is the number the human actually feels, and the one the "no dead air > 1.2s"
   * criterion in docs/voice-agent-development-methodology.md is written against.
   * null = the agent never responded within the timeout.
   *
   * IT RUNS ~1–1.5s HIGH in absolute terms — it includes network transport and the receive jitter
   * buffer, neither of which the agent is responsible for. Compare A against B with it; never
   * quote it as the product's latency. See ./README.md.
   */
  responseLatencyMs: number | null;
  /** Whether the agent started talking BEFORE the caller finished — i.e. it cut them off. */
  interruptedCaller: boolean;
  /** How long the agent then spoke for, in ms. */
  agentSpokeMs: number;
  /** ms since call start when this utterance started / finished going out on the wire. */
  callerStartedAtMs: number;
  callerFinishedAtMs: number;
  /** The caller's own audio for this turn, 24kHz mono. Empty when capture is off. */
  callerPcm: Int16Array;
  /** The agent's reply audio for this turn, 24kHz mono. Empty when capture is off. */
  agentPcm: Int16Array;
}

export interface CallResult {
  room: string;
  /** Wall-clock ms at the moment the caller connected — the zero of every *AtMs in here. */
  startedAt: number;
  turns: TurnResult[];
  /** The agent participant's identity, e.g. `agent-AJ_xxx`. Null if nobody joined. */
  agentIdentity: string | null;
  /**
   * `lk.agent.name` off the agent participant — i.e. WHICH WORKER answered.
   * `''` means a default-dispatch worker took the call, which on this project means the
   * PRODUCTION CLOUD AGENT, not the laptop under test. See `expectAgentName`.
   */
  agentName: string | null;
  /**
   * ms from "the caller was connected" to "the agent's audio track appeared" — i.e. how long the
   * worker took to fork a job process and join. THIS IS THE COLD-START FIGURE. On a laptop under
   * `tsx` it is tens of seconds on the first call of a worker's life and ~1s afterwards, which is
   * why turn 1 of a fresh worker is not comparable with anything.
   */
  agentJoinedMs: number | null;
  /** ms from connect to the agent's first non-silent frame (the greeting starting). */
  greetingStartedMs: number | null;
  /** Everything the agent said before the first caller utterance (the greeting). */
  greetingPcm: Int16Array;
  /** Both voices on one timeline, 24kHz mono — the whole call, listenable end to end. */
  mixedPcm: Int16Array;
  /**
   * How much of `mixedPcm` is two segments summed on top of each other. Real overlap (the caller
   * talking over the agent) is a handful of segments; anything more means the whole-call track is
   * mush and should not be trusted by ear. See `Mixer.stats`.
   */
  mixStats?: { segments: number; overlappingSegments: number; overlapMs: number };
  /** Agent never joined, wrong agent answered, agent never spoke, etc. */
  error?: string;
}

const CHANNELS = 1;
/** Silence pushed after each utterance so the agent's endpointing sees the caller stop. */
const TRAILING_SILENCE_MS = 3_000;
/** How long to wait for the agent to start replying before calling it a failure. */
const REPLY_TIMEOUT_MS = 15_000;
/**
 * How long to wait for the agent to JOIN — a different and much longer budget than replying.
 *
 * A freshly started worker forks a cold job process, and that process imports googleapis, drizzle
 * and the Silero model through tsx. Measured on this laptop: over 15 seconds. With the old
 * 15s budget the caller gave up first and reported "agent never joined" on a run where the agent
 * arrived seconds later and wrote a perfectly good call report — a false failure that looks
 * exactly like a broken variant.
 */
const JOIN_TIMEOUT_MS = 120_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SyntheticCallerOptions {
  identity?: string;
  /**
   * Dispatch this named agent into the room INSTEAD of letting LiveKit auto-dispatch.
   *
   * THIS IS NOT A CONVENIENCE. Verified on 2026-08-30: a room created in this project with a plain
   * token had the production cloud agent (`lk.agent.name: ""`) in it within ~2 seconds, because a
   * worker with no agentName is auto-dispatched to EVERY new room. So every synthetic-caller run
   * before this change was liable to be answered by PRODUCTION rather than by the local worker
   * under test — measuring the wrong agent, and billing it.
   *
   * Putting the agent in the token's `RoomConfiguration` both dispatches the named worker AND
   * suppresses that automatic dispatch: the same probe, with `roomConfig.agents` set to a name no
   * worker was registered under, had nobody join within 15s.
   *
   * Undefined/empty = the old behaviour (auto-dispatch; the cloud agent may answer).
   */
  agentName?: string;
  /**
   * Fail the call unless the agent that answered reports this `lk.agent.name`. Defaults to
   * `agentName`. An empty string means "accept whoever answers" and is the pre-2026-08-30
   * behaviour — say so on purpose rather than getting it by accident.
   */
  expectAgentName?: string;
  /** Keep the audio. Off = the old timing-only behaviour, and no memory held per call. */
  captureAudio?: boolean;
}

/**
 * A fake Hebrew-speaking caller.
 *
 * Joins a LiveKit room, publishes Cartesia-synthesized Hebrew as if it were a microphone, listens
 * to the agent's audio track to measure how long the agent takes to respond, and (since
 * 2026-08-30) KEEPS THE AUDIO so a human can judge by ear what the timings cannot see.
 *
 * The agent worker must already be running. With `agentName` set it is dispatched explicitly and
 * is the only agent in the room; without it, LiveKit auto-dispatches whichever unnamed worker it
 * likes — which includes the production cloud agent.
 *
 * Honest limitations — read before trusting a number from this:
 *  - The caller speaks in one clean burst with no hesitation, "אה", or mid-sentence pause.
 *    Real Hebrew speakers do all three, and those are exactly what break endpointing. So this
 *    measures the BEST case for end-of-turn, not the average one.
 *  - The caller uses the same Cartesia voice as the agent, so the agent hears its own timbre.
 *  - It cannot judge whether the Hebrew sounds natural. Only a human can do that — which is what
 *    the recorded audio and the HTML report are for.
 */
export class SyntheticCaller {
  constructor(
    private env: Env,
    private opts: SyntheticCallerOptions = {},
  ) {}

  async call(roomName: string, utterances: string[]): Promise<CallResult> {
    const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = this.env;
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      throw new Error('LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET must be set');
    }
    const capture = this.opts.captureAudio ?? true;
    const dispatchName = this.opts.agentName ?? '';
    const expectName = this.opts.expectAgentName ?? dispatchName;

    // Synthesize everything up front so Cartesia latency never pollutes the measurement.
    const speech = await Promise.all(
      utterances.map(async (text) => {
        const frames = await synthesizeHebrew(this.env, text);
        return { text, frames, pcm: capture ? concatFrames(frames).pcm : EMPTY };
      }),
    );

    const identity = this.opts.identity ?? 'synthetic-caller';
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
    if (dispatchName) {
      // Creates the room WITH an explicit dispatch list, which is what keeps auto-dispatched
      // workers (i.e. production) out. See SyntheticCallerOptions.agentName.
      at.roomConfig = new RoomConfiguration({
        agents: [new RoomAgentDispatch({ agentName: dispatchName })],
      });
    }
    const token = await at.toJwt();

    const room = new Room();
    const turns: TurnResult[] = [];

    // --- agent audio tracking -------------------------------------------------------------
    // We do not trust the agent's own logs; we time it from this side of the wire.
    let agentAudioAt: number | null = null; // first agent frame of the current reply
    let agentLastAudioAt: number | null = null; // most recent agent frame
    let agentJoined = false;
    let agentJoinedAt: number | null = null;
    let greetingStartedAt: number | null = null;
    let agentIdentity: string | null = null;
    let agentName: string | null = null;
    let bucket: Int16Array[] = []; // agent audio for the turn in progress
    // Wall clock of the FIRST sample sitting in `bucket`. The agent publishes a track for the whole
    // call, so the bucket starts filling with silence the moment it is emptied; this is the anchor
    // that turns "sample N of the bucket" back into "this many ms into the call".
    let bucketStartedAt: number | null = null;
    const startedAt = Date.now();
    const mixer = new Mixer(startedAt, CAPTURE_RATE);

    /**
     * Close off the agent audio collected since the last reset: trim the silence that surrounds it,
     * place the SPEECH on the call timeline, and hand back the clip.
     *
     * One contiguous segment per agent turn — NOT one per received frame. Per-frame placement was
     * the original design and it produced a whole-call recording that was unlistenable: frames
     * arrive from the jitter buffer in bursts, so `arrivalTime - frameDuration` put dozens of them
     * on top of each other. Measured on a real 31s call before this changed: 2734 segments, 1790
     * of them overlapping another, 13.7 SECONDS of audio summed on top of itself, and 882 clipped
     * samples. That is the "the voice was not clear at all" bug.
     */
    const closeAgentRun = (): Int16Array => {
      if (!capture) {
        bucket = [];
        bucketStartedAt = null;
        return EMPTY;
      }
      const raw = concatPcm(bucket);
      const anchor = bucketStartedAt;
      bucket = [];
      bucketStartedAt = null;
      if (raw.length === 0 || anchor === null) return EMPTY;
      const { pcm, startSample, hasSpeech } = trimSilenceWithOffset(raw, CAPTURE_RATE, 120);
      if (!hasSpeech || pcm.length === 0) return EMPTY;
      mixer.add(anchor + (startSample / CAPTURE_RATE) * 1000, pcm);
      return pcm;
    };

    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant: RemoteParticipant) => {
      agentJoined = true;
      agentJoinedAt ??= Date.now();
      agentIdentity ??= participant.identity;
      agentName ??= participant.attributes?.[AGENT_NAME_ATTRIBUTE] ?? null;
      // Force the agent's audio to the harness rate so it can be mixed with the caller's without
      // resampling, and so every WAV this harness writes has one known rate.
      const stream = new AudioStream(track, CAPTURE_RATE, CHANNELS);
      void (async () => {
        for await (const frame of stream) {
          const now = Date.now();
          if (capture) {
            const pcm = Int16Array.from(frame.data);
            // Anchor the bucket to the moment this frame's audio BEGAN, not to when it arrived —
            // arrival is jittery, the anchor must not be. Everything after it is appended in
            // order, so the clip is contiguous by construction. See `closeAgentRun`.
            bucketStartedAt ??= now - (frame.samplesPerChannel / CAPTURE_RATE) * 1000;
            bucket.push(pcm);
          }
          // Cartesia never emits digital silence mid-utterance, so any non-silent frame is speech.
          // Silence still gets captured above — dropping it would splice the recording.
          if (isSilent(frame)) continue;
          if (agentAudioAt === null) agentAudioAt = now;
          agentLastAudioAt = now;
        }
      })();
    });

    await room.connect(LIVEKIT_URL, token, { autoSubscribe: true, dynacast: false });

    const source = new AudioSource(CAPTURE_RATE, CHANNELS);
    const track = LocalAudioTrack.createAudioTrack('caller-mic', source);
    await room.localParticipant!.publishTrack(
      track,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );

    const fail = (error: string): CallResult => ({
      room: roomName,
      startedAt,
      turns,
      agentIdentity,
      agentName,
      agentJoinedMs: agentJoinedAt === null ? null : agentJoinedAt - startedAt,
      greetingStartedMs: greetingStartedAt === null ? null : greetingStartedAt - startedAt,
      greetingPcm: EMPTY,
      mixedPcm: capture ? mixer.render() : EMPTY,
      mixStats: mixer.stats(),
      error,
    });

    try {
      // Wait for the agent to join and deliver its greeting, then let it go quiet.
      const joinedBy = Date.now() + JOIN_TIMEOUT_MS;
      while (!agentJoined && Date.now() < joinedBy) await sleep(100);
      if (!agentJoined) {
        return fail(
          dispatchName
            ? `no agent named "${dispatchName}" joined the room. Is the worker running, and does it register under that name? (npm run voice:dev prints its dispatch mode at boot.)`
            : 'agent never joined the room',
        );
      }

      // WHO ANSWERED. Getting this wrong is silent and expensive: the production cloud agent
      // answering a test room looks exactly like a successful run, except every number describes
      // production instead of the change under test.
      if (expectName !== '' && agentName !== expectName) {
        return fail(
          `WRONG AGENT ANSWERED: expected lk.agent.name="${expectName}", got ` +
            `"${agentName ?? 'unknown'}" (identity ${agentIdentity ?? 'unknown'}). ` +
            `An empty name means a default-dispatch worker — on this project that is the ` +
            `PRODUCTION cloud agent, not your laptop.`,
        );
      }

      await this.waitForAgentToFinish(() => agentLastAudioAt);
      if (agentAudioAt === null) {
        return fail('agent joined but never spoke a greeting');
      }
      greetingStartedAt = agentAudioAt;
      const greetingPcm = closeAgentRun();

      for (const { text, frames, pcm: callerPcm } of speech) {
        // Only start the next utterance once the agent has genuinely gone quiet — otherwise
        // its previous reply bleeds into this turn and registers as an instant "response".
        await this.waitForAgentToFinish(() => agentLastAudioAt);
        await sleep(300);

        agentAudioAt = null;
        agentLastAudioAt = null;
        // Anything still in the bucket belongs to the PREVIOUS turn (or is trailing silence);
        // closing it here keeps it out of this turn's clip and out of the mix twice.
        closeAgentRun();

        const callerStartedAt = Date.now();
        if (capture) mixer.add(callerStartedAt, callerPcm);
        for (const frame of frames) await source.captureFrame(frame);
        // captureFrame() returns once the frame is QUEUED, not once it has been transmitted.
        // Without this wait, "the caller stopped talking" is timestamped seconds early and
        // every latency number is inflated by the queue depth.
        await source.waitForPlayout();
        const callerFinishedAt = Date.now();

        // Agent started talking before the caller had finished = it cut them off.
        const interruptedCaller = agentAudioAt !== null && agentAudioAt < callerFinishedAt;

        // Real silence on the wire, so the agent's endpointing sees the caller stop. Stop early
        // once the agent starts replying — no point holding the line open.
        await this.pushSilence(source, TRAILING_SILENCE_MS, () => agentAudioAt !== null);

        const repliedBy = Date.now() + REPLY_TIMEOUT_MS;
        while (agentAudioAt === null && Date.now() < repliedBy) await sleep(20);

        const responseLatencyMs =
          agentAudioAt === null ? null : Math.max(0, agentAudioAt - callerFinishedAt);

        await this.waitForAgentToFinish(() => agentLastAudioAt);
        const agentSpokeMs =
          agentAudioAt !== null && agentLastAudioAt !== null ? agentLastAudioAt - agentAudioAt : 0;

        turns.push({
          said: text,
          responseLatencyMs,
          interruptedCaller,
          agentSpokeMs,
          callerStartedAtMs: callerStartedAt - startedAt,
          callerFinishedAtMs: callerFinishedAt - startedAt,
          callerPcm,
          agentPcm: closeAgentRun(),
        });
      }

      return {
        room: roomName,
        startedAt,
        turns,
        agentIdentity,
        agentName,
        agentJoinedMs: agentJoinedAt === null ? null : agentJoinedAt - startedAt,
        greetingStartedMs: greetingStartedAt === null ? null : greetingStartedAt - startedAt,
        greetingPcm,
        mixedPcm: capture ? mixer.render() : EMPTY,
        mixStats: mixer.stats(),
      };
    } finally {
      await room.disconnect();
    }
  }

  /** Push digital silence, in real time, so the far end perceives the caller as having stopped. */
  private async pushSilence(
    source: AudioSource,
    ms: number,
    stopWhen?: () => boolean,
  ): Promise<void> {
    const samplesPerFrame = CAPTURE_RATE / 100; // 10ms frames
    const frames = Math.ceil(ms / 10);
    for (let i = 0; i < frames; i++) {
      if (stopWhen?.()) return;
      const buf = new Int16Array(samplesPerFrame * CHANNELS); // zeros
      await source.captureFrame(new AudioFrame(buf, CAPTURE_RATE, CHANNELS, samplesPerFrame));
    }
  }

  /** Block until the agent has been quiet for 800ms (i.e. it finished its turn). */
  private async waitForAgentToFinish(lastAudioAt: () => number | null): Promise<void> {
    const QUIET_MS = 800;
    const HARD_CAP = Date.now() + 30_000;
    // Give it a moment to start in the first place.
    await sleep(200);
    while (Date.now() < HARD_CAP) {
      const last = lastAudioAt();
      if (last !== null && Date.now() - last > QUIET_MS) return;
      if (last === null && Date.now() > HARD_CAP) return;
      await sleep(50);
    }
  }
}

const EMPTY = new Int16Array(0);

function concatPcm(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Both voices, on one timeline, so the call can be played back as a conversation.
 *
 * Placement is by WALL CLOCK, not by concatenation, which is the only way the gaps survive: the
 * dead air between "the caller stopped" and "the agent started" is the thing under test, and a
 * concatenated recording deletes exactly that. Summed in 32-bit and clamped once at the end so two
 * voices overlapping (a cut-off) stays audible as an overlap instead of wrapping into noise.
 */
export class Mixer {
  #segments: Array<{ offset: number; pcm: Int16Array }> = [];

  constructor(
    private t0: number,
    private rate: number,
  ) {}

  add(atMs: number, pcm: Int16Array): void {
    if (pcm.length === 0) return;
    const offset = Math.max(0, Math.round(((atMs - this.t0) / 1000) * this.rate));
    this.#segments.push({ offset, pcm });
  }

  /**
   * How much of this mix is one segment landing ON TOP of another — i.e. how much of the recording
   * is two copies of the same voice summed together rather than played in sequence.
   *
   * A little of this is REAL and wanted: the caller talking over the agent is a cut-off, and the
   * mix has to keep it. A lot of it means the PLACEMENT is wrong, and the track is mush.
   */
  stats(): { segments: number; overlappingSegments: number; overlapMs: number } {
    const sorted = [...this.#segments].sort((a, b) => a.offset - b.offset);
    let overlapSamples = 0;
    let overlapping = 0;
    let end = 0;
    for (const s of sorted) {
      if (s.offset < end) {
        overlapping++;
        overlapSamples += Math.min(end - s.offset, s.pcm.length);
      }
      end = Math.max(end, s.offset + s.pcm.length);
    }
    return {
      segments: sorted.length,
      overlappingSegments: overlapping,
      overlapMs: Math.round((overlapSamples / this.rate) * 1000),
    };
  }

  render(): Int16Array {
    let end = 0;
    for (const s of this.#segments) end = Math.max(end, s.offset + s.pcm.length);
    if (end === 0) return EMPTY;
    const acc = new Int32Array(end);
    for (const s of this.#segments) {
      for (let i = 0; i < s.pcm.length; i++) acc[s.offset + i]! += s.pcm[i]!;
    }
    const out = new Int16Array(end);
    for (let i = 0; i < end; i++) out[i] = Math.max(-32768, Math.min(32767, acc[i]!));
    return out;
  }
}

/** True if the frame is (near-)digital silence — used to ignore comfort noise / padding. */
function isSilent(frame: AudioFrame): boolean {
  const data = frame.data;
  for (let i = 0; i < data.length; i += 16) {
    if (Math.abs(data[i]!) > 200) return false;
  }
  return true;
}
