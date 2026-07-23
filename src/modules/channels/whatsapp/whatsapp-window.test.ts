import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../db/client.js';
import { touchWhatsappWindow } from './whatsapp-window.js';

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
