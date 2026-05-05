import { google } from 'googleapis';
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { tenants, leads } from '../../db/schema/index.js';
import { encrypt, decrypt } from '../../shared/crypto.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';

interface SheetCredentials {
  spreadsheetId: string;
  accessToken: string;
  refreshToken?: string;
  lastSyncedRow: number;
}

/**
 * Maps sheet column headers (lowercase) to lead fields.
 */
const COLUMN_MAP: Record<string, string> = {
  name: 'name',
  'full name': 'name',
  fullname: 'name',
  email: 'email',
  'email address': 'email',
  phone: 'phone',
  mobile: 'phone',
  'phone number': 'phone',
  source: 'source',
  'lead source': 'source',
};

export class GoogleSheetsService {
  constructor(private app: FastifyInstance) {}

  private buildAuthClient(credentials: SheetCredentials) {
    const env = this.app.env;
    const auth = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
    auth.setCredentials({
      access_token: credentials.accessToken,
      refresh_token: credentials.refreshToken,
    });
    return auth;
  }

  private async loadCredentials(tenantId: string): Promise<SheetCredentials> {
    const [tenant] = await this.app.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const settings = (tenant.settings as Record<string, any>) ?? {};
    const raw = settings.integrations?.googleSheets;
    if (!raw) throw new ValidationError('Google Sheets not connected for this tenant');

    const decrypted = decrypt(raw, this.app.env.ENCRYPTION_KEY);
    return JSON.parse(decrypted) as SheetCredentials;
  }

  private async saveCredentials(tenantId: string, credentials: SheetCredentials): Promise<void> {
    const [tenant] = await this.app.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) throw new NotFoundError('Tenant', tenantId);

    const settings = (tenant.settings as Record<string, any>) ?? {};
    const integrations = settings.integrations ?? {};
    integrations.googleSheets = encrypt(JSON.stringify(credentials), this.app.env.ENCRYPTION_KEY);
    settings.integrations = integrations;

    await this.app.db
      .update(tenants)
      .set({ settings, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));
  }

  async connectSheet(
    tenantId: string,
    spreadsheetId: string,
    accessToken: string,
    refreshToken?: string,
  ): Promise<{ title: string; sheets: string[] }> {
    const credentials: SheetCredentials = {
      spreadsheetId,
      accessToken,
      refreshToken,
      lastSyncedRow: 1, // Row 1 is header; data starts at row 2
    };

    const auth = this.buildAuthClient(credentials);
    const sheetsApi = google.sheets({ version: 'v4', auth });

    // Validate access by fetching spreadsheet metadata
    let spreadsheetMeta;
    try {
      const res = await sheetsApi.spreadsheets.get({
        spreadsheetId,
        fields: 'properties.title,sheets.properties.title',
      });
      spreadsheetMeta = res.data;
    } catch (err: any) {
      throw new ValidationError(`Cannot access spreadsheet: ${err.message}`);
    }

    await this.saveCredentials(tenantId, credentials);

    const sheetNames = (spreadsheetMeta.sheets ?? []).map(
      (s: any) => s.properties?.title ?? 'Sheet1',
    );

    this.app.log.info(
      { tenantId, spreadsheetId },
      `Google Sheet connected: "${spreadsheetMeta.properties?.title}"`,
    );

    return {
      title: spreadsheetMeta.properties?.title ?? spreadsheetId,
      sheets: sheetNames,
    };
  }

  async syncNewRows(tenantId: string): Promise<number> {
    const credentials = await this.loadCredentials(tenantId);
    const auth = this.buildAuthClient(credentials);
    const sheetsApi = google.sheets({ version: 'v4', auth });

    // Read all data from the first sheet, starting after the last synced row
    const startRow = credentials.lastSyncedRow + 1;
    const range = `A${startRow}:Z`;

    let rows: any[][] = [];
    let headers: string[] = [];

    try {
      // Fetch header row first to build column map
      const headerRes = await sheetsApi.spreadsheets.values.get({
        spreadsheetId: credentials.spreadsheetId,
        range: 'A1:Z1',
      });
      headers = (headerRes.data.values?.[0] ?? []).map((h: string) =>
        String(h).trim().toLowerCase(),
      );

      if (headers.length === 0) {
        throw new ValidationError('Spreadsheet has no header row');
      }

      // Fetch data rows
      const dataRes = await sheetsApi.spreadsheets.values.get({
        spreadsheetId: credentials.spreadsheetId,
        range,
      });
      rows = dataRes.data.values ?? [];
    } catch (err: any) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(`Google Sheets read error: ${err.message}`);
    }

    if (rows.length === 0) {
      this.app.log.info({ tenantId }, 'Google Sheets sync: no new rows');
      return 0;
    }

    let created = 0;

    for (const row of rows) {
      const mapped: Record<string, string> = {};
      for (let i = 0; i < headers.length; i++) {
        const field = COLUMN_MAP[headers[i]];
        if (field && row[i]) mapped[field] = String(row[i]).trim();
      }

      if (!mapped['name'] && !mapped['email'] && !mapped['phone']) continue;

      // Deduplicate by phone then email
      let existingId: string | undefined;
      if (mapped['phone']) {
        const [existing] = await this.app.db
          .select({ id: leads.id })
          .from(leads)
          .where(and(eq(leads.tenantId, tenantId), eq(leads.phone, mapped['phone'])))
          .limit(1);
        existingId = existing?.id;
      }
      if (!existingId && mapped['email']) {
        const [existing] = await this.app.db
          .select({ id: leads.id })
          .from(leads)
          .where(and(eq(leads.tenantId, tenantId), eq(leads.email, mapped['email'])))
          .limit(1);
        existingId = existing?.id;
      }

      if (!existingId) {
        await this.app.db.insert(leads).values({
          tenantId,
          name: mapped['name'],
          email: mapped['email'],
          phone: mapped['phone'],
          source: mapped['source'] ?? 'google_sheets',
          status: 'new',
        });
        created++;
      }
    }

    // Update lastSyncedRow to include newly processed rows
    credentials.lastSyncedRow = startRow + rows.length - 1;
    await this.saveCredentials(tenantId, credentials);

    this.app.log.info({ tenantId, created, rows: rows.length }, 'Google Sheets sync complete');
    return created;
  }
}
