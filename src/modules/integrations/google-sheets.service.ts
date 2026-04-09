import type { FastifyInstance } from 'fastify';

export class GoogleSheetsService {
  constructor(private app: FastifyInstance) {}

  async connectSheet(tenantId: string, spreadsheetId: string): Promise<void> {
    // TODO: Set up Google Sheets API connection, configure polling job
    this.app.log.info({ tenantId, spreadsheetId }, 'Google Sheet connected');
  }

  async syncNewRows(tenantId: string, spreadsheetId: string): Promise<number> {
    // TODO: Fetch new rows since last sync, create leads
    this.app.log.info({ tenantId, spreadsheetId }, 'Google Sheets sync');
    return 0;
  }
}
