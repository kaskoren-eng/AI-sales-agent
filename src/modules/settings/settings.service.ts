import { eq } from 'drizzle-orm';
import { tenants } from '../../db/schema/index.js';
import type { Database } from '../../db/client.js';
import { encrypt, decrypt } from '../../shared/crypto.js';
import { NotFoundError } from '../../shared/errors.js';

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
