# VOICE — pauses: shipped on Cartesia, dead on DeepDub, and the day three sessions shared one directory

**Session:** voice-pauses (`ai-sales-agent-3d`) · **Date:** 2026-09-02 · branch: `feature/voice-turn-openers`, everything pushed to `origin/main`

---

## In plain language, for Koren

You asked for her rhythm to change during a call — steadier when she is sure, slower when she is
thinking. **Shipped and live**, then **made dormant by your own engine decision six hours later.**
Both of those are correct outcomes and neither is wasted work.

- The lever that survived your ear is `<break time="…"/>`, at three lengths in three positions
  (rounds 16–18). The rate lever died on round 16 — you could not hear 0.90 from 0.78, and on the
  transition card you chose the clip with no change at all. The duration table that justified it
  was correct and measured the wrong thing.
- Round 18 replaced the rule with the one you stated: **a pause is the sound of not knowing yet.**
  Never before a price, an introduction or a confirmation; yes before checking the calendar.
- Deployed `8uEhqMDXYiXE` at 10:19Z. That is what is live.
- **Then you moved TTS to DeepDub, and I measured what that costs: DeepDub READS THE TAG ALOUD.**
  The caller would hear "break time 00:56" mid-sentence, +2.2–2.7s of markup. The feature is gated
  off on any engine but Cartesia, so nothing can leak. Rounds 17–18 do not transfer.

## Shipped (all on `origin/main`)

| commit | what |
|---|---|
| `c151ba0` | the pause feature — prompt half + guard half on one flag, round-18 rule, price behaviour |
| `8edd0ff` | breath round renumbered 20→21; known-issues **§17** (Cartesia's one non-verbal) |
| `128c430` | restored a tracked 93KB fixture that a 2MB DeepDub generation had overwritten |
| `b2ad206` | the two call-report pairings that answer a different question; both ceiling tests annotated |
| `e70f356` | `pausesSupported()` — the pause dies with Cartesia, gate mutation-tested |
| `06e5adc` | §16/§17 + `testing/README.md` + `env.ts` scoped to the engine that produced them |
| `39c453d` | **§18 — DeepDub SPEAKS `<break>`**, measured; probe 24 |
| `e7f29ce` | "the broken instrument returns the comfortable answer" |

## Two findings that outlive the feature

**The instant acknowledgement is not arriving early in production.** 391 paired turns across 18
call reports: her first audio starts a median of **+668ms AFTER** the model's first token, and
before it on only **7.7%** of turns. A second session got +542ms / 15% on a different sample. The
mechanism is meant to buy ~620ms and buys nothing. **Closing it needs timing inside `ttsNode`,
which nobody has built** — the reports can show the effect is absent, not where it goes.

**The prompt "budget" is not one.** Both ceiling tests compare `on.length / off.length` where the
renders differ only by their own section, so the ratio is `S / off`: text added anywhere else makes
`off` bigger and the number go DOWN. **The ceiling loosens as the prompt grows**, and everything
outside the branch is budgeted by nothing. Annotated in both tests, not replaced — no measurement
says total prompt length is what hurts.

## Questions for architect

1. **Is the instant-ack investigation worth a session?** It is the largest unexplained latency item
   we have, and the caller's silence is a median 1568ms / p90 2757ms.
2. **Pacing on DeepDub — pursue or drop?** It needs a different mechanism, not this tag, and per
   §17's lesson not a third round of probing markup syntax.

## Blocked on Koren

**The price NUMBER.** `1,490 ₪/month` sits in `docs/gtm/pricing-model.md` marked as an unapproved
draft. She still deflects the question on live calls. I will not write an unapproved price to
production — a number she says to a real lead is a commitment. Once it exists it goes into the
dashboard Settings `pricing` field and takes effect with no deploy.

## Round-number claims

**24 = `r24_*` (this session, DeepDub break-tag probe).** Claimed second — `0a` had claimed 24 for
the breath tag matrix and I did not see it before pushing. Resolved as 24 mine / 25 `63`'s /
26 `0a`'s, and it is recorded here as a collision rather than a clean claim.

**Three sessions shared this checkout today**, and nothing was lost only because three independent
judgements happened to coincide. Claim the NUMBER and the CLIP PREFIX in a handoff before
generating, and the protocol must cover subagents, which write to the shared tree unless launched
with worktree isolation.
