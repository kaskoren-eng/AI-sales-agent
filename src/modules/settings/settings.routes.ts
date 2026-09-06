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


/**
 * THE FOLLOW-UP LADDER, as a tenant may write it (Koren, 2026-09-04: the follow-ups must be
 * configurable per client, from inside their own system).
 *
 * What is NOT here is the design:
 *   · no `window` on a rung — `honored` (07:00–23:00) belongs to an hour the LEAD named, and a
 *     tenant that could stamp it on its own rungs would be cold-calling strangers at 22:30;
 *   · no `channel` on a rung — the worker still dials unconditionally, so accepting one would
 *     promise a WhatsApp follow-up and place a phone call;
 *   · no hard floor, no Shabbat, no holidays. Those are not settings.
 *
 * `.strict()` on both objects so a client that sends one of those gets a 400 instead of a field
 * that silently does nothing. The resolver clamps everything else, and the response is the
 * RESOLVED config so the operator sees what actually took effect.
 */
const callbackRungSchema = z
  .object({
    after: z
      .object({
        minutes: z.number().int().positive().optional(),
        hours: z.number().int().positive().optional(),
        businessDays: z.number().int().positive().optional(),
      })
      .strict()
      .refine((o) => [o.minutes, o.hours, o.businessDays].filter((v) => v !== undefined).length === 1, {
        message: 'each rung needs exactly one of minutes, hours or businessDays',
      }),
    // 'rotate' is the one Koren asked for by name: if the last attempt was in the morning, try the
    // afternoon, and the other way round. 'keep' repeats the previous attempt's hour.
    timeOfDay: z.enum(['keep', 'rotate', 'morning', 'afternoon']).optional(),
  })
  .strict();

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

const callbackSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    // Five is a boundary, not a preference: a tenant may choose how many times to follow up and
    // may not choose "until he answers". See MAX_ATTEMPTS_CEILING.
    maxAttempts: z.number().int().min(1).max(5).optional(),
    proactiveWeekday: z.object({ start: hhmm, end: hhmm }).strict().optional(),
    proactiveFriday: z.object({ start: hhmm, end: hhmm }).strict().optional(),
    dayParts: z.object({ morning: hhmm, afternoon: hhmm, split: hhmm }).strict().optional(),
    disconnectedDelayMinutes: z.number().int().min(1).max(24 * 60).optional(),
    ladders: z
      .object({
        // `explicit` describes the RETRIES only — rung 1 is the time the lead himself named and
        // is prepended by the resolver.
        explicit: z.array(callbackRungSchema).max(5).optional(),
        soft_defer: z.array(callbackRungSchema).max(5).optional(),
        not_reached: z.array(callbackRungSchema).max(5).optional(),
        disconnected: z.array(callbackRungSchema).max(5).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

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


  // --- Follow-ups (the callback ladder this tenant's agent runs) ---

  app.get('/callbacks', async (request) => {
    const tenantId = (request as any).tenantId as string;
    const { settings, configured } = await service.getCallbackSettings(tenantId);
    return { settings, configured };
  });

  app.put('/callbacks', async (request, reply) => {
    const tenantId = (request as any).tenantId as string;
    const result = callbackSettingsSchema.safeParse(request.body);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new ValidationError(
        issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid input',
      );
    }

    // The RESOLVED config comes back, not the patch: every clamp in callback-settings.ts is silent
    // by design, and an operator who cannot see one fire will believe a ladder is live that is not.
    const settings = await service.saveCallbackSettings(tenantId, result.data);
    return reply.status(200).send({ ok: true, settings });
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
