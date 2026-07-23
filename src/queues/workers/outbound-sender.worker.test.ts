/**
 * outbound-sender.worker tests
 *
 * Strategy: mock BullMQ Worker so no Redis connection is made. Capture the
 * processor function and invoke it directly with fake job data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock BullMQ ────────────────────────────────────────────────────────────
const capturedProcessors: Array<(job: any) => Promise<any>> = [];

vi.mock('bullmq', () => {
  class Worker {
    constructor(_name: string, processor: (job: any) => Promise<any>, _opts?: any) {
      capturedProcessors.push(processor);
    }
    on() { return this; }
    close() { return Promise.resolve(); }
  }
  return { Worker };
});

import { createOutboundSenderWorker } from './outbound-sender.worker.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeWhatsAppMock() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendVideo: vi.fn().mockResolvedValue(undefined),
    sendTemplate: vi.fn().mockResolvedValue(undefined),
    supportsTemplates: true,
  };
}

function makeEmailMock() {
  return {
    sendEmail: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * DB mock for the window/consent lookups the WhatsApp path now performs.
 * Defaults model the common case — the lead messaged us recently (open 24h window) — so the
 * legacy freeform tests keep meaning what they always meant.
 */
function makeDbMock(opts: {
  lead?: { lastInboundWhatsappAt: Date | null; whatsappConsent: { granted: boolean } | null } | null;
  tenantSettings?: Record<string, unknown>;
} = {}) {
  const lead = opts.lead === undefined
    ? { lastInboundWhatsappAt: new Date(), whatsappConsent: null }
    : opts.lead;
  return {
    select: vi.fn((fields: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            'settings' in fields
              ? [{ settings: opts.tenantSettings ?? {} }]
              : lead
                ? [lead]
                : [],
        }),
      }),
    })),
  };
}

function makeDeps(overrides: Partial<{ whatsapp: any; email: any; db: any }> = {}) {
  return {
    db: makeDbMock(),
    redis: { duplicate: vi.fn().mockReturnValue({}) },
    ...overrides,
  };
}

function makeJob(data: Partial<any> = {}) {
  return {
    id: 'job-1',
    data: {
      tenantId: 'tenant-1',
      channel: 'whatsapp',
      to: '+15551234567',
      content: 'Hello!',
      conversationId: 'conv-1',
      ...data,
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('outbound-sender worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedProcessors.length = 0;
  });

  it('sends a WhatsApp message via whatsapp service', async () => {
    const whatsapp = makeWhatsAppMock();
    createOutboundSenderWorker(makeDeps({ whatsapp }) as any);
    const processor = capturedProcessors[0];

    const result = await processor(makeJob({ channel: 'whatsapp', to: '+15551234567', content: 'Hello!' }));

    expect(whatsapp.sendMessage).toHaveBeenCalledOnce();
    expect(whatsapp.sendMessage).toHaveBeenCalledWith('+15551234567', 'Hello!');
    expect(result).toMatchObject({ channel: 'whatsapp', to: '+15551234567' });
  });

  it('throws when channel is whatsapp but service not configured', async () => {
    createOutboundSenderWorker(makeDeps({ whatsapp: undefined }) as any);
    const processor = capturedProcessors[0];

    await expect(processor(makeJob({ channel: 'whatsapp' }))).rejects.toThrow(
      /whatsapp service not configured/i,
    );
  });

  it('sends an email via email service', async () => {
    const email = makeEmailMock();
    createOutboundSenderWorker(makeDeps({ email }) as any);
    const processor = capturedProcessors[0];

    const result = await processor(
      makeJob({ channel: 'email', to: 'lead@example.com', content: '<p>Hi</p>' }),
    );

    expect(email.sendEmail).toHaveBeenCalledOnce();
    expect(email.sendEmail).toHaveBeenCalledWith('lead@example.com', 'Follow up', '<p>Hi</p>');
    expect(result).toMatchObject({ channel: 'email', to: 'lead@example.com' });
  });

  it('throws when channel is email but service not configured', async () => {
    createOutboundSenderWorker(makeDeps({ email: undefined }) as any);
    const processor = capturedProcessors[0];

    await expect(processor(makeJob({ channel: 'email' }))).rejects.toThrow(
      /email service not configured/i,
    );
  });

  it('voice channel skips silently (real-time channel)', async () => {
    createOutboundSenderWorker(makeDeps() as any);
    const processor = capturedProcessors[0];

    // Should NOT throw — voice is real-time
    const result = await processor(makeJob({ channel: 'voice', to: '+15551234567' }));

    // Returns undefined (early return)
    expect(result).toBeUndefined();
  });

  it('returns correct shape with conversationId', async () => {
    const whatsapp = makeWhatsAppMock();
    createOutboundSenderWorker(makeDeps({ whatsapp }) as any);
    const processor = capturedProcessors[0];

    // Full-length number so the lead resolves (default mock = open window → freeform). A number
    // too short to match any lead is now BLOCKED by design — no blind out-of-window freeform.
    const result = await processor(
      makeJob({ channel: 'whatsapp', to: '+19995551234', content: 'test', conversationId: 'conv-xyz' }),
    );

    expect(result).toEqual({ channel: 'whatsapp', to: '+19995551234', conversationId: 'conv-xyz' });
  });

  it('WhatsApp service error propagates out of the processor', async () => {
    const whatsapp = makeWhatsAppMock();
    whatsapp.sendMessage.mockRejectedValue(new Error('UChat API error: 503'));

    createOutboundSenderWorker(makeDeps({ whatsapp }) as any);
    const processor = capturedProcessors[0];

    await expect(processor(makeJob({ channel: 'whatsapp' }))).rejects.toThrow('UChat API error: 503');
  });

  it('email service error propagates out of the processor', async () => {
    const email = makeEmailMock();
    email.sendEmail.mockRejectedValue(new Error('Resend API failure'));

    createOutboundSenderWorker(makeDeps({ email }) as any);
    const processor = capturedProcessors[0];

    await expect(processor(makeJob({ channel: 'email' }))).rejects.toThrow('Resend API failure');
  });

  // ── email subject (was hardcoded 'Follow up') ─────────────────────────────

  it('email uses the job subject when present, legacy fallback otherwise', async () => {
    const email = makeEmailMock();
    createOutboundSenderWorker(makeDeps({ email }) as any);
    const processor = capturedProcessors[0];

    await processor(makeJob({ channel: 'email', to: 'a@b.co', subject: 'אישור פגישה', content: 'גוף' }));
    expect(email.sendEmail).toHaveBeenCalledWith('a@b.co', 'אישור פגישה', 'גוף');

    await processor(makeJob({ channel: 'email', to: 'a@b.co', content: 'גוף' }));
    expect(email.sendEmail).toHaveBeenLastCalledWith('a@b.co', 'Follow up', 'גוף');
  });

  // ── window-aware WhatsApp: freeform / template / blocked ──────────────────

  const CLOSED_WINDOW_LEAD = {
    lastInboundWhatsappAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h ago
    whatsappConsent: { granted: true },
  };
  const TEMPLATES = { whatsapp_templates: { meeting_confirmation: { contentSid: 'HX123' } } };

  it('open window → freeform even when a template is configured (cheaper, natural)', async () => {
    const whatsapp = makeWhatsAppMock();
    const db = makeDbMock({
      lead: { lastInboundWhatsappAt: new Date(Date.now() - 60_000), whatsappConsent: null },
      tenantSettings: TEMPLATES,
    });
    createOutboundSenderWorker(makeDeps({ whatsapp, db }) as any);
    await capturedProcessors[0](
      makeJob({ template: { key: 'meeting_confirmation', variables: { '1': 'x' } } }),
    );
    expect(whatsapp.sendMessage).toHaveBeenCalledOnce();
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
  });

  it('closed window + consent + configured SID → template send with variables', async () => {
    const whatsapp = makeWhatsAppMock();
    const db = makeDbMock({ lead: CLOSED_WINDOW_LEAD, tenantSettings: TEMPLATES });
    createOutboundSenderWorker(makeDeps({ whatsapp, db }) as any);
    await capturedProcessors[0](
      makeJob({ template: { key: 'meeting_confirmation', variables: { '1': 'דנה' } } }),
    );
    expect(whatsapp.sendTemplate).toHaveBeenCalledWith('+15551234567', 'HX123', { '1': 'דנה' });
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  it('closed window WITHOUT consent → blocked, nothing sent, job succeeds (no DLQ poisoning)', async () => {
    const whatsapp = makeWhatsAppMock();
    const db = makeDbMock({
      lead: { ...CLOSED_WINDOW_LEAD, whatsappConsent: null },
      tenantSettings: TEMPLATES,
    });
    createOutboundSenderWorker(makeDeps({ whatsapp, db }) as any);
    const result = await capturedProcessors[0](
      makeJob({ template: { key: 'meeting_confirmation', variables: {} } }),
    );
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
    expect(whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 'no_consent' });
  });

  it('closed window, consent, but NO configured template → blocked no_template', async () => {
    const whatsapp = makeWhatsAppMock();
    const db = makeDbMock({ lead: CLOSED_WINDOW_LEAD, tenantSettings: {} });
    createOutboundSenderWorker(makeDeps({ whatsapp, db }) as any);
    const result = await capturedProcessors[0](
      makeJob({ template: { key: 'meeting_confirmation', variables: {} } }),
    );
    expect(result).toMatchObject({ skipped: 'no_template' });
  });

  it('UChat-only deployment (no template support) → out-of-window is blocked', async () => {
    const whatsapp = { ...makeWhatsAppMock(), supportsTemplates: false };
    const db = makeDbMock({ lead: CLOSED_WINDOW_LEAD, tenantSettings: TEMPLATES });
    createOutboundSenderWorker(makeDeps({ whatsapp, db }) as any);
    const result = await capturedProcessors[0](makeJob({}));
    expect(result).toMatchObject({ skipped: 'provider_no_templates' });
  });

  it('unknown lead (no row) out of window → blocked, never a blind freeform', async () => {
    const whatsapp = makeWhatsAppMock();
    const db = makeDbMock({ lead: null, tenantSettings: TEMPLATES });
    createOutboundSenderWorker(makeDeps({ whatsapp, db }) as any);
    const result = await capturedProcessors[0](
      makeJob({ template: { key: 'meeting_confirmation', variables: {} } }),
    );
    expect(result).toMatchObject({ skipped: 'no_consent' });
  });
});
