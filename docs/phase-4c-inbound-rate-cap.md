# Phase 4c — a per-DID inbound cap

**Status:** scoped, not started · **Territory:** VOICE (`voice-livekit/**` + guards in `calls/**`) ·
**Why it's not built here:** the guard has to be called from the agent at call start, which is the
voice session's lane. Everything in this document is a request, not a design you have to keep.

---

## The gap

**Nothing limits inbound calls.** Verified, not assumed:

- `countDialAttempt` is called **only by the dialer** — the spend guard is outbound-only, by design
  and correctly so. Inbound is counted nowhere.
- No `maxCallDuration`. LiveKit supports it on outbound participants; inbound trunks have no such
  field, so a duration cap has to be enforced by the agent.
- One agent replica (`1 / 1 / 1`, 2 vCPU / 4GB).

Two distinct threats, and the cheap defence only covers one of them:

| | Reaches the agent? | Costs |
|---|---|---|
| Flood to **unmapped** numbers | No — refused at the trunk, now that the `numbers` list is synced (`scripts/lib/trunk-numbers.mjs`) | ~0 |
| Calls to a tenant's **real, mapped** number | **Always** — it is a legitimate DID | **Full AI spend**: STT + LLM + TTS for the whole conversation |

The second row is the expensive one and has no ceiling at all. A robocaller, a competitor, or one
bored person redialling gets a complete sales conversation every time, billed at full rate. The
number cannot be kept secret to prevent it: **every lead called outbound sees it as caller ID.**

## What to build

A Redis counter per DID, the same shape as `evaluateSpend` / `countDialAttempt` in
`src/modules/calls/spend-guard.ts` — that split (a pure evaluate, a separate count) is what makes
defence-in-depth safe there, and the same reasoning applies here.

- **Evaluate at call start**, in the agent, right after `resolveCallIdentity` returns a tenant and
  before `session.start()`. That ordering is what makes a refusal cheap: no STT, no LLM, no TTS.
- **Count once**, at the same place. Inbound has one entry point, so there is no second call site to
  keep honest — but keep the split anyway so a future one cannot double-count.
- **Refuse by playing the existing pre-generated WAV and hanging up**, exactly as the unmapped-DID
  path does today. That path already costs no vendor credit. Consider a distinct announcement so a
  legitimate caller who trips the cap is not told the number is out of service.

**Per DID, not per tenant, and not per caller.** Per caller-ID is trivially defeated — spoofed or
rotated ANI is the normal case in exactly the abuse you are defending against. Per tenant would let
one busy number starve another belonging to the same customer.

### The limits belong in tenant settings

Put them under the existing **`toll_fraud`** namespace (already claimed, VOICE-owned, already
operator-only) rather than inventing a key. Suggested shape, defaults chosen to be invisible to a
real business and ruinous to a script:

```
toll_fraud: {
  inboundPerHourPerNumber: 60,
  inboundPerDayPerNumber:  400,
}
```

Absent means "use the default", not "unlimited" — the failure that matters is a tenant with no
config, and the permissive reading of an absent value is how a tenant ends up unmetered. (That is
the same mistake `plan_code = NULL` made: absence resolved to free and unlimited.)

### Fail OPEN, unlike the tool gate

If Redis is unreachable, **let the call through.** This is the opposite of the tool gate's
fail-closed rule, deliberately: a broken cache must never silently take a customer's inbound line
down. Log it at `error` with the DID so it is visible, and let the toll-fraud alerting that already
watches Redis failure state catch it. Losing a rate limit for a few minutes is recoverable; refusing
every real lead for a few minutes is not.

Note `evaluateSpend` already tracks DB and Redis failure separately (Bug #6 — `if (dbOk || redisOk)`
was masking a dead cap). Reuse that pattern rather than a bare try/catch.

## Verification

- Two numbers on one tenant: flooding one does not affect the other.
- The cap refuses **before** `session.start()` — assert no STT/LLM/TTS client is touched, which is
  the whole point.
- Redis down → calls still connect, and an error is logged naming the DID.
- An absent `toll_fraud` config gets the default limits, not unlimited.
- A refused caller hears something distinguishable from "this number is not in service".

## Out of scope

- **A call-duration cap.** Also missing, also worth having (a stuck session bills until it drops),
  but it is a timer in the session rather than a counter at the door.
- Anything about outbound — that is `docs/phase-4b-outbound-tenant-identity.md`.
