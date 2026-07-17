/**
 * flow-executor.worker tests
 *
 * Strategy: mock BullMQ Worker and the enqueueFlowStep helper so no Redis
 * connection is made. Capture the processor and invoke it directly.
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

// ── Mock enqueueFlowStep ───────────────────────────────────────────────────
vi.mock('../flow-executor.queue.js', () => ({
  enqueueFlowStep: vi.fn().mockResolvedValue({ id: 'next-step-job' }),
}));

import { createFlowExecutorWorker } from './flow-executor.worker.js';
import { enqueueFlowStep } from '../flow-executor.queue.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-flow-1';
const LEAD_ID = 'lead-flow-1';

/** Build a simple single-step send_whatsapp flow stored in tenant settings. */
function makeTenantWithFlow(flowName: string, steps: any[], enabled = true) {
  return {
    settings: {
      flows: {
        [flowName]: {
          enabled,
          steps,
        },
      },
    },
  };
}

const WHATSAPP_STEP = {
  type: 'send_whatsapp',
  delayMinutes: 0,
  content: { messageType: 'text', text: 'Hello {{name}}!' },
};

const EMAIL_SEND_STEP = {
  type: 'send_whatsapp',
  delayMinutes: 5,
  content: { messageType: 'text', text: 'Follow up for {{name}}' },
};

const CALL_STEP = {
  type: 'make_call',
  delayMinutes: 10,
};

function makeSelectChain(rows: any[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
}

function makeDeps(overrides: Partial<any> = {}): any {
  const db = {
    select: vi.fn(),
  };
  return {
    db: db as any,
    env: { AI_MODEL: 'gemini-2.5-flash' } as any,
    redis: { duplicate: vi.fn().mockReturnValue({}) } as any,
    flowExecutorQueue: { add: vi.fn().mockResolvedValue({ id: 'q-job' }) } as any,
    ...overrides,
  };
}

function makeJob(overrides: Partial<any> = {}) {
  return {
    id: 'flow-job-1',
    data: {
      tenantId: TENANT_ID,
      leadId: LEAD_ID,
      flowName: 'onboarding',
      stepIndex: 0,
      leadPhone: '+15551234567',
      leadName: 'Alice',
      leadEmail: 'alice@example.com',
      ...overrides,
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('flow-executor worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedProcessors.length = 0;
  });

  // ── send_whatsapp step ────────────────────────────────────────────────────

  it('send_whatsapp step — calls whatsapp.sendMessage with interpolated text', async () => {
    const tenant = makeTenantWithFlow('onboarding', [WHATSAPP_STEP]);
    const deps = makeDeps();
    deps.db.select.mockReturnValue(makeSelectChain([tenant]));

    const whatsapp = { sendMessage: vi.fn().mockResolvedValue(undefined), sendVideo: vi.fn() };
    deps.whatsapp = whatsapp;

    createFlowExecutorWorker(deps);
    const processor = capturedProcessors[0];

    const result = await processor(makeJob({ stepIndex: 0 }));

    expect(whatsapp.sendMessage).toHaveBeenCalledOnce();
    // {{name}} interpolated with leadName
    expect(whatsapp.sendMessage).toHaveBeenCalledWith('+15551234567', 'Hello Alice!');
    expect(result).toMatchObject({
      tenantId: TENANT_ID,
      leadId: LEAD_ID,
      flowName: 'onboarding',
      stepIndex: 0,
      action: 'send_whatsapp',
    });
  });

  it('send_whatsapp step — uses "there" when leadName is missing', async () => {
    const tenant = makeTenantWithFlow('onboarding', [WHATSAPP_STEP]);
    const deps = makeDeps();
    deps.db.select.mockReturnValue(makeSelectChain([tenant]));

    const whatsapp = { sendMessage: vi.fn().mockResolvedValue(undefined), sendVideo: vi.fn() };
    deps.whatsapp = whatsapp;

    createFlowExecutorWorker(deps);
    const processor = capturedProcessors[0];

    await processor(makeJob({ stepIndex: 0, leadName: undefined }));

    expect(whatsapp.sendMessage).toHaveBeenCalledWith('+15551234567', 'Hello there!');
  });

  it('send_whatsapp step — calls sendVideo for video messageType', async () => {
    const videoStep = {
      type: 'send_whatsapp',
      delayMinutes: 0,
      content: { messageType: 'video', url: 'https://example.com/v.mp4', caption: 'Watch this {{name}}' },
    };
    const tenant = makeTenantWithFlow('onboarding', [videoStep]);
    const deps = makeDeps();
    deps.db.select.mockReturnValue(makeSelectChain([tenant]));

    const whatsapp = { sendMessage: vi.fn(), sendVideo: vi.fn().mockResolvedValue(undefined) };
    deps.whatsapp = whatsapp;

    createFlowExecutorWorker(deps);
    const processor = capturedProcessors[0];

    await processor(makeJob({ stepIndex: 0 }));

    expect(whatsapp.sendVideo).toHaveBeenCalledOnce();
    expect(whatsapp.sendVideo).toHaveBeenCalledWith(
      '+15551234567',
      'https://example.com/v.mp4',
      'Watch this Alice',
    );
  });

  it('send_whatsapp step — skips gracefully when WhatsApp service not configured', async () => {
    const tenant = makeTenantWithFlow('onboarding', [WHATSAPP_STEP]);
    const deps = makeDeps();
    deps.db.select.mockReturnValue(makeSelectChain([tenant]));
    // No whatsapp service

    createFlowExecutorWorker(deps);
    const processor = capturedProcessors[0];

    // Should NOT throw
    const result = await processor(makeJob({ stepIndex: 0 }));
    expect(result).toMatchObject({ action: 'send_whatsapp' });
  });

  // ── wait step (delayMinutes on next step) ─────────────────────────────────

  it('enqueues next step with correct delay when next step has delayMinutes', async () => {
    const steps = [
      WHATSAPP_STEP, // step 0
      { ...EMAIL_SEND_STEP, delayMinutes: 30 }, // step 1 — 30-minute delay
    ];
    const tenant = makeTenantWithFlow('onboarding', steps);
    const deps = makeDeps();
    deps.db.select.mockReturnValue(makeSelectChain([tenant]));

    const whatsapp = { sendMessage: vi.fn().mockResolvedValue(undefined), sendVideo: vi.fn() };
    deps.whatsapp = whatsapp;

    createFlowExecutorWorker(deps);
    const processor = capturedProcessors[0];

    await processor(makeJob({ stepIndex: 0 }));

    expect(enqueueFlowStep).toHaveBeenCalledOnce();
    const [_queue, jobData, delayMs] = (enqueueFlowStep as any).mock.calls[0];
    expect(jobData.stepIndex).toBe(1);
    expect(delayMs).toBe(30 * 60_000);
  });

  it('does NOT enqueue next step when current step is the last one', async () => {
    const tenant = makeTenantWithFlow('onboarding', [WHATSAPP_STEP]); // only 1 step
    const deps = makeDeps();
    deps.db.select.mockReturnValue(makeSelectChain([tenant]));

    const whatsapp = { sendMessage: vi.fn().mockResolvedValue(undefined), sendVideo: vi.fn() };
    deps.whatsapp = whatsapp;

    createFlowExecutorWorker(deps);
    const processor = capturedProcessors[0];

    await processor(makeJob({ stepIndex: 0 }));

    expect(enqueueFlowStep).not.toHaveBeenCalled();
  });

  // ── make_call step ────────────────────────────────────────────────────────

  it('make_call step — calls voice.initiateOutboundCall', async () => {
    const tenant = makeTenantWithFlow('onboarding', [CALL_STEP]);
    const deps = makeDeps();
    deps.db.select.mockReturnValue(makeSelectChain([tenant]));

    const voice = { initiateOutboundCall: vi.fn().mockResolvedValue('call-sid') };
    deps.voice = voice;

    createFlowExecutorWorker(deps);
    const processor = capturedProcessors[0];

    const result = await processor(makeJob({ stepIndex: 0 }));

    expect(voice.initiateOutboundCall).toHaveBeenCalledOnce();
    expect(voice.initiateOutboundCall).toHaveBeenCalledWith('+15551234567', TENANT_ID, {
      name: 'Alice',
      email: 'alice@example.com',
      phone: '+15551234567',
    });
    expect(result).toMatchObject({ action: 'make_call' });
  });

  it('make_call step — NEVER dials an opted_out lead (Retell engine)', async () => {
    const tenant = makeTenantWithFlow('onboarding', [CALL_STEP]);
    const deps = makeDeps();
    deps.db.select
      .mockReturnValueOnce(makeSelectChain([tenant])) // flow lookup
      .mockReturnValueOnce(makeSelectChain([{ status: 'opted_out' }])); // DNC check

    const voice = { initiateOutboundCall: vi.fn() };
    deps.voice = voice;

    createFlowExecutorWorker(deps);
    const processor = capturedProcessors[0];

    const result = await processor(makeJob({ stepIndex: 0 }));

    expect(voice.initiateOutboundCall).not.toHaveBeenCalled();
    expect(result).toMatchObject({ action: 'make_call' });
  });

  it('make_call step — NEVER dials an opted_out lead (LiveKit engine)', async () => {
    const tenant = makeTenantWithFlow('onboarding', [CALL_STEP]);
    (tenant.settings as any).voice_engine = 'livekit';
    const deps = makeDeps();
    deps.db.select
      .mockReturnValueOnce(makeSelectChain([tenant]))
      .mockReturnValueOnce(makeSelectChain([{ status: 'opted_out' }]));

    const voiceLivekit = { initiateOutboundCall: vi.fn() };
    deps.voiceLivekit = voiceLivekit;
    deps.voice = { initiateOutboundCall: vi.fn() };

    createFlowExecutorWorker(deps);
    const processor = capturedProcessors[0];

    await processor(makeJob({ stepIndex: 0 }));

    expect(voiceLivekit.initiateOutboundCall).not.toHaveBeenCalled();
    expect(deps.voice.initiateOutboundCall).not.toHaveBeenCalled();
  });

  it('make_call step — skips when voice service not configured', async () => {
    const tenant = makeTenantWithFlow('onboarding', [CALL_STEP]);
    const deps = makeDeps();
    deps.db.select.mockReturnValue(makeSelectChain([tenant]));
    // No voice service

    createFlowExecutorWorker(deps);
    const processor = capturedProcessors[0];

    // Should not throw
    const result = await processor(makeJob({ stepIndex: 0 }));
    expect(result).toMatchObject({ action: 'make_call' });
  });

  // ── Edge / error cases ────────────────────────────────────────────────────

  it('returns undefined when tenant is not found', async () => {
    const deps = makeDeps();
    deps.db.select.mockReturnValue(makeSelectChain([]));

    createFlowExecutorWorker(deps);
    const processor = capturedProcessors[0];

    const result = await processor(makeJob());

    expect(result).toBeUndefined();
    expect(enqueueFlowStep).not.toHaveBeenCalled();
  });

  it('returns undefined when flow is not found in tenant settings', async () => {
    const tenant = { settings: { flows: {} } }; // no 'onboarding' flow
    const deps = makeDeps();
    deps.db.select.mockReturnValue(makeSelectChain([tenant]));

    createFlowExecutorWorker(deps);
    const processor = capturedProcessors[0];

    const result = await processor(makeJob({ flowName: 'onboarding' }));

    expect(result).toBeUndefined();
  });

  it('returns undefined when flow is disabled', async () => {
    const tenant = makeTenantWithFlow('onboarding', [WHATSAPP_STEP], false /* disabled */);
    const deps = makeDeps();
    deps.db.select.mockReturnValue(makeSelectChain([tenant]));

    const whatsapp = { sendMessage: vi.fn(), sendVideo: vi.fn() };
    deps.whatsapp = whatsapp;

    createFlowExecutorWorker(deps);
    const processor = capturedProcessors[0];

    const result = await processor(makeJob());

    expect(result).toBeUndefined();
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  it('returns undefined when stepIndex is out of bounds', async () => {
    const tenant = makeTenantWithFlow('onboarding', [WHATSAPP_STEP]); // only step 0
    const deps = makeDeps();
    deps.db.select.mockReturnValue(makeSelectChain([tenant]));

    createFlowExecutorWorker(deps);
    const processor = capturedProcessors[0];

    const result = await processor(makeJob({ stepIndex: 99 }));

    expect(result).toBeUndefined();
  });

  it('returns undefined when flow config fails Zod validation', async () => {
    const tenant = {
      settings: {
        flows: {
          onboarding: {
            enabled: true,
            steps: [{ type: 'invalid_step_type', delayMinutes: 0 }], // invalid
          },
        },
      },
    };
    const deps = makeDeps();
    deps.db.select.mockReturnValue(makeSelectChain([tenant]));

    createFlowExecutorWorker(deps);
    const processor = capturedProcessors[0];

    const result = await processor(makeJob());

    expect(result).toBeUndefined();
  });

  it('passes correct job data to enqueueFlowStep for next step', async () => {
    const steps = [WHATSAPP_STEP, CALL_STEP];
    const tenant = makeTenantWithFlow('nurture', steps);
    const deps = makeDeps();
    deps.db.select.mockReturnValue(makeSelectChain([tenant]));

    const whatsapp = { sendMessage: vi.fn().mockResolvedValue(undefined), sendVideo: vi.fn() };
    deps.whatsapp = whatsapp;

    createFlowExecutorWorker(deps);
    const processor = capturedProcessors[0];

    await processor(makeJob({ flowName: 'nurture', stepIndex: 0 }));

    expect(enqueueFlowStep).toHaveBeenCalledOnce();
    const [, jobData] = (enqueueFlowStep as any).mock.calls[0];
    expect(jobData).toMatchObject({
      tenantId: TENANT_ID,
      leadId: LEAD_ID,
      flowName: 'nurture',
      stepIndex: 1,
      leadPhone: '+15551234567',
      leadName: 'Alice',
      leadEmail: 'alice@example.com',
    });
  });
});
