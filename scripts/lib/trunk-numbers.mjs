/**
 * Keep the LiveKit inbound trunk's `numbers` list in step with the `phone_numbers` table.
 *
 * ── Why the list exists at all ────────────────────────────────────────────────────────────────
 *
 * The trunk accepts a call only if the dialled number is on this list. That is the cheapest
 * boundary in the whole system: an INVITE for an unlisted number is rejected by LiveKit at the SIP
 * layer, before a room exists, before an agent process is spawned, before a database query runs.
 *
 * Emptying the list (`numbers: []`) was considered and is the wrong trade. The argument for it —
 * "our number is public anyway, so the list protects nothing" — holds for a targeted caller and is
 * backwards for a flood: someone abusing the trunk from inside the allow-listed Zadarma ranges
 * does not care which digits they dial, and the list is exactly what makes those calls free to
 * refuse. Without it every bogus INVITE costs a room, a process and a few seconds of LiveKit
 * session, with nothing anywhere capping the rate. With one agent replica, availability breaks
 * before the bill does: real leads hear a dead line while the replica is busy refusing strangers.
 *
 * ── Why it is synced by a script rather than maintained by hand ───────────────────────────────
 *
 * Because a hand-maintained list drifts, and we have the receipts: `infra/livekit-sip/inbound-trunk.json`
 * has said `"numbers": []` for weeks while production carried one number, and the trunk's own
 * `updatedAt` showed it had never been changed since the day it was created.
 *
 * Drift has a quiet direction and a loud one. Loud: a number on the trunk with no database row —
 * the caller hears "not in service", which is at least diagnosable. Quiet: a number in the database
 * with no trunk entry — the customer's leads get a dead line at the SIP layer, no call ever reaches
 * our code, and nothing anywhere logs it. You find out from the customer. `verifyTrunkNumbers`
 * exists to turn that into a failed check instead.
 *
 * ── Both forms of every number ────────────────────────────────────────────────────────────────
 *
 * Each number goes on the list twice, `+972…` and `972…`. Zadarma is not consistent about the
 * leading `+` — the same fact `phone_numbers.e164` documents for `resolveCallIdentity`. Listing one
 * form and receiving the other is a rejected call that looks exactly like a misconfigured trunk.
 */
import { spawnSync } from 'node:child_process';

/** E.164 as we store it. Anything else must never reach a command line. */
const E164 = /^\+\d{8,15}$/;

/** The two spellings Zadarma may send for one number. */
export function bothForms(e164) {
  if (!E164.test(e164)) throw new Error(`refusing to use "${e164}" as a trunk number — not E.164`);
  return [e164, e164.slice(1)];
}

/**
 * Arguments that are safe to concatenate into a shell command line.
 *
 * `lk` is a `.cmd` shim on Windows, so `spawnSync` needs `shell: true` to find it — and with a
 * shell, Node concatenates argv rather than escaping it (DEP0190). Everything passed here is
 * already ours: E.164 numbers validated by `bothForms`, trunk ids returned by the LiveKit API, and
 * literal flags. This asserts that rather than trusting it, so a future caller that threads user
 * input through cannot turn a list update into shell execution.
 */
const SAFE_ARG = /^[A-Za-z0-9_+.:/-]+$/;

/**
 * `lk` is a shim on Windows, so `shell: true`. Output is JSON on stdout; the CLI also prints
 * config warnings, so parse from the first `{`.
 */
function lk(args) {
  const bad = args.find((a) => !SAFE_ARG.test(a));
  if (bad !== undefined) throw new Error(`refusing to pass "${bad}" to the shell`);
  const res = spawnSync('lk', args, { encoding: 'utf8', shell: true });
  if (res.error) throw new Error(`could not run the LiveKit CLI (lk): ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`lk ${args.join(' ')} failed:\n${(res.stderr || res.stdout || '').trim()}`);
  }
  return res.stdout ?? '';
}

function lkJson(args) {
  const out = lk(args);
  const start = out.indexOf('{');
  if (start === -1) throw new Error(`no JSON in lk output:\n${out.trim()}`);
  return JSON.parse(out.slice(start));
}

/**
 * The inbound trunk, by id if given, otherwise the only one that exists.
 *
 * Refuses to guess when there are several: picking the wrong trunk here means editing the security
 * boundary of something else.
 */
export function readInboundTrunk(trunkId = process.env.LIVEKIT_SIP_INBOUND_TRUNK_ID) {
  const { items = [] } = lkJson(['sip', 'inbound', 'list', '--json']);
  if (trunkId) {
    const found = items.find((t) => t.sipTrunkId === trunkId);
    if (!found) throw new Error(`no inbound trunk ${trunkId} (found: ${items.map((t) => t.sipTrunkId).join(', ') || 'none'})`);
    return found;
  }
  if (items.length === 1) return items[0];
  if (items.length === 0) throw new Error('no inbound SIP trunk exists');
  throw new Error(
    `${items.length} inbound trunks exist — set LIVEKIT_SIP_INBOUND_TRUNK_ID to say which one: ${items.map((t) => t.sipTrunkId).join(', ')}`,
  );
}

/** What the trunk list should be, derived from the rows that can legitimately receive a call. */
export function expectedNumbers(rows) {
  const active = rows.filter((r) => r.is_active && r.tenant_id);
  return [...new Set(active.flatMap((r) => bothForms(r.e164)))].sort();
}

export function diffNumbers(expected, actual) {
  const a = new Set(actual);
  const e = new Set(expected);
  return {
    missing: expected.filter((n) => !a.has(n)), // in the database, not on the trunk — the quiet one
    extra: actual.filter((n) => !e.has(n)), // on the trunk, not in the database
  };
}

/**
 * Make the trunk match the database.
 *
 * Uses the CLI's field flags, which map to the protocol's PARTIAL update (`SIPInboundTrunkUpdate`,
 * whose fields are optional) rather than `replace`, which takes a whole `SIPInboundTrunkInfo` and
 * would blank any field left out. That distinction is the difference between setting a list and
 * silently deleting the IP allowlist — the one boundary that actually keeps strangers off this
 * trunk — so the allowlist is re-read and compared afterwards regardless.
 */
export function syncTrunkNumbers(rows, { trunkId, dryRun = false } = {}) {
  const trunk = readInboundTrunk(trunkId);
  const expected = expectedNumbers(rows);
  const actual = [...(trunk.numbers ?? [])].sort();
  const diff = diffNumbers(expected, actual);

  if (!diff.missing.length && !diff.extra.length) {
    return { trunk, changed: false, expected, diff };
  }
  if (dryRun) return { trunk, changed: false, expected, diff, dryRun: true };

  if (expected.length === 0) {
    // An empty list means "accept ANY dialled number" in LiveKit, not "accept none" — the opposite
    // of what an empty database implies. Never let a bad query or an unassigned pool silently
    // widen the trunk to everything.
    throw new Error(
      'refusing to clear the trunk number list: no active assigned numbers found, and an empty list means the trunk accepts EVERY dialled number',
    );
  }

  const addressesBefore = [...(trunk.allowedAddresses ?? [])].sort();
  lk(['sip', 'inbound', 'update', '--id', trunk.sipTrunkId, ...expected.flatMap((n) => ['--numbers', n])]);

  const after = readInboundTrunk(trunk.sipTrunkId);
  const addressesAfter = [...(after.allowedAddresses ?? [])].sort();
  if (JSON.stringify(addressesBefore) !== JSON.stringify(addressesAfter)) {
    throw new Error(
      `THE IP ALLOWLIST CHANGED during a numbers update — restore it now.\n` +
        `  before: ${addressesBefore.join(', ') || '(none)'}\n` +
        `  after:  ${addressesAfter.join(', ') || '(none)'}\n` +
        `  An inbound trunk with no allowed addresses is a SIP endpoint anyone on the internet can dial.`,
    );
  }

  const remaining = diffNumbers(expected, [...(after.numbers ?? [])].sort());
  if (remaining.missing.length || remaining.extra.length) {
    throw new Error(`trunk did not take the update — missing: ${remaining.missing.join(', ') || 'none'}, extra: ${remaining.extra.join(', ') || 'none'}`);
  }

  return { trunk: after, changed: true, expected, diff };
}

/** Read-only: is this one number reachable at the SIP layer? */
export function verifyTrunkNumbers(e164, { trunkId } = {}) {
  const trunk = readInboundTrunk(trunkId);
  const onTrunk = new Set(trunk.numbers ?? []);
  const forms = bothForms(e164);
  return {
    trunkId: trunk.sipTrunkId,
    // Empty list = the trunk accepts everything, so the number IS reachable — but say so, because
    // it is reachable for the wrong reason and every unlisted number is reachable too.
    acceptsEverything: (trunk.numbers ?? []).length === 0,
    present: forms.filter((f) => onTrunk.has(f)),
    missing: forms.filter((f) => !onTrunk.has(f)),
  };
}
