# 2026-08-29 — Work list for the VOICE session (written by the supervisor session)

Source: Koren's live PSTN test of `EU3Yk6NqTNJZ` (= `296f03e`), the first call against the
humanization + handoff build, made 2026-08-29 ~10:24 UTC. Every claim below is backed by the
call report / agent logs quoted inline — no guesses.

**The supervisor does not write feature code.** Everything here is VOICE's to implement.

Reference call: room `call-_+972509788845_7STCY8qGtyLq`, 194s, 8 turns, tenant ClickScales
(`613d826c`), persona default (קרן / ClickScales).

---

## P0-1 — Migration 0017 is NOT applied in production; the handoff records nothing

```
request_human_handoff  {"reason":"רוצה לדבר עם בן אדם"}
handoff_flag_failed    column "handoff_requested_at" of relation "leads" does not exist
tool_call {"name":"request_human_handoff","durationMs":971,"ok":true}   <-- reports ok anyway
```

Verified by hashing every migration file against `drizzle.__drizzle_migrations`: **0017 is the
only genuinely unapplied migration.** (0016 IS applied — an earlier check looked for the wrong
column name; 0016 adds `plans.included_minutes`, not `usage_events.minutes`.)

⚠️ **`npm run db:migrate` is NOT safe here.** Three files — `0000_smart_wolf_cub.sql`,
`0001_add_tenant_api_key_hash.sql`, `0002_call_learnings.sql` — have drifted hashes (file content
changed after they were applied, most likely line endings). Drizzle applies anything whose hash is
absent, so a plain migrate would try to re-run `0000` against a live database and fail.

**Do:** apply 0017's two statements directly (add `IF NOT EXISTS` guards), then insert 0017's hash
into `drizzle.__drizzle_migrations` so the ledger matches reality. Separately decide what to do
about the three drifted hashes — reconciling them is what makes `db:migrate` usable again.

**Done when:** a handoff call leaves a non-null `leads.handoff_requested_at`, and
`handoff_flag_failed` no longer appears in the logs.

---

## P0-2 — The owner is never notified of a handoff

```
handoff_owner_not_notified {"tenantId":"613d826c...","configured":{"phone":false,"email":false}}
```

`tenants.settings.handoff` is **null** for ClickScales, so the tool had nowhere to send the alert.
Koren received nothing. The tool still returned `ok:true`.

**Do:** populate `handoff` for ClickScales (owner phone + email + notify channels) — Koren is
confirming the exact contacts. Then re-check the WhatsApp template SID the alert needs.

**Consider:** `ok:true` while both the DB write and the notification failed is the wrong signal.
A handoff nobody is told about is a lost lead. At minimum it should surface loudly in the call
report — Koren's call.

**Done when:** a handoff request reaches Koren's phone within 10s on a live call.

---

## P1-1 — The thinking-filler is what makes her sound robotic (Koren's main complaint)

Koren, verbatim: *"she stops after one word and then continue to the other word... she puts stops
inside her sentences, and it sounds like she got something like script to say."*

He is describing the filler firing long before the real reply. From the transcript:

| filler spoken | real sentence | gap |
|---|---|---|
| `"אהה."` @ 29.3s | `"אוקיי. כמה פניות נכנסות אליךָ ביום..."` @ 34.7s | **5.4s** |
| `"כן."` @ 186.8s | `"אוקיי. אני מעבירה את זה לצוות שלנו..."` @ 194.2s | **7.4s** |

The filler is designed to cover ~600ms of LLM think-time. It does not account for a TOOL CALL
running afterwards (`capture_lead_info` 1025ms, `request_human_handoff` 971ms) — so the pattern
becomes *word … multi-second silence … sentence*, which is worse than no filler at all.

It also hit its per-call cap: `thinking_filler {"filler":"אה...","n":3,"max":3}` — three fillers in
194s, mostly the same word. That is Koren's "the filler words was a bit weird".

**Do:** make the filler aware of what follows it. Options for VOICE to weigh — arm it only when no
tool call is pending; re-arm or extend if a tool starts after it fires; or raise
`VOICE_THINKING_FILLER_MS` (currently 2500) so it lands closer to the answer. Vary the word.

**Done when:** on a real call, no filler is followed by more than ~1.5s of silence, and no filler
word repeats within a call.

---

## P1-2 — The spoken register is enabled but she is not using it

`VOICE_SPOKEN_REGISTER_ENABLED` defaults ON and is not overridden in the cloud, so the section IS
in the prompt. Yet her Hebrew came out correct-but-formal — `"בסדר"`, `"מעולה"`, `"אהה"` — with no
light slang anywhere in 194 seconds. Koren: *"I didn't hear the saying any slang words."*

So this is prompt STRENGTH, not a switch. The register section is present and being ignored.

**Do:** strengthen the section so slang is actually reached for, without tipping into caricature.
Round-5 (17/17) was scored on TTS samples, not on a live LLM turn — that is the gap.

**Done when:** a live call shows natural light slang in at least 2 turns, and the golden fixture
tests are updated deliberately (they will change — see the note in `system-prompt.persona.test.ts`).

---

## P1-3 — Two conversation-quality bugs visible in the transcript

1. She answered `"כן."` to `"מה המצב, קרן?"` ("how is it going?"). Answering "yes" to a greeting
   question reads as a machine mishearing.
2. `"אהה."` was emitted as an entire standalone turn twice (@99.0s, @120.4s) while the caller was
   mid-thought — see also the 16.7s dead-air sample in the second call report.

---

## P2 — Handoff should capture WHY, and summarise it for the owner (Koren's request)

Koren, verbatim: *"she needs to ask the user why and what he needs and what he wants to say or talk
with the human... for the admin, for me, I would like to see a reason why that user want to talk to
me rather than talk to Keren. So it should come with a small summary about the reason."*

Today the tool takes a one-line `reason` straight from the model
(`{"reason":"רוצה לדבר עם בן אדם"}` — useless to a human) and ends the call.

**Do:** before handing off, have her ask what they would like to discuss, then send the owner a
short structured summary — who called, what they wanted, what was already established on the call,
and why a human was requested. Keep the "never block the handoff" property: if the caller will not
say, hand off anyway.

**Note:** this is the agent's first-impression role, so the ask must be one natural question, not
an interrogation.

---

## P3 — Latency: the sub-1s goal is still missed, and the LLM is why

Reference call, medians: end-of-turn **351ms** · LLM first token **1145ms** · TTS first byte
**233ms** · worst case **1730ms** · **dead air median 1708ms**, p90 2685ms. Prompt cache 84%.

Consistent with the known ~1.6s floor. Nothing here regressed — recorded so the humanization work
is not blamed for it. Under 1s still requires speaking sooner, which is exactly what P1-1 is about.

---

## P4 — Carried over: `feature/voice-cartesia-tenant-tts` (queue #4) still blocked

`main` and that branch implement `tenants.settings.agent_persona` twice — main's `persona.ts`
(`readAgentPersona` + `buildTTS`, now live in production) versus the branch's `tts/tts-settings.ts`
(`resolveAgentPersona` + `applyTenantTts`). They collide in `agent.ts`. The branch also holds
decisions main lacks: **sonic-3.5 as default**, the tenant-selectable model allowlist, and
per-tenant emotion/speed/volume. Replay those onto main's architecture; do not merge as-is, and do
not delete the branch. Full detail in `docs/supervisor/MERGE_QUEUE.md`.

---

## Not a bug — closed

**DID routing is correct.** Koren reported the two numbers were swapped; the logs disprove it.
`+972555070922` → `613d826c` Click Scales → קרן (`isDefault:true`), and `+972559662463` →
`c4862c8a` "Keren Gate Test" → מאיה / Acme Dental. Four consecutive calls, all resolved correctly.
The confusion is that the TEST TENANT is named "Keren Gate Test" while its agent is **Maya** —
worth renaming that tenant to something like "Acme Dental (test)".

⚠️ Koren has since changed something in the Zadarma dashboard to "fix" this. Since nothing was
broken, **re-verify inbound routing on the next call** — if a DID now arrives in a different form,
the lookup misses and the caller gets "not in service".

**Also confirmed working:** gender-aware niqqud (`"לךָ"` throughout), Soniox transcription,
sonic-3.5 TTS, `capture_lead_info`, prompt caching at 84%.
