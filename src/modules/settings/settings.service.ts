import { eq } from 'drizzle-orm';
import { tenants } from '../../db/schema/index.js';
import type { Database } from '../../db/client.js';
import { encrypt, decrypt } from '../../shared/crypto.js';
import { NotFoundError } from '../../shared/errors.js';
import {
  resolveWhatsappTemplates,
  type WhatsappTemplatesConfig,
} from '../channels/whatsapp/whatsapp-window.js';
import { resolveTollFraudSettings, type TollFraudSettings } from '../calls/spend-guard.js';
import { resolveCrmSyncSettings, type CrmSyncSettings } from '../integrations/crm-sync.settings.js';
import { readAgentPersona, type AgentPersona } from '../channels/voice-livekit/persona.js';
import {
  resolveCallbackSettings,
  type CallbackSettings,
} from '../channels/voice-livekit/tools/callback-settings.js';

export interface BusinessProfile {
  companyName: string;
  description: string;
  product: string;
  targetAudience: string;
  pricing: string;
  commonObjections: string;
  toneOfVoice: string;
  language: string;
}

export interface ZadarmaSettings {
  phoneNumber: string;
  configuredAt: string;
}

interface ZadarmaStoredSettings extends ZadarmaSettings {
  apiKeyEncrypted: string;
  apiSecretEncrypted: string;
}

function getTenantSettings(raw: unknown): Record<string, unknown> {
  return (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
}

export class SettingsService {
  constructor(
    private db: Database,
    private encryptionKey: string,
  ) {}

  async getBusinessProfile(tenantId: string): Promise<BusinessProfile | null> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const settings = getTenantSettings(tenant.settings);
    return (settings.businessProfile as BusinessProfile | undefined) ?? null;
  }

  /**
   * The tenant's agent persona, resolved — every unset field filled from `DEFAULT_PERSONA` — plus
   * a flag for whether they have actually configured one.
   *
   * `configured` is what the dashboard needs to tell "this tenant chose to call their agent קרן"
   * apart from "this tenant has never been through onboarding and is inheriting our defaults".
   * The resolved persona alone cannot distinguish those, and they are very different states: the
   * second one means a live agent is introducing itself as ClickScales to somebody else's leads.
   */
  async getAgentPersona(tenantId: string): Promise<{ persona: AgentPersona; configured: boolean }> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const settings = getTenantSettings(tenant.settings);
    return {
      persona: readAgentPersona(settings),
      configured: !!settings.agent_persona && typeof settings.agent_persona === 'object',
    };
  }

  /**
   * Writes the CONTENT half of the persona, merged over whatever is stored.
   *
   * `tts` is deliberately not writable here and is preserved untouched: a voice id is operator
   * territory (`settings-policy.ts`), because a wrong one produces a silent audio stream on a live
   * call rather than an error. A tenant editing their agent's name must not be able to mute it.
   */
  async saveAgentPersona(
    tenantId: string,
    patch: Partial<Omit<AgentPersona, 'tts'>>,
  ): Promise<AgentPersona> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const settings = getTenantSettings(tenant.settings);
    const stored = (settings.agent_persona ?? {}) as Record<string, unknown>;

    // `tts` is stripped from the PATCH, not merely overwritten by the stored value. Re-applying
    // the stored one only guarded the case where a voice already existed — a tenant with no voice
    // configured could still introduce one, which is the same hole in the direction nobody checks.
    const { tts: _rejected, ...content } = patch as Record<string, unknown>;
    settings.agent_persona = { ...stored, ...content, ...(stored.tts ? { tts: stored.tts } : {}) };

    await this.db
      .update(tenants)
      .set({ settings, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));

    return readAgentPersona(settings);
  }

  /**
   * THE FOLLOW-UP SETTINGS — `tenants.settings.callbacks`.
   *
   * Returned RESOLVED, never raw: a tenant that has configured nothing still sees the ladder its
   * agent is actually running, which is the only version of this screen that can be reasoned
   * about. The resolver is the same one the worker calls at fire time, so what the operator reads
   * here is what will happen tonight — including every fallback a malformed override triggered.
   */
  async getCallbackSettings(tenantId: string): Promise<{ settings: CallbackSettings; configured: boolean }> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const settings = getTenantSettings(tenant.settings);
    return {
      settings: resolveCallbackSettings(settings),
      configured: !!settings.callbacks && typeof settings.callbacks === 'object',
    };
  }

  /**
   * Writes the tenant's follow-up configuration, then returns it AS RESOLVED.
   *
   * Returning the resolved value rather than the stored patch is the point: every boundary in
   * `callback-settings.ts` is a silent clamp — a ladder of six rungs falls back to the default, a
   * `maxAttempts` of 9 becomes 5 — and an operator who does not see that happen will believe a
   * ladder is live that never was.
   */
  async saveCallbackSettings(
    tenantId: string,
    patch: Record<string, unknown>,
  ): Promise<CallbackSettings> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const settings = getTenantSettings(tenant.settings);
    const stored = (settings.callbacks ?? {}) as Record<string, unknown>;
    settings.callbacks = { ...stored, ...patch };

    await this.db
      .update(tenants)
      .set({ settings, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));

    return resolveCallbackSettings(settings);
  }

  async saveBusinessProfile(tenantId: string, profile: BusinessProfile): Promise<BusinessProfile> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const settings = getTenantSettings(tenant.settings);
    settings.businessProfile = profile;

    await this.db
      .update(tenants)
      .set({ settings, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));

    return profile;
  }

  /** Daily outbound caps — resolver clamps everything invalid to the defaults (never off). */
  async getTollFraudSettings(tenantId: string): Promise<TollFraudSettings> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundError('Tenant', tenantId);
    return resolveTollFraudSettings(tenant.settings);
  }

  async saveTollFraudSettings(tenantId: string, input: Partial<TollFraudSettings>): Promise<TollFraudSettings> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const settings = getTenantSettings(tenant.settings);
    settings.toll_fraud = { ...(settings.toll_fraud as object | undefined), ...input };

    await this.db
      .update(tenants)
      .set({ settings, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));

    return resolveTollFraudSettings(settings);
  }

  /** After-call CRM sync behavior (outcome→status map, per-CRM label maps). Resolver fills defaults. */
  async getCrmSyncSettings(tenantId: string): Promise<CrmSyncSettings> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundError('Tenant', tenantId);
    return resolveCrmSyncSettings(tenant.settings);
  }

  async saveCrmSyncSettings(tenantId: string, input: Partial<CrmSyncSettings>): Promise<CrmSyncSettings> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const settings = getTenantSettings(tenant.settings);
    settings.crm_sync = { ...(settings.crm_sync as object | undefined), ...input };

    await this.db
      .update(tenants)
      .set({ settings, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));

    return resolveCrmSyncSettings(settings);
  }

  /** The tenant's approved WhatsApp template SIDs — see whatsapp-window.ts for the slot keys. */
  async getWhatsappTemplates(tenantId: string): Promise<WhatsappTemplatesConfig> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundError('Tenant', tenantId);
    return resolveWhatsappTemplates(tenant.settings);
  }

  async saveWhatsappTemplates(tenantId: string, templates: WhatsappTemplatesConfig): Promise<WhatsappTemplatesConfig> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const settings = getTenantSettings(tenant.settings);
    settings.whatsapp_templates = templates;

    await this.db
      .update(tenants)
      .set({ settings, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));

    return resolveWhatsappTemplates(settings);
  }

  async getZadarmaSettings(tenantId: string): Promise<{ configured: boolean; phoneNumber: string | null; configuredAt: string | null }> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const settings = getTenantSettings(tenant.settings);
    const zadarma = settings.zadarma as ZadarmaStoredSettings | undefined;

    if (!zadarma?.apiKeyEncrypted) {
      return { configured: false, phoneNumber: null, configuredAt: null };
    }

    return {
      configured: true,
      phoneNumber: zadarma.phoneNumber ?? null,
      configuredAt: zadarma.configuredAt ?? null,
    };
  }

  async saveZadarmaSettings(
    tenantId: string,
    input: { apiKey: string; apiSecret: string; phoneNumber: string },
  ): Promise<void> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const settings = getTenantSettings(tenant.settings);
    const stored: ZadarmaStoredSettings = {
      apiKeyEncrypted: encrypt(input.apiKey, this.encryptionKey),
      apiSecretEncrypted: encrypt(input.apiSecret, this.encryptionKey),
      phoneNumber: input.phoneNumber,
      configuredAt: new Date().toISOString(),
    };
    settings.zadarma = stored;

    await this.db
      .update(tenants)
      .set({ settings, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));
  }

  async deleteZadarmaSettings(tenantId: string): Promise<void> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const settings = getTenantSettings(tenant.settings);
    delete settings.zadarma;

    await this.db
      .update(tenants)
      .set({ settings, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));
  }

  async getZadarmaCredentials(tenantId: string): Promise<{ apiKey: string; apiSecret: string } | null> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) return null;

    const settings = getTenantSettings(tenant.settings);
    const zadarma = settings.zadarma as ZadarmaStoredSettings | undefined;
    if (!zadarma?.apiKeyEncrypted || !zadarma?.apiSecretEncrypted) return null;

    try {
      return {
        apiKey: decrypt(zadarma.apiKeyEncrypted, this.encryptionKey),
        apiSecret: decrypt(zadarma.apiSecretEncrypted, this.encryptionKey),
      };
    } catch {
      return null;
    }
  }
}
