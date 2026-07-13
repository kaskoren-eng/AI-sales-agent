import { stt as sttBase } from '@livekit/agents';
import { AudioStream, type RemoteAudioTrack } from '@livekit/rtc-node';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { eq } from 'drizzle-orm';
import { callLearnings, type ShadowSttTranscript } from '../../../../db/schema/call-learnings.js';
import { sonioxCircuit, createSonioxSTT } from './soniox.stt.js';
import type { Database } from '../../../../db/client.js';
import type { Env } from '../../../../config/env.js';

/**
 * Shadow STT — runs the CANDIDATE engine alongside the live one, on real callers, and says nothing.
 *
 * The corpus A/B (`npm run stt:ab`) is synthesized speech: perfectly articulated, no disfluencies,
 * no accent, no mumbling. Real callers do all of that constantly, so the corpus can only rank the
 * engines — it cannot tell us what either actually does to a Hebrew salesperson on a mobile in a
 * car. This closes that gap: both engines hear the SAME real audio, and we read the disagreements
 * afterwards.
 *
 *
 * THE SAFETY CONTRACT, which is the whole design:
 *
 *   THIS CODE MUST NEVER BE ABLE TO HARM A LIVE CALL.
 *
 * The caller is a real lead, on the phone, right now. A shadow experiment that degrades their call
 * has cost more than it could ever discover. So:
 *
 *   - Every path is try/caught. Errors are COLLECTED, never thrown. There is no failure mode here
 *     that propagates.
 *   - It reads a SEPARATE AudioStream off the same track. It never touches the live STT, the live
 *     session, or the audio the agent hears.
 *   - It goes through the Soniox circuit breaker. Five consecutive failures and it stops trying for
 *     the rest of the cooldown, rather than hammering a dead endpoint on every turn of every call.
 *   - Persistence happens at the END of the call, off the hot path.
 *
 * Its output is never read by the agent, never shown to the caller, and never influences a reply.
 */
export class ShadowSTT {
  #env: Env;
  #startedAt = Date.now();
  #authoritative: ShadowSttTranscript['authoritative'] = [];
  #shadow: ShadowSttTranscript['shadow'] = [];
  #errors: string[] = [];
  #stream?: sttBase.SpeechStream;
  #pump?: Promise<void>;
  #stopped = false;

  constructor(env: Env) {
    this.#env = env;
  }

  /** The engine being trialled: whichever one is NOT live. */
  get shadowEngine(): 'openai' | 'soniox' {
    return this.#env.STT_PROVIDER === 'soniox' ? 'openai' : 'soniox';
  }

  /**
   * Starts transcribing the caller's audio with the shadow engine.
   *
   * Never throws. If the shadow engine cannot start, the call proceeds exactly as if shadow mode
   * were switched off, and the reason is recorded for the analysis script.
   */
  async start(track: RemoteAudioTrack): Promise<void> {
    try {
      const stt = await this.#buildShadowEngine();
      const stream = stt.stream();
      this.#stream = stream;

      // A SECOND AudioStream on the same track. LiveKit permits multiple readers, and this is the
      // point: the live STT's stream is untouched, so nothing we do here can starve or stall it.
      const audio = new AudioStream(track);

      this.#pump = (async () => {
        try {
          for await (const frame of audio) {
            if (this.#stopped) break;
            stream.pushFrame(frame);
          }
        } catch (err) {
          this.#note(err);
        }
      })();

      void this.#consume(stream);
    } catch (err) {
      this.#note(err);
    }
  }

  /** Records what the LIVE engine heard, so the two can be compared later. */
  recordAuthoritative(text: string): void {
    if (!text.trim()) return;
    this.#authoritative.push({ atMs: Date.now() - this.#startedAt, text });
  }

  /**
   * Both transcripts as they stand. Used for the end-of-call log line, and by `persist`.
   *
   * Exists because until Phase 4 writes a call_learnings row for LiveKit calls, there is nothing to
   * attach the shadow data TO — so today it goes to stdout. Same payload either way, so the
   * analysis script's input shape does not change when persistence lands.
   */
  snapshot(): ShadowSttTranscript {
    return {
      authoritativeEngine: this.#env.STT_PROVIDER,
      shadowEngine: this.shadowEngine,
      shadowModel:
        this.shadowEngine === 'soniox' ? this.#env.SONIOX_MODEL : this.#env.OPENAI_REALTIME_MODEL,
      authoritative: this.#authoritative,
      shadow: this.#shadow,
      errors: this.#errors,
    };
  }

  /**
   * Writes both transcripts to call_learnings. Call once, at the end of the call.
   *
   * Returns rather than throws on failure: a shadow-mode write that fails must not take down the
   * agent's own shutdown path, which has real work to do (Phase 4: the transcript, the booking).
   */
  async persist(db: Database, callLearningId: string): Promise<void> {
    this.#stopped = true;
    try {
      this.#stream?.close();
    } catch {
      // Already closed.
    }
    await this.#pump?.catch(() => {});

    if (this.#authoritative.length === 0 && this.#shadow.length === 0) return;

    try {
      await db
        .update(callLearnings)
        .set({ shadowSttTranscript: this.snapshot() })
        .where(eq(callLearnings.id, callLearningId));
    } catch (err) {
      // Nothing left to do but say so. Losing shadow data is an acceptable loss; failing the call
      // is not.
      console.error('shadow_stt_persist_failed', err instanceof Error ? err.message : String(err));
    }
  }

  async #buildShadowEngine(): Promise<sttBase.STT> {
    if (this.shadowEngine === 'soniox') {
      return createSonioxSTT(this.#env);
    }
    // The OpenAI realtime STT cannot decide a turn is over on its own — it needs a local VAD. Its
    // own VAD instance, never the live session's: sharing one would couple the shadow path to the
    // live path, which is precisely what this class must not do.
    const vad = await silero.VAD.load({
      minSilenceDuration: this.#env.VOICE_VAD_MIN_SILENCE_MS,
      activationThreshold: this.#env.VOICE_VAD_ACTIVATION_THRESHOLD,
    });
    return new openai.STT({
      model: this.#env.OPENAI_REALTIME_MODEL,
      language: this.#env.VOICE_LANGUAGE,
      useRealtime: true,
      vad,
    });
  }

  async #consume(stream: sttBase.SpeechStream): Promise<void> {
    try {
      const run = async () => {
        for await (const ev of stream) {
          if (this.#stopped) break;
          // Only finals. Interims churn several times a second and would bloat the row for no gain.
          if (ev.type === sttBase.SpeechEventType.FINAL_TRANSCRIPT && ev.alternatives?.[0]?.text) {
            this.#shadow.push({
              atMs: Date.now() - this.#startedAt,
              text: ev.alternatives[0].text,
              endpointMs: null,
            });
          }
        }
      };
      // Soniox runs behind the breaker so a Soniox outage stops being retried on every call.
      // The OpenAI shadow has no breaker: it is the incumbent, already guarded on the live path.
      await (this.shadowEngine === 'soniox' ? sonioxCircuit.execute(run) : run());
    } catch (err) {
      this.#note(err);
    }
  }

  #note(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    // Cap it. A flapping engine could otherwise write thousands of identical lines into a jsonb
    // column on a long call.
    if (this.#errors.length < 20 && !this.#errors.includes(message)) {
      this.#errors.push(message);
    }
  }
}
