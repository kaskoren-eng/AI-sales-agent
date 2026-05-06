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

export interface TwilioSettings {
  accountSid: string;
  phoneNumber: string;
  configuredAt: string;
}

interface TwilioStoredSettings extends TwilioSettings {
  authTokenEncrypted: string;
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

  async getTwilioSettings(tenantId: string): Promise<{ configured: boolean; accountSid: string | null; phoneNumber: string | null; authTokenMasked: string | null; configuredAt: string | null }> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const settings = getTenantSettings(tenant.settings);
    const twilio = settings.twilio as TwilioStoredSettings | undefined;

    if (!twilio?.accountSid || !twilio?.authTokenEncrypted) {
      return { configured: false, accountSid: null, phoneNumber: null, authTokenMasked: null, configuredAt: null };
    }

    return {
      configured: true,
      accountSid: twilio.accountSid,
      phoneNumber: twilio.phoneNumber ?? null,
      authTokenMasked: '••••••••' + twilio.authTokenEncrypted.slice(-4),
      configuredAt: twilio.configuredAt ?? null,
    };
  }

  async saveTwilioSettings(
    tenantId: string,
    input: { accountSid: string; authToken: string; phoneNumber: string },
  ): Promise<void> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const settings = getTenantSettings(tenant.settings);
    const stored: TwilioStoredSettings = {
      accountSid: input.accountSid,
      authTokenEncrypted: encrypt(input.authToken, this.encryptionKey),
      phoneNumber: input.phoneNumber,
      configuredAt: new Date().toISOString(),
    };
    settings.twilio = stored;

    await this.db
      .update(tenants)
      .set({ settings, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));
  }

  async deleteTwilioSettings(tenantId: string): Promise<void> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const settings = getTenantSettings(tenant.settings);
    delete settings.twilio;

    await this.db
      .update(tenants)
      .set({ settings, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));
  }

  async getTwilioAuthToken(tenantId: string): Promise<string | null> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) return null;

    const settings = getTenantSettings(tenant.settings);
    const twilio = settings.twilio as TwilioStoredSettings | undefined;
    if (!twilio?.authTokenEncrypted) return null;

    try {
      return decrypt(twilio.authTokenEncrypted, this.encryptionKey);
    } catch {
      return null;
    }
  }

  async getTwilioPhoneNumber(tenantId: string): Promise<string | null> {
    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) return null;
    const settings = getTenantSettings(tenant.settings);
    const twilio = settings.twilio as TwilioStoredSettings | undefined;
    return twilio?.phoneNumber ?? null;
  }
}
