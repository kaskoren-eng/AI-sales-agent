# Phase 4b — outbound caller identity per tenant

**Status:** scoped, not started · **Territory:** VOICE · **Blocks:** customer #2 making outbound calls

---

## The gap

`initiateOutboundCall` dials every tenant through one trunk with one caller ID.

```ts
// src/modules/channels/voice-livekit/voice-livekit.service.ts:68
const trunkId = this.env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID;   // ← one global env var
...
this.sip.createSipParticipant(trunkId, to, roomName, {
  participantIdentity: `lead-${to}`,
  participantName: leadContext?.name ?? to,
  participantMetadata: JSON.stringify(metadata),
  waitUntilAnswered: true,
  playDialtone: false,
  // ← no fromNumber
});
```

`phone_numbers` records which tenant *owns* a DID, but nothing says which number a tenant dials
*out* from. So tenant #2's lead sees **ClickScales' number**, and when they call it back they reach
**ClickScales' agent** — which routes correctly, to the wrong company. The lead is then in
ClickScales' data, having been called by a company they have never heard of.

The tenant that this is silently correct for is ClickScales, because the global value happens to be
theirs. That is why no amount of testing on the current number surfaces it: **the bug is invisible
from customer #1 by construction.** It appears the first time a second tenant dials.

Inbound is unaffected — `resolveCallIdentity` already reads `phone_numbers` per call, and a callback
to a tenant's own number routes to that tenant correctly today. This is the outbound half of the
same idea.

---

## ⚠️ Task 0 — settle this before designing anything else

**Will Zadarma accept an arbitrary `From` on the existing shared trunk?**

The LiveKit SDK already supports per-call caller ID, so no LiveKit-side work is needed:

```ts
// node_modules/livekit-server-sdk/dist/SipClient.d.ts:99
/** Optional SIP From number to use. If empty, trunk number is used. */
fromNumber?: string;
```

But a SIP provider normally only permits a `From` that the authenticated account owns, and may
silently rewrite or reject anything else. **Verify with one real outbound call spoofing a second
owned number before writing code**, because the answer picks the design:

| Zadarma accepts arbitrary `From` | Design |
|---|---|
| **Yes** (expected) | One shared trunk. Per-tenant `fromNumber` per call. Everything below applies as written. |
| **No** | One outbound trunk per DID. `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` stops being an env var and becomes a column on `phone_numbers`; the resolver returns a trunk id as well as a number. Same seam, more provisioning. |

Everything else in this document is identical either way — only what the resolver returns changes.

---

## The work

### 1. Schema — migration **0016** (claimed; update `CLAUDE.md` in the same commit)

`phone_numbers` needs to say which of a tenant's numbers is their outbound identity. Most tenants
will have exactly one, but "the only row" is not a rule — it is a coincidence that holds until
someone buys a second number for a campaign.

```sql
ALTER TABLE phone_numbers
  ADD COLUMN is_outbound_caller_id boolean NOT NULL DEFAULT false;

-- At most one outbound identity per tenant. A partial unique index rather than application logic,
-- because two rows claiming it would make caller ID depend on row order — the same failure the
-- e164 unique index exists to prevent on the inbound side.
CREATE UNIQUE INDEX phone_numbers_outbound_caller_id_key
  ON phone_numbers (tenant_id)
  WHERE is_outbound_caller_id;
```

Backfill: set it true for ClickScales' existing row, so customer #1's behaviour is unchanged the
moment this deploys.

### 2. `resolveOutboundIdentity(db, tenantId)` — and it must **fail closed**

New function, mirroring `resolveCallIdentity` / `resolveCalendarAuth`. Returns the tenant's
outbound number, or a typed refusal.

**A tenant with no assigned outbound number must not dial.** Not "fall back to the trunk default" —
the fallback *is* the bug. This is the same rule Phase 4 already applies to inbound (an unmapped DID
answers "not in service" rather than falling through to the env tenant) and to the tool gate
(fail-closed). A refused dial is a support ticket; a dial from the wrong company's number is a
compliance problem and a lead in the wrong tenant's database.

Refusal reasons should be distinguishable, because they have different fixes:
`no_number_assigned` · `number_inactive` · `tenant_suspended`.

Reuse the normalisation rules documented on `phone_numbers.e164` — never compare a raw value to that
column.

### 3. Wire it into the dialer

One change in `initiateOutboundCall`, after the spend guard and before `createSipParticipant`.
Both existing call sites inherit it, because both go through this service:

- `src/modules/calls/calls.routes.ts:204` — `POST /calls/outbound`
- `src/queues/workers/flow-executor.worker.ts:285` — the `call` flow step

Note the existing contract: a missing trunk returns `{ callId: 'skipped' }` rather than throwing, so
a missing config degrades instead of breaking a flow mid-run. Decide deliberately whether a refused
dial is `skipped` (flow continues) or an error (flow fails and is visible). **Recommend an error
surfaced to the operator** — a silently skipped call to a real lead is exactly the class of
invisible failure this phase exists to remove — but it is a behaviour change to the flow executor,
so make it consciously.

### 4. Check the outbound trunk config into `infra/livekit-sip/`

`inbound-trunk.json` is in the repo; there is no `outbound-trunk.json` — that trunk exists only in
the LiveKit account, so its configuration is undocumented and unreproducible. Same reason the
inbound one was checked in.

### 5. Operator surfaces

- `scripts/provision-number.mjs` — a flag to set/clear the outbound designation, and show it in the
  listing output. Assigning a number without it produces a tenant that cannot dial out, so the
  script should either set it by default on a tenant's first number or warn loudly.
- Admin console — show which number is a tenant's outbound identity. **A tenant that cannot dial
  out should be visible at a glance**, in the same way the missing Plan column let three production
  workspaces sit unpriced: an invisible unset field is one nobody sets.

### 6. Tests

- Two tenants, two numbers → each dials with its own `fromNumber`. This is the whole point; assert
  on the arguments actually passed to `createSipParticipant`.
- Tenant with no outbound number → **nothing is dialled**, and the error names the fix.
- Tenant with an inactive number → refused, distinct reason.
- **ClickScales regression:** with the backfilled row, `createSipParticipant` receives byte-for-byte
  what it receives today. Customer #1's behaviour must not move.

---

## Verification gate

One real outbound call from a second tenant:

1. The lead's phone shows **tenant #2's** number, not ClickScales'.
2. Calling that number back reaches **tenant #2's** agent (`call_identity` logs
   `source: "did_lookup"` with tenant #2's id).
3. The call, lead and usage rows all land in tenant #2.

Report EOU / LLM / TTS / worst-case latency against budgets after the call, per the standing rule.

---

## Out of scope

- **`plans.maxConcurrentCalls` is a column nothing reads** — no per-tenant concurrency cap is
  enforced anywhere. Real, separate, costs money rather than correctness.
- A live PSTN call per persona variant. ClickScales runs `DEFAULT_PERSONA` deliberately, so a custom
  agent name / gender / voice has still never been heard on a real call — the Phase 3 gate, not this
  one.
