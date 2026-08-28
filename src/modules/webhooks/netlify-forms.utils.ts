import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Bridge for the clickscales.com demo form.
 *
 * The form posts to Netlify Forms (that is what `data-netlify` + the fetch to `/` in
 * `website/assets/site.js` do), so submissions land in Netlify and never reach us. Netlify can
 * then fire an outgoing webhook on `submission_created` — that is what these helpers verify and
 * normalise.
 *
 * Why not the `website/netlify/functions/lead.js` forwarder that already exists: the published
 * site has ZERO functions deployed (`listSiteFiles` shows no function bundle), and the form does
 * not post to it anyway. Deploying it would mean re-uploading the whole site, and the live HTML
 * has drifted from git — it carries `/privacy` and `/terms` pages that were never committed. So
 * the bridge lives here instead, where it is covered by tests and deploys with the backend.
 */

/**
 * Verify Netlify's `x-webhook-signature` JWS.
 *
 * Netlify signs with HS256 over a compact JWT whose payload carries `sha256`, the hex digest of
 * the request body. So there are two checks and both matter: the signature proves the sender
 * holds the shared secret, and the digest binds that signature to THIS body — without it a
 * captured token could be replayed with any payload.
 */
export function verifyNetlifyJws(rawBody: string, token: string, secret: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  const expected = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');

  // Length-guard first: timingSafeEqual throws on a length mismatch rather than returning false.
  if (expected.length !== encodedSignature.length) return false;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(encodedSignature))) return false;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return false;
  }

  const claimed = payload.sha256;
  if (typeof claimed !== 'string' || claimed.length === 0) return false;

  const actual = createHash('sha256').update(rawBody, 'utf8').digest('hex');
  if (actual.length !== claimed.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(claimed));
}

/** Pull the first non-empty string among the given keys. */
function pick(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * Normalise a Netlify `submission_created` payload into the shape `genericLeadSchema` expects.
 *
 * Answers live under `data`, but Netlify also lifts the well-known ones to the top level, so both
 * are read — `data` first, since that is the form's own field naming.
 *
 * The whole submission is kept under `metadata.netlify` rather than cherry-picked: the form's
 * fields will change (a consent checkbox and UTM hidden inputs are both planned) and
 * `leads.metadata` is jsonb, so anything added to the form arrives here with no code change.
 */
export function normalizeNetlifyFormSubmission(body: Record<string, any>) {
  const data = (body?.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
  const merged = { ...body, ...data } as Record<string, unknown>;

  const formName = pick(merged, ['form_name', 'formName', 'form-name']);

  // The Hebrew form is `demo-he`, the English one `demo-en`. Worth carrying: it is the only
  // signal of which language the lead read the site in, and the agent greets in Hebrew by default.
  const locale = pick(merged, ['locale']) ?? (formName === 'demo-he' ? 'he' : 'en');

  return {
    name: pick(merged, ['name', 'full_name', 'fullname']),
    email: pick(merged, ['email']),
    phone: pick(merged, ['phone', 'phone_number', 'tel']),
    source: 'clickscales.com',
    // Netlify's own consent field, if the form ever grows one. Absent today, so website leads
    // arrive without consent — see the note in the integrations handoff.
    whatsapp_consent:
      merged.whatsapp_consent === true || merged.whatsapp_consent === 'true' || merged.consent === 'on'
        ? true
        : undefined,
    metadata: {
      locale,
      form_name: formName,
      netlify_submission_id: pick(merged, ['id']),
      // utm_* hidden inputs land here automatically once the form carries them, and
      // lead-board.ts already reads utm_source / utm_campaign / utm_content.
      ...(typeof body?.data === 'object' && body.data ? { netlify: body.data } : {}),
    },
  };
}
