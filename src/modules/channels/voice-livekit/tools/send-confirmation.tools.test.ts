import { llm } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import type { LastBooking, ToolRuntimeContext } from './tool-context.js';
import {
  emailConfirmation,
  sendEmailConfirmationSchema,
  sendEmailConfirmationTool,
  sendWhatsappConfirmationSchema,
  sendWhatsappConfirmationTool,
  whatsappConfirmationText,
} from './send-confirmation.tools.js';

const BOOKING: LastBooking = {
  uid: 'evt-1',
  start: '2026-07-26T07:00:00.000Z', // Sunday 10:00 Israel (IDT)
  meetLink: 'https://meet.google.com/abc',
  name: 'דנה לוי',
  email: 'dana@example.com',
  phone: '+972501234567',
  durationMinutes: 15,
  inviteSent: true,
};

function fakeRt(opts: { booking?: LastBooking | null; queue?: boolean } = {}) {
  const added: Array<{ name: string; data: Record<string, unknown> }> = [];
  const queue =
    opts.queue === false
      ? null
      : ({ add: vi.fn(async (name: string, data: Record<string, unknown>) => added.push({ name, data })) } as never);
  const rt = {
    tenantId: 'tenant-1',
    leadId: 'lead-1',
    callId: 'call-1',
    callerPhone: '+972501234567',
    report: { recordToolCall: vi.fn() },
    outboundQueue: queue,
    lastBooking: opts.booking === undefined ? BOOKING : opts.booking,
    lastCheckedDurationMinutes: null,
    bookingCompleted: true,
    endReason: null,
  } as unknown as ToolRuntimeContext;
  return { rt, added };
}

const runTool = (tool: { execute: (a: never, o: never) => Promise<unknown> }) =>
  tool.execute({} as never, { ctx: {}, toolCallId: 't', abortSignal: new AbortController().signal } as never);

describe('structural injection defense', () => {
  it('the schemas have NO destination parameters — nothing for a redirect to land in', () => {
    expect(Object.keys(sendWhatsappConfirmationSchema.shape)).toHaveLength(0);
    expect(Object.keys(sendEmailConfirmationSchema.shape)).toHaveLength(0);
  });
});

describe('send_whatsapp_confirmation', () => {
  it('queues the template job with slot variables + fallback text, claims QUEUED only', async () => {
    const { rt, added } = fakeRt();
    const out = (await runTool(sendWhatsappConfirmationTool(rt))) as string;

    expect(added).toHaveLength(1);
    expect(added[0]!.data).toMatchObject({
      tenantId: 'tenant-1',
      channel: 'whatsapp',
      to: '+972501234567',
      leadId: 'lead-1',
      template: {
        key: 'meeting_confirmation',
        variables: expect.objectContaining({ '1': 'דנה לוי', '3': 'https://meet.google.com/abc' }),
      },
    });
    expect(added[0]!.data.content).toContain('קרן'); // freeform fallback text rides along
    expect(out).toContain('queued');
    expect(out).not.toContain('delivered');
  });

  it('refuses before any booking — and instructs the model to claim nothing', async () => {
    const { rt, added } = fakeRt({ booking: null });
    await expect(runTool(sendWhatsappConfirmationTool(rt))).rejects.toThrowError(llm.ToolError);
    expect(added).toHaveLength(0);
  });

  it('refuses truthfully when messaging is down (queue null)', async () => {
    const { rt } = fakeRt({ queue: false });
    const err = await runTool(sendWhatsappConfirmationTool(rt)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(llm.ToolError);
    expect((err as Error).message).toContain('Do NOT tell the lead');
  });
});

describe('send_email_confirmation', () => {
  it('queues with a real Hebrew subject (no more hardcoded Follow up)', async () => {
    const { rt, added } = fakeRt();
    const out = (await runTool(sendEmailConfirmationTool(rt))) as string;
    expect(added[0]!.data).toMatchObject({ channel: 'email', to: 'dana@example.com' });
    expect(String(added[0]!.data.subject)).toContain('אישור פגישה');
    expect(out).toContain('queued');
  });
});

describe('message content', () => {
  it('WhatsApp text carries name, Hebrew slot, link, and the reply-to-reschedule hook', () => {
    const text = whatsappConfirmationText(BOOKING);
    expect(text).toContain('דנה לוי');
    expect(text).toContain('ביולי'); // formatSlotHe output
    expect(text).toContain('https://meet.google.com/abc');
    expect(text).toContain('תענה לי כאן');
  });

  it('meetLink line is DROPPED when absent — never a blank placeholder', () => {
    const text = whatsappConfirmationText({ ...BOOKING, meetLink: undefined });
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('לינק');
    const mail = emailConfirmation({ ...BOOKING, meetLink: undefined });
    expect(mail.body).not.toContain('קישור לפגישה');
  });
});
