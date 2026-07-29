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
