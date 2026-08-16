import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { SettingsService } from './settings.service.js';
import { ValidationError } from '../../shared/errors.js';
import { buildGreeting } from '../channels/voice-livekit/persona.js';

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

/**
 * The CONTENT half of the agent persona — what a tenant may set about who their agent is.
 *
 * `tts` is absent by design, not by omission: voice selection is operator-managed
 * (`settings-policy.ts` lists `agent_persona` as operator-only for exactly this reason), because a
 * bad voice id makes Cartesia and ElevenLabs return a SILENT stream rather than an error, and the
 * first anyone would know is a lead listening to nothing. `.strict()` so a client that tries to
 * smuggle one in gets a 400 rather than a silently dropped field.
 */
const agentPersonaSchema = z
  .object({
    // Mandatory and non-empty: CLAUDE.md makes naming the agent part of onboarding, and an agent
    // with no name falls back to ClickScales' — which is the leak this whole feature closes.
    agentName: z.string().trim().min(1).max(40),
    // Drives Hebrew first-person inflection in the prompt AND the greeting verb, from one field.
    agentGender: z.enum(['female', 'male']),
    companyName: z.string().trim().min(1).max(120),
    companyDescription: z.string().trim().max(300).default(''),
    handoffPerson: z.string().trim().max(60).default(''),
    // Empty means "generate it from name + company + gender", which stays correct when those
    // change. A stored line does not, so the UI leaves this blank unless the tenant writes one.
    greeting: z.string().trim().max(300).default(''),
    faq: z
      .array(z.object({ topic: z.string().trim().min(1).max(200), answer: z.string().trim().min(1).max(1000) }))
      .max(30)
      .default([]),
  })
  .strict();

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

  // --- Agent persona (who the agent is on this tenant's calls) ---

  app.get('/agent-persona', async (request) => {
    const tenantId = (request as any).tenantId as string;
    const { persona, configured } = await service.getAgentPersona(tenantId);
    // The greeting is SHOWN resolved (what a lead actually hears) but STORED raw, so the UI can
    // display the generated line without silently promoting it to a stored override on next save.
    return {
      persona,
      configured,
      resolvedGreeting: buildGreeting(persona),
      // The voice is read-only here — the dashboard renders it as a fact, not a control.
      tts: persona.tts ?? null,
    };
  });

  app.put('/agent-persona', async (request, reply) => {
    const tenantId = (request as any).tenantId as string;
    const result = agentPersonaSchema.safeParse(request.body);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new ValidationError(
        issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid input',
      );
    }

    const persona = await service.saveAgentPersona(tenantId, result.data);
    return reply.status(200).send({ ok: true, persona, resolvedGreeting: buildGreeting(persona) });
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
