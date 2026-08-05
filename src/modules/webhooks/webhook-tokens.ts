import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed per-tenant webhook URLs.
 *
 * The problem this solves: an inbound webhook from a third party arrives with no credential of
 * ours attached, so the handler has to work out which tenant it belongs to. The Monday handler did
 * that by reading `boardId` out of the request BODY and scanning every tenant for a match — which
 * means the caller chose the tenant. With `MONDAY_WEBHOOK_SECRET` unset (as it was in production)
 * nothing else was checked either, so an unauthenticated POST could change lead statuses in any
 * tenant whose board id could be guessed.
 *
 * The fix is to put the tenant in the URL and sign it, so the URL itself is the credential:
 *
 *     /webhooks/leads/monday/<tenantId>.<signature>
 *
 * The signature is an HMAC of the tenant id, so verification is a constant-time comparison with no
 * database lookup and nothing to store — no migration, no token table, no rotation job. A tenant
 * cannot forge another tenant's URL without the server key, and the URL is unguessable.
 *
 * This is authentication of the ROUTE, not of the message. Where the vendor also signs the body
 * (Monday does, when a signing secret is configured) that check stays, and both must pass.
 */

/**
 * Domain separation. The signing key is shared with other uses, so every purpose gets its own
 * prefix — without it, a signature minted for one context would verify in another.
 */
const DOMAIN = 'webhook-url:v1';

/** 32 hex chars = 128 bits. Ample against forgery, short enough to paste into a vendor's UI. */
const SIG_LENGTH = 32;

function sign(secret: string, provider: string, tenantId: string): string {
  return createHmac('sha256', secret)
    .update(`${DOMAIN}:${provider}:${tenantId}`)
    .digest('hex')
    .slice(0, SIG_LENGTH);
}

/** The path segment to hand to the vendor: `<tenantId>.<signature>`. */
export function buildWebhookToken(secret: string, provider: string, tenantId: string): string {
  return `${tenantId}.${sign(secret, provider, tenantId)}`;
}

/**
 * Recover the tenant id from a token, or null if the signature does not verify.
 *
 * Null for every failure mode — malformed, unknown, tampered. The caller responds 404 to all of
 * them, so a probe cannot learn whether a tenant id exists by varying the signature.
 */
export function verifyWebhookToken(
  secret: string,
  provider: string,
  token: string | undefined,
): string | null {
  if (!token) return null;

  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const tenantId = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  if (provided.length !== SIG_LENGTH) return null;

  const expected = sign(secret, provider, tenantId);

  // Both are fixed-length hex by construction, so the lengths match and timingSafeEqual cannot
  // throw here — but it throws on a length mismatch, so the guard above is load-bearing.
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return null;

  return timingSafeEqual(a, b) ? tenantId : null;
}
