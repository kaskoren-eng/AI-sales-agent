import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RoomEvent,
  Room,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import type { Env } from '../../../../config/env.js';
import { synthesizeHebrew } from './speech.js';

/** One caller utterance and what the agent did about it. */
export interface TurnResult {
  /** What the synthetic caller said (Hebrew). */
  said: string;
  /**
   * Dead air, in ms: from the last frame of caller audio to the first frame of agent audio.
   * This is the number the human actually feels, and the one the "no dead air > 1.2s"
   * criterion in docs/voice-agent-development-methodology.md is written against.
   * null = the agent never responded within the timeout.
   */
  responseLatencyMs: number | null;
  /** Whether the agent started talking BEFORE the caller finished — i.e. it cut them off. */
  interruptedCaller: boolean;
  /** How long the agent then spoke for, in ms. */
  agentSpokeMs: number;
}

export interface CallResult {
  room: string;
  turns: TurnResult[];
  /** Agent never joined, agent never spoke, etc. */
  error?: string;
}

const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
/** Silence pushed after each utterance so the agent's endpointing sees the caller stop. */
const TRAILING_SILENCE_MS = 3_000;
/** How long to wait for the agent to start replying before calling it a failure. */
const REPLY_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake Hebrew-speaking caller.
 *
 * Joins a LiveKit room, publishes Cartesia-synthesized Hebrew as if it were a microphone, and
 * listens to the agent's audio track to measure how long the agent takes to respond.
 *
 * The agent worker (`npm run voice:dev`) must already be running: it has no agentName, so
 * LiveKit auto-dispatches it into any room that gets created.
 *
 * Honest limitations — read before trusting a number from this:
 *  - The caller speaks in one clean burst with no hesitation, "אה", or mid-sentence pause.
 *    Real Hebrew speakers do all three, and those are exactly what break endpointing. So this
 *    measures the BEST case for end-of-turn, not the average one.
 *  - The caller uses the same Cartesia voice as the agent, so the agent hears its own timbre.
 *  - It cannot judge whether the Hebrew sounds natural. Only a human can do that.
 */
export class SyntheticCaller {
  constructor(
    private env: Env,
    private opts: { identity?: string } = {},
  ) {}

  async call(roomName: string, utterances: string[]): Promise<CallResult> {
    const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = this.env;
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      throw new Error('LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET must be set');
    }

    // Synthesize everything up front so Cartesia latency never pollutes the measurement.
    const speech = await Promise.all(
      utterances.map(async (text) => ({ text, frames: await synthesizeHebrew(this.env, text) })),
    );

    const identity = this.opts.identity ?? 'synthetic-caller';
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
    const token = await at.toJwt();

    const room = new Room();
    const turns: TurnResult[] = [];

    // --- agent audio tracking -------------------------------------------------------------
    // We do not trust the agent's own logs; we time it from this side of the wire.
    let agentAudioAt: number | null = null; // first agent frame of the current reply
    let agentLastAudioAt: number | null = null; // most recent agent frame
    let agentJoined = false;

    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== 1 /* AUDIO */ && String(track.kind) !== 'audio') {
        // rtc-node exposes kind as an enum; accept either representation.
      }
      agentJoined = true;
      const stream = new AudioStream(track);
      void (async () => {
        for await (const frame of stream) {
          // Cartesia never emits digital silence mid-utterance, so any frame is real speech.
          if (isSilent(frame)) continue;
          const now = Date.now();
          if (agentAudioAt === null) agentAudioAt = now;
          agentLastAudioAt = now;
        }
      })();
    });

    await room.connect(LIVEKIT_URL, token, { autoSubscribe: true, dynacast: false });

    const source = new AudioSource(SAMPLE_RATE, CHANNELS);
    const track = LocalAudioTrack.createAudioTrack('caller-mic', source);
    await room.localParticipant!.publishTrack(
      track,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );

    try {
      // Wait for the agent to join and deliver its greeting, then let it go quiet.
      const joinedBy = Date.now() + REPLY_TIMEOUT_MS;
      while (!agentJoined && Date.now() < joinedBy) await sleep(100);
      if (!agentJoined) return { room: roomName, turns, error: 'agent never joined the room' };

      await this.waitForAgentToFinish(() => agentLastAudioAt);
      if (agentAudioAt === null) {
        return { room: roomName, turns, error: 'agent joined but never spoke a greeting' };
      }

      for (const { text, frames } of speech) {
        // Only start the next utterance once the agent has genuinely gone quiet — otherwise
        // its previous reply bleeds into this turn and registers as an instant "response".
        await this.waitForAgentToFinish(() => agentLastAudioAt);
        await sleep(300);

        agentAudioAt = null;
        agentLastAudioAt = null;

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

        turns.push({ said: text, responseLatencyMs, interruptedCaller, agentSpokeMs });
      }

      return { room: roomName, turns };
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
    const samplesPerFrame = SAMPLE_RATE / 100; // 10ms frames
    const frames = Math.ceil(ms / 10);
    for (let i = 0; i < frames; i++) {
      if (stopWhen?.()) return;
      const buf = new Int16Array(samplesPerFrame * CHANNELS); // zeros
      await source.captureFrame(new AudioFrame(buf, SAMPLE_RATE, CHANNELS, samplesPerFrame));
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

/** True if the frame is (near-)digital silence — used to ignore comfort noise / padding. */
function isSilent(frame: AudioFrame): boolean {
  const data = frame.data;
  for (let i = 0; i < data.length; i += 16) {
    if (Math.abs(data[i]!) > 200) return false;
  }
  return true;
}
