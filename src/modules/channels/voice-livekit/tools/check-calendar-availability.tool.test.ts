import { llm } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import type { TimeSlot } from '../../../scheduling/providers/provider.interface.js';
import {
  executeCheckAvailability,
  type CheckAvailabilityArgs,
} from './check-calendar-availability.tool.js';
import type { ToolRuntimeContext } from './tool-context.js';

/** Thursday morning, Israel summer time (IDT, UTC+3). 08:00Z = 11:00 in Tel Aviv. */
const NOW = new Date('2026-07-16T08:00:00.000Z');

const mk = (start: string): TimeSlot => ({ start, end: start });

function fakeRt(slots: TimeSlot[]) {
  const getAvailableSlots = vi.fn(async () => slots);
  const makeProvider = vi.fn(() => ({ getAvailableSlots }));
  const rt = {
    env: { GOOGLE_CALENDAR_ID: 'cal@group.calendar.google.com' },
    makeProvider,
    report: { recordToolCall: vi.fn() },
    lastCheckedDurationMinutes: null,
    bookingCompleted: false,
    endReason: null,
  } as unknown as ToolRuntimeContext;
  return { rt, makeProvider, getAvailableSlots };
}

const args = (over: Partial<CheckAvailabilityArgs> = {}): CheckAvailabilityArgs => ({
  from_date: '2026-07-16',
  to_date: '2026-07-23',
  duration_minutes: 15,
  ...over,
});

describe('executeCheckAvailability', () => {
  it('asks the provider for a duration+buffer grid — 15-min meeting → 30-min blocks', async () => {
    const { rt, makeProvider } = fakeRt([mk('2026-07-19T07:00:00.000Z')]);
    await executeCheckAvailability(rt, args(), NOW);
    expect(makeProvider).toHaveBeenCalledWith(30);
  });

  it('remembers the checked duration so book_meeting re-checks the SAME grid', async () => {
    const { rt } = fakeRt([mk('2026-07-19T07:00:00.000Z')]);
    await executeCheckAvailability(rt, args({ duration_minutes: 30 }), NOW);
    expect(rt.lastCheckedDurationMinutes).toBe(30);
  });

  it('drops Fri/Sat and presents each day as a free RANGE, with every time returned for booking', async () => {
    const { rt } = fakeRt([
      mk('2026-07-17T07:00:00.000Z'), // Friday — must die here
      mk('2026-07-18T07:00:00.000Z'), // Saturday — must die here
      mk('2026-07-19T07:00:00.000Z'), // Sunday 10:00  ┐
      mk('2026-07-19T07:30:00.000Z'), // Sunday 10:30  ├ contiguous 30-min grid → one range 10:00–11:00
      mk('2026-07-19T08:00:00.000Z'), // Sunday 11:00  ┘
      mk('2026-07-20T07:00:00.000Z'), // Monday 10:00 (single time)
    ]);
    const out = await executeCheckAvailability(rt, args(), NOW);

    // Fri/Sat gone.
    expect(out).not.toContain('2026-07-17');
    expect(out).not.toContain('2026-07-18');
    // Sunday reads as a RANGE she can speak — not one time, not a list.
    expect(out).toContain('יום ראשון, 19 ביולי — פנוי 10:00–11:00');
    // …but EVERY Sunday slot_datetime is still returned so she can book the exact time he picks.
    expect(out).toContain('[slot_datetime: 2026-07-19T07:00:00.000Z]');
    expect(out).toContain('[slot_datetime: 2026-07-19T07:30:00.000Z]');
    expect(out).toContain('[slot_datetime: 2026-07-19T08:00:00.000Z]');
    // A single-time day shows that time as its own "range".
    expect(out).toContain('יום שני, 20 ביולי — פנוי 10:00');
    // The offer-a-range instruction + the anti-hallucination rule.
    expect(out).toMatch(/Offer the free RANGE/u);
    expect(out).toContain('VERBATIM');
  });

  it('hides slots starting inside the minimum-notice window', async () => {
    const soon = new Date(NOW.getTime() + 30 * 60_000).toISOString(); // 30 min away
    const later = '2026-07-16T12:00:00.000Z'; // Thursday 15:00 Israel, 4h away
    const { rt } = fakeRt([mk(soon), mk(later)]);
    const out = await executeCheckAvailability(rt, args(), NOW);
    expect(out).not.toContain(soon);
    expect(out).toContain(later);
  });

  it('returns a relayable no-availability answer instead of throwing', async () => {
    const { rt } = fakeRt([mk('2026-07-17T07:00:00.000Z')]); // only a Friday — filtered away
    const out = await executeCheckAvailability(rt, args(), NOW);
    expect(out).toContain('No free slots');
    expect(out).toContain('search again');
  });

  it('clamps a past from_date to today instead of arguing with the model', async () => {
    const { rt, getAvailableSlots } = fakeRt([mk('2026-07-19T07:00:00.000Z')]);
    await executeCheckAvailability(rt, args({ from_date: '2026-07-01' }), NOW);
    expect(getAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-07-16' }));
  });

  it('rejects a backwards range as a ToolError the LLM can relay', async () => {
    const { rt } = fakeRt([]);
    await expect(
      executeCheckAvailability(rt, args({ from_date: '2026-07-23', to_date: '2026-07-16' }), NOW),
    ).rejects.toThrowError(llm.ToolError);
  });

  it('rejects a range wider than 14 days', async () => {
    const { rt } = fakeRt([]);
    await expect(
      executeCheckAvailability(rt, args({ to_date: '2026-08-16' }), NOW),
    ).rejects.toThrowError(llm.ToolError);
  });

  it('rejects a range entirely in the past, naming today', async () => {
    const { rt } = fakeRt([]);
    await expect(
      executeCheckAvailability(rt, args({ from_date: '2026-07-01', to_date: '2026-07-10' }), NOW),
    ).rejects.toThrow('2026-07-16');
  });
});
