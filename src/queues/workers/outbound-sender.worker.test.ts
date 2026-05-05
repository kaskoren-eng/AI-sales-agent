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
  };
}

function makeEmailMock() {
  return {
    sendEmail: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDeps(overrides: Partial<{ whatsapp: any; email: any }> = {}) {
  return {
    db: {} as any,
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

    const result = await processor(
      makeJob({ channel: 'whatsapp', to: '+1999', content: 'test', conversationId: 'conv-xyz' }),
    );

    expect(result).toEqual({ channel: 'whatsapp', to: '+1999', conversationId: 'conv-xyz' });
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
});
