import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../../config/env.js';
import type { Database } from '../../../../db/client.js';
import { GoogleCalendarProvider } from '../../../scheduling/providers/google-calendar.provider.js';
import type { CallReport } from '../call-report.js';
import { CallStateMachine } from '../call-state.js';
import {
  FLAG_READ_TIMEOUT_MS,
  buildToolRuntime,
  evaluateToolGate,
  parseOutboundMetadata,
  redactArgs,
  timedTool,
  type ToolRuntimeContext,
} from './tool-context.js';

const baseEnv = {
  VOICE_WEBHOOK_TENANT_ID: undefined,
  GOOGLE_CALENDAR_ID: 'cal@group.calendar.google.com',
  GOOGLE_CALENDAR_SERVICE_ACCOUNT_EMAIL: 'svc@proj.iam.gserviceaccount.com',
  GOOGLE_CALENDAR_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
} as unknown as Env;

const OUTBOUND_META = JSON.stringify({
  tenantId: 'tenant-1',
  leadId: 'lead-1',
  leadPhone: '+972501234567',
  direction: 'outbound',
});

const ENABLED_SETTINGS = { functions_enabled: true };

function fakeReport(): CallReport {
  return { recordToolCall: vi.fn() } as unknown as CallReport;
}

function fakeQueues() {
  const closeQueues = vi.fn(async () => undefined);
  return {
    closeQueues,
    makeQueues: () => ({
      outboundQueue: { add: vi.fn() } as never,
      remindersQueue: { add: vi.fn() } as never,
      callAnalysisQueue: { add: vi.fn() } as never,
      close: closeQueues,
    }),
  };
}

function deps(settings: unknown, close = vi.fn(async () => undefined)) {
  const q = fakeQueues();
  return {
    close,
    closeQueues: q.closeQueues,
    deps: {
      connectDb: () => ({ db: {} as Database, close }),
      loadSettings: async () => settings,
      // Stubbed so unit tests never dial a real Redis through the default factory.
      makeQueues: q.makeQueues,
    },
  };
}

function callOpts() {
  return {
    callId: 'call-out-abc',
    callerPhone: '+972501234567',
    participantMetadata: OUTBOUND_META,
    report: fakeReport(),
    callState: new CallStateMachine(),
  };
}

describe('parseOutboundMetadata', () => {
  it('reads tenantId + leadId from the outbound dialer payload', () => {
    expect(parseOutboundMetadata(OUTBOUND_META)).toEqual({
      tenantId: 'tenant-1',
      leadId: 'lead-1',
      conversationId: null,
    });
  });

  it('carries the dispatcher-created conversationId (Task 0) when present', () => {
    const withConvo = JSON.stringify({ tenantId: 'tenant-1', leadId: 'lead-1', conversationId: 'convo-9' });
    expect(parseOutboundMetadata(withConvo)).toEqual({
      tenantId: 'tenant-1',
      leadId: 'lead-1',
      conversationId: 'convo-9',
    });
  });

  it('returns null for absent, garbage, and tenant-less metadata — inbound calls, not errors', () => {
    expect(parseOutboundMetadata(undefined)).toBeNull();
    expect(parseOutboundMetadata('not json')).toBeNull();
    expect(parseOutboundMetadata(JSON.stringify({ leadId: 'l-1' }))).toBeNull();
  });

  it('carries dispatcher-resolved settings when present, ignores a non-object settings field', () => {
    const withSettings = JSON.stringify({ tenantId: 'tenant-1', settings: { functions_enabled: true } });
    expect(parseOutboundMetadata(withSettings)).toEqual({
      tenantId: 'tenant-1',
      leadId: null,
      conversationId: null,
      settings: { functions_enabled: true },
    });
    // A garbage settings field is simply dropped — the agent falls back to its own DB read.
    const badSettings = JSON.stringify({ tenantId: 'tenant-1', settings: 'nope' });
    expect(parseOutboundMetadata(badSettings)).toEqual({
      tenantId: 'tenant-1',
      leadId: null,
      conversationId: null,
    });
  });
});

describe('sanitizeSettingsForAgent — whitelist, never leak secrets', () => {
  it('keeps only the voice-relevant keys and drops everything else (incl. secrets)', async () => {
    const { sanitizeSettingsForAgent } = await import('../voice-livekit.service.js');
    const out = sanitizeSettingsForAgent({
      functions_enabled: true,
      whatsapp_templates: { meeting_confirmation: { contentSid: 'HX1' } },
      toll_fraud: { dailySpendLimitUsd: 50 },
      reminders: { enabled: true },
      businessProfile: { companyName: 'ClickScales' },
      monday: { encryptedApiToken: 'SECRET-DO-NOT-LEAK' },
      apiKeyHash: 'also-secret',
    });
    expect(out).toEqual({
      functions_enabled: true,
      whatsapp_templates: { meeting_confirmation: { contentSid: 'HX1' } },
      toll_fraud: { dailySpendLimitUsd: 50 },
      reminders: { enabled: true },
      businessProfile: { companyName: 'ClickScales' },
    });
    expect(JSON.stringify(out)).not.toContain('SECRET-DO-NOT-LEAK');
  });

  it('returns undefined for null/non-object input', async () => {
    const { sanitizeSettingsForAgent } = await import('../voice-livekit.service.js');
    expect(sanitizeSettingsForAgent(null)).toBeUndefined();
    expect(sanitizeSettingsForAgent('x')).toBeUndefined();
  });
});

describe('evaluateToolGate — the fail-closed core', () => {
  it('denies tenants without the functions flag — absence means NO', () => {
    expect(evaluateToolGate({})).toEqual({
      enabled: false,
      reason: 'functions_disabled',
    });
  });

  it('denies on null/undefined settings — an unreadable tenant gets no tools', () => {
    expect(evaluateToolGate(null).enabled).toBe(false);
    expect(evaluateToolGate(undefined).enabled).toBe(false);
  });

  it('denies on a truthy-but-not-true flag — strict === true, "true" strings do not count', () => {
    expect(evaluateToolGate({ functions_enabled: 'true' }).enabled).toBe(false);
    expect(evaluateToolGate({ functions_enabled: 1 }).enabled).toBe(false);
  });

  it('allows only functions_enabled === true', () => {
    expect(evaluateToolGate(ENABLED_SETTINGS)).toEqual({ enabled: true, reason: null });
  });
});

describe('buildToolRuntime — fail-closed matrix', () => {
  it('no metadata and no VOICE_WEBHOOK_TENANT_ID → no_tenant', async () => {
    const result = await buildToolRuntime(
      baseEnv,
      { ...callOpts(), participantMetadata: undefined },
      deps(ENABLED_SETTINGS).deps,
    );
    expect(result).toEqual({ runtime: null, disabledReason: 'no_tenant', settings: null });
  });

  it('returns the tenant settings even when the tool gate is CLOSED', async () => {
    // The agent reads its persona — name, gender, company, FAQ, greeting, voicemail — from these
    // settings. They used to be discarded along with the runtime whenever the gate said no, so a
    // tenant who had simply not enabled booking had their agent introduce itself as ClickScales.
    const settings = { ...ENABLED_SETTINGS, functions_enabled: false, agent_persona: { agentName: 'מיכל' } };
    const result = await buildToolRuntime(baseEnv, callOpts(), deps(settings).deps);
    expect(result.runtime).toBeNull();
    expect(result.disabledReason).toBe('functions_disabled');
    expect(result.settings).toEqual(settings);
  });

  it('returns the tenant settings even when the calendar is not configured', async () => {
    // Same reasoning, and this one also required moving the calendar check to AFTER the settings
    // read — it used to return before the tenant's identity had been loaded at all.
    const env = { ...baseEnv, GOOGLE_CALENDAR_PRIVATE_KEY: undefined } as unknown as Env;
    const settings = { ...ENABLED_SETTINGS, agent_persona: { agentName: 'מיכל' } };
    const result = await buildToolRuntime(env, callOpts(), deps(settings).deps);
    expect(result.disabledReason).toBe('calendar_not_configured');
    expect(result.settings).toEqual(settings);
  });

  it('inbound call falls back to VOICE_WEBHOOK_TENANT_ID with no lead', async () => {
    const env = { ...baseEnv, VOICE_WEBHOOK_TENANT_ID: 'tenant-env' } as Env;
    const result = await buildToolRuntime(
      env,
      { ...callOpts(), participantMetadata: undefined },
      deps(ENABLED_SETTINGS).deps,
    );
    expect(result.runtime?.tenantId).toBe('tenant-env');
    expect(result.runtime?.leadId).toBeNull();
  });

  it('missing calendar creds → calendar_not_configured (tools that cannot book must not exist)', async () => {
    const env = { ...baseEnv, GOOGLE_CALENDAR_PRIVATE_KEY: undefined } as unknown as Env;
    const result = await buildToolRuntime(env, callOpts(), deps(ENABLED_SETTINGS).deps);
    expect(result.disabledReason).toBe('calendar_not_configured');
  });

  it('gates off metadata settings WITHOUT reading the DB — the cloud fix', async () => {
    // The dispatcher shipped the resolved settings; the agent must NOT block on a settings read.
    const loadSettings = vi.fn(async () => {
      throw new Error('DB must not be read on the gate hot path');
    });
    const q = fakeQueues();
    const metaWithSettings = JSON.stringify({
      tenantId: 'tenant-meta',
      leadId: 'lead-9',
      settings: ENABLED_SETTINGS,
    });
    const result = await buildToolRuntime(
      baseEnv,
      { ...callOpts(), participantMetadata: metaWithSettings },
      { connectDb: () => ({ db: {} as Database, close: vi.fn(async () => undefined) }), loadSettings, makeQueues: q.makeQueues },
    );
    expect(result.disabledReason).toBeNull();
    expect(result.runtime?.tenantId).toBe('tenant-meta');
    expect(result.runtime?.settings).toEqual(ENABLED_SETTINGS);
    // The blocking read never gates the call. (It may be fired in the background to warm the pool,
    // but the gate resolved before and regardless of it.)
  });

  it('metadata settings that fail the gate are still honored — no DB fallback rescue', async () => {
    const metaDisabled = JSON.stringify({ tenantId: 't', settings: { functions_enabled: false } });
    const result = await buildToolRuntime(
      baseEnv,
      { ...callOpts(), participantMetadata: metaDisabled },
      deps(ENABLED_SETTINGS).deps, // DB would say enabled — but metadata wins
    );
    expect(result.disabledReason).toBe('functions_disabled');
  });

  it('settings read throws → settings_read_failed, pool closed', async () => {
    const close = vi.fn(async () => undefined);
    const result = await buildToolRuntime(baseEnv, callOpts(), {
      connectDb: () => ({ db: {} as Database, close }),
      loadSettings: async () => {
        throw new Error('connection refused');
      },
    });
    expect(result.disabledReason).toBe('settings_read_failed');
    expect(close).toHaveBeenCalled();
  });

  it('settings read hangs past the timebox → settings_read_timeout, pool closed', async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn(async () => undefined);
      const pending = buildToolRuntime(baseEnv, callOpts(), {
        connectDb: () => ({ db: {} as Database, close }),
        loadSettings: () => new Promise(() => undefined), // never resolves
      });
      await vi.advanceTimersByTimeAsync(FLAG_READ_TIMEOUT_MS + 1);
      const result = await pending;
      expect(result.disabledReason).toBe('settings_read_timeout');
      expect(close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flag off → functions_disabled, pool closed', async () => {
    const { deps: d, close } = deps({ functions_enabled: false });
    const result = await buildToolRuntime(baseEnv, callOpts(), d);
    expect(result.disabledReason).toBe('functions_disabled');
    expect(close).toHaveBeenCalled();
  });

  it('settings with no functions flag at all → functions_disabled', async () => {
    const { deps: d } = deps({});
    const result = await buildToolRuntime(baseEnv, callOpts(), d);
    expect(result.disabledReason).toBe('functions_disabled');
  });

  it('both flags on → a live runtime carrying tenant, lead, and a provider factory', async () => {
    const result = await buildToolRuntime(baseEnv, callOpts(), deps(ENABLED_SETTINGS).deps);
    expect(result.disabledReason).toBeNull();
    const rt = result.runtime!;
    expect(rt.tenantId).toBe('tenant-1');
    expect(rt.leadId).toBe('lead-1');
    expect(rt.bookingCompleted).toBe(false);
    expect(rt.makeProvider(15)).toBeInstanceOf(GoogleCalendarProvider);
  });

  it('keeps the tenant settings object on the runtime — tools read config without a second query', async () => {
    const result = await buildToolRuntime(baseEnv, callOpts(), deps(ENABLED_SETTINGS).deps);
    expect(result.runtime!.settings).toEqual(ENABLED_SETTINGS);
  });

  it('builds the messaging queues and lastBooking starts null', async () => {
    const result = await buildToolRuntime(baseEnv, callOpts(), deps(ENABLED_SETTINGS).deps);
    expect(result.runtime!.outboundQueue).not.toBeNull();
    expect(result.runtime!.remindersQueue).not.toBeNull();
    expect(result.runtime!.callAnalysisQueue).not.toBeNull();
    expect(result.runtime!.lastBooking).toBeNull();
  });

  it('Redis failure degrades to null queues — the CALL proceeds', async () => {
    const { deps: d } = deps(ENABLED_SETTINGS);
    d.makeQueues = () => {
      throw new Error('redis unreachable');
    };
    const result = await buildToolRuntime(baseEnv, callOpts(), d);
    expect(result.disabledReason).toBeNull(); // gate still passed
    expect(result.runtime!.outboundQueue).toBeNull();
    expect(result.runtime!.remindersQueue).toBeNull();
    expect(result.runtime!.callAnalysisQueue).toBeNull();
  });

  it('closeDb tears down queues AND the pool', async () => {
    const { deps: d, close, closeQueues } = deps(ENABLED_SETTINGS);
    const result = await buildToolRuntime(baseEnv, callOpts(), d);
    await result.runtime!.closeDb();
    expect(closeQueues).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});

describe('timedTool', () => {
  function rtWithReport() {
    const recordToolCall = vi.fn();
    const rt = { report: { recordToolCall } } as unknown as ToolRuntimeContext;
    return { rt, recordToolCall };
  }

  it('records a successful call with its duration and returns the result', async () => {
    const { rt, recordToolCall } = rtWithReport();
    const result = await timedTool(rt, 'check_calendar_availability', { from_date: '2026-07-19' }, async () => 'ok');
    expect(result).toBe('ok');
    expect(recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'check_calendar_availability', ok: true, durationMs: expect.any(Number) }),
    );
  });

  it('records a failure and RETHROWS — a silent tool error is how false bookings happen', async () => {
    const { rt, recordToolCall } = rtWithReport();
    await expect(
      timedTool(rt, 'book_meeting', {}, async () => {
        throw new Error('calendar down');
      }),
    ).rejects.toThrow('calendar down');
    expect(recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'book_meeting', ok: false, error: 'calendar down' }),
    );
  });
});

describe('redactArgs — PII never reaches a log line', () => {
  it('cuts phones to last-4, emails to domain, names to an initial', () => {
    expect(
      redactArgs({ phone: '+972501234567', email: 'dana@example.com', name: 'דנה לוי', notes: 'עסק קטן' }),
    ).toEqual({ phone: '…4567', email: '…@example.com', name: 'ד…', notes: 'עסק קטן' });
  });

  it('passes non-strings through and truncates long strings', () => {
    const out = redactArgs({ duration_minutes: 15, notes: 'x'.repeat(200) });
    expect(out.duration_minutes).toBe(15);
    expect((out.notes as string).length).toBeLessThan(130);
  });
});
