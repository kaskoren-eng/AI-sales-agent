import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyMetaSignature, normalizeMetaLeadPayload } from './meta.utils.js';

describe('verifyMetaSignature', () => {
  const appSecret = 'test-secret-123';

  function sign(body: string): string {
    return 'sha256=' + createHmac('sha256', appSecret).update(body).digest('hex');
  }

  it('returns true for valid signature', () => {
    const body = '{"test":"data"}';
    expect(verifyMetaSignature(body, sign(body), appSecret)).toBe(true);
  });

  it('returns false for tampered body', () => {
    const body = '{"test":"data"}';
    const sig = sign(body);
    expect(verifyMetaSignature('{"test":"tampered"}', sig, appSecret)).toBe(false);
  });

  it('returns false for wrong secret', () => {
    const body = '{"test":"data"}';
    const sig = sign(body);
    expect(verifyMetaSignature(body, sig, 'wrong-secret')).toBe(false);
  });

  it('returns false for malformed signature', () => {
    expect(verifyMetaSignature('body', 'sha256=abc', appSecret)).toBe(false);
  });
});

describe('normalizeMetaLeadPayload', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';

  it('extracts fields from Meta Lead Ads payload', () => {
    const payload = {
      entry: [{
        id: 'page-123',
        changes: [{
          value: {
            leadgen_id: 'lead-456',
            form_id: 'form-789',
            field_data: [
              { name: 'full_name', values: ['John Doe'] },
              { name: 'email', values: ['john@example.com'] },
              { name: 'phone_number', values: ['+1234567890'] },
            ],
          },
        }],
      }],
    };

    const result = normalizeMetaLeadPayload(payload, tenantId);

    expect(result).toEqual({
      tenant_id: tenantId,
      name: 'John Doe',
      email: 'john@example.com',
      phone: '+1234567890',
      source: 'meta_lead_ads',
      metadata: {
        leadgen_id: 'lead-456',
        form_id: 'form-789',
        page_id: 'page-123',
        raw_field_data: payload.entry[0].changes[0].value.field_data,
      },
    });
  });

  it('handles missing fields gracefully', () => {
    const payload = {
      entry: [{
        changes: [{
          value: {
            field_data: [
              { name: 'email', values: ['test@test.com'] },
            ],
          },
        }],
      }],
    };

    const result = normalizeMetaLeadPayload(payload, tenantId);
    expect(result.email).toBe('test@test.com');
    expect(result.name).toBeUndefined();
    expect(result.phone).toBeUndefined();
  });

  it('handles empty payload', () => {
    const result = normalizeMetaLeadPayload({}, tenantId);
    expect(result.tenant_id).toBe(tenantId);
    expect(result.source).toBe('meta_lead_ads');
  });
});
