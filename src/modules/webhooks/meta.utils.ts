import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify Meta's x-hub-signature-256 HMAC signature.
 * Meta signs webhook payloads with the app secret.
 */
export function verifyMetaSignature(rawBody: string, signature: string, appSecret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Normalize a Meta Lead Ads webhook payload into our standard lead format.
 *
 * Meta sends:
 * {
 *   "entry": [{
 *     "changes": [{
 *       "value": {
 *         "leadgen_id": "...",
 *         "field_data": [
 *           { "name": "full_name", "values": ["John Doe"] },
 *           { "name": "email", "values": ["john@example.com"] },
 *           { "name": "phone_number", "values": ["+1234567890"] }
 *         ]
 *       }
 *     }]
 *   }]
 * }
 */
export function normalizeMetaLeadPayload(body: Record<string, any>, tenantId: string) {
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value ?? {};
  const fieldData: Array<{ name: string; values: string[] }> = value.field_data ?? [];

  const fields: Record<string, string> = {};
  for (const f of fieldData) {
    fields[f.name] = f.values?.[0] ?? '';
  }

  // Everything Meta sent, minus the answers (kept separately as raw_field_data so the shape
  // stays stable). This used to cherry-pick four keys and drop `ad_id` / `adgroup_id` with them,
  // which is the ad attribution — the reason anyone looks at a lead-ads lead at all.
  //
  // Spreading rather than listing means a key Meta adds later, or one a Graph API enrichment
  // writes in, lands with no code change: leads.metadata is jsonb, and nothing downstream reads
  // it positionally.
  //
  // Note what is NOT here: `ad_name`, `adset_name`, `campaign_name`. The leadgen webhook carries
  // ids only; the names need GET /{leadgen_id}?fields=... with a page access token. Until that
  // exists the name columns on the Airtable board stay blank, and the ids are what we have.
  const { field_data: _fieldData, ...attribution } = value as Record<string, unknown>;

  return {
    tenant_id: tenantId,
    name: fields.full_name || fields.name || undefined,
    email: fields.email || undefined,
    phone: fields.phone_number || fields.phone || undefined,
    source: 'meta_lead_ads',
    metadata: {
      ...attribution,
      leadgen_id: value.leadgen_id,
      form_id: value.form_id,
      // entry.id is the page the form lives on. Meta also sends page_id inside `value` on some
      // form versions; the explicit assignment after the spread keeps entry.id authoritative.
      page_id: entry?.id ?? value.page_id,
      raw_field_data: fieldData,
    },
  };
}
