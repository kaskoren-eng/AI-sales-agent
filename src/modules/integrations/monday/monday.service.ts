import { CircuitBreaker } from '../../../shared/circuit-breaker.js';

const MONDAY_API = 'https://api.monday.com/v2';
const API_VERSION = '2024-01';
const MONDAY_TIMEOUT_MS = 15_000;

const mondayCircuit = new CircuitBreaker({ name: 'monday', failureThreshold: 5, cooldownMs: 30_000 });

export interface MondayColumnMap {
  /** Monday column ID for lead email */
  email?: string;
  /** Monday column ID for lead phone */
  phone?: string;
  /** Monday column ID for lead status label */
  status?: string;
  /** Monday column ID for lead qualification score */
  score?: string;
}

export interface MondayConfig {
  apiToken: string;
  boardId: string;
  columnMap: MondayColumnMap;
}

export interface MondayBoard {
  id: string;
  name: string;
}

export interface MondayColumn {
  id: string;
  title: string;
  type: string;
}

export interface MondayItem {
  id: string;
  name: string;
  columnValues: Array<{ id: string; text: string }>;
}

export interface LeadFromItem {
  mondayItemId: string;
  name: string;
  email?: string;
  phone?: string;
}

export class MondayService {
  constructor(private config: MondayConfig) {}

  private async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    return mondayCircuit.execute(async () => {
      const res = await fetch(MONDAY_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.config.apiToken,
          'API-Version': API_VERSION,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(MONDAY_TIMEOUT_MS),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Monday API ${res.status}: ${text}`);
      }

      const json = (await res.json()) as {
        data: T;
        errors?: Array<{ message: string }>;
      };

      if (json.errors?.length) {
        throw new Error(`Monday GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
      }

      return json.data;
    });
  }

  async getBoards(): Promise<MondayBoard[]> {
    const data = await this.gql<{ boards: Array<{ id: string; name: string }> }>(
      `query { boards(limit: 50, order_by: created_at) { id name } }`,
    );
    return data.boards;
  }

  async getBoardColumns(boardId: string): Promise<MondayColumn[]> {
    const data = await this.gql<{
      boards: Array<{ columns: Array<{ id: string; title: string; type: string }> }>;
    }>(
      `query($ids: [ID!]) { boards(ids: $ids) { columns { id title type } } }`,
      { ids: [boardId] },
    );
    return data.boards[0]?.columns ?? [];
  }

  async getItems(boardId: string, groupId?: string): Promise<MondayItem[]> {
    let items: Array<{ id: string; name: string; column_values: Array<{ id: string; text: string }> }> = [];

    if (groupId) {
      const data = await this.gql<{
        boards: Array<{
          groups: Array<{
            items_page: {
              items: Array<{ id: string; name: string; column_values: Array<{ id: string; text: string }> }>;
            };
          }>;
        }>;
      }>(
        `query($ids: [ID!], $groupIds: [String]) {
          boards(ids: $ids) {
            groups(ids: $groupIds) {
              items_page(limit: 500) {
                items { id name column_values { id text } }
              }
            }
          }
        }`,
        { ids: [boardId], groupIds: [groupId] },
      );
      items = data.boards[0]?.groups[0]?.items_page.items ?? [];
    } else {
      const data = await this.gql<{
        boards: Array<{
          items_page: {
            items: Array<{ id: string; name: string; column_values: Array<{ id: string; text: string }> }>;
          };
        }>;
      }>(
        `query($ids: [ID!]) {
          boards(ids: $ids) {
            items_page(limit: 500) {
              items { id name column_values { id text } }
            }
          }
        }`,
        { ids: [boardId] },
      );
      items = data.boards[0]?.items_page.items ?? [];
    }

    return items.map((item) => ({
      id: item.id,
      name: item.name,
      columnValues: item.column_values,
    }));
  }

  async createItem(
    boardId: string,
    name: string,
    columnValues: Record<string, string>,
  ): Promise<string> {
    const data = await this.gql<{ create_item: { id: string } }>(
      `mutation($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) { id }
      }`,
      { boardId, itemName: name || 'Lead', columnValues: JSON.stringify(columnValues) },
    );
    return data.create_item.id;
  }

  async updateItem(
    boardId: string,
    itemId: string,
    columnValues: Record<string, string>,
  ): Promise<void> {
    await this.gql(
      `mutation($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
      }`,
      { boardId, itemId, columnValues: JSON.stringify(columnValues) },
    );
  }

  /** Build Monday column values object from a lead record */
  buildColumnValues(lead: {
    email?: string | null;
    phone?: string | null;
    status?: string;
    score?: number | null;
  }): Record<string, string> {
    const { columnMap } = this.config;
    const cols: Record<string, string> = {};
    if (columnMap.email && lead.email) cols[columnMap.email] = lead.email;
    if (columnMap.phone && lead.phone) cols[columnMap.phone] = lead.phone;
    if (columnMap.status && lead.status) cols[columnMap.status] = lead.status;
    if (columnMap.score && lead.score != null) cols[columnMap.score] = String(lead.score);
    return cols;
  }

  async getItemById(itemId: string): Promise<MondayItem | null> {
    const data = await this.gql<{
      items: Array<{ id: string; name: string; column_values: Array<{ id: string; text: string }> }>;
    }>(
      `query($ids: [ID!]) {
        items(ids: $ids) { id name column_values { id text } }
      }`,
      { ids: [itemId] },
    );
    const item = data.items[0];
    if (!item) return null;
    return { id: item.id, name: item.name, columnValues: item.column_values };
  }

  /** Parse a lead record from a Monday item using the column map */
  parseLeadFromItem(item: MondayItem): LeadFromItem {
    const { columnMap } = this.config;
    const byId = Object.fromEntries(item.columnValues.map((c) => [c.id, c.text]));
    return {
      mondayItemId: item.id,
      name: item.name,
      email: (columnMap.email && byId[columnMap.email]) || undefined,
      phone: (columnMap.phone && byId[columnMap.phone]) || undefined,
    };
  }
}
