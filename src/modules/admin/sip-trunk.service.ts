import { SipClient } from 'livekit-server-sdk';
import { ListUpdate } from '@livekit/protocol';
import { and, eq, isNotNull } from 'drizzle-orm';
import { phoneNumbers } from '../../db/schema/index.js';
import type { Database } from '../../db/client.js';
import type { Env } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';

/**
 * Keep the LiveKit inbound trunk's number list in step with `phone_numbers`.
 *
 * ── Why the list matters ──────────────────────────────────────────────────────────────────────
 *
 * The trunk accepts a call only if the dialled number is on this list, and that check happens at
 * the SIP layer: an INVITE for an unlisted number is refused before a room exists, before an agent
 * process is spawned, before a query runs. Every other defence we have — the fail-closed DID
 * lookup, the "not in service" announcement — costs a room and a process first.
 *
 * Emptying the list was the earlier plan and is the wrong trade. "Our number is public anyway" is
 * true of a targeted caller and backwards for a flood: someone abusing the trunk from inside the
 * allow-listed Zadarma ranges does not care which digits they dial, and the list is exactly what
 * makes those calls free to refuse. Nothing rate-limits inbound today, and with one agent replica a
 * flood starves real callers well before it costs real money.
 *
 * ── Why this lives in the API and not only in a script ────────────────────────────────────────
 *
 * `scripts/provision-number.mjs` does the same job, but it needs a direct Postgres connection, and
 * Railway's TCP proxy is blocked outbound on some networks — including the dev machine, where
 * HTTPS works fine. Provisioning a number is an onboarding step; it should not be the one step that
 * depends on a port your firewall may not allow. Both paths converge on the same rule, so running
 * either one repairs drift.
 */

/** The two spellings Zadarma may send. Listing one and receiving the other is a rejected call. */
function bothForms(e164: string): string[] {
  return [e164, e164.slice(1)];
}

function sipClient(env: Env): SipClient {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    throw new AppError(
      'LiveKit is not configured, so the SIP trunk cannot be updated. The phone_numbers row is saved; run `node scripts/provision-number.mjs --sync-trunk` from a host with LiveKit credentials.',
      503,
      'LIVEKIT_NOT_CONFIGURED',
    );
  }
  return new SipClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
}

export interface TrunkSyncResult {
  trunkId: string;
  numbers: string[];
  changed: boolean;
}

/**
 * Push the table's state to the trunk.
 *
 * Uses `updateSipInboundTrunkFields` — the PARTIAL update — rather than `updateSipInboundTrunk`,
 * which replaces the whole trunk object and would blank anything not supplied. The difference is
 * setting a list versus silently deleting the IP allowlist, which is the one thing keeping
 * strangers off this trunk, so the allowlist is re-read and compared afterwards regardless.
 */
export async function syncInboundTrunkNumbers(deps: {
  db: Database;
  env: Env;
}): Promise<TrunkSyncResult> {
  const { db, env } = deps;
  const client = sipClient(env);

  const trunks = await client.listSipInboundTrunk();
  const trunk = env.LIVEKIT_SIP_INBOUND_TRUNK_ID
    ? trunks.find((t) => t.sipTrunkId === env.LIVEKIT_SIP_INBOUND_TRUNK_ID)
    : trunks.length === 1
      ? trunks[0]
      : undefined;

  if (!trunk) {
    // Never guess between several: picking the wrong trunk means editing the security boundary of
    // something else.
    throw new AppError(
      trunks.length > 1
        ? `${trunks.length} inbound trunks exist — set LIVEKIT_SIP_INBOUND_TRUNK_ID to say which one`
        : 'no inbound SIP trunk found',
      500,
      'SIP_TRUNK_UNRESOLVED',
    );
  }

  const rows = await db
    .select({ e164: phoneNumbers.e164 })
    .from(phoneNumbers)
    .where(and(eq(phoneNumbers.isActive, true), isNotNull(phoneNumbers.tenantId)));

  const expected = [...new Set(rows.flatMap((r) => bothForms(r.e164)))].sort();
  const actual = [...(trunk.numbers ?? [])].sort();

  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    return { trunkId: trunk.sipTrunkId, numbers: actual, changed: false };
  }

  if (expected.length === 0) {
    // An empty list means "accept ANY dialled number" in LiveKit — the opposite of what an empty
    // table implies. A bad query must never silently widen the trunk to everything.
    throw new AppError(
      'refusing to clear the trunk number list: no active assigned numbers, and an empty list makes the trunk accept EVERY dialled number',
      500,
      'SIP_TRUNK_WOULD_OPEN',
    );
  }

  const addressesBefore = [...(trunk.allowedAddresses ?? [])].sort();
  await client.updateSipInboundTrunkFields(trunk.sipTrunkId, {
    numbers: new ListUpdate({ set: expected }),
  });

  const after = (await client.listSipInboundTrunk()).find((t) => t.sipTrunkId === trunk.sipTrunkId);
  const addressesAfter = [...(after?.allowedAddresses ?? [])].sort();
  if (JSON.stringify(addressesBefore) !== JSON.stringify(addressesAfter)) {
    throw new AppError(
      `THE IP ALLOWLIST CHANGED during a numbers update — restore it now. before: ${addressesBefore.join(', ') || '(none)'} after: ${addressesAfter.join(', ') || '(none)'}`,
      500,
      'SIP_TRUNK_ALLOWLIST_CHANGED',
    );
  }

  return { trunkId: trunk.sipTrunkId, numbers: [...(after?.numbers ?? [])].sort(), changed: true };
}
