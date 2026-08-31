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

function fakeRt(
  opts: {
    booking?: LastBooking | null;
    queue?: boolean;
    /** Tenant has an approved `meeting_confirmation` template AND a Twilio-capable provider. */
    templateReady?: boolean;
  } = {},
) {
  const templateReady = opts.templateReady ?? true;
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
    env: { TWILIO_ACCOUNT_SID: templateReady ? 'AC_test' : undefined },
    settings: templateReady
      ? { whatsapp_templates: { meeting_confirmation: { contentSid: 'HX_MC' } } }
      : {},
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

/**
 * A MEETING BOOKED WITH NO EMAIL (2026-08-31) — and the promise that goes with it.
 *
 * `book_meeting` may now be called with `email: null` rather than lose an agreed demo to a field
 * that will not cross a phone line. Two consequences are pinned here: there is nothing for
 * `send_email_confirmation` to send to, and the WhatsApp result must stop encouraging a promise
 * the outbound worker cannot keep.
 */
describe('the no-email booking', () => {
  const NO_EMAIL: LastBooking = { ...BOOKING, email: null, inviteSent: false };

  it('send_email_confirmation refuses, and tells her not to claim one or re-ask for the address', async () => {
    const { rt, added } = fakeRt({ booking: NO_EMAIL });
    const err = (await runTool(sendEmailConfirmationTool(rt)).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(llm.ToolError);
    expect(err.message).toMatch(/do not ask him for the address again/iu);
    expect(added).toHaveLength(0);
  });

  it('send_whatsapp_confirmation still works — it is the whole point of the fallback', async () => {
    const { rt, added } = fakeRt({ booking: NO_EMAIL });
    const out = (await runTool(sendWhatsappConfirmationTool(rt))) as string;
    expect(added).toHaveLength(1);
    expect(added[0]!.data).toMatchObject({ channel: 'whatsapp', to: '+972501234567' });
    expect(out).toContain('queued');
  });
});

/**
 * "QUEUED" WAS NEVER "WILL ARRIVE".
 *
 * A lead who has only ever PHONED us has no open 24-hour WhatsApp window, so the outbound worker
 * takes the business-initiated path: without a Twilio-capable provider AND an approved
 * `meeting_confirmation` template it logs `whatsapp_send_blocked` and drops the job — returning
 * success. Nothing failed loudly enough for the agent to know, so she promised a message nobody
 * sent. Both preconditions are readable in the tool, so it now tells the model the truth.
 */
describe('send_whatsapp_confirmation — deliverability pre-flight', () => {
  it('with a configured template, she may say the message is on its way', async () => {
    const { rt } = fakeRt();
    const out = (await runTool(sendWhatsappConfirmationTool(rt))) as string;
    expect(out).toMatch(/on its way/u);
    expect(out).not.toMatch(/Do NOT tell him/u);
  });

  it('with NO template, the job is still queued but she is told not to promise it', async () => {
    const { rt, added } = fakeRt({ templateReady: false });
    const out = (await runTool(sendWhatsappConfirmationTool(rt))) as string;
    // Still queued: a lead whose 24h window IS open gets the freeform message.
    expect(added).toHaveLength(1);
    expect(out).toContain('queued');
    expect(out).toMatch(/Do NOT tell him a WhatsApp is coming/u);
    expect(out).not.toMatch(/You may tell the lead a WhatsApp message is on its way/u);
  });
});
