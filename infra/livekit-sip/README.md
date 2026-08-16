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

## Current setup — TWO trunks, and they authenticate differently

Inbound and outbound are separate LiveKit objects. They are not interchangeable, and the reason
they differ is the thing most likely to trip you up:

| Thing | ID | Notes |
|---|---|---|
| Inbound trunk | `ST_V5CXE6L5539t` | `"numbers": []` — accepts ANY dialled number from the allow-listed addresses. See the warning below. **IP-allowlisted, no credentials.** |
| Dispatch rule | `SDR_GHNgzGi4CB4n` | One room per call (`call-*`); the agent auto-dispatches. Bound to the inbound trunk only. |
| Outbound trunk | `ST_8s6N3DqUVtWw` | Dials via `sip.zadarma.com`. Authenticates as Zadarma **direct SIP line `744650`** — credentials live inside the trunk on LiveKit, not in our `.env` |

**Inbound authenticates by IP, outbound by SIP credentials.** Zadarma sends inbound INVITEs from
its own IP range, so the inbound trunk trusts those addresses and needs no password. Outbound is
the reverse: we call Zadarma, so we present a login.

**Outbound must use a DIRECT SIP LINE, not a PBX extension.** A trunk authenticating as a PBX
extension (`568106-100`) fails every INVITE with `max auth retry attempts reached for SIP invite`,
because Zadarma expects PBX extensions to REGISTER first and LiveKit outbound trunks never
register. This cost a long debugging session on 2026-08-05 — the password is not the problem, the
account type is. Use the direct SIP line from **Settings → SIP**.

### What the app needs

Exactly one env var, and it is the OUTBOUND trunk:

```
LIVEKIT_SIP_OUTBOUND_TRUNK_ID=ST_8s6N3DqUVtWw
```

**The inbound trunk is not referenced by any env var or any line of application code.** Inbound is
entirely LiveKit-side: trunk + dispatch rule + the Zadarma forwarding below. If inbound breaks,
nothing in `.env` will fix it.

Set the outbound var in `.env` **and in the production host env**. A stale trunk ID there is
invisible until someone places a call and gets a 500.

**The inbound trunk is IP-locked to Zadarma's SIP ranges** — currently `185.45.152.0/24`,
`185.45.154.0/24`, `185.45.155.0/24`, `195.122.19.0/27`, `31.31.222.192/27`, `15.235.128.64/28`.
Do not remove them. An unrestricted inbound trunk is a SIP endpoint anyone on the internet can
dial, and every call spends real OpenAI + Cartesia credits. If Zadarma adds a range, inbound
starts failing for some calls only — check this list first.

## Multiple numbers — `"numbers": []` and what it costs

`inbound-trunk.json` used to name one number. Every customer needs their own DID, and re-listing
every number on the trunk each time a customer is onboarded is a deploy-shaped step in what should
be a database-shaped one — so the trunk now accepts **any** dialled number and the application
decides who it belongs to (`phone_numbers` table, `resolveCallIdentity`).

⚠️ **This makes the IP allowlist the ONLY security boundary on this trunk.** Previously a stranger
who reached our SIP endpoint was rejected unless they dialled the one listed number; now the
allowlist above is what stands between us and anyone who can send an INVITE. Do not widen it, and
do not remove entries "to debug" — an unrestricted inbound trunk is a SIP endpoint anyone on the
internet can dial, and every answered call spends real OpenAI and Cartesia credits.

The second line of defence is in the app: a number with no `phone_numbers` row is answered with a
short "not in service" announcement and hung up, creating no lead, no conversation and no call
record. That is deliberate — a scanner sweeping DID ranges gets a few seconds of audio, not a sales
call and not a database row.

**Onboarding a number is now:**

```bash
node scripts/provision-number.mjs --number +972XXXXXXXXX --tenant <uuid> --label "Acme main"
# then point that number's forwarding at the SIP URI below, in the Zadarma portal
node scripts/provision-number.mjs --list   # what is mapped where
```

Do the script first. A forwarded number with no row gives the caller a dead line; a row with no
forwarding is merely inert.

**Applying the trunk change** (once, by hand — nothing in CI touches LiveKit):

```bash
lk sip inbound update ST_V5CXE6L5539t infra/livekit-sip/inbound-trunk.json
lk sip inbound list    # confirm numbers is empty and the address list is intact
```

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
