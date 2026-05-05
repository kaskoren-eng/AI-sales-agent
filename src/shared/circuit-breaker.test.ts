import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 1000;

function makeBreaker() {
  return new CircuitBreaker({
    name: 'test-breaker',
    failureThreshold: FAILURE_THRESHOLD,
    cooldownMs: COOLDOWN_MS,
  });
}

const alwaysFail = () => Promise.reject(new Error('service down'));
const alwaysSucceed = () => Promise.resolve('ok');

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.clearAllMocks();
    breaker = makeBreaker();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── CLOSED state ──────────────────────────────────────────────────────────

  it('starts in CLOSED state', () => {
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('CLOSED: passes through successful calls', async () => {
    const result = await breaker.execute(alwaysSucceed);
    expect(result).toBe('ok');
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('CLOSED: stays CLOSED below failure threshold', async () => {
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      await expect(breaker.execute(alwaysFail)).rejects.toThrow('service down');
    }
    expect(breaker.getState()).toBe('CLOSED');
  });

  // ── CLOSED → OPEN ─────────────────────────────────────────────────────────

  it('CLOSED → OPEN after failureThreshold consecutive failures', async () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await expect(breaker.execute(alwaysFail)).rejects.toThrow();
    }
    expect(breaker.getState()).toBe('OPEN');
  });

  it('resets failure count on a success (stays CLOSED)', async () => {
    // Two failures
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      await expect(breaker.execute(alwaysFail)).rejects.toThrow();
    }
    // Success resets count
    await breaker.execute(alwaysSucceed);
    expect(breaker.getState()).toBe('CLOSED');

    // Need FAILURE_THRESHOLD more failures to open
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      await expect(breaker.execute(alwaysFail)).rejects.toThrow();
    }
    expect(breaker.getState()).toBe('CLOSED');
  });

  // ── OPEN state ────────────────────────────────────────────────────────────

  it('OPEN: rejects immediately without calling fn', async () => {
    // Open the circuit
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await expect(breaker.execute(alwaysFail)).rejects.toThrow();
    }

    const spy = vi.fn().mockResolvedValue('should-not-run');
    await expect(breaker.execute(spy)).rejects.toThrow(/OPEN/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('OPEN: rejects with circuit breaker error message', async () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await expect(breaker.execute(alwaysFail)).rejects.toThrow();
    }

    await expect(breaker.execute(alwaysSucceed)).rejects.toThrow(/circuit breaker.*OPEN/i);
  });

  // ── OPEN → HALF_OPEN ──────────────────────────────────────────────────────

  it('OPEN → HALF_OPEN after cooldown', async () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await expect(breaker.execute(alwaysFail)).rejects.toThrow();
    }
    expect(breaker.getState()).toBe('OPEN');

    // Advance time past cooldown
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + COOLDOWN_MS + 1);

    expect(breaker.getState()).toBe('HALF_OPEN');
  });

  it('remains OPEN before cooldown expires', async () => {
    // Capture time BEFORE opening so the mock offset is computed against a point
    // guaranteed to be ≤ lastOpenedAt, making the "before cooldown" assertion reliable.
    const beforeOpen = Date.now();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await expect(breaker.execute(alwaysFail)).rejects.toThrow();
    }

    vi.spyOn(Date, 'now').mockReturnValue(beforeOpen + COOLDOWN_MS - 1);

    expect(breaker.getState()).toBe('OPEN');
  });

  // ── HALF_OPEN → CLOSED ────────────────────────────────────────────────────

  it('HALF_OPEN: success → CLOSED', async () => {
    // Open the circuit
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await expect(breaker.execute(alwaysFail)).rejects.toThrow();
    }

    const openedAt = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(openedAt + COOLDOWN_MS + 1);

    // Should be HALF_OPEN now
    expect(breaker.getState()).toBe('HALF_OPEN');

    // Probe succeeds
    const result = await breaker.execute(alwaysSucceed);
    expect(result).toBe('ok');
    expect(breaker.getState()).toBe('CLOSED');
  });

  // ── HALF_OPEN → OPEN ──────────────────────────────────────────────────────

  it('HALF_OPEN: failure → OPEN', async () => {
    // Open the circuit
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await expect(breaker.execute(alwaysFail)).rejects.toThrow();
    }

    const openedAt = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(openedAt + COOLDOWN_MS + 1);

    expect(breaker.getState()).toBe('HALF_OPEN');

    // Probe fails
    await expect(breaker.execute(alwaysFail)).rejects.toThrow('service down');
    expect(breaker.getState()).toBe('OPEN');
  });

  // ── reset() ───────────────────────────────────────────────────────────────

  it('reset() returns to CLOSED state', async () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await expect(breaker.execute(alwaysFail)).rejects.toThrow();
    }
    expect(breaker.getState()).toBe('OPEN');

    breaker.reset();

    expect(breaker.getState()).toBe('CLOSED');
    const result = await breaker.execute(alwaysSucceed);
    expect(result).toBe('ok');
  });
});
