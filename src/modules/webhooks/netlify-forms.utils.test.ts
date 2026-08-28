import { describe, it, expect } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import { verifyNetlifyJws, normalizeNetlifyFormSubmission } from './netlify-forms.utils.js';

const SECRET = 'netlify-shared-secret';

/** Build the JWS Netlify sends in `x-webhook-signature` for a given body. */
function sign(rawBody: string, secret = SECRET, overrides: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sha256: createHash('sha256').update(rawBody, 'utf8').digest('hex'),
      ...overrides,
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

const BODY = JSON.stringify({
  id: 'sub_123',
  form_name: 'demo-en',
  data: { name: 'Dana Levi', email: 'dana@example.com', phone: '+972501234567' },
});

describe('verifyNetlifyJws', () => {
  it('accepts a correctly signed payload', () => {
    expect(verifyNetlifyJws(BODY, sign(BODY), SECRET)).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyNetlifyJws(BODY, sign(BODY, 'wrong-secret'), SECRET)).toBe(false);
  });

  it('rejects a replayed token against a DIFFERENT body', () => {
    // The whole point of the sha256 claim. Without it, one captured token would let anyone post
    // arbitrary leads — the signature alone only proves the token was minted with the secret.
    const token = sign(BODY);
    const tampered = JSON.stringify({
      id: 'sub_123',
      form_name: 'demo-en',
      data: { name: 'Attacker', email: 'evil@example.com', phone: '+10000000000' },
    });
    expect(verifyNetlifyJws(tampered, token, SECRET)).toBe(false);
  });

  it('rejects a token with no sha256 claim rather than skipping the body check', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: 'netlify' })).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
    expect(verifyNetlifyJws(BODY, `${header}.${payload}.${sig}`, SECRET)).toBe(false);
  });

  it('rejects malformed tokens without throwing', () => {
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', 'a.!!!.c']) {
      expect(() => verifyNetlifyJws(BODY, bad, SECRET)).not.toThrow();
      expect(verifyNetlifyJws(BODY, bad, SECRET)).toBe(false);
    }
  });
});

describe('normalizeNetlifyFormSubmission', () => {
  it('reads the answers out of `data`', () => {
    const out = normalizeNetlifyFormSubmission(JSON.parse(BODY));
    expect(out.name).toBe('Dana Levi');
    expect(out.email).toBe('dana@example.com');
    expect(out.phone).toBe('+972501234567');
    expect(out.source).toBe('clickscales.com');
  });

  it('falls back to top-level fields when Netlify lifts them', () => {
    const out = normalizeNetlifyFormSubmission({
      id: 'sub_9',
      form_name: 'demo-en',
      name: 'Top Level',
      email: 'top@example.com',
    });
    expect(out.name).toBe('Top Level');
    expect(out.email).toBe('top@example.com');
  });

  it('derives locale from the form name — demo-he is the Hebrew page', () => {
    expect(normalizeNetlifyFormSubmission({ form_name: 'demo-he', data: {} }).metadata.locale).toBe('he');
    expect(normalizeNetlifyFormSubmission({ form_name: 'demo-en', data: {} }).metadata.locale).toBe('en');
  });

  it('keeps the whole submission so new form fields need no code change', () => {
    // utm_* hidden inputs and a consent checkbox are both planned for the form; lead-board.ts
    // already reads utm_source/utm_campaign/utm_content out of leads.metadata.
    const out = normalizeNetlifyFormSubmission({
      form_name: 'demo-en',
      data: { email: 'a@b.com', utm_source: 'google', utm_campaign: 'launch-he' },
    });
    expect((out.metadata as any).netlify.utm_source).toBe('google');
    expect((out.metadata as any).netlify.utm_campaign).toBe('launch-he');
  });

  it('trims blanks to undefined so empty inputs never become empty-string leads', () => {
    const out = normalizeNetlifyFormSubmission({ form_name: 'demo-en', data: { name: '   ', phone: '' } });
    expect(out.name).toBeUndefined();
    expect(out.phone).toBeUndefined();
  });

  it('leaves consent undefined unless the form actually sent one', () => {
    expect(normalizeNetlifyFormSubmission({ data: {} }).whatsapp_consent).toBeUndefined();
    expect(normalizeNetlifyFormSubmission({ data: { consent: 'on' } }).whatsapp_consent).toBe(true);
  });

  it('survives a payload with no data object at all', () => {
    expect(() => normalizeNetlifyFormSubmission({})).not.toThrow();
    expect(normalizeNetlifyFormSubmission({}).email).toBeUndefined();
  });
});
