import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyRetellSignature } from './voice.routes.js';

const KEY = 'key_test_abc123';
const BODY = JSON.stringify({ event: 'call_analyzed', call: { call_id: 'שיחה_123', x: 'ünïcode' } });

/** Reproduces Retell's official signing (webhook_auth.ts): HMAC(apiKey, body + timestamp). */
function sign(body: string, secret: string, ts: number): string {
  const digest = createHmac('sha256', secret).update(body + ts, 'utf8').digest('hex');
  return `v=${ts},d=${digest}`;
}

describe('verifyRetellSignature', () => {
  it('accepts a valid signature', () => {
    expect(verifyRetellSignature(BODY, sign(BODY, KEY, Date.now()), KEY)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = sign(BODY, KEY, Date.now());
    expect(verifyRetellSignature(BODY + 'x', sig, KEY)).toBe(false);
  });

  it('rejects a wrong key', () => {
    const sig = sign(BODY, KEY, Date.now());
    expect(verifyRetellSignature(BODY, sig, 'wrong-key')).toBe(false);
  });

  it('rejects a timestamp older than 5 minutes (replay protection)', () => {
    const stale = sign(BODY, KEY, Date.now() - 6 * 60 * 1000);
    expect(verifyRetellSignature(BODY, stale, KEY)).toBe(false);
  });

  it('rejects a malformed signature header', () => {
    expect(verifyRetellSignature(BODY, 'garbage', KEY)).toBe(false);
    expect(verifyRetellSignature(BODY, '', KEY)).toBe(false);
  });

  it('rejects the legacy wrong-order hash (timestamp + body) that caused the bypass', () => {
    const ts = Date.now();
    const wrongOrder = createHmac('sha256', KEY).update(ts + BODY, 'utf8').digest('hex');
    expect(verifyRetellSignature(BODY, `v=${ts},d=${wrongOrder}`, KEY)).toBe(false);
  });
});
