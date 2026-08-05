import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildWebhookToken, verifyWebhookToken } from './webhook-tokens.js';

/**
 * THE VULNERABILITY THIS CLOSES.
 *
 * The Monday webhook took `boardId` from the request BODY and scanned every tenant for a match, so
 * the caller chose which tenant to act on. Signature verification was conditional on
 * `MONDAY_WEBHOOK_SECRET`, which was NOT set in production. Net effect: an unauthenticated POST
 * with a guessed board id and item id could change lead statuses inside a live customer account.
 *
 * The tenant now comes from a signed URL, verified here.
 */

const SECRET = 'a'.repeat(32);
const TENANT = '613d826c-ad00-4302-9817-1c0649ed4f98';

describe('signed webhook URLs', () => {
  it('round-trips the tenant id', () => {
    const token = buildWebhookToken(SECRET, 'monday', TENANT);
    expect(verifyWebhookToken(SECRET, 'monday', token)).toBe(TENANT);
  });

  it('rejects a tampered tenant id — the actual attack', () => {
    // Swap in someone else's tenant id and keep the signature: this is what "the caller picks the
    // tenant" looked like, and it must now fail.
    const token = buildWebhookToken(SECRET, 'monday', TENANT);
    const sig = token.slice(token.lastIndexOf('.') + 1);
    const forged = `00000000-0000-0000-0000-000000000000.${sig}`;
    expect(verifyWebhookToken(SECRET, 'monday', forged)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const token = buildWebhookToken(SECRET, 'monday', TENANT);
    const flipped = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    expect(verifyWebhookToken(SECRET, 'monday', flipped)).toBeNull();
  });

  it('rejects a token signed with a different key', () => {
    const token = buildWebhookToken('b'.repeat(32), 'monday', TENANT);
    expect(verifyWebhookToken(SECRET, 'monday', token)).toBeNull();
  });

  it('is domain-separated per provider', () => {
    // Without separation, a URL issued for one integration would authenticate another. The signing
    // key is shared with other uses, so this is the property that keeps them apart.
    const token = buildWebhookToken(SECRET, 'monday', TENANT);
    expect(verifyWebhookToken(SECRET, 'airtable', token)).toBeNull();
  });

  it('gives different tenants different signatures', () => {
    const a = buildWebhookToken(SECRET, 'monday', TENANT);
    const b = buildWebhookToken(SECRET, 'monday', '00000000-0000-0000-0000-000000000000');
    expect(a.split('.')[1]).not.toBe(b.split('.')[1]);
  });

  it('returns null rather than throwing on malformed input', () => {
    // These reach the route from the open internet. timingSafeEqual throws on a length mismatch,
    // so an unguarded comparison here would turn a probe into a 500.
    for (const bad of ['', 'no-dot', '.', '.abc', 'abc.', 'abc.short', undefined]) {
      expect(verifyWebhookToken(SECRET, 'monday', bad)).toBeNull();
    }
  });

  it('accepts only a full-length signature', () => {
    const token = buildWebhookToken(SECRET, 'monday', TENANT);
    const [id, sig] = token.split('.');
    // A truncated signature must not verify against a prefix comparison.
    expect(verifyWebhookToken(SECRET, 'monday', `${id}.${sig.slice(0, 16)}`)).toBeNull();
    expect(verifyWebhookToken(SECRET, 'monday', `${id}.${sig}ff`)).toBeNull();
  });

  it('matches the derivation in scripts/webhook-url.mjs', () => {
    // The script prints the URL an operator pastes into Monday, and it re-implements the
    // derivation rather than importing TypeScript. If the two drift, the printed URL 404s and the
    // integration dies silently. This pins them together.
    const expected = createHmac('sha256', SECRET)
      .update(`webhook-url:v1:monday:${TENANT}`)
      .digest('hex')
      .slice(0, 32);
    expect(buildWebhookToken(SECRET, 'monday', TENANT)).toBe(`${TENANT}.${expected}`);
  });
});
