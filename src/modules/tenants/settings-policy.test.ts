import { describe, it, expect } from 'vitest';
import {
  redactSettings,
  isSecretKey,
  isTenantWritable,
  describeRefusal,
  safeTenant,
  REDACTED,
  TENANT_WRITABLE_NAMESPACES,
  OPERATOR_ONLY_NAMESPACES,
} from './settings-policy.js';
import { updateSelfSchema } from './tenant.schemas.js';

/**
 * `tenants.settings` mixes tenant preferences, operator controls and encrypted credentials in one
 * jsonb column. Before this policy existed, `PATCH /tenants/me` took `z.record(z.string(), z.any())`
 * and wrote it through, and `GET /tenants/me` returned the column whole.
 *
 * Two consequences, both silent:
 *   - a tenant could raise its own `toll_fraud` daily spend cap — the only brake on a runaway
 *     dialer billing our Cartesia / OpenAI / LiveKit accounts
 *   - every caller holding the tenant's key, down to a `viewer`, could read the encrypted Zadarma
 *     secret, Monday token and Airtable key
 *
 * These are the kind of rules that rot: someone adds a namespace, doesn't think about this file,
 * and the leak arrives by omission. Hence the two "nobody forgot" tests at the bottom.
 */

describe('write allowlist — closed by default', () => {
  it('permits the tenant-owned sections', () => {
    for (const ns of TENANT_WRITABLE_NAMESPACES) {
      expect(isTenantWritable(ns)).toBe(true);
    }
  });

  it('refuses the spend cap — the one that costs money', () => {
    // The motivating case. toll_fraud caps daily calls and dollars; a tenant that can edit it can
    // uncap its own spend on our vendor accounts.
    expect(isTenantWritable('toll_fraud')).toBe(false);
  });

  it('refuses every operator-controlled section', () => {
    for (const ns of Object.keys(OPERATOR_ONLY_NAMESPACES)) {
      expect(isTenantWritable(ns)).toBe(false);
    }
  });

  it('refuses a section nobody has classified', () => {
    // The whole point of default-deny: forgetting to classify a new namespace must break saving,
    // not silently open a hole.
    expect(isTenantWritable('some_new_thing_added_next_month')).toBe(false);
    expect(isTenantWritable('')).toBe(false);
    expect(isTenantWritable('__proto__')).toBe(false);
  });

  it('explains refusals in terms an operator can act on', () => {
    expect(describeRefusal('toll_fraud')).toMatch(/managed by ClickScales/);
    expect(describeRefusal('monday')).toMatch(/integrations API/);
    expect(describeRefusal('nonsense')).toMatch(/not a settings section/);
  });
});

describe('redaction — pattern-based, so it cannot leak by omission', () => {
  it('redacts all three spellings the codebase actually uses', () => {
    // zadarma spells it apiKeyEncrypted, monday encryptedApiToken, airtable encryptedApiKey.
    // A list-based rule would have to know all three; matching "encrypted" anywhere does not.
    const out = redactSettings({
      zadarma: { apiKeyEncrypted: 'ct1', apiSecretEncrypted: 'ct2', phoneNumber: '+972500000000' },
      monday: { encryptedApiToken: 'ct3', boardId: '123' },
      airtable: { encryptedApiKey: 'ct4', baseId: 'app1' },
    }) as Record<string, Record<string, unknown>>;

    expect(out.zadarma.apiKeyEncrypted).toBe(REDACTED);
    expect(out.zadarma.apiSecretEncrypted).toBe(REDACTED);
    expect(out.monday.encryptedApiToken).toBe(REDACTED);
    expect(out.airtable.encryptedApiKey).toBe(REDACTED);
  });

  it('keeps the non-secret fields beside them', () => {
    // Redaction has to leave enough for a UI to render "Monday · connected · board 123".
    const out = redactSettings({
      zadarma: { apiKeyEncrypted: 'ct', phoneNumber: '+972500000000', configuredAt: '2026-01-01' },
      monday: { encryptedApiToken: 'ct', boardId: '123' },
    }) as Record<string, Record<string, unknown>>;

    expect(out.zadarma.phoneNumber).toBe('+972500000000');
    expect(out.zadarma.configuredAt).toBe('2026-01-01');
    expect(out.monday.boardId).toBe('123');
  });

  it('keeps the key so "configured" stays distinguishable from "not configured"', () => {
    // Deleting the key instead would force every client to guess, and the obvious guess —
    // treating absent as not-configured — would show a connected integration as disconnected.
    const out = redactSettings({ monday: { encryptedApiToken: 'ct' } }) as Record<string, object>;
    expect('encryptedApiToken' in out.monday).toBe(true);
  });

  it('redacts at any depth, including inside arrays', () => {
    const out = redactSettings({
      integrations: { googleSheets: { nested: { deep: { apiSecret: 'ct' } } } },
      accounts: [{ token: 'a' }, { token: 'b' }],
    }) as Record<string, any>;

    expect(out.integrations.googleSheets.nested.deep.apiSecret).toBe(REDACTED);
    expect(out.accounts[0].token).toBe(REDACTED);
    expect(out.accounts[1].token).toBe(REDACTED);
  });

  it('redacts a whole subtree when the CONTAINER key is itself a credential', () => {
    // `credentials: {...}` names a bag of secrets, so the bag goes, not just its leaves. This is
    // why the array test above uses `accounts` — naming the container `credentials` redacts it
    // before the walk ever reaches the items.
    const out = redactSettings({ credentials: { a: 1, b: 2 } }) as Record<string, unknown>;
    expect(out.credentials).toBe(REDACTED);
  });

  it('leaves ordinary configuration untouched', () => {
    const settings = {
      businessProfile: { companyName: 'ClickScales', language: 'hebrew' },
      toll_fraud: { dailyCallLimit: 100, dailyCostCapUsd: 50 },
      flows: { 'lead-intake': { steps: [{ type: 'send_message', delayMinutes: 0 }] } },
      voice_engine: 'livekit',
    };
    expect(redactSettings(settings)).toEqual(settings);
  });

  it('survives the shapes a jsonb column can actually hold', () => {
    expect(redactSettings(null)).toBeNull();
    expect(redactSettings(undefined)).toBeUndefined();
    expect(redactSettings({})).toEqual({});
    expect(redactSettings([])).toEqual([]);
    expect(redactSettings('a string')).toBe('a string');
    expect(redactSettings(42)).toBe(42);
  });

  it('does not mutate its input', () => {
    // The caller usually holds a live row. Redacting in place would strip the credentials the
    // service is about to decrypt and use.
    const original = { monday: { encryptedApiToken: 'ct' } };
    redactSettings(original);
    expect(original.monday.encryptedApiToken).toBe('ct');
  });

  it('matches whole words across camelCase and snake_case, not substrings', () => {
    // "token" must catch apiToken and refresh_token without swallowing tokenizerModel.
    // Over-redacting configuration is a bug too — just a quieter one, since the symptom is a
    // settings page showing [redacted] where a model name should be.
    expect(isSecretKey('apiToken')).toBe(true);
    expect(isSecretKey('refresh_token')).toBe(true);
    expect(isSecretKey('tokenizerModel')).toBe(false);

    // "key" alone is far too common to redact; only the compounds are credentials.
    expect(isSecretKey('apiKey')).toBe(true);
    expect(isSecretKey('api_key')).toBe(true);
    expect(isSecretKey('privateKey')).toBe(true);
    expect(isSecretKey('statusKey')).toBe(false);
    expect(isSecretKey('columnMap')).toBe(false);
    expect(isSecretKey('boardId')).toBe(false);
    expect(isSecretKey('phoneNumber')).toBe(false);
  });
});

describe('safeTenant — the single exit for a tenant row', () => {
  const row = {
    id: 't1',
    name: 'ClickScales',
    slug: 'clickscales',
    apiKeyHash: 'sha256-of-the-key',
    settings: { monday: { encryptedApiToken: 'ct', boardId: '9' }, voice_engine: 'livekit' },
  };

  it('drops the key hash and reports only whether one exists', () => {
    const out = safeTenant(row) as Record<string, unknown>;
    expect(out.apiKeyHash).toBeUndefined();
    expect(out.hasApiKey).toBe(true);
  });

  it('redacts credentials inside settings', () => {
    const out = safeTenant(row) as { settings: { monday: Record<string, unknown> } };
    expect(out.settings.monday.encryptedApiToken).toBe(REDACTED);
    expect(out.settings.monday.boardId).toBe('9');
  });

  it('handles a row selected without settings', () => {
    // rotateApiKey() returns {id, name} only. Adding `settings: undefined` to that response would
    // make the field look present-and-empty to a client.
    const out = safeTenant({ id: 't1', name: 'X', apiKeyHash: null }) as Record<string, unknown>;
    expect('settings' in out).toBe(false);
    expect(out.hasApiKey).toBe(false);
  });
});

describe('PATCH /tenants/me no longer accepts a settings blob', () => {
  it('accepts a rename', () => {
    expect(updateSelfSchema.safeParse({ name: 'New Name' }).success).toBe(true);
  });

  it('REJECTS settings outright rather than ignoring them', () => {
    // Stripping unknown keys silently would be worse than refusing: the save appears to succeed
    // and the tenant believes their spend cap changed.
    const result = updateSelfSchema.safeParse({
      name: 'New Name',
      settings: { toll_fraud: { dailyCallLimit: 100_000 } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects the fields a tenant must never set on itself', () => {
    expect(updateSelfSchema.safeParse({ isActive: true }).success).toBe(false);
    expect(updateSelfSchema.safeParse({ slug: 'someone-else' }).success).toBe(false);
  });
});

describe('the two lists cannot silently drift apart', () => {
  it('no namespace is both writable and operator-only', () => {
    const overlap = TENANT_WRITABLE_NAMESPACES.filter((n) => n in OPERATOR_ONLY_NAMESPACES);
    expect(overlap).toEqual([]);
  });

  it('every credential-bearing namespace is refused for writes', () => {
    // Redaction stops credentials being READ. This asserts the other half: that the sections
    // holding them cannot be WRITTEN through the generic path either, which would let a tenant
    // overwrite a working integration or plant a value of its choosing.
    for (const ns of ['zadarma', 'monday', 'airtable', 'integrations']) {
      expect(isTenantWritable(ns)).toBe(false);
    }
  });
});
