# Handoff — voice-livekit — 2026-07-29 (Phase 6 verification day)

Branch `feature/meeting-reminders` = `master` (fast-forward each push; Railway backend auto-deploys
from master, cloud agent redeployed per change). Full suite: **504 passing**, tsc clean; the only 2
failures are the pre-existing `lead.service` / `lead.routes` ones (Koren's lead-detail work — voice
never touches that module).

## Production cutover (earlier today)
Retell→LiveKit went live on the real ClickScales tenant `613d826c` (voice_engine=livekit,
functions_enabled=true). Cloud agent + prod backend both on the new code. Rollback = flip tenant to
retell (but Retell is deprecated — not a real fallback; do NOT roll back there). See
[[project_livekit_prod_cutover]]. Recording notice is DISABLED per Koren (not needed now); the
10ms-frame smoothness fix is committed and flag-gated for whenever it's wanted.

## Phase 6 — Layer 0 (my deliverable): GREEN
- 0.1 merge order: meeting-reminders→master done; dashboard-sprint-2→master is the dashboard
  session's step (order respected).
- 0.2 backend deployed on latest master, healthy, reminders + window-WhatsApp workers live.
- 0.3 businessProfile reaches the agent (whitelisted + consumed; 42 tests). Fill Settings→Business
  Profile on the test tenant to see the live mention in a layer-1 call.
- 0.4 recording notice: fixed (10ms) + DISABLED per Koren's decision (he owns the legal call).
- 0.5 Task 0: all paths (outbound + web + inbound); voice calls list in the dashboard.
- Tools for Koren's layers 1-5: `scripts/inspect-reminders.mjs` (queue.getDelayed) and
  `scripts/set-toll-fraud.mjs <tenant> <limit|reset>`. Target tenant = keren-gate-test (c4862c8a)
  for the simulator; real inbound phone routes to ClickScales 613d826c (VOICE_WEBHOOK_TENANT_ID).

## Bugs found in Koren's verification calls — all FIXED
1. **`capture_lead_info` null-loop (the "she vanished 20-44s" bug)** — gpt-5.4 fills unknown tool
   fields with `null`; schemas were `.optional()` (rejects null) → Zod failed → the model retried
   the same call in a silent loop. Fixed: every optional field `.nullable().optional()` on
   capture_lead_info AND book_meeting.notes. (commit 3e3d80e) Verified gone on the next call.
2. **Calendar: one-slot-per-day → offer a RANGE** (Koren's spec) — new `groupAvailability()` +
   check_calendar returns per-day free ranges + all slot_datetimes; STEP4_TOOLS rewritten to
   tomorrow-first → pick a day → "יש לי פנוי מ-10:00 עד 15:00" → book the exact matching slot.
   (commit 01e62cc) Verified working on the next call (booked Sun 12:00 from a range).
3. **WhatsApp never delivered — two distinct causes across calls:**
   - out-of-window + no approved template → `whatsapp_send_blocked` (EXPECTED until Twilio approves
     templates — Koren's standing note).
   - **Twilio 21211 "invalid number"** — the confirmation went to a LOCAL Israeli number
     (`0501111111`), not E.164. Fixed: `toWhatsAppE164()` normalizes `05X→+9725X` on both Twilio
     send paths. (commit cb48a88, backend a5eb4179) NOTE: Koren gave a FAKE number in the test, so
     it still won't deliver — a REAL number in any format now will.

## What the last verification call proved (end-to-end, tools on)
Task-0 row ✓ · capture ×4 all-ok (null fix) ✓ · tomorrow-first + range offer ✓ · anti-hallucination
(refused an out-of-range time) ✓ · booked the exact picked slot ✓ · scheduled_calls + 4 reminders
(>24h) ✓ · call_learnings `analyzed` + GPT summary ✓ · email ok · whatsapp failed only on the
fake/local number (now fixed). Latency median: EOU 591 / LLM 841 / TTS 162 / worst 1594, cache 88%.

## Remaining (NOT mine to start unprompted)
- **Layers 1-5**: Koren runs; I fix what surfaces.
- **#5 behavior tuning** (prompt/content = Koren's territory): her replies are long (drives the
  "feels high" latency), and she looped on one discovery question 4× on a difficult caller. Give a
  spec (like the calendar one) and I'll implement.
- **#1 voice quality / DeepDub**: deferred until marketing (product decision).
- **Layer 6**: 10 real calls on ClickScales — only after 1-5 green.
