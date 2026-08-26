# Task for a browser agent: fix inbound call routing in the Zadarma console

Paste everything below into Claude on Chrome, with the Zadarma console already open and logged in.

---

## What you are doing

We run an AI phone agent. Two phone numbers should reach **two different** AI agents. Right now both
numbers reach the **same** one. The fault is somewhere in this Zadarma account's incoming-call
routing. Find it, report it, and fix it.

**Do not ask for or handle passwords.** The browser is already logged in. If you hit a login screen
or a 2FA prompt, stop and say so.

## What is already known and confirmed — do not re-litigate this

- The account has a PBX numbered **568106** with at least two extensions: **100** and **101**.
- **Extension 100** forwards to an external SIP server:
  `+972555070922@svhky5yvhj9.sip.livekit.cloud:5060;transport=tcp`
- **Extension 101** forwards to an external SIP server:
  `+972559662463@svhky5yvhj9.sip.livekit.cloud:5060;transport=tcp`
- Both of those forwarding settings are **correct**. Do not change them.
- Numbers visible in the account: `+972555070922`, `+972559662463`, `+972509788845`.

## The symptom, precisely

When someone dials **either** number, our server receives **two** separate incoming calls about
4 milliseconds apart — one labelled `+972555070922` and one labelled `+972559662463`. The caller
hears whichever answers first, which is always the `+972555070922` one.

That means **one incoming phone call is ringing both extensions.** Dialling `+972559662463` is
somehow also ringing extension 100.

## What we need instead

```
call to +972555070922   →  rings extension 100 ONLY
call to +972559662463   →  rings extension 101 ONLY
```

One number, one extension, no overlap.

## Step 1 — investigate, change nothing

Explore the console read-only and report what you find. Likely places:

- **My PBX → Incoming calls** (may be called "Incoming call settings", "Scenarios", or "Routing").
  This is the most likely location. Look for a rule or scenario per phone number saying which
  extension, ring group, queue or IVR receives it.
- **Settings → Direct phone numbers** (or "My numbers"). Each number may have its own destination —
  it might point at the PBX, at a specific extension, or at an external SIP URI directly.
- **My PBX → Extensions**, only to note whether extensions 100 and 101 belong to a **ring group**,
  **queue**, or **call scenario** that rings several extensions at once.

For each number, answer these questions explicitly:

1. Where does `+972555070922` go when someone dials it? Name the exact screen and setting.
2. Where does `+972559662463` go when someone dials it? Same.
3. Is there a default/catch-all rule that applies to numbers with no specific rule?
4. Is there anything that rings **more than one** extension — a ring group, "ring all", a queue, or
   a scenario listing several extensions?
5. Does either number have forwarding set in **two** places at once (for example, both a direct
   number destination *and* a PBX scenario)? That alone would produce two call legs.

**Report all of this before changing anything.** Take screenshots of the relevant screens.

## Step 2 — make one change

Once you have reported, make the smallest change that gives each number its own single extension.
In order of preference:

1. If `+972559662463` has **no** routing rule of its own and is falling through to a default that
   rings extension 100 → create a rule sending it to **extension 101 only**.
2. If a **ring group / "ring all" / queue** is receiving the calls → change the routing so each
   number targets a single extension instead of the group.
3. If `+972559662463` is forwarded in **two** places → remove the one that is not extension 101.

## Rules

- **Change one thing at a time**, and say what you changed and where.
- **Never modify extension 100 or 101's own external-SIP forwarding URIs.** They are correct.
- **Do not touch anything to do with outbound calls, CallerID, SIP credentials, or billing.**
  CallerID in particular is unrelated — it only affects what the far end sees on outgoing calls.
- **Do not delete a phone number, an extension, or the PBX.**
- If the only way forward looks like deleting something or changing many settings at once, **stop
  and report** instead.

## What to report back

1. Where each number's incoming route is configured — exact menu path and current value.
2. What was causing one call to ring both extensions.
3. What you changed, precisely.
4. Anything that looked wrong but you did not touch.

We will verify with a real phone call afterwards, so an accurate report of what changed matters more
than getting it working on the first try.
