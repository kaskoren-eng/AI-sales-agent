import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../../config/env.js';
import type { Database } from '../../../../db/client.js';
import type { CallReport } from '../call-report.js';
import { CallStateMachine } from '../call-state.js';
import { buildToolRuntime, isDidRefusal, resolveCallIdentity } from './tool-context.js';
import { didCandidates, toE164 } from '../../../../shared/phone-number.js';

/**
 * WHOSE CALL IS THIS.
 *
 * Until DID routing existed, every inbound call on every number resolved to one env var. With one
 * customer that reads as configuration; with two it is the most visible cross-tenant leak the
 * product can have — a stranger's caller reaching another company's agent, being greeted by that
 * company, and any lead created landing in that company's data.
 *
 * The single most important assertion in this file is the one that says an UNMAPPED number is
 * REFUSED rather than served by the env-var tenant. Everything else is supporting detail: that
 * behaviour is silent when it is wrong, and a customer finds it before we do.
 */

const ENV_WITH_FALLBACK = {
  VOICE_WEBHOOK_TENANT_ID: 'env-tenant',
  GOOGLE_CALENDAR_ID: 'cal@group.calendar.google.com',
  GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL: 'svc@proj.iam.gserviceaccount.com',
  GOOGLE_CALENDAR_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
} as unknown as Env;

/**
 * A stand-in for the `phone_numbers` table, injected through the same seam production uses.
 *
 * The first version of this helper tried to recover the queried values out of drizzle's `inArray`
 * fragment by walking it. That object is circular and internal, so the test ended up asserting on
 * drizzle's shape rather than on our routing — and failed for a reason that had nothing to do with
 * the behaviour under test. Injecting the lookup instead means `queried` is exactly the candidate
 * list the routing code asked for.
 */
function fakeNumbers(rows: Array<{ e164: string; tenantId: string | null; isActive: boolean }>) {
  const queried: string[][] = [];
  const lookupNumber = async (candidates: string[]) => {
    queried.push(candidates);
    const hit = rows.find((r) => candidates.includes(r.e164));
    return hit ? { tenantId: hit.tenantId, isActive: hit.isActive } : null;
  };
  return { lookupNumber, queried };
}

describe('toE164', () => {
  it('canonicalises the forms a carrier actually sends', () => {
    expect(toE164('+972555070922')).toBe('+972555070922');
    expect(toE164('972555070922')).toBe('+972555070922');
    expect(toE164('00972555070922')).toBe('+972555070922');
    // National form — Israeli mobiles arrive as 05x. The country code is a parameter, not a literal.
    expect(toE164('0555070922')).toBe('+972555070922');
    expect(toE164('055-507-0922')).toBe('+972555070922');
    expect(toE164('0205550199', '1')).toBe('+1205550199');
  });

  it('refuses anything that cannot be a real number, rather than storing a row nothing can match', () => {
    expect(toE164('')).toBeNull();
    expect(toE164('   ')).toBeNull();
    expect(toE164('12345')).toBeNull(); // too short to carry a country code
    expect(toE164('+9725550709221234567')).toBeNull(); // past E.164's 15 digits
    expect(toE164('+972+555070922')).toBeNull();
    expect(toE164('not a number')).toBeNull();
  });
});

describe('didCandidates', () => {
  it('covers both spellings Zadarma has been seen to send', () => {
    // The trunk config declares +972555070922; SIP attributes have arrived bare. Rather than
    // trusting either side to normalise, the lookup asks for both.
    const candidates = didCandidates('972555070922');
    expect(candidates).toContain('+972555070922');
    expect(candidates).toContain('972555070922');
  });

  it('is empty for no number at all — a console or web call', () => {
    expect(didCandidates(null)).toEqual([]);
    expect(didCandidates(undefined)).toEqual([]);
    expect(didCandidates('')).toEqual([]);
  });

  it('never produces a partial or suffix form', () => {
    // A suffix match could route one country's caller to another country's tenant. Exactness here
    // is the difference between "caller hears not-in-service" and "caller reaches the wrong company".
    for (const candidate of didCandidates('+972555070922')) {
      expect(candidate.replace(/\D/g, '')).toBe('972555070922');
    }
  });
});

describe('resolveCallIdentity', () => {
  const meta = JSON.stringify({ tenantId: 'tenant-outbound', leadId: 'lead-9' });

  it('outbound metadata wins, even when a DID is also present', async () => {
    const { lookupNumber } = fakeNumbers([{ e164: '+972555070922', tenantId: 'tenant-inbound', isActive: true }]);
    const result = await resolveCallIdentity(
      ENV_WITH_FALLBACK,
      { participantMetadata: meta, calledNumber: '+972555070922' },
      { lookupNumber },
    );
    expect(result.identity?.tenantId).toBe('tenant-outbound');
    expect(result.identity?.source).toBe('outbound_metadata');
  });

  it('routes an inbound call to the tenant that owns the dialled number', async () => {
    const { lookupNumber } = fakeNumbers([{ e164: '+972555070922', tenantId: 'tenant-a', isActive: true }]);
    const result = await resolveCallIdentity(
      ENV_WITH_FALLBACK,
      { participantMetadata: undefined, calledNumber: '+972555070922' },
      { lookupNumber },
    );
    expect(result.identity?.tenantId).toBe('tenant-a');
    expect(result.identity?.source).toBe('did_lookup');
  });

  it('matches when the carrier drops the plus', async () => {
    const { lookupNumber } = fakeNumbers([{ e164: '+972555070922', tenantId: 'tenant-a', isActive: true }]);
    const result = await resolveCallIdentity(
      ENV_WITH_FALLBACK,
      { participantMetadata: undefined, calledNumber: '972555070922' },
      { lookupNumber },
    );
    expect(result.identity?.tenantId).toBe('tenant-a');
  });

  it('matches when the row was stored without the plus', async () => {
    const { lookupNumber } = fakeNumbers([{ e164: '972555070922', tenantId: 'tenant-a', isActive: true }]);
    const result = await resolveCallIdentity(
      ENV_WITH_FALLBACK,
      { participantMetadata: undefined, calledNumber: '+972555070922' },
      { lookupNumber },
    );
    expect(result.identity?.tenantId).toBe('tenant-a');
  });

  it('REFUSES an unmapped number instead of falling through to the env tenant', async () => {
    // THE ONE THAT MATTERS. `VOICE_WEBHOOK_TENANT_ID` is set, and it must not be used: a caller
    // who dialled a number we cannot place is not that tenant's lead, and answering as that tenant
    // is a cross-tenant leak that looks exactly like a working call from the inside.
    const { lookupNumber } = fakeNumbers([{ e164: '+972555070922', tenantId: 'tenant-a', isActive: true }]);
    const result = await resolveCallIdentity(
      ENV_WITH_FALLBACK,
      { participantMetadata: undefined, calledNumber: '+972999999999' },
      { lookupNumber },
    );
    expect(result.identity).toBeNull();
    expect(result.refusal).toBe('unmapped_did');
  });

  it('refuses a number that is bought but not yet assigned', async () => {
    const { lookupNumber } = fakeNumbers([{ e164: '+972555070922', tenantId: null, isActive: true }]);
    const result = await resolveCallIdentity(
      ENV_WITH_FALLBACK,
      { participantMetadata: undefined, calledNumber: '+972555070922' },
      { lookupNumber },
    );
    expect(result.refusal).toBe('number_unassigned');
  });

  it('refuses a parked number', async () => {
    const { lookupNumber } = fakeNumbers([{ e164: '+972555070922', tenantId: 'tenant-a', isActive: false }]);
    const result = await resolveCallIdentity(
      ENV_WITH_FALLBACK,
      { participantMetadata: undefined, calledNumber: '+972555070922' },
      { lookupNumber },
    );
    expect(result.refusal).toBe('number_inactive');
  });

  it('refuses rather than guessing when the DB is unavailable mid-lookup', async () => {
    const result = await resolveCallIdentity(
      ENV_WITH_FALLBACK,
      { participantMetadata: undefined, calledNumber: '+972555070922' },
      {},
    );
    expect(result.refusal).toBe('unmapped_did');
  });

  it('uses the env fallback ONLY when no number was dialled at all', async () => {
    // Console sessions and the browser Simulator have no dialled number by definition, so this is
    // the one case where the single-tenant env var is still the right answer.
    const result = await resolveCallIdentity(
      ENV_WITH_FALLBACK,
      { participantMetadata: undefined, calledNumber: null },
      {},
    );
    expect(result.identity?.tenantId).toBe('env-tenant');
    expect(result.identity?.source).toBe('env_fallback');
  });

  it('has no tenant at all when nothing identifies the call', async () => {
    const result = await resolveCallIdentity(
      { ...ENV_WITH_FALLBACK, VOICE_WEBHOOK_TENANT_ID: undefined } as unknown as Env,
      { participantMetadata: undefined, calledNumber: null },
      {},
    );
    expect(result.refusal).toBe('no_tenant');
  });
});

describe('isDidRefusal', () => {
  it('separates "a caller reached us and we will not serve them" from a misconfigured console', () => {
    // Only the first group should ever reach a human ear as the not-in-service announcement.
    expect(isDidRefusal('unmapped_did')).toBe(true);
    expect(isDidRefusal('number_unassigned')).toBe(true);
    expect(isDidRefusal('number_inactive')).toBe(true);
    expect(isDidRefusal('no_tenant')).toBe(false);
    expect(isDidRefusal('functions_disabled')).toBe(false);
    expect(isDidRefusal(null)).toBe(false);
  });
});

describe('buildToolRuntime — inbound routing end to end', () => {
  function opts(calledNumber: string | null) {
    return {
      callId: 'call-in-abc',
      callerPhone: '+972501111111',
      calledNumber,
      participantMetadata: undefined,
      report: { recordToolCall: vi.fn() } as unknown as CallReport,
      callState: new CallStateMachine(),
    };
  }

  it('an unmapped inbound number never becomes the env tenant, and grants no tools', async () => {
    const { lookupNumber } = fakeNumbers([{ e164: '+972555070922', tenantId: 'tenant-a', isActive: true }]);
    const result = await buildToolRuntime(ENV_WITH_FALLBACK, opts('+972999999999'), {
      connectDb: () => ({ db: {} as Database, close: vi.fn(async () => undefined) }),
      lookupNumber,
      loadSettings: async () => ({ functions_enabled: true }),
    });
    expect(result.runtime).toBeNull();
    expect(result.disabledReason).toBe('unmapped_did');
    expect(isDidRefusal(result.disabledReason)).toBe(true);
  });

  it('closes the pool it opened when it refuses the call', async () => {
    // A refused call still opened a connection to answer "whose is this?". Leaking one per hostile
    // or misdialled call is how a scanner sweeping DID ranges exhausts the pool.
    const close = vi.fn(async () => undefined);
    const { lookupNumber } = fakeNumbers([]);
    await buildToolRuntime(ENV_WITH_FALLBACK, opts('+972999999999'), {
      connectDb: () => ({ db: {} as Database, close }),
      lookupNumber,
      loadSettings: async () => ({ functions_enabled: true }),
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('a mapped inbound number resolves to its own tenant, not the env one', async () => {
    const { lookupNumber } = fakeNumbers([{ e164: '+972555070922', tenantId: 'tenant-a', isActive: true }]);
    const result = await buildToolRuntime(ENV_WITH_FALLBACK, opts('+972555070922'), {
      connectDb: () => ({ db: {} as Database, close: vi.fn(async () => undefined) }),
      lookupNumber,
      loadSettings: async () => ({ functions_enabled: true }),
      makeQueues: () => ({
        outboundQueue: { add: vi.fn() } as never,
        remindersQueue: { add: vi.fn() } as never,
        callAnalysisQueue: { add: vi.fn() } as never,
        close: vi.fn(async () => undefined),
      }),
    });
    expect(result.runtime?.tenantId).toBe('tenant-a');
  });
});
