import type { FastifyInstance } from 'fastify';

export class NangoProvider {
  constructor(private app: FastifyInstance) {}

  async syncLeadsFromCRM(tenantId: string, connectionId: string): Promise<void> {
    // TODO: Use @nangohq/node to fetch leads from connected CRM
    // Sync bidirectionally: new leads in, status updates out
    this.app.log.info({ tenantId, connectionId }, 'CRM sync triggered');
  }

  async pushLeadUpdate(tenantId: string, connectionId: string, leadId: string, data: Record<string, unknown>): Promise<void> {
    // TODO: Push lead status update to CRM via Nango
    this.app.log.info({ tenantId, connectionId, leadId }, 'CRM lead update pushed');
  }
}
