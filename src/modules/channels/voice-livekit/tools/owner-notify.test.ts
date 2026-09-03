import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { notifyOwner } from './owner-notify.js';
import type { HandoffSettings } from './handoff-settings.js';
import type { ToolRuntimeContext } from './tool-context.js';

/**
 * THE OWNER PING, extracted from `request-human-handoff.tool.ts` on 2026-09-03 so the mid-call
 * disconnect could reuse it instead of growing a second copy.
 *
 * THE REAL PROOF OF A CLEAN EXTRACTION IS NOT IN THIS FILE. It is that
 * `request-human-handoff.tool.test.ts` was NOT TOUCHED and stayed green: those tests assert the
 * queued WhatsApp and email jobs field by field — channel, recipient, template key, the four
 * template variables, the `notifyRole: 'owner'` metadata, the `<br>` email body — so if the move
 * had changed any of it, they would have said so.
 *
 * What this file adds is the properties the handoff tests could not see, because the handoff only
 * ever exercises one shape: that the parameterised bits are genuinely parameterised (a caller can
 * send a different body, subject, template and log prefix), and that the contract every caller
 * depends on holds for a NEW caller too — this function never throws, whatever the tenant has
 * configured and whatever Redis is doing.
 */

const OWNER: HandoffSettings = {
  ownerName: 'קורן',
  ownerPhone: '+972501112222',
  ownerEmail: 'koren@clickscales.com',
  notify: ['whatsapp', 'email'],
};

function fakeRt(opts: { queue?: false | 'hangs' | 'throws' } = {}) {
  const added: Array<{ name: string; data: Record<string, unknown> }> = [];
  const queue =
    opts.queue === false
      ? null
      : opts.queue === 'hangs'
        ? ({ add: vi.fn(() => new Promise(() => undefined)) } as never)
        : opts.queue === 'throws'
          ? ({ add: vi.fn(async () => { throw new Error('redis down'); }) } as never)
          : ({
              add: vi.fn(async (name: string, data: Record<string, unknown>) => {
                added.push({ name, data });
              }),
            } as never);
  const rt = {
    tenantId: 'tenant-1',
    callId: 'room-1',
    outboundQueue: queue,
  } as unknown as ToolRuntimeContext;
  return { rt, added };
}

const ALERT = {
  leadId: 'lead-1',
  text: 'שורה ראשונה\nשורה שנייה',
  subject: 'נושא',
  template: { key: 'handoff_alert' as const, variables: { '1': 'א', '2': 'ב' } },
  logPrefix: 'handoff',
};

describe('notifyOwner — the shape both callers depend on', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('queues WhatsApp and email to the configured OWNER, never to the lead', () => {
    const { rt, added } = fakeRt();
    return notifyOwner(rt, OWNER, ALERT).then((channels) => {
      expect(channels).toEqual(['whatsapp', 'email']);
      const [wa, mail] = added.map((a) => a.data);
      expect(wa).toMatchObject({ channel: 'whatsapp', to: OWNER.ownerPhone, content: ALERT.text });
      expect(mail).toMatchObject({ channel: 'email', to: OWNER.ownerEmail, subject: 'נושא' });
      // The one transformation the function still owns: the email body is the same text with the
      // newlines turned into <br>. It is not a parameter because both callers want it.
      expect(mail.content).toBe('שורה ראשונה<br>שורה שנייה');
      // notifyRole:'owner' is what tells the outbound worker that the configured owner phone is
      // consent. Losing it in the move would have silently stopped every alert at the consent gate.
      expect((wa.metadata as Record<string, unknown>).notifyRole).toBe('owner');
      expect((wa.metadata as Record<string, unknown>).source).toBe('voice-livekit');
      expect(wa.leadId).toBe('lead-1');
    });
  });

  it('carries whatever template the caller passes — this is what the disconnect alert needed', async () => {
    const { rt, added } = fakeRt();
    await notifyOwner(rt, OWNER, {
      ...ALERT,
      template: { key: 'disconnect_alert', variables: { '1': 'דנה', '3': 'נותק באמצע הבירור' } },
    });
    expect((added[0]!.data.template as { key: string }).key).toBe('disconnect_alert');
    expect((added[0]!.data.template as { variables: Record<string, string> }).variables['3']).toBe(
      'נותק באמצע הבירור',
    );
  });

  it('sends freeform with NO template when the caller omits one', async () => {
    const { rt, added } = fakeRt();
    const { template, ...noTemplate } = ALERT;
    void template;
    await notifyOwner(rt, OWNER, noTemplate);
    expect(added[0]!.data).not.toHaveProperty('template');
    expect(added[0]!.data.content).toBe(ALERT.text);
  });

  it('honours `notify` in BOTH directions — email-only sends no WhatsApp, and vice versa', async () => {
    // Both halves, because each branch has its own `cfg.notify.includes(...)` test and a mutation
    // that drops one of them survives a suite that only ever checks the other.
    const emailOnly = fakeRt();
    expect(await notifyOwner(emailOnly.rt, { ...OWNER, notify: ['email'] }, ALERT)).toEqual(['email']);
    expect(emailOnly.added).toHaveLength(1);
    expect(emailOnly.added[0]!.data.channel).toBe('email');

    const waOnly = fakeRt();
    expect(await notifyOwner(waOnly.rt, { ...OWNER, notify: ['whatsapp'] }, ALERT)).toEqual(['whatsapp']);
    expect(waOnly.added).toHaveLength(1);
    expect(waOnly.added[0]!.data.channel).toBe('whatsapp');
  });

  it('skips a channel with no destination configured, rather than queueing to nowhere', async () => {
    const { rt, added } = fakeRt();
    const channels = await notifyOwner(rt, { ...OWNER, ownerPhone: null }, ALERT);
    expect(channels).toEqual(['email']);
    expect(added).toHaveLength(1);
  });
});

describe('notifyOwner — it never throws, whatever is broken', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('no queue at all → an empty result and a log line', async () => {
    const { rt } = fakeRt({ queue: false });
    await expect(notifyOwner(rt, OWNER, ALERT)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith('handoff_notify_skipped', expect.any(String));
  });

  it('a throwing queue → an empty result, never a rejection', async () => {
    const { rt } = fakeRt({ queue: 'throws' });
    await expect(notifyOwner(rt, OWNER, ALERT)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith('handoff_notify_failed', expect.any(String));
  });

  it('a HUNG Redis is timeboxed — nothing waits on it', async () => {
    // The caller is on the phone (handoff) or the worker is in teardown (disconnect). Neither can
    // afford to block on an unreachable queue.
    const { rt } = fakeRt({ queue: 'hangs' });
    const started = Date.now();
    await expect(notifyOwner(rt, OWNER, ALERT)).resolves.toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('an unconfigured owner is a LOUD log, not a silent nothing', async () => {
    const { rt } = fakeRt();
    const channels = await notifyOwner(
      rt,
      { ownerName: null, ownerPhone: null, ownerEmail: null, notify: ['whatsapp', 'email'] },
      ALERT,
    );
    expect(channels).toEqual([]);
    expect(warn).toHaveBeenCalledWith('handoff_owner_not_notified', expect.any(String));
  });

  it('the log prefix follows the CALLER, so one grep separates the two alert kinds', async () => {
    const { rt } = fakeRt({ queue: false });
    await notifyOwner(rt, OWNER, { ...ALERT, logPrefix: 'disconnect' });
    expect(warn).toHaveBeenCalledWith('disconnect_notify_skipped', expect.any(String));
  });
});
