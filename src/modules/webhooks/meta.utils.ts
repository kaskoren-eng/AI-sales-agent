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

  return {
    tenant_id: tenantId,
    name: fields.full_name || fields.name || undefined,
    email: fields.email || undefined,
    phone: fields.phone_number || fields.phone || undefined,
    source: 'meta_lead_ads',
    metadata: {
      leadgen_id: value.leadgen_id,
      form_id: value.form_id,
      page_id: entry?.id,
      raw_field_data: fieldData,
    },
  };
}
