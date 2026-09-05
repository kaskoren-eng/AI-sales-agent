/**
 * message-processor.worker tests
 *
 * Strategy: mock BullMQ's Worker constructor so no real Redis connection is
 * made.  Capture the processor function passed to `new Worker(...)` and invoke
 * it directly with a fake job object.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock BullMQ before importing the worker ───────────────────────────────
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

// ── Mock enqueueOutbound ───────────────────────────────────────────────────
vi.mock('../outbound-sender.queue.js', () => ({
  enqueueOutbound: vi.fn().mockResolvedValue({ id: 'outbound-job-1' }),
}));

// ── Mock AI engine ─────────────────────────────────────────────────────────
vi.mock('../../modules/ai-engine/index.js', () => ({
  AIEngineService: vi.fn().mockImplementation(() => ({
    generateResponse: vi.fn().mockResolvedValue('AI response text'),
  })),
}));

import { createMessageProcessorWorker } from './message-processor.worker.js';
import { enqueueOutbound } from '../outbound-sender.queue.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeDeps(dbOverrides: Partial<ReturnType<typeof makeMockDb>> = {}) {
  const db = { ...makeMockDb(), ...dbOverrides };
  const redis = { duplicate: vi.fn().mockReturnValue({}) };
  const outboundQueue = { add: vi.fn().mockResolvedValue({ id: 'q-job' }) };
  const env = {
    GOOGLE_AI_API_KEY: undefined, // No AI by default
    AI_MODEL: 'gemini-2.5-flash',
  } as any;

  return { db, redis, outboundQueue, env };
}

function makeMockDb() {
  const returningChain = (rows: any[]) => ({ returning: vi.fn().mockResolvedValue(rows) });
  const selectChain = (rows: any[]) => {
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(rows),
    };
    // orderBy returns itself so that .limit() still works after it
    chain.orderBy = vi.fn().mockReturnValue(chain);
    return chain;
  };

  return {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    // helpers stored for configuration in individual tests
    _selectChain: selectChain,
    _returningChain: returningChain,
  };
}

const TENANT_ID = 'tenant-abc';
const LEAD_ID = 'lead-uuid-1';
const CONV_ID = 'conv-uuid-1';

const SAMPLE_LEAD = {
  id: LEAD_ID,
  tenantId: TENANT_ID,
  phone: '+15551234567',
  email: null,
  status: 'new',
  source: 'whatsapp',
};

const SAMPLE_CONV = {
  id: CONV_ID,
  tenantId: TENANT_ID,
  leadId: LEAD_ID,
  channel: 'whatsapp',
  channelRef: 'wa-ref-1',
  status: 'active',
};

const HISTORY_ROWS = [
  { role: 'lead', content: 'Hello' },
  { role: 'agent', content: 'Hi there' },
];

function makeWhatsAppJob(overrides: Partial<any> = {}) {
  return {
    id: 'job-1',
    data: {
      tenantId: TENANT_ID,
      channel: 'whatsapp',
      channelRef: 'wa-ref-1',
      from: '+15551234567',
      content: 'Hello, I want to buy',
      contentType: 'text',
      rawPayload: {},
      ...overrides,
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
  };
}

function makeEmailJob(overrides: Partial<any> = {}) {
  return {
    id: 'job-2',
    data: {
      tenantId: TENANT_ID,
      channel: 'email',
      channelRef: 'email-ref-1',
      from: 'lead@example.com',
      content: 'Subject: interested',
      contentType: 'text',
      rawPayload: {},
      ...overrides,
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('message-processor worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedProcessors.length = 0;
  });

  it('processes a whatsapp message — finds existing lead + conversation', async () => {
    const deps = makeDeps();
    const { db } = deps;

    // select() calls: findOrCreateLead, findOrCreateConversation, load history
    let selectCallCount = 0;
    db.select.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) return db._selectChain([SAMPLE_LEAD]); // lead exists
      if (selectCallCount === 2) return db._selectChain([SAMPLE_CONV]);  // conv exists
      return db._selectChain(HISTORY_ROWS); // history
    });

    // insert for the two messages
    db.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{}]) }) });

    // update not called (lead is 'new' — update happens)
    db.update.mockReturnValue({ set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) });

    createMessageProcessorWorker(deps as any);
    const processor = capturedProcessors[0];
    expect(processor).toBeDefined();

    const result = await processor(makeWhatsAppJob());

    expect(result).toMatchObject({ leadId: LEAD_ID, conversationId: CONV_ID });
    expect(enqueueOutbound).toHaveBeenCalledOnce();
    const outboundCall = (enqueueOutbound as any).mock.calls[0];
    expect(outboundCall[1].channel).toBe('whatsapp');
    expect(outboundCall[1].to).toBe('+15551234567');
  });

  it('processes an email channel job — uses email identifier', async () => {
    const deps = makeDeps();
    const { db } = deps;

    const emailLead = { ...SAMPLE_LEAD, email: 'lead@example.com', phone: null, id: 'lead-email-1', source: 'email' };
    const emailConv = { ...SAMPLE_CONV, id: 'conv-email-1', channel: 'email', leadId: 'lead-email-1' };

    let selectCallCount = 0;
    db.select.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) return db._selectChain([emailLead]);
      if (selectCallCount === 2) return db._selectChain([emailConv]);
      return db._selectChain(HISTORY_ROWS);
    });

    db.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{}]) }) });
    db.update.mockReturnValue({ set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) });

    createMessageProcessorWorker(deps as any);
    const processor = capturedProcessors[0];

    const result = await processor(makeEmailJob());

    expect(result).toMatchObject({ leadId: 'lead-email-1', conversationId: 'conv-email-1' });
    expect(enqueueOutbound).toHaveBeenCalledOnce();
    const outboundCall = (enqueueOutbound as any).mock.calls[0];
    expect(outboundCall[1].channel).toBe('email');
    expect(outboundCall[1].to).toBe('lead@example.com');
  });

  it('creates new lead + conversation when none exist', async () => {
    const deps = makeDeps();
    const { db } = deps;

    const newLead = { ...SAMPLE_LEAD, id: 'lead-new', status: 'new' };
    const newConv = { ...SAMPLE_CONV, id: 'conv-new', leadId: 'lead-new' };

    let selectCallCount = 0;
    db.select.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) return db._selectChain([]);  // no existing lead
      if (selectCallCount === 2) return db._selectChain([]);  // no existing conv
      return db._selectChain(HISTORY_ROWS);
    });

    // insert returns new lead, then new conv, then messages
    let insertCallCount = 0;
    db.insert.mockImplementation(() => {
      insertCallCount++;
      if (insertCallCount === 1) return { values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([newLead]) }) };
      if (insertCallCount === 2) return { values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([newConv]) }) };
      return { values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{}]) }) };
    });

    db.update.mockReturnValue({ set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) });

    createMessageProcessorWorker(deps as any);
    const processor = capturedProcessors[0];

    const result = await processor(makeWhatsAppJob());

    expect(result).toMatchObject({ leadId: 'lead-new', conversationId: 'conv-new' });
    // update called because lead.status === 'new'
    expect(db.update).toHaveBeenCalled();
  });

  it('updates lead status from new to contacted', async () => {
    const deps = makeDeps();
    const { db } = deps;

    const newLead = { ...SAMPLE_LEAD, status: 'new' };

    let selectCallCount = 0;
    db.select.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) return db._selectChain([newLead]);
      if (selectCallCount === 2) return db._selectChain([SAMPLE_CONV]);
      return db._selectChain(HISTORY_ROWS);
    });

    db.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{}]) }) });

    const setMock = vi.fn().mockReturnThis();
    const whereMock = vi.fn().mockResolvedValue([]);
    db.update.mockReturnValue({ set: setMock, where: whereMock });

    createMessageProcessorWorker(deps as any);
    const processor = capturedProcessors[0];

    await processor(makeWhatsAppJob());

    expect(db.update).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'contacted' }));
  });

  it('does NOT update lead status when already qualifying (no further auto-transition)', async () => {
    const deps = makeDeps();
    const { db } = deps;

    const contactedLead = { ...SAMPLE_LEAD, status: 'qualifying' };

    let selectCallCount = 0;
    db.select.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) return db._selectChain([contactedLead]);
      if (selectCallCount === 2) return db._selectChain([SAMPLE_CONV]);
      return db._selectChain(HISTORY_ROWS);
    });

    db.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{}]) }) });
    db.update.mockReturnValue({ set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) });

    createMessageProcessorWorker(deps as any);
    const processor = capturedProcessors[0];

    await processor(makeWhatsAppJob());

    expect(db.update).not.toHaveBeenCalled();
  });

  it('uses fallback message when AI engine is not configured', async () => {
    const deps = makeDeps({ } as any); // GOOGLE_AI_API_KEY is undefined
    const { db } = deps;

    let selectCallCount = 0;
    db.select.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) return db._selectChain([SAMPLE_LEAD]);
      if (selectCallCount === 2) return db._selectChain([SAMPLE_CONV]);
      return db._selectChain(HISTORY_ROWS);
    });

    db.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{}]) }) });
    db.update.mockReturnValue({ set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) });

    createMessageProcessorWorker(deps as any);
    const processor = capturedProcessors[0];

    await processor(makeWhatsAppJob());

    // enqueueOutbound is called with the fallback content
    expect(enqueueOutbound).toHaveBeenCalledOnce();
    const outboundCall = (enqueueOutbound as any).mock.calls[0];
    expect(outboundCall[1].content).toMatch(/team member/i);
  });

  it('enqueues to outbound queue with correct job shape', async () => {
    const deps = makeDeps();
    const { db } = deps;

    let selectCallCount = 0;
    db.select.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) return db._selectChain([SAMPLE_LEAD]);
      if (selectCallCount === 2) return db._selectChain([SAMPLE_CONV]);
      return db._selectChain(HISTORY_ROWS);
    });

    db.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{}]) }) });
    db.update.mockReturnValue({ set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) });

    createMessageProcessorWorker(deps as any);
    const processor = capturedProcessors[0];

    await processor(makeWhatsAppJob());

    expect(enqueueOutbound).toHaveBeenCalledOnce();
    const [_queue, jobData] = (enqueueOutbound as any).mock.calls[0];
    expect(jobData).toMatchObject({
      tenantId: TENANT_ID,
      channel: 'whatsapp',
      to: '+15551234567',
      conversationId: CONV_ID,
    });
    expect(typeof jobData.content).toBe('string');
    expect(jobData.content.length).toBeGreaterThan(0);
  });
});

/**
 * THE STOP GUARDRAIL, on the inbound text path (Koren, 2026-09-04).
 *
 * Until this existed, `opted_out` had exactly one writer in the codebase — the voice agent's
 * `end_call` tool — so a lead who typed "תפסיקו לשלוח לי" into WhatsApp was dialled by the
 * callback ladder the next morning. There is no OpenAI key in these deps, which is deliberate:
 * every guarantee below must hold on the deterministic phrase lists alone.
 */
describe('message-processor worker — when the lead says stop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedProcessors.length = 0;
  });

  function stopDeps(lead: any) {
    const deps = makeDeps();
    const { db } = deps;
    let n = 0;
    db.select.mockImplementation(() => {
      n++;
      if (n === 1) return db._selectChain([lead]);
      if (n === 2) return db._selectChain([SAMPLE_CONV]);
      return db._selectChain(HISTORY_ROWS);
    });
    db.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{}]) }) });
    db.update.mockReturnValue({ set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) });
    return deps;
  }

  /** Every `set({...})` payload written to any table during the run. */
  function setsFrom(db: any): Record<string, unknown>[] {
    return db.update.mock.results
      .map((r: any) => r.value?.set?.mock?.calls?.[0]?.[0])
      .filter(Boolean);
  }

  it('a do-not-call message opts the lead out and sends NO reply', async () => {
    const deps = stopDeps({ ...SAMPLE_LEAD, status: 'contacted' });
    createMessageProcessorWorker(deps as any);
    const out = await capturedProcessors[0](makeWhatsAppJob({ content: 'תפסיקו לשלוח לי הודעות' }));

    expect(out).toMatchObject({ stopped: 'hard_stop', action: 'opted_out' });
    expect(setsFrom(deps.db).some((s) => s.status === 'opted_out')).toBe(true);
    // Replying to somebody who just told us to stop is the complaint we are avoiding.
    expect(enqueueOutbound).not.toHaveBeenCalled();
  });

  it('THE BUG THIS FIXES: a QUALIFIED lead can still opt out', async () => {
    // The terminal-status early return used to fire first, so a `qualified` lead's do-not-call
    // request was read, dropped on the floor, and never recorded anywhere.
    const deps = stopDeps({ ...SAMPLE_LEAD, status: 'qualified' });
    createMessageProcessorWorker(deps as any);
    const out = await capturedProcessors[0](makeWhatsAppJob({ content: 'אל תתקשרו אליי יותר' }));

    expect(out).toMatchObject({ stopped: 'hard_stop' });
    expect(setsFrom(deps.db).some((s) => s.status === 'opted_out')).toBe(true);
  });

  it('"לא מעוניין" is a SOFT stop — the ladder ends, the person is not blacklisted', async () => {
    const deps = stopDeps({ ...SAMPLE_LEAD, status: 'contacted' });
    createMessageProcessorWorker(deps as any);
    const out = await capturedProcessors[0](makeWhatsAppJob({ content: 'לא מעוניין תודה' }));

    expect(out).toMatchObject({ stopped: 'soft_stop', action: 'followup_stopped' });
    const sets = setsFrom(deps.db);
    expect(sets.some((s) => s.followupStoppedAt instanceof Date)).toBe(true);
    // Crucially NOT opted out: he refused the offer, he did not forbid contact.
    expect(sets.some((s) => s.status === 'opted_out')).toBe(false);
  });

  it('"תתקשר אליי מחר" is NOT a stop — it is the callback the whole model exists for', async () => {
    const deps = stopDeps({ ...SAMPLE_LEAD, status: 'contacted' });
    createMessageProcessorWorker(deps as any);
    const out = await capturedProcessors[0](
      makeWhatsAppJob({ content: 'אני עסוק עכשיו, תתקשר אליי מחר בבוקר' }),
    );

    expect(out).not.toHaveProperty('stopped');
    expect(setsFrom(deps.db).some((s) => s.status === 'opted_out')).toBe(false);
  });

  it('a lead who comes back has his soft stop lifted', async () => {
    const deps = stopDeps({
      ...SAMPLE_LEAD,
      status: 'contacted',
      followupStoppedAt: new Date('2026-09-01T10:00:00.000Z'),
    });
    createMessageProcessorWorker(deps as any);
    await capturedProcessors[0](makeWhatsAppJob({ content: 'רגע, כמה זה עולה?' }));

    expect(setsFrom(deps.db).some((s) => s.followupStoppedAt === null)).toBe(true);
  });

  it('a BRAND NEW lead whose first message is "stop" does not get the lead-intake flow', async () => {
    // The intake flow calls him. Detecting the stop after it would ring somebody who had just
    // asked, in writing, not to be rung.
    const deps = makeDeps();
    const { db } = deps;
    let n = 0;
    db.select.mockImplementation(() => {
      n++;
      if (n === 1) return db._selectChain([]); // no lead → one is created
      if (n === 2) return db._selectChain([SAMPLE_CONV]);
      return db._selectChain(HISTORY_ROWS);
    });
    db.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ ...SAMPLE_LEAD, status: 'new' }]) }),
    });
    db.update.mockReturnValue({ set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) });

    createMessageProcessorWorker(deps as any);
    const out = await capturedProcessors[0](makeWhatsAppJob({ content: 'STOP' }));

    expect(out).toMatchObject({ stopped: 'hard_stop' });
    expect(out).not.toHaveProperty('triggeredFlow');
  });
});
