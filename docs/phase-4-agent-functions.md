# Phase 4: Agent Functions (Feature Parity with Retell)

> **Historical framing.** Retell was removed from the repo on 2026-08-05. The "Retell equivalent"
> lines below are kept deliberately: they record WHY each tool exists and what it was specced
> against. They are not a live integration.

**Status:** Built and live (six tools)
**Reference:** `docs/retell-ai-dashboard-reference.md` (archived Functions section)
**Goal:** Wire up the tools/functions Keren needs to actually perform sales work — book meetings, capture lead data, send confirmations, transfer to human.

---

## Design Principle

Retell's "Functions" are just **LLM tool calls**. The LLM decides during the conversation which function to invoke, based on context. Our job is to:
1. Register each function as an LLM tool with a clear name + JSON schema
2. Implement the handler that actually executes it
3. Return a structured result the LLM can use in its next turn
4. Reuse existing services (calendar, DB, workers) — don't rebuild

---

## Priority-Ordered Function List

### 🥇 Priority 1 — MUST HAVE (blocks going live with real leads)

#### 1. `check_calendar_availability(from_date, to_date, duration_minutes)`
- **What:** Query available slots on Koren's Google Calendar within a range
- **Returns:** List of available time slots, formatted for Keren to offer verbally
- **Reuses:** `src/modules/scheduling/providers/google-calendar.provider.ts` (existing)
- **Retell equivalent:** "Check calendar availability (Cal.com)"

#### 2. `book_meeting(name, phone, email, slot_datetime, notes)`
- **What:** Create a Google Calendar event + insert into `scheduled_calls` DB table + trigger post-booking flow
- **Returns:** Confirmation with booking ID and slot details
- **Reuses:** Google Calendar provider, `scheduled_calls` schema, existing flow executor
- **Retell equivalent:** "Book calendar availability"

#### 3. `end_call(reason)`
- **What:** Gracefully hang up the call. Optional reason for logging.
- **Returns:** void (call terminates)
- **Reuses:** LiveKit `Room.disconnect()`
- **Retell equivalent:** "End the call"

### 🥈 Priority 2 — SHOULD HAVE (needed for full sales flow)

#### 4. `capture_lead_info(field_name, value)`
- **What:** Save extracted lead data (name, business_type, service_needed, budget, timeline) to `leads` table as the conversation progresses
- **Returns:** Confirmation the field was saved
- **Reuses:** `leads` schema, existing lead update patterns
- **Retell equivalent:** "Extract dynamic variables"
- **Why important:** Lead qualification data lives in DB even if call disconnects

#### 5. `send_whatsapp_confirmation(phone, template, variables)`
- **What:** Send confirmation of booked meeting via WhatsApp
- **Returns:** Message ID
- **Reuses:** `outbound-sender.worker.ts` (existing) — just enqueue a job
- **Retell equivalent:** "Send in-call SMS" (but WhatsApp)

#### 6. `send_email_confirmation(email, subject, body, ics_attachment)`
- **What:** Send email with calendar invite attached
- **Returns:** Message ID
- **Reuses:** Resend integration (existing), `outbound-sender.worker.ts`
- **Retell equivalent:** Doesn't have — bonus

### 🥉 Priority 3 — NICE TO HAVE (advanced flows)

#### 7. `transfer_to_human(target_phone)`
- **What:** SIP REFER — transfer the current call to Koren's mobile
- **Returns:** Transfer initiated confirmation
- **Reuses:** LiveKit SIP REFER capability
- **Retell equivalent:** "Warm/cold call transfer"

#### 8. `notify_slack(channel, message)`
- **What:** Post to Slack when hot lead identified (real-time alert to Koren)
- **Returns:** Message ID
- **Reuses:** Slack MCP or webhook (Koren has this configured for other things)
- **Retell equivalent:** "Call a custom webhook function"

#### 9. `send_ivr_digit(digit)`
- **What:** For scenarios where the callee's phone tree requires a keypress
- **Returns:** Confirmation
- **Reuses:** LiveKit DTMF support
- **Retell equivalent:** "IVR digit press"
- **Priority:** Very low — only relevant for outbound to businesses with IVR

#### 10. `custom_webhook(url, payload)`
- **What:** Generic HTTP POST for future integrations (CRM sync, analytics, etc.)
- **Returns:** Webhook response status
- **Reuses:** Existing HTTP client with circuit breaker
- **Retell equivalent:** "Call a custom webhook function"

---

## What We Already Have in the Codebase (Reuse Map)

| Function | Existing Service to Reuse |
|---|---|
| `check_calendar_availability` | `google-calendar.provider.ts` → `getAvailableSlots()` |
| `book_meeting` | `google-calendar.provider.ts` → `createEvent()` + `scheduled_calls` schema |
| `capture_lead_info` | `leads` service → `updateLead()` |
| `send_whatsapp_confirmation` | `outbound-sender.worker.ts` queue |
| `send_email_confirmation` | `outbound-sender.worker.ts` queue (Resend path) |
| `notify_slack` | New — but simple HTTP POST to Slack webhook |
| `transfer_to_human` | New — LiveKit SIP REFER |
| `end_call` | LiveKit built-in `Room.disconnect()` |
| `custom_webhook` | New — simple HTTP client + circuit breaker |

**Bottom line:** Priorities 1 & 2 use ~90% existing code. This is a wiring job, not a build job.

---

## Copy-Paste Prompt for Claude Code

```
TASK: Implement Phase 4 — Agent Functions for the voice-livekit agent (Keren).

Read docs/phase-4-agent-functions.md for the full function list and priorities.

Implementation approach:

1. Create src/modules/channels/voice-livekit/tools/ directory with one file per 
   function. Each file exports:
   - The tool definition (name, description, JSON schema) that gets registered 
     with the LLM
   - The handler function that executes the tool call
   - Zod validation for tool arguments
   
2. Wire the tools into agent.config.ts by passing them to the LLM plugin's tools 
   array. Each turn, the LLM will decide whether to call a tool based on the 
   conversation context.

3. All tool handlers must:
   - Accept a context object containing: tenantId, leadId, conversationId, callId
   - Return a structured response the LLM can incorporate into its next reply
   - Log tool calls to call_learnings.analysis for post-call review
   - Handle errors gracefully — return an error message the LLM can relay to the 
     caller ("I had trouble booking that slot, let me try another time")
   - Respect tenant isolation on all DB queries
   - Use circuit breakers for external calls

4. Implement Priority 1 FIRST — do not skip to Priority 2 until 1 is tested and 
   working end-to-end with a real phone call.

Priority 1 functions (implement + test before moving on):
- check_calendar_availability
- book_meeting
- end_call

Priority 2 functions (implement AFTER Priority 1 is live):
- capture_lead_info
- send_whatsapp_confirmation
- send_email_confirmation

Priority 3 functions (implement in Phase 4.3, only if needed):
- transfer_to_human
- notify_slack
- custom_webhook

5. Update the Keren system prompt (system-prompt.he.ts) to instruct the LLM WHEN 
   to use each tool. For example:
   
   "When the lead is qualified and wants to book a meeting:
   - First call check_calendar_availability with a 5-day window from today
   - Offer the lead 2-3 slots verbally
   - Once they confirm a slot, call book_meeting with all their details
   - Then send_whatsapp_confirmation AND send_email_confirmation in parallel
   - Confirm verbally that everything was sent
   - Then call end_call gracefully"

6. Testing:
   - Unit tests for each tool handler (mock external services)
   - Scripted conversation test: HOT lead → check_calendar → book → confirmations 
     → end_call. Assert all 4 tool calls happen in order.
   - Real end-to-end phone call test: call the number, go through the flow, 
     verify meeting appears in Koren's Google Calendar within 5 seconds

CONSTRAINTS:
- The legacy `src/modules/channels/voice/` module no longer exists (deleted 2026-08-05)
- Follow all conventions in CLAUDE.md (imports with .js, Fastify plugins, 
  AppError subclasses, tenant isolation on every DB query)
- Circuit breaker on every external API call (LiveKit registered breakers pattern)
- Feature-flag the tools so they only activate for tenants with 
  voice_engine='livekit' AND functions_enabled=true (add this to tenants.settings)
- Commit each function separately on branch feature/voice-livekit-phase-4-tools
- Do not merge to main until Priority 1 passes real-call test

DELIVERABLES REPORT:
When each priority is complete, report:
- Which tools shipped
- Test results (unit + scripted + real call if applicable)
- Any Hebrew edge cases discovered (date/time formatting in Hebrew, name 
  encoding issues, etc.)
- Latency impact of tool calls (should be <500ms per tool call ideally)
- Recommendation on when to move to next priority

Before writing code: propose a plan for Priority 1 only and wait for my approval.
Explain terminology as you go — I'm not a developer.
```

---

## What Success Looks Like at End of Phase 4

**A HOT lead calls the ClickScales phone number.**

Keren answers, asks 4 discovery questions, decides the lead is qualified (budget >15K NIS + timeline <1 month). Then:

1. Keren: "מעולה, בוא נקבע פגישת דמו עם קורן. אני בודקת את היומן..." 
   → LLM calls `check_calendar_availability(2026-07-19, 2026-07-24, 30)`
   → Returns 3 slots

2. Keren: "יש לי מחר ב-11:00, מחרתיים ב-14:30, או ביום חמישי ב-10:00. מה מתאים?"
   → Lead: "מחרתיים ב-14:30 טוב"

3. Keren: "מעולה. מה מספר הטלפון והאימייל שלך?"
   → Lead provides
   → LLM calls `capture_lead_info` twice (phone, email)
   → LLM calls `book_meeting(name, phone, email, 2026-07-20T14:30, notes)`
   → Returns booking ID + calendar event link

4. Keren: "מצוין! שלחתי לך אישור בוואטסאפ ובמייל, ונדבר מחרתיים ב-14:30."
   → LLM calls `send_whatsapp_confirmation` in parallel with `send_email_confirmation`
   → Both return success

5. Keren: "יום נהדר!" 
   → LLM calls `end_call("meeting_booked")`
   → Call ends gracefully

**End state:**
- Google Calendar event: created ✅
- `scheduled_calls` DB row: created ✅
- `leads` DB row: updated with qualification data ✅
- `call_learnings` DB row: created with full transcript + tool call log ✅
- WhatsApp confirmation: sent to lead ✅
- Email confirmation with .ics: sent to lead ✅
- Slack notification to Koren: "🔥 Hot lead booked — יובל, e-commerce, 20K/mo, מחרתיים 14:30" (if Priority 3 done)

**Time from call start to complete: 3-4 minutes. Fully autonomous.**

---

## Estimated Timeline

- Priority 1 (calendar + booking + end_call): **1-2 days** of Claude Code
- Priority 2 (lead capture + confirmations): **1 day**
- Priority 3 (transfer + Slack + webhook): **1 day** — do only if needed
- Testing + Hebrew edge cases: **1-2 days** across all priorities

**Total realistic:** 5-6 days of active Claude Code work + your testing time between batches.

---

## After Phase 4 is done

Remaining tasks:
- Phase 5: Testing infrastructure (scripted conversations, automated regression)
- Phase 7: Weekly iteration loop (human review + prompt tuning)
- Ongoing: latency optimization, Hebrew quality tuning, prompt evolution

**Phase 4 made Retell fully replaceable — and it was replaced.** LiveKit went live on 2026-07-29 and the Retell code was deleted on 2026-08-05. There is no engine flag any more.
