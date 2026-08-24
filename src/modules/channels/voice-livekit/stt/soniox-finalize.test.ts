import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as soniox from '@livekit/agents-plugin-soniox';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FinalizingSonioxSTT } from './soniox.stt.js';

/**
 * ── THE PAUSE-ARM EOU FIX ──────────────────────────────────────────────────────────────────────
 *
 * The SDK commits a turn only on a Soniox FINAL transcript, and Soniox holds text non-final until
 * its own endpoint fires (500ms API floor) — so turns where the caller trails off waited 566-758ms
 * against Silero's 226ms. `finalizeTurn()` tells Soniox to finalize the moment Silero declares
 * end-of-speech. These tests pin the wrapper's contract; the wire behaviour (`{"type":"finalize"}`
 * → `<fin>`) lives in the plugin patch, which the last test pins by content.
 *
 * The parent's `stream()` is stubbed — the real one opens a Soniox websocket from the constructor.
 */

type FakeStream = { closed: boolean; flush: ReturnType<typeof vi.fn> };

function fakeStream(): FakeStream {
  return { closed: false, flush: vi.fn() };
}

let streamSpy: MockInstance;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  streamSpy?.mockRestore();
});

function makeStt(stream: FakeStream): FinalizingSonioxSTT {
  streamSpy = vi.spyOn(soniox.STT.prototype, 'stream') as unknown as MockInstance;
  streamSpy.mockReturnValue(stream);
  return new FinalizingSonioxSTT({ apiKey: 'test-key', model: 'stt-rt-v5' });
}

describe('FinalizingSonioxSTT.finalizeTurn', () => {
  it('flushes the active stream — the flush IS the finalize, via the patched plugin', () => {
    const s = fakeStream();
    const stt = makeStt(s);
    stt.stream();

    stt.finalizeTurn();

    expect(s.flush).toHaveBeenCalledTimes(1);
  });

  it('is a no-op before any stream exists and after the stream closed', () => {
    const s = fakeStream();
    const stt = makeStt(s);

    stt.finalizeTurn(); // no stream yet — a session that never started must not throw
    stt.stream();
    s.closed = true;
    stt.finalizeTurn(); // stream tore down mid-call

    expect(s.flush).not.toHaveBeenCalled();
  });

  /**
   * Soniox tolerates a finalize every few seconds; a flapping VAD (breath, line noise) can fire
   * speaking→listening several times in one real pause, and a finalize storm gets the socket
   * dropped — which costs the whole call, not 300ms.
   */
  it('rate-limits: a flapping VAD cannot turn into a finalize storm', () => {
    const s = fakeStream();
    const stt = makeStt(s);
    stt.stream();

    stt.finalizeTurn();
    stt.finalizeTurn(); // 0ms later — swallowed
    vi.advanceTimersByTime(400);
    stt.finalizeTurn(); // still inside the window — swallowed
    vi.advanceTimersByTime(700);
    stt.finalizeTurn(); // 1.1s after the first — allowed

    expect(s.flush).toHaveBeenCalledTimes(2);
  });

  it('always finalizes the LATEST stream — a reconnect must not finalize a dead socket', () => {
    const first = fakeStream();
    const second = fakeStream();
    const stt = makeStt(first);
    stt.stream();
    streamSpy.mockReturnValue(second);
    stt.stream(); // STT reconnect created a new stream

    stt.finalizeTurn();

    expect(first.flush).not.toHaveBeenCalled();
    expect(second.flush).toHaveBeenCalledTimes(1);
  });
});

describe('the plugin patch this wrapper depends on', () => {
  /**
   * `flush()` only pushes a sentinel; the PATCH is what turns the sentinel into the
   * `{"type":"finalize"}` websocket message. An `npm install` that silently failed to apply it
   * (patch-package missing from postinstall, version bump) would revert flush() to a no-op and
   * quietly bring the 500ms pause-arm EOU back. Pin the installed file, not just the patch file.
   */
  it('the installed plugin actually sends finalize on FLUSH_SENTINEL', () => {
    const installed = readFileSync(
      join(process.cwd(), 'node_modules/@livekit/agents-plugin-soniox/dist/stt.js'),
      'utf8',
    );
    expect(installed).toContain('{"type":"finalize"}');
  });
});
