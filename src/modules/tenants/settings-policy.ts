/**
 * What a tenant may write into, and what it may read back out of, `tenants.settings`.
 *
 * `tenants.settings` is one jsonb column carrying three very different kinds of thing:
 *
 *   1. tenant preferences  — business profile, flows, reminders, CRM field maps
 *   2. operator controls   — spend caps, which voice engine runs, which agent tools are enabled
 *   3. encrypted secrets   — Zadarma API secret, Monday API token, Airtable API key
 *
 * `PATCH /tenants/me` accepted `settings: z.record(z.string(), z.any())` and wrote it straight
 * through, which meant a tenant could raise its own `toll_fraud` daily spend cap — the only brake
 * on a runaway dialer billing our Cartesia, OpenAI and LiveKit accounts — and `GET /tenants/me`
 * returned every ciphertext in the column to any caller holding the key, including a `viewer`.
 *
 * Both directions are default-closed, and deliberately so:
 *
 *   WRITE — an explicit allowlist. A namespace nobody has classified yet is rejected, so the
 *           failure mode of forgetting to update this file is "a feature does not save", which
 *           someone notices immediately, rather than "a tenant can edit its own spend cap", which
 *           nobody notices until the bill arrives.
 *
 *   READ  — a pattern, not a list. Any key that looks like a credential is redacted at any depth.
 *           An allowlist here would leak by omission the first time somebody adds a namespace with
 *           a token in it and doesn't think about this file.
 */

/**
 * Namespaces a tenant may write through the self-service API.
 *
 * Note that most of these ALSO have a dedicated typed route (`PUT /settings/business-profile`,
 * `PUT /tenants/me/flows`) which validates the payload properly. Those routes are the good path;
 * this allowlist governs the generic escape hatch, which validates shape but not meaning.
 */
export const TENANT_WRITABLE_NAMESPACES = [
  'businessProfile', // company description fed to the agent prompt
  'flows', // automation flow definitions (PUT /me/flows validates these against a schema)
  'whatsapp_templates', // the tenant's own Meta-approved template SIDs
  'crm_sync', // outcome→status maps for their own CRM
  'reminders', // meeting reminder offsets and quiet hours
  'operating_hours', // when the agent may dial
  'ui_locale', // dashboard interface language — NEVER the agent's spoken language
] as const;

/**
 * Namespaces only the operator console may write. Listed explicitly — rather than left to fall
 * through the default deny — so that rejecting them can say *why*, and so this file doubles as the
 * documentation of which knobs are ours.
 */
export const OPERATOR_ONLY_NAMESPACES: Record<string, string> = {
  toll_fraud: 'daily call and spend caps',
  voice_engine: 'which voice engine serves this tenant',
  functions_enabled: 'which agent tools are permitted',
  agent_persona: 'agent name, gender and TTS voice',
  billing_provider: 'billing configuration',
  zadarma: 'telephony credentials (use PUT /settings/zadarma)',
  monday: 'CRM credentials (use the integrations API)',
  airtable: 'CRM credentials (use the integrations API)',
  integrations: 'integration credentials (use the integrations API)',
};

export type WritableNamespace = (typeof TENANT_WRITABLE_NAMESPACES)[number];

export function isTenantWritable(namespace: string): namespace is WritableNamespace {
  return (TENANT_WRITABLE_NAMESPACES as readonly string[]).includes(namespace);
}

/** Human-readable reason a namespace was refused, for the 403 body. */
export function describeRefusal(namespace: string): string {
  const known = OPERATOR_ONLY_NAMESPACES[namespace];
  return known
    ? `"${namespace}" (${known}) is managed by ClickScales and cannot be changed here`
    : `"${namespace}" is not a settings section you can edit`;
}

/**
 * Keys whose VALUE is credential material.
 *
 * Matched on WORDS rather than substrings. The codebase spells the same idea three different ways
 * — `apiKeyEncrypted` (zadarma), `encryptedApiToken` (monday), `encryptedApiKey` (airtable) — so a
 * position-dependent rule would miss one, but a naive substring rule over-matches in the other
 * direction: `tokenizerModel` is a model name, not a token, and redacting configuration people
 * need to see is its own (quieter) bug.
 *
 * So: split camelCase and snake_case into words, then look for a secret word. `apiToken` and
 * `refresh_token` both contain the word "token"; `tokenizerModel` contains "tokenizer".
 */
const SECRET_WORDS = new Set([
  'encrypted',
  'secret',
  'secrets',
  'password',
  'passwd',
  'credential',
  'credentials',
  'token',
  'tokens',
  'apikey',
  'privatekey',
]);

/** Words that are only credentials in combination — "key" alone is far too common to redact. */
const SECRET_COMPOUNDS = /apikey|privatekey|accesskey|secretkey|authkey/;

function toWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export const REDACTED = '[redacted]';

export function isSecretKey(key: string): boolean {
  const words = toWords(key);
  if (words.some((w) => SECRET_WORDS.has(w))) return true;
  // `apiKey`, `api_key` and `apikey` all collapse to the same compound here.
  return SECRET_COMPOUNDS.test(words.join(''));
}

/**
 * Recursively replace credential values with a marker, preserving structure.
 *
 * The KEY survives, only the value is replaced — so a client can still tell that Monday is
 * configured, and render "connected · disconnect", without ever receiving the ciphertext. Removing
 * the key entirely would make "configured" indistinguishable from "not configured" and force the
 * UI to guess.
 *
 * Ciphertext is not plaintext, but it is not public either: it is offline-attackable, it confirms
 * exactly which integrations a tenant runs, and every tenant's secrets are sealed with the same
 * process-wide ENCRYPTION_KEY — so one leaked key plus one leaked blob is a full compromise.
 * There is no reason for it to cross the API boundary at all.
 */
export function redactSettings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSettings);
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretKey(key) ? REDACTED : redactSettings(v);
  }
  return out;
}

/**
 * The ONE way a tenant row leaves the API: no key hash, no credentials.
 *
 * Deliberately single-sourced. There were two `safeTenant` helpers — one in the tenant routes and
 * one in the admin routes — and when redaction was added to the first, the operator console kept
 * returning the settings document whole. Two copies of a security boundary means the second one is
 * eventually the hole.
 */
export function safeTenant<T extends { apiKeyHash?: string | null; settings?: unknown }>(t: T) {
  const { apiKeyHash, ...rest } = t;
  return {
    ...rest,
    ...('settings' in t ? { settings: redactSettings(t.settings) } : {}),
    hasApiKey: !!apiKeyHash,
  };
}
