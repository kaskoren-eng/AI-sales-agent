# LiveKit SIP config (Phase 3)

Telephony wiring for the LiveKit voice engine. Zadarma owns the phone number; LiveKit owns the
call. Reproducible so nobody has to reverse-engineer it from a dashboard later.

## The SIP hostname — read this before you touch Zadarma

```
svhky5yvhj9.sip.livekit.cloud
```

**It is derived from the PROJECT ID (`p_svhky5yvhj9`), NOT from the project URL subdomain**
(`ai-sales-agent-yro9fqwb.livekit.cloud`). Those two are different, and assuming they match cost
us a failed test call.

Worse, the mistake does not announce itself: LiveKit's SIP servers answer `SIP/2.0 200 OK` on a
*wrong* subdomain too, so a connectivity probe "passes" while real INVITEs are silently dropped.
The only trustworthy source is the dashboard: **Telephony → SIP URI**.

## Current setup

| Thing | ID | Notes |
|---|---|---|
| Inbound trunk | `ST_2cKqBieAJZG3` | Accepts `+972555070922` and `972555070922` — Zadarma's number format is not guaranteed |
| Dispatch rule | `SDR_XAmvf73KaC5G` | One room per call (`call-*`); the agent auto-dispatches |
| Outbound trunk | `ST_EeXshw4zXKuZ` | Dials via `sip.zadarma.com` over TCP. Zadarma SIP login/password live **inside the trunk on LiveKit**, not in our `.env` |

`LIVEKIT_SIP_OUTBOUND_TRUNK_ID` in `.env` points at the outbound trunk.

**The inbound trunk is locked to `185.45.152.0/22`** (Zadarma's SIP range). Do not remove this. An
unrestricted inbound trunk is a SIP endpoint anyone on the internet can dial, and every call spends
real OpenAI + Cartesia credits.

## Zadarma side

Forward the number to LiveKit:

```
+972555070922@svhky5yvhj9.sip.livekit.cloud:5060;transport=tcp
```

Set under **Settings → Direct phone numbers → forwarding**, or **My PBX → Extensions → Call
forwarding → External server (SIP URI)** if the number routes through the PBX. Only one of these
applies depending on how the number is provisioned — using the wrong one means Zadarma swallows
the call and LiveKit never sees an INVITE.

## Rollback

**There is none.** LiveKit is the only voice engine — the previous vendor is gone, and its code
was removed from this repo. Deleting the forwarding rule in Zadarma does not fail over to
anything: the number stops reaching an agent and inbound calls are silently dropped.

If inbound is broken, fix forward — check the dispatch rule and the trunk (below), not the
forwarding rule.

## Recreating from scratch

```bash
lk sip inbound create infra/livekit-sip/inbound-trunk.json
lk sip dispatch create --name zadarma-inbound-to-agent --trunks <TRUNK_ID> --individual "call-"
# Outbound (needs ZADARMA_SIP_LOGIN / ZADARMA_SIP_PASSWORD from .env — never commit these):
lk sip outbound create <json with address sip.zadarma.com, transport TCP, authUsername, authPassword>
```

## Diagnosing a failed call

1. **Agent log shows no job at all** → the INVITE never reached LiveKit. Suspect the Zadarma
   forwarding (wrong hostname, or set in the wrong place).
2. **LiveKit dashboard → Telephony** shows inbound attempts and why they were rejected. This is
   the fastest way to tell "Zadarma never called" from "LiveKit refused".
3. Do **not** trust a TCP/SIP OPTIONS probe of the hostname — it returns 200 OK regardless.
