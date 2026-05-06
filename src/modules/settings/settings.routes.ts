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

const twilioSettingsSchema = z.object({
  accountSid: z.string().startsWith('AC').min(34).max(34),
  authToken: z.string().min(32).max(64),
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

  // --- Twilio ---

  app.get('/twilio', async (request) => {
    const tenantId = (request as any).tenantId as string;
    return service.getTwilioSettings(tenantId);
  });

  app.put('/twilio', async (request, reply) => {
    const tenantId = (request as any).tenantId as string;
    const result = twilioSettingsSchema.safeParse(request.body);
    if (!result.success) throw new ValidationError(result.error.issues[0]?.message ?? 'Invalid input');

    await service.saveTwilioSettings(tenantId, result.data);
    return reply.status(200).send({ ok: true });
  });

  app.delete('/twilio', async (request, reply) => {
    const tenantId = (request as any).tenantId as string;
    await service.deleteTwilioSettings(tenantId);
    return reply.status(200).send({ ok: true });
  });
}
