/**
 * Circuit breaker pattern for external API calls.
 *
 * Simple explanation: when an external service (UChat, ElevenLabs, etc.) starts
 * failing, instead of every call waiting for the timeout before giving up, the
 * circuit "trips open" after N consecutive failures. All calls are instantly
 * rejected for a cooldown period, giving the service time to recover. After the
 * cooldown, one test call goes through (HALF_OPEN). If it succeeds, the circuit
 * closes again; if it fails, the cooldown restarts.
 *
 * States:
 *   CLOSED    — normal operation; failures increment the counter
 *   OPEN      — all calls rejected immediately; waits cooldownMs before testing
 *   HALF_OPEN — one test call allowed; success → CLOSED, failure → OPEN
 *
 * Usage:
 *   const breaker = new CircuitBreaker({ name: 'uchat' });
 *   const result = await breaker.execute(() => fetch(...));
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreakerOptions {
  /** Human-readable name used in error messages and logs */
  name: string;
  /** Consecutive failures before the circuit opens (default: 5) */
  failureThreshold?: number;
  /** How long (ms) to stay OPEN before allowing a test call (default: 30 000) */
  cooldownMs?: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private lastOpenedAt = 0;

  readonly name: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(opts: CircuitBreakerOptions) {
    this.name = opts.name;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
  }

  /** Resolve current state, transitioning OPEN → HALF_OPEN if cooldown elapsed */
  private currentState(): CircuitState {
    if (this.state === 'OPEN' && Date.now() - this.lastOpenedAt >= this.cooldownMs) {
      this.state = 'HALF_OPEN';
    }
    return this.state;
  }

  getState(): CircuitState {
    return this.currentState();
  }

  /**
   * Execute `fn` through the circuit breaker.
   * Throws `CircuitOpenError` immediately if the circuit is OPEN.
   * Propagates the original error on failure (and may trip the circuit).
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.currentState() === 'OPEN') {
      throw new CircuitOpenError(this.name);
    }

    try {
      const result = await fn();
      // Success: reset failure count and close the circuit
      this.consecutiveFailures = 0;
      this.state = 'CLOSED';
      return result;
    } catch (err) {
      this.consecutiveFailures += 1;
      this.lastOpenedAt = Date.now();

      // Trip open from HALF_OPEN immediately; from CLOSED after threshold
      if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.failureThreshold) {
        this.state = 'OPEN';
      }

      throw err;
    }
  }

  reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.lastOpenedAt = 0;
  }
}

export class CircuitOpenError extends Error {
  constructor(serviceName: string) {
    super(`Circuit breaker OPEN for "${serviceName}" — calls temporarily halted (cooldown in progress)`);
    this.name = 'CircuitOpenError';
  }
}
