import { CircuitBreaker } from '../../../shared/circuit-breaker.js';

const AIRTABLE_API_BASE = 'https://api.airtable.com/v0';
const AIRTABLE_META_BASE = 'https://api.airtable.com/v0/meta/bases';
const AIRTABLE_TIMEOUT_MS = 15_000;

const airtableCircuit = new CircuitBreaker({ name: 'airtable', failureThreshold: 5, cooldownMs: 30_000 });

export interface AirtableConfig {
  apiKey: string;
  baseId: string;
  tableId: string;
  phoneFieldName?: string;
  emailFieldName?: string;
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
  createdTime?: string;
}

export class AirtableService {
  private tableUrl: string;

  constructor(private config: AirtableConfig) {
    this.tableUrl = `${AIRTABLE_API_BASE}/${config.baseId}/${config.tableId}`;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async fetch<T>(url: string, opts: RequestInit): Promise<T> {
    return airtableCircuit.execute(async () => {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(AIRTABLE_TIMEOUT_MS) });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Airtable ${res.status}: ${text}`);
      }
      return res.json() as Promise<T>;
    });
  }

  /** Validate credentials by listing tables for the base. */
  async listTables(): Promise<Array<{ id: string; name: string }>> {
    const data = await this.fetch<{ tables: Array<{ id: string; name: string }> }>(
      `${AIRTABLE_META_BASE}/${this.config.baseId}/tables`,
      { headers: this.authHeaders() },
    );
    return data.tables;
  }

  async findByPhone(phone: string): Promise<AirtableRecord | null> {
    const fieldName = this.config.phoneFieldName ?? 'Phone';
    const formula = encodeURIComponent(`{${fieldName}}="${phone}"`);
    const data = await this.fetch<{ records: AirtableRecord[] }>(
      `${this.tableUrl}?filterByFormula=${formula}&maxRecords=1`,
      { headers: this.authHeaders() },
    );
    return data.records[0] ?? null;
  }

  async findByEmail(email: string): Promise<AirtableRecord | null> {
    const fieldName = this.config.emailFieldName ?? 'Email';
    const formula = encodeURIComponent(`{${fieldName}}="${email}"`);
    const data = await this.fetch<{ records: AirtableRecord[] }>(
      `${this.tableUrl}?filterByFormula=${formula}&maxRecords=1`,
      { headers: this.authHeaders() },
    );
    return data.records[0] ?? null;
  }

  async updateRecord(recordId: string, fields: Record<string, unknown>): Promise<void> {
    await this.fetch<AirtableRecord>(
      `${this.tableUrl}/${recordId}`,
      { method: 'PATCH', headers: this.authHeaders(), body: JSON.stringify({ fields }) },
    );
  }

  async createRecord(fields: Record<string, unknown>): Promise<string> {
    const data = await this.fetch<AirtableRecord>(
      this.tableUrl,
      { method: 'POST', headers: this.authHeaders(), body: JSON.stringify({ fields }) },
    );
    return data.id;
  }
}
