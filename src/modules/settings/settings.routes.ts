import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { SettingsService } from './settings.service.js';
import { ValidationError } from '../../shared/errors.js';

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
