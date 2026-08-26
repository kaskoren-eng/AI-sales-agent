import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM operator script, no types. Tested here because the rules it encodes
// are security rules, and an operator script is exactly the code nobody re-reads before running.
import { bothForms, expectedNumbers, diffNumbers } from '../../../scripts/lib/trunk-numbers.mjs';

/**
 * WHICH NUMBERS THE SIP TRUNK ACCEPTS.
 *
 * The trunk's `numbers` list is the cheapest boundary in the system: an INVITE for an unlisted
 * number is refused by LiveKit before a room exists, before an agent process is spawned, before a
 * database query runs. Everything else — the fail-closed DID lookup, the "not in service"
 * announcement — happens only after we have already paid for a room and a process.
 *
 * Emptying the list was proposed and rejected. The argument for it ("our number is public, so the
 * list protects nothing") is true of a targeted caller and backwards for a flood: someone abusing
 * the trunk from inside the allow-listed Zadarma ranges does not care which digits they dial, and
 * the list is exactly what makes those calls free to refuse. With one agent replica, a flood
 * starves real callers before it costs real money.
 *
 * So the list has to exist AND has to stay in step with `phone_numbers`, which a human maintaining
 * it by hand demonstrably did not: the checked-in trunk config said `numbers: []` for weeks while
 * production carried one number, and the trunk's own `updatedAt` showed it had never been changed
 * since the day it was created.
 */

describe('bothForms', () => {
  it('lists a number in both spellings Zadarma might send', () => {
    // Not cosmetic. Zadarma is inconsistent about the leading `+` — the same fact
    // `phone_numbers.e164` documents for resolveCallIdentity. Listing one form and receiving the
    // other is a refused call that looks exactly like a broken trunk.
    expect(bothForms('+972555070922')).toEqual(['+972555070922', '972555070922']);
  });

  it('refuses anything that is not E.164', () => {
    // These strings end up on a shell command line. A local number, an empty string, or something
    // with a space in it must never get that far.
    for (const bad of ['0555070922', '972555070922', '', '+972 555 070 922', '+abc']) {
      expect(() => bothForms(bad)).toThrow(/E\.164/);
    }
  });
});

describe('expectedNumbers', () => {
  const row = (e164: string, over = {}) => ({ e164, tenant_id: 'tenant-1', is_active: true, ...over });

  it('derives the trunk list from the rows that can legitimately take a call', () => {
    const list = expectedNumbers([row('+972555070922'), row('+972500000001')]);

    expect(list).toEqual(['+972500000001', '+972555070922', '972500000001', '972555070922']);
  });

  it('excludes an unassigned number', () => {
    // A number we own but have not sold yet. Accepting calls to it costs a room and a process to
    // say "not in service" — the pool should be invisible at the SIP layer.
    expect(expectedNumbers([row('+972555070922', { tenant_id: null })])).toEqual([]);
  });

  it('excludes a deactivated number', () => {
    // Parked between customers. Same reasoning as unassigned.
    expect(expectedNumbers([row('+972555070922', { is_active: false })])).toEqual([]);
  });

  it('de-duplicates', () => {
    expect(expectedNumbers([row('+972555070922'), row('+972555070922')])).toEqual([
      '+972555070922',
      '972555070922',
    ]);
  });
});

describe('diffNumbers', () => {
  it('separates the two directions of drift, which are not equally dangerous', () => {
    const diff = diffNumbers(['+9721', '+9722'], ['+9722', '+9723']);

    // `missing` is the quiet one: in the database, not on the trunk. The call is rejected at the
    // SIP layer, our code never runs, nothing logs it, and the customer's leads hear a dead line.
    expect(diff.missing).toEqual(['+9721']);
    // `extra` is the loud one: on the trunk, no row. The caller reaches us and hears "not in
    // service", which is at least diagnosable from our own logs.
    expect(diff.extra).toEqual(['+9723']);
  });

  it('reports no drift when the two agree', () => {
    const diff = diffNumbers(['+9721', '+9722'], ['+9721', '+9722']);

    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([]);
  });

  it('treats an empty trunk list as everything missing', () => {
    // An empty list means "accept ANY number" in LiveKit — the opposite of what an empty set
    // implies. The sync path refuses to write one; this makes sure the diff still reports it.
    expect(diffNumbers(['+9721'], []).missing).toEqual(['+9721']);
  });
});
