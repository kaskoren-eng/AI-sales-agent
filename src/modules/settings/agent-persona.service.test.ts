import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/client.js';
import { SettingsService } from './settings.service.js';
import { DEFAULT_PERSONA } from '../channels/voice-livekit/persona.js';

/**
 * The persona WRITE path.
 *
 * The read path is covered exhaustively by `system-prompt.persona.test.ts`. What is only testable
 * here is the property that makes it safe to expose this to a customer at all: a tenant editing
 * their agent's name must not be able to change — or erase — their voice.
 *
 * That is not a theoretical concern. A wrong `voiceId` does not raise: Cartesia and ElevenLabs
 * both return a SILENT stream for one, so the failure mode of losing it is a live call where the
 * lead hears nothing and the agent has no idea. Hence `agent_persona` being operator-only in
 * `settings-policy.ts`, and hence a typed route that cannot carry a voice at all.
 */
function fakeDb(settings: Record<string, unknown>) {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ settings }] }) }),
    })),
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          writes.push(vals);
        },
      }),
    })),
  } as unknown as Database;
  return { db, writes };
}

const service = (settings: Record<string, unknown>) => {
  const { db, writes } = fakeDb(settings);
  return { svc: new SettingsService(db, 'k'.repeat(32)), writes };
};

describe('saveAgentPersona', () => {
  it('preserves an operator-set voice through a tenant edit', () => {
    const { svc, writes } = service({
      agent_persona: { agentName: 'מיכל', tts: { voiceId: 'operator-voice', speed: 0.92 } },
    });

    return svc.saveAgentPersona('t1', { agentName: 'דנה', agentGender: 'female' }).then((persona) => {
      const written = (writes[0]!.settings as Record<string, unknown>).agent_persona as Record<string, unknown>;
      expect(written.agentName).toBe('דנה');
      expect(written.tts).toEqual({ voiceId: 'operator-voice', speed: 0.92 });
      expect(persona.tts).toEqual({ voiceId: 'operator-voice', speed: 0.92 });
    });
  });

  it('cannot introduce a voice through the content patch', async () => {
    // Belt and braces: the route's schema is `.strict()` and has no `tts` field, so this cannot
    // arrive over HTTP. The service refuses it anyway — the guarantee should not depend on which
    // caller you came through.
    const { svc, writes } = service({});
    await svc.saveAgentPersona('t1', { agentName: 'דנה', tts: { voiceId: 'smuggled' } } as never);
    const written = (writes[0]!.settings as Record<string, unknown>).agent_persona as Record<string, unknown>;
    expect(written.tts).toBeUndefined();
  });

  it('merges over stored fields rather than replacing the object', async () => {
    const { svc, writes } = service({
      agent_persona: { agentName: 'מיכל', companyName: 'סטודיו', handoffPerson: 'רון' },
    });
    await svc.saveAgentPersona('t1', { agentGender: 'male' });
    const written = (writes[0]!.settings as Record<string, unknown>).agent_persona as Record<string, unknown>;
    expect(written).toMatchObject({ agentName: 'מיכל', companyName: 'סטודיו', handoffPerson: 'רון', agentGender: 'male' });
  });

  it('leaves the rest of tenants.settings untouched', async () => {
    // The whole column is read-modify-written, so a bug here silently deletes a tenant's CRM
    // credentials or flow definitions.
    const { svc, writes } = service({
      businessProfile: { companyName: 'X' },
      monday: { encryptedApiToken: 'cipher' },
    });
    await svc.saveAgentPersona('t1', { agentName: 'דנה' });
    const settings = writes[0]!.settings as Record<string, unknown>;
    expect(settings.businessProfile).toEqual({ companyName: 'X' });
    expect(settings.monday).toEqual({ encryptedApiToken: 'cipher' });
  });
});

describe('getAgentPersona', () => {
  it('reports configured:false for a tenant that has never set one', async () => {
    // This flag is the difference the dashboard shows as a warning banner. Getting it wrong means
    // a tenant sees a filled-in form and believes their agent is named — while it is live on the
    // phone introducing itself as ClickScales'.
    const { svc } = service({ businessProfile: { companyName: 'X' } });
    const result = await svc.getAgentPersona('t1');
    expect(result.configured).toBe(false);
    expect(result.persona).toEqual(DEFAULT_PERSONA);
  });

  it('reports configured:true once anything is stored', async () => {
    const { svc } = service({ agent_persona: { agentName: 'מיכל' } });
    const result = await svc.getAgentPersona('t1');
    expect(result.configured).toBe(true);
    expect(result.persona.agentName).toBe('מיכל');
  });
});
