import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../db/client.js';
import {
  resolveWhatsappSendMode,
  resolveWhatsappTemplates,
  touchWhatsappWindow,
} from './whatsapp-window.js';

const NOW = new Date('2026-07-21T12:00:00Z');
const TEMPLATES = { meeting_confirmation: { contentSid: 'HX123' } };

describe('resolveWhatsappSendMode — the window decides, not the sender', () => {
  const base = {
    templates: TEMPLATES,
    templateKey: 'meeting_confirmation' as const,
    providerSupportsTemplates: true,
    now: NOW,
  };

  it('23:59 since last inbound → freeform (window still open)', () => {
    const last = new Date(NOW.getTime() - (24 * 60 - 1) * 60_000);
    expect(
      resolveWhatsappSendMode({ ...base, lastInboundWhatsappAt: last, consentGranted: false }).mode,
    ).toBe('freeform');
  });

  it('24:01 since last inbound → window closed → template (with consent + SID)', () => {
    const last = new Date(NOW.getTime() - (24 * 60 + 1) * 60_000);
    const d = resolveWhatsappSendMode({ ...base, lastInboundWhatsappAt: last, consentGranted: true });
    expect(d).toMatchObject({ mode: 'template', contentSid: 'HX123' });
  });

  it('never messaged us + no consent → blocked no_consent', () => {
    const d = resolveWhatsappSendMode({ ...base, lastInboundWhatsappAt: null, consentGranted: false });
    expect(d).toMatchObject({ mode: 'blocked', reason: 'no_consent' });
  });

  it('out of window, consent, but no SID for the slot → blocked no_template', () => {
    const d = resolveWhatsappSendMode({
      ...base,
      templates: {},
      lastInboundWhatsappAt: null,
      consentGranted: true,
    });
    expect(d).toMatchObject({ mode: 'blocked', reason: 'no_template' });
  });

  it('UChat-only (no template support) out of window → blocked regardless of consent', () => {
    const d = resolveWhatsappSendMode({
      ...base,
      providerSupportsTemplates: false,
      lastInboundWhatsappAt: null,
      consentGranted: true,
    });
    expect(d).toMatchObject({ mode: 'blocked', reason: 'provider_no_templates' });
  });

  it('in-window freeform requires NO consent — they messaged us first', () => {
    const d = resolveWhatsappSendMode({
      ...base,
      lastInboundWhatsappAt: new Date(NOW.getTime() - 60_000),
      consentGranted: false,
    });
    expect(d.mode).toBe('freeform');
  });
});

describe('resolveWhatsappTemplates', () => {
  it('accepts all four slot keys including first_touch', () => {
    const cfg = resolveWhatsappTemplates({
      whatsapp_templates: {
        meeting_confirmation: { contentSid: 'HX1' },
        reminder_t24: { contentSid: 'HX2' },
        reminder_t1: { contentSid: 'HX3' },
        first_touch: { contentSid: 'HX4' },
      },
    });
    expect(Object.keys(cfg)).toHaveLength(4);
    expect(cfg.first_touch?.contentSid).toBe('HX4');
  });

  it('drops malformed entries and unknown keys, tolerates garbage settings', () => {
    expect(resolveWhatsappTemplates(null)).toEqual({});
    expect(resolveWhatsappTemplates({ whatsapp_templates: 'nope' })).toEqual({});
    const cfg = resolveWhatsappTemplates({
      whatsapp_templates: { meeting_confirmation: { contentSid: '' }, evil_key: { contentSid: 'HX' } },
    });
    expect(cfg).toEqual({});
  });
});

function fakeDb() {
  const updates: Array<{ vals: Record<string, unknown> }> = [];
  const db = {
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ vals });
        },
      }),
    })),
  } as unknown as Database;
  return { db, updates };
}

describe('touchWhatsappWindow', () => {
  it('stamps last_inbound_whatsapp_at with the given instant', async () => {
    const { db, updates } = fakeDb();
    const at = new Date('2026-07-21T10:00:00Z');
    await touchWhatsappWindow(db, 'tenant-1', 'whatsapp:+972501234567'.replace('whatsapp:', ''), at);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.vals).toMatchObject({ lastInboundWhatsappAt: at });
  });

  it('accepts every Israeli phone format (suffix matching handles +972/0/dashes)', async () => {
    const { db, updates } = fakeDb();
    await touchWhatsappWindow(db, 'tenant-1', '+972-50-123-4567');
    await touchWhatsappWindow(db, 'tenant-1', '0501234567');
    expect(updates).toHaveLength(2);
  });

  it('refuses to stamp on a suffix too short to identify anyone', async () => {
    const { db, updates } = fakeDb();
    await touchWhatsappWindow(db, 'tenant-1', '123');
    expect(updates).toHaveLength(0);
  });
});
