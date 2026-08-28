import { stt as sttBase } from '@livekit/agents';
import * as soniox from '@livekit/agents-plugin-soniox';
import { CircuitBreaker } from '../../../../shared/circuit-breaker.js';
import { type MeasureOptions, type Measurement, measureStream } from './measure.js';
import type { Env } from '../../../../config/env.js';

/**
 * Soniox STT — configuration, not a wrapper.
 *
 * WHY THERE IS NO WRAPPER HERE. The original brief asked for a hand-written LiveKit-compatible
 * STT class over Soniox's WebSocket API. There is an OFFICIAL one — `@livekit/agents-plugin-soniox`,
 * published by LiveKit at 1.5.1, the same version as every other plugin we run. It already
 * subclasses `stt.STT`, so it drops straight into `AgentSession`. Hand-rolling ours would mean
 * owning the reconnect logic, the audio framing, the interim/final token state machine and the
 * `<end>`/`<fin>` endpoint protocol — all of it code LiveKit maintains and we would not.
 *
 * So this file is the thin part that IS ours: the Hebrew configuration, and the circuit breaker.
 */

/**
 * HONEST LIMIT OF THIS BREAKER — read before trusting it.
 *
 * A circuit breaker is a request/response device: `execute(fn)` runs a call that RETURNS, counts
 * the failures, and starts rejecting once the far end looks dead. Soniox's live path is not that
 * shape. It is one long-lived WebSocket, opened once per call and held for minutes, owned INSIDE
 * the plugin. There is no `fn` to wrap, and pretending otherwise by wrapping the constructor would
 * produce a breaker that guards nothing and reads, to the next person, as though it does.
 *
 * What this breaker genuinely covers: the discrete, awaitable Soniox calls WE own — the A/B harness
 * and shadow mode (`transcribeBuffer` below). Those are real fan-out risks: shadow mode runs on
 * every live call, and a Soniox outage there must never bleed into the caller's audio path.
 *
 * What guards the live streaming path instead: LiveKit's own `APIConnectionError` /
 * `APIStatusError` handling inside `SpeechStream.run()`, plus `AgentSession`'s STT fallback. That
 * is the plugin's job and it already does it.
 */
export const sonioxCircuit = new CircuitBreaker({
  name: 'soniox',
  failureThreshold: 5,
  cooldownMs: 30_000,
});

/**
 * Builds the Soniox STT with our Hebrew settings.
 *
 * `context.terms` is the whole reason Soniox is being evaluated. Hebrew STT invents plausible
 * nonsense from what it half-hears — on a real call it turned "קורן" into "קורנטיטרי". The fix is
 * to bias the recogniser toward the words we actually expect, and `gpt-realtime-whisper` REJECTS
 * the `prompt` parameter that would do it (see docs/phase-4-known-issues.md §1). That rejection is
 * the sole reason Phase 4 carries a "hybrid STT" workaround. Soniox accepts biasing terms on a
 * STREAMING connection, so if this holds up on Hebrew, the workaround is deleted rather than built.
 */
export function createSonioxSTT(env: Env): soniox.STT {
  if (!env.SONIOX_API_KEY) {
    throw new Error('STT_PROVIDER=soniox requires SONIOX_API_KEY');
  }

  return new soniox.STT({
    apiKey: env.SONIOX_API_KEY,
    model: env.SONIOX_MODEL,
    languageHints: [env.VOICE_LANGUAGE],
    // Left FALSE deliberately. Strict hints would force every token to Hebrew, which would kill the
    // phantom-English problem (line noise transcribing as the word "you")... and also mangle the
    // things Phase 4 must capture verbatim: an email address, and the brand name "ClickScales".
    // A caller spelling out their email in English letters is not an edge case, it is the booking.
    languageHintsStrict: false,
    // The biasing terms. VOICE_STT_PROMPT is authored as a Whisper-style comma-separated phrase
    // list, so split it back into the array Soniox wants rather than duplicating the vocabulary in
    // a second env var that would inevitably drift out of sync with the first.
    context: { terms: parseBiasTerms(env.VOICE_STT_PROMPT) },
    maxEndpointDelayMs: env.SONIOX_MAX_ENDPOINT_DELAY_MS,
    // Off: one caller per call, and diarization is billed work we cannot use.
    enableSpeakerDiarization: false,
    enableLanguageIdentification: true,
  });
}

/**
 * Makes preemptive generation work under `VOICE_TURN_DETECTION=stt`.
 *
 * THE BUG THIS EXISTS TO FIX. LiveKit only starts drafting a reply early from two places
 * (agents/dist/voice/audio_recognition.js):
 *
 *   FINAL_TRANSCRIPT     → gated on `vadBaseTurnDetection || userTurnCommitted`
 *   PREFLIGHT_TRANSCRIPT → gated on `turnDetectionMode !== 'manual' || userTurnCommitted`
 *
 * In `stt` mode `vadBaseTurnDetection` is FALSE and the turn is not yet committed, so the FINAL
 * path never fires. That leaves the PREFLIGHT path — and the Soniox plugin only emits PREFLIGHT
 * when it holds final text with NO non-final token pending, which on a live call is a window of
 * approximately zero: Soniox finalizes its tokens at the same moment it emits the `<end>`
 * endpoint. Net effect: switching to `stt` silently disabled preemptive generation entirely.
 * Measured on the deployed agent — 0 "starting preemptive generation" across a whole call in
 * `stt`, 4 in `vad`, with every other setting identical.
 *
 * THE FIX: DRAFT ON A PAUSE. When no new interim text has arrived for
 * `VOICE_PREEMPTIVE_PAUSE_MS`, the caller has stopped producing words, and we inject a
 * PREFLIGHT_TRANSCRIPT carrying the text so far. That moment arrives a few hundred ms before
 * Soniox's `<end>`, which is exactly the window the LLM needs.
 *
 * THE FIRST VERSION OF THIS TRIGGERED ON TEXT EQUALITY — two consecutive interims carrying
 * identical text — and it almost never fired: 1 preemptive start across a whole 135s call
 * (2026-08-16), because Soniox rarely re-emits an interim verbatim. It keeps revising
 * punctuation and word endings right up to the endpoint, so "settled" in the string-equality
 * sense is not a state real speech passes through. A pause is: it is measured on the CLOCK,
 * not on the text, so it cannot be defeated by the recogniser fiddling with the tail.
 *
 * WHY THIS IS SAFE. It only ever ADDS a PREFLIGHT event carrying text the plugin already
 * emitted as an interim — it never edits, drops or reorders the plugin's own events, and never
 * touches FINAL, END_OF_SPEECH or START_OF_SPEECH. A draft built from a transcript the caller
 * then extends is discarded by the SDK's own context check
 * (`preemptive.chatCtx.isEquivalent(chatCtx)`). `MAX_PREFLIGHTS_PER_TURN` caps the waste at
 * three drafts per turn; the best case is the whole LLM TTFT hiding behind the endpoint wait.
 */
/**
 * The live SpeechStream for an STT, so end-of-speech can force Soniox to finalise.
 *
 * WHY THIS EXISTS. Silero and Soniox run on tee'd copies of the same audio and neither tells the
 * other anything (`audio_recognition.js`: `primaryInputStream.tee()`), but a turn cannot commit
 * without BOTH — the VAD's stop time and the STT's final transcript. So the reply waits on the
 * slower one, and it is always Soniox. Measured on the 2026-08-18 call, 17 turns:
 *
 *     end-of-turn median  565ms
 *     of which SILERO         1ms
 *     of which transcript   565ms   <- 98% of it
 *
 * And on the two turns where the transcript happened to already be there, end-of-turn was 128ms —
 * exactly VOICE_VAD_MIN_SILENCE_MS and nothing else. That is the number every turn could have.
 *
 * Soniox supports `{"type":"finalize"}`, which commits every pending token immediately instead of
 * waiting for its own endpoint detection. The LiveKit plugin never sends it — it receives the
 * base class's FLUSH_SENTINEL and drops it (`continue`). One patch in patches/ forwards it, and
 * this hands the agent the stream handle to trigger it, because the SDK flushes only the VAD
 * stream and never the STT's.
 */
const ACTIVE_STREAM = new WeakMap<sttBase.STT, sttBase.SpeechStream>();

/** Wraps `stream()` to remember the live stream. Same instance-shadowing trick as below — never a
 * Proxy, which breaks the SDK's `#private` fields. */
export function withFinalizeOnEndOfSpeech(inner: soniox.STT): soniox.STT {
  const originalStream = inner.stream.bind(inner);
  (inner as unknown as { stream: (...a: unknown[]) => sttBase.SpeechStream }).stream = (
    ...args: unknown[]
  ) => {
    const stream = originalStream(...(args as []));
    ACTIVE_STREAM.set(inner, stream);
    return stream;
  };
  return inner;
}

/**
 * Tell the STT the caller has stopped — commit what you have, now.
 *
 * Safe to call spuriously: `flush()` throws once the stream is closed or its input has ended, and
 * a failed finalize must never take a live call down with it.
 */
export function finalizeTranscriptNow(stt: unknown): void {
  // `unknown` because AgentSessionOptions types `stt` as STT | ModelWithLanguage | undefined, and
  // the OpenAI path has no stream to finalise. A non-Soniox STT simply misses the WeakMap.
  if (typeof stt !== 'object' || stt === null) return;
  const stream = ACTIVE_STREAM.get(stt as sttBase.STT);
  if (!stream) return;
  try {
    stream.flush();
  } catch {
    // stream already closed between end-of-speech and here — nothing to finalise.
  }
}

export function withPreflightSurvival(inner: soniox.STT, pauseMs: number): soniox.STT {
  // Instance-level shadow of `stream`, NOT a Proxy. The first attempt at this used a Proxy over
  // the STT and its SpeechStream, and it broke the agent outright — "AgentSession is not running"
  // before the greeting — because the SDK's classes use JS private fields (`#private`), which
  // throw when touched through a Proxy receiver. Assigning an own property here shadows the
  // prototype method while `this` stays the real instance, so private fields keep working.
  const originalStream = inner.stream.bind(inner);
  (inner as unknown as { stream: (...a: unknown[]) => sttBase.SpeechStream }).stream = (
    ...args: unknown[]
  ) => {
    const stream = originalStream(...(args as []));
    patchQueue(stream, pauseMs);
    return stream;
  };
  return inner;
}

/**
 * Terminal punctuation Soniox appends when it finalises an utterance.
 *
 * THIS SINGLE CHARACTER WAS COSTING ~850ms ON EVERY TURN. Measured on a real call (2026-08-16):
 * three preemptive drafts, and the two that died differed from the committed transcript by
 * exactly one trailing mark —
 *
 *     drafted "תגידי, את יודעת"      committed "תגידי, את יודעת."
 *     drafted "את יודעת להביע רגש"    committed "את יודעת להביע רגש?"
 *     drafted "אממ,"                 committed "אממ,"              <- identical, draft SURVIVED
 *
 * The survivor's turn had 248ms of dead air. The two that lost their drafts had 2222ms and
 * 2958ms. Same pipeline, same call — the entire difference is whether a full stop landed after
 * the draft was taken.
 *
 * Not a general "clean the transcript" list: `…` and `!` are included because Soniox emits them
 * in the same position, and nothing else is touched. Internal punctuation is never stripped —
 * "אממ," keeps its comma, which is why that draft matched in the first place.
 */
const TERMINAL_PUNCTUATION = /[.?!…]+$/u;

/** Returns `text` with any trailing terminal punctuation removed. Internal marks are untouched. */
function stripTerminal(text: string): string {
  return text.replace(TERMINAL_PUNCTUATION, '').trimEnd();
}

/** Rebuilds an event with different primary text, leaving every other field alone. */
function withText(ev: sttBase.SpeechEvent, text: string): sttBase.SpeechEvent {
  const [primary, ...rest] = ev.alternatives ?? [];
  if (!primary) return ev;
  return { ...ev, alternatives: [{ ...primary, text }, ...rest] } as sttBase.SpeechEvent;
}

/**
 * Most drafts a single caller turn may spawn.
 *
 * Each one is an LLM call that the caller's next word can invalidate, so this is the ceiling on
 * wasted spend per turn. Three is deliberately above LiveKit's own `maxRetries` default of 2:
 * the SDK is the real limiter, and this only stops a pathological turn (a caller pausing every
 * other word) from queueing drafts indefinitely.
 */
const MAX_PREFLIGHTS_PER_TURN = 3;

/**
 * Interims shorter than this never arm the timer.
 *
 * A draft written from "אה" costs a full LLM call and cannot possibly survive the caller's next
 * word. The threshold is in characters rather than words because Hebrew filler syllables are
 * short and one real word already carries enough for a useful draft.
 */
const MIN_PREFLIGHT_CHARS = 3;

/** Extracts the primary alternative's text, or '' when the event carries none. */
function eventText(ev: sttBase.SpeechEvent): string {
  return ev.alternatives?.[0]?.text ?? '';
}

/**
 * Rewrites events on their way out of the plugin.
 *
 * EVERY event the Soniox plugin produces goes through `this.queue.put(...)` (its private `#put`,
 * plugin dist/stt.js:216). `queue` is a plain AsyncIterableQueue held in a normal property, so
 * patching `put` on that one object intercepts the whole event stream without touching the
 * stream class itself. That is why this works where the Proxy did not.
 */
function patchQueue(stream: sttBase.SpeechStream, pauseMs: number): void {
  const holder = stream as unknown as {
    queue?: { put: (ev: sttBase.SpeechEvent) => void; closed?: boolean };
  };
  const queue = holder.queue;
  if (!queue || typeof queue.put !== 'function') {
    // Plugin internals changed shape. Do nothing rather than crash the call: the cost is the
    // lost overlap we are trying to win, not a dead agent.
    console.warn('preflight_patch_disabled', JSON.stringify({ reason: 'queue_not_found' }));
    return;
  }

  const originalPut = queue.put.bind(queue);

  // ── The punctuation rescue ────────────────────────────────────────────────────────────────
  // Remembers the text of the last PREFLIGHT so a FINAL that differs from it ONLY by trailing
  // punctuation can be handed over in the form the draft was built on. See TERMINAL_PUNCTUATION.
  //
  // DELIBERATELY NARROW. It never edits a FINAL whose words changed — if the caller kept talking
  // after the draft was taken, that draft SHOULD die, and it does. The only rewrite it can make
  // is deleting a mark the caller did not say out loud. The cost is that on a rescued turn the
  // LLM sees "את יודעת להביע רגש" without its question mark; the gain is that turn arriving in
  // ~250ms instead of ~2900ms.
  let lastPreflight: string | null = null;
  const rescue = (ev: sttBase.SpeechEvent): sttBase.SpeechEvent => {
    const pending = lastPreflight;
    lastPreflight = null;
    if (pending === null) return ev;
    const finalText = eventText(ev).trim();
    if (!finalText || finalText === pending) return ev;
    if (stripTerminal(finalText) !== pending) return ev; // words changed — let the draft die
    console.log(
      'preflight_punctuation_rescue',
      JSON.stringify({ drafted: pending, committed: finalText }),
    );
    return withText(ev, pending);
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: sttBase.SpeechEvent | null = null;
  let flaggedText: string | null = null;
  let preflights = 0;

  const disarm = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
  };

  /**
   * Ends the turn's draft window. Called on every non-interim event.
   *
   * Clears `lastPreflight` too: a draft that never reached a FINAL (the caller started a new turn,
   * or the stream ended) must not have its text applied to some later utterance's transcript.
   */
  const resetTurn = (): void => {
    disarm();
    flaggedText = null;
    preflights = 0;
    lastPreflight = null;
  };

  const fire = (): void => {
    timer = null;
    const ev = pending;
    pending = null;
    if (!ev) return;
    // The stream can close inside the pause window (caller hung up mid-sentence). Putting to a
    // closed queue throws, and a throw here lands on the timer's stack where nothing can catch it.
    if (queue.closed) return;
    const text = eventText(ev).trim();
    flaggedText = text;
    lastPreflight = text;
    preflights++;
    try {
      originalPut({ ...ev, type: sttBase.SpeechEventType.PREFLIGHT_TRANSCRIPT });
    } catch {
      // A late close between the guard above and here. Losing the draft is the correct outcome.
    }
  };

  queue.put = (ev: sttBase.SpeechEvent) => {
    // The plugin's OWN preflight — emitted when every token is final and the endpoint has not
    // fired. These are the drafts most likely to survive, so their text is what the rescue below
    // compares against.
    if (ev.type === sttBase.SpeechEventType.PREFLIGHT_TRANSCRIPT) {
      lastPreflight = eventText(ev).trim() || null;
      return originalPut(ev);
    }

    // The turn's committed text. Last chance to hand the SDK the exact string its draft was built
    // on, before it compares the two and throws the draft away.
    if (ev.type === sttBase.SpeechEventType.FINAL_TRANSCRIPT) {
      const rescued = rescue(ev);
      resetTurn();
      return originalPut(rescued);
    }

    // Any other non-interim event ends the current draft window — the next turn starts fresh.
    if (ev.type !== sttBase.SpeechEventType.INTERIM_TRANSCRIPT) {
      resetTurn();
      return originalPut(ev);
    }

    const text = eventText(ev).trim();
    // Empty interims are keep-alives, not speech: they must not re-arm the timer, or a silent
    // stream would draft off stale text forever.
    if (!text) return originalPut(ev);

    // New words arrived. Cancel the armed draft — it would have been written from a transcript
    // the caller has already moved past.
    disarm();

    // pauseMs 0 = the injector is off (the default). The punctuation rescue above still runs —
    // it works on the plugin's OWN preflights and does not need this at all.
    const worthDrafting =
      pauseMs > 0 &&
      text.length >= MIN_PREFLIGHT_CHARS &&
      text !== flaggedText &&
      preflights < MAX_PREFLIGHTS_PER_TURN;

    if (worthDrafting) {
      pending = ev;
      timer = setTimeout(fire, pauseMs);
      // Node would hold the process open for this timer through a shutdown that is otherwise
      // finished. It is a latency optimisation, never a reason to stay alive.
      timer.unref?.();
    }
    return originalPut(ev);
  };
}

/** Splits the Whisper-style biasing prompt ("קורן, ClickScales, פגישה") into Soniox's term array. */
export function parseBiasTerms(prompt: string): string[] {
  return prompt
    .split(',')
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

/**
 * Transcribes a finite audio buffer through Soniox, via the breaker.
 *
 * This is the shape a circuit breaker actually fits: hand it a known chunk of audio, wait for an
 * answer. Used by shadow mode, which runs on EVERY live call — a Soniox outage there must never
 * bleed into the caller's audio path, and after 5 consecutive failures this stops trying entirely.
 *
 * The measurement itself is `measureStream`, which is engine-agnostic and shared with the OpenAI
 * arm of the A/B, so neither engine can be advantaged by how it was driven.
 */
export async function transcribeBuffer(
  stt: soniox.STT,
  pcm: Int16Array,
  sampleRate: number,
  opts: MeasureOptions = {},
): Promise<Measurement> {
  return sonioxCircuit.execute(() => measureStream(stt, pcm, sampleRate, opts));
}
