/**
 * Replay attack protection for webhooks.
 *
 * Simple explanation: every webhook should carry a timestamp of when it was sent.
 * If that timestamp is more than 5 minutes old (or in the future), we reject it —
 * because a legitimate provider sends webhooks immediately, not minutes later.
 * This stops attackers from recording a valid request and replaying it later.
 *
 * Usage:
 *   const ts = Number(request.headers['x-timestamp']);
 *   if (!isTimestampFresh(ts)) return reply.status(401).send({ error: 'Stale request' });
 */

const DEFAULT_WINDOW_MS = 300_000; // 5 minutes

export function isTimestampFresh(
  timestamp: number | string | null | undefined,
  windowMs: number = DEFAULT_WINDOW_MS,
): boolean {
  if (timestamp == null || timestamp === '') return false;

  let timestampSeconds: number;
  if (typeof timestamp === 'string') {
    const isoMs = Date.parse(timestamp);
    timestampSeconds = Number.isNaN(isoMs) ? Number(timestamp) : isoMs / 1000;
  } else {
    timestampSeconds = timestamp;
  }

  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
  return ageSeconds <= windowMs / 1000;
}
