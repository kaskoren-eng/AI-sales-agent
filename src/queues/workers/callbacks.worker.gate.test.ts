import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Database } from '../../db/client.js';

/**
 * VOICE_CALLBACK_WORKER=false MUST BE A NO-OP, AND THAT IS PROVED BY RUNNING IT.
 *
 * This repo has shipped a flag that silently did nothing (VOICE_PREEMPTIVE_TTS ran as TRUE for
 * weeks), and it has more recently shipped tests that stayed green through a deliberately broken
 * change. So this asserts the OFF path by executing it and watching the BullMQ constructor, not by
 * grepping server.ts for an `if`.
 *
 * OFF means: no Worker constructed, no Redis connection duplicated, nothing listening on the
 * `callbacks` queue. Not "a worker that starts and returns early" — that still holds a connection,
 * still claims jobs, and still has to be trusted to do nothing with them.
 */

const WorkerCtor = vi.fn();

vi.mock('bullmq', () => ({
  Worker: class {
    constructor(...args: unknown[]) {
      WorkerCtor(...args);
    }
    on() {
      return this;
    }
  },
}));

const { startCallbacksWorker } = await import('./callbacks.worker.js');

function deps(enabled: boolean) {
  const duplicate = vi.fn(() => ({}) as Redis);
  return {
    args: {
      enabled,
      db: {} as Database,
      redis: { duplicate } as unknown as Redis,
      deadLetterQueue: {} as Queue,
      callbacksQueue: {} as Queue,
      env: { LIVEKIT_SIP_OUTBOUND_TRUNK_ID: 'ST_trunk' },
    },
    duplicate,
  };
}

beforeEach(() => {
  WorkerCtor.mockClear();
});

describe('startCallbacksWorker — the flag gate', () => {
  it('OFF: returns null, constructs no Worker, opens no Redis connection', () => {
    const { args, duplicate } = deps(false);
    expect(startCallbacksWorker(args)).toBeNull();
    expect(WorkerCtor).not.toHaveBeenCalled();
    expect(duplicate).not.toHaveBeenCalled();
  });

  it('ON: constructs exactly one Worker, on the `callbacks` queue', () => {
    const { args, duplicate } = deps(true);
    expect(startCallbacksWorker(args)).not.toBeNull();
    expect(WorkerCtor).toHaveBeenCalledTimes(1);
    expect(WorkerCtor.mock.calls[0]![0]).toBe('callbacks');
    expect(duplicate).toHaveBeenCalledTimes(1);
  });

  it('ON: concurrency is low, because every job here places a phone call', () => {
    startCallbacksWorker(deps(true).args);
    expect((WorkerCtor.mock.calls[0]![2] as { concurrency: number }).concurrency).toBeLessThanOrEqual(2);
  });
});
