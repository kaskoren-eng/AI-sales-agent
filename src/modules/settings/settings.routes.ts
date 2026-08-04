import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { SettingsService } from './settings.service.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';

const businessProfileSchema = z.object({
  companyName: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  product: z.string().min(1).max(1000),
  targetAudience: z.string().min(1).max(1000),
  pricing: z.string().max(1000).default(''),
  commonObjections: z.string().max(2000).default(''),
  toneOfVoice: z.string().max(500).default(''),
  language: z.enum(['hebrew', 'english', 'both']).default('hebrew'),
});

const zadarmaSettingsSchema = z.object({
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
  phoneNumber: z.string().min(7).max(20),
});

export async function settingsRoutes(app: FastifyInstance) {
  const service = new SettingsService(app.db, app.env.ENCRYPTION_KEY);

  // --- Business Profile ---

  app.get('/business-profile', async (request) => {
    const tenantId = (request as any).tenantId as string;
    const profile = await service.getBusinessProfile(tenantId);
    return { businessProfile: profile };
  });

  app.put('/business-profile', async (request, reply) => {
    const tenantId = (request as any).tenantId as string;
    const result = businessProfileSchema.safeParse(request.body);
    if (!result.success) throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid input');

    const saved = await service.saveBusinessProfile(tenantId, result.data);
    return reply.status(200).send({ ok: true, businessProfile: saved });
  });

  // --- Agent persona (name, gender, voice) ---
  //
  // No zod schema here on purpose: `assertAgentPersona` in the service IS the schema, and it is the
  // same function the agent and the voice:sample CLI validate with. A parallel zod copy of the
  // ranges is exactly how an API comes to accept a value the voice pipeline then silently drops.

  app.get('/agent-persona', async (request) => {
    const tenantId = (request as any).tenantId as string;
    return { agentPersona: await service.getAgentPersona(tenantId) };
  });

  app.put('/agent-persona', async (request, reply) => {
    const tenantId = (request as any).tenantId as string;
    let saved;
    try {
      saved = await service.saveAgentPersona(tenantId, request.body);
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      throw new ValidationError(err instanceof Error ? err.message : 'Invalid agent persona');
    }
    return reply.status(200).send({ ok: true, agentPersona: saved });
  });

  // --- Zadarma ---

  app.get('/zadarma', async (request) => {
    const tenantId = (request as any).tenantId as string;
    return service.getZadarmaSettings(tenantId);
  });

  app.put('/zadarma', async (request, reply) => {
    const tenantId = (request as any).tenantId as string;
    const result = zadarmaSettingsSchema.safeParse(request.body);
    if (!result.success) throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid input');

    await service.saveZadarmaSettings(tenantId, result.data);
    return reply.status(200).send({ ok: true });
  });

  app.delete('/zadarma', async (request, reply) => {
    const tenantId = (request as any).tenantId as string;
    await service.deleteZadarmaSettings(tenantId);
    return reply.status(200).send({ ok: true });
  });
}
