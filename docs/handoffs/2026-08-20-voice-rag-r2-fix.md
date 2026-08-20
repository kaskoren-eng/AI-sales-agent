# Voice RAG — preemptive-draft fix + real-call setup (2026-08-20)

Branch `feature/voice-rag-r1`, worktree `C:/keren-rag`. Rewind tag `pre-rag-r1` → `d6c4baf`.
`main` untouched. All three flags default **false**; with them off the prompt is byte-identical
(golden fixtures untouched, 96 prompt tests green).

## Shipped today

| commit | what |
|---|---|
| `f2d8320` | the fix — inject during interims, not on the final transcript |
| `aecd8bd` | verification — 5/5 drafts used, 0 discarded |
| `89bc78c` | `WEB_CALL_TTL_SECONDS` on the local web-call minter |

### The bug, and why R2 got it wrong

R2 prefetched on interim transcripts but only INJECTED on the final one, assuming retrieving
early was enough. It is not — warming a cache puts nothing in the chat context.

Traced the real ordering: the Soniox plugin emits `PREFLIGHT_TRANSCRIPT` the moment the caller
pauses (`_internal.cjs:239` — final text present, no pending non-final text), and
`audio_recognition.cjs:798` turns that straight into `onPreemptiveGeneration`, which copies the
context synchronously. Plain `INTERIM_TRANSCRIPT` events, while the caller is still speaking,
trigger nothing. So the final-transcript injection was late **by construction**.

Fix: `injectSpeculative()` injects during the interims (12-char floor, growth requirement, 3
attempts/turn — the old prefetch-on-every-interim was buying an embedding on each one). The
final-transcript injection now runs ONLY when `groundedThisTurn` is false, i.e. when the choice
is between losing a draft and not answering at all. Mutations are serialised.

    before:  6 started, 4 discarded
    after:   5 started, 5 USED, 0 discarded   (measured at LOG_LEVEL=debug)
    clean:   6 started, 0 discarded, 6/6 answered

Measured at debug deliberately: `using preemptive generation` is `logger.debug` while only the
DISCARD is a warn, so absence of the warning is weak evidence and had to be a positive count.

**Latency is NOT claimed as improved.** LLM TTFT median read 1182ms here vs 815ms on 2026-08-19,
n=1 per arm — noise, not a regression and not a win. What is established is the mechanism.

## State when Koren left (18:21)

- **Local agent worker: STOPPED.** Deliberate — see the risk note below.
- Flags back to `false` in `.env`. `LOG_LEVEL=info`.
- Containers left UP for a fast resume: `keren-rag-pg` (pgvector, port 55432, 24 KB chunks) and
  `keren-rag-redis` (port 6379).
- Local DB now has a `phone_numbers` row: `+972555070922` → tenant `6b05cd71`, active. Added so
  an inbound PSTN call would route; it was empty, which would have refused the call as
  `unmapped_did` and played the not-in-service tone.

### ⚠️ The risk that forced the shutdown

`+972555070922` is ClickScales' PRODUCTION number, and the dispatch rule
`zadarma-inbound-to-agent` pins no agent — inbound calls go to whichever worker is registered and
awake. While the local worker ran (16:33–18:21), **a real prospect calling that number would have
reached the dev agent quoting placeholder pricing.** Stopping the local worker restores normal
production behaviour (the cloud agent `CA_azGQ9uaLxpot` picks up). Do not leave the local worker
running unattended.

## To resume the real-call test

    cd C:/keren-rag
    # flip the three flags to true in .env
    npm run voice:dev                     # wait for "registered worker"
    # then call +972555070922 from a real phone

Push on the two things the synthetic harness cannot test, because its TTS→STT mangles Hebrew
("זה יקר לי" → "היי היי קרלי", "אוקיי" → "הוקי"):
  - an objection phrased as a STATEMENT — must still retrieve
  - a bare acknowledgement — must log `rag_skipped reason=acknowledgement`
  - a price question (grounded) and something the KB does not hold (follow-up, never a number)

Browser alternative, no API server needed:
`WEB_CALL_TTL_SECONDS=21600 npx tsx --env-file=.env scripts/mint-web-call.ts`
(the 17:36 browser session connected and RAG resolved, but produced zero spoken turns — it
tested nothing about voice or latency).

## Still open

1. **pgvector on the production Railway DB — UNVERIFIED.** The read-only probe was blocked by the
   sandbox classifier. This gates a production deploy: migration 0014 runs `CREATE EXTENSION
   vector`, and since 2026-08-05 migrations run before boot, so a missing extension means the API
   container never boots. Verify BEFORE merging, not after.
2. **KB pricing is placeholder** (1,490 / 2,490 / 4,000 + 3,500 setup). Koren said he would update
   it. Grounding works well now, so she states these numbers aloud with confidence.
3. **RAG↔calendar coupling** — `ragEnabled` requires `runtime !== null`, so a tenant without a
   calendar gets no retrieval. Unrelated concerns. Fix: expose `tenantId` + a DB handle from
   `buildToolRuntime` when the gate is closed (that function carries a pool-leak warning — read it).
4. **`## Lead Context` defect** — literal `{{lead_name}}` reaches the LLM on every call. Pre-existing.
5. **Phase R3** — dashboard Knowledge page. DASHBOARD territory, not started.
