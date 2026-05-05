import { describe, it, expect, vi, afterEach } from 'vitest';
import { isTimestampFresh } from './webhook-timestamp.js';

const NOW_MS = 1_700_000_000_000; // fixed point in time
const NOW_S = Math.floor(NOW_MS / 1000);

describe('isTimestampFresh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function freezeTime() {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  }

  // ── Within 5-minute window ────────────────────────────────────────────────

  it('returns true for timestamp exactly at now (Unix seconds)', () => {
    freezeTime();
    expect(isTimestampFresh(NOW_S)).toBe(true);
  });

  it('returns true for timestamp 1 second ago (Unix seconds)', () => {
    freezeTime();
    expect(isTimestampFresh(NOW_S - 1)).toBe(true);
  });

  it('returns true for timestamp 4 min 59 s ago (Unix seconds)', () => {
    freezeTime();
    expect(isTimestampFresh(NOW_S - 4 * 60 - 59)).toBe(true);
  });

  it('returns true for ISO string timestamp at now', () => {
    freezeTime();
    expect(isTimestampFresh(new Date(NOW_MS).toISOString())).toBe(true);
  });

  it('returns true for timestamp as numeric string (Unix seconds)', () => {
    freezeTime();
    expect(isTimestampFresh(String(NOW_S))).toBe(true);
  });

  it('returns true for timestamp in the future within 5 min', () => {
    freezeTime();
    expect(isTimestampFresh(NOW_S + 60)).toBe(true);
  });

  // ── Older than 5 minutes ─────────────────────────────────────────────────

  it('returns false for timestamp exactly 5 min + 1 s ago (Unix seconds)', () => {
    freezeTime();
    expect(isTimestampFresh(NOW_S - 5 * 60 - 1)).toBe(false);
  });

  it('returns false for timestamp 10 minutes ago', () => {
    freezeTime();
    expect(isTimestampFresh(NOW_S - 10 * 60)).toBe(false);
  });

  it('returns false for ISO string 1 hour ago', () => {
    freezeTime();
    const hourAgoIso = new Date(NOW_MS - 60 * 60 * 1000).toISOString();
    expect(isTimestampFresh(hourAgoIso)).toBe(false);
  });

  it('returns false for timestamp more than 5 min in the future', () => {
    freezeTime();
    expect(isTimestampFresh(NOW_S + 5 * 60 + 1)).toBe(false);
  });

  // ── Missing / undefined / invalid ────────────────────────────────────────

  it('returns false for undefined', () => {
    expect(isTimestampFresh(undefined)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isTimestampFresh(null)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isTimestampFresh('')).toBe(false);
  });

  it('returns false for non-numeric string', () => {
    expect(isTimestampFresh('not-a-timestamp')).toBe(false);
  });

  it('returns false for zero', () => {
    expect(isTimestampFresh(0)).toBe(false);
  });

  it('returns false for negative number', () => {
    expect(isTimestampFresh(-1)).toBe(false);
  });

  // ── Custom window ─────────────────────────────────────────────────────────

  it('accepts custom window — 1-second window accepts timestamp at now', () => {
    freezeTime();
    expect(isTimestampFresh(NOW_S, 1000)).toBe(true);
  });

  it('accepts custom window — 1-second window rejects timestamp 2 s ago', () => {
    freezeTime();
    expect(isTimestampFresh(NOW_S - 2, 1000)).toBe(false);
  });
});
