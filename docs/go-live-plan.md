# Go-Live Plan — Keren in Production
## From working voice agent to full sales machine

**Owner:** Koren
**Telephony:** **Zadarma** is the voice/SIP provider (production path, already wired to LiveKit). **Twilio is for WhatsApp only** — a temporary bridge so Keren can operate WhatsApp for ClickScales while the business WhatsApp awaits Meta approval. Once Meta approves, migrate WhatsApp to Meta Cloud API direct and retire the Twilio WhatsApp path (Twilio stays for conference-call monitoring only).
**CRM targets:** Monday.com (exists) + Airtable (exists) → then Fireberry (new — popular with Israeli SMBs)
**Invoicing:** **SUMIT and Green Invoice built in parallel** behind one provider interface. SUMIT = what Koren uses (tenant #1); Green Invoice = what most Israeli clients use. Both are launch requirements, per-tenant selectable.

---

## What already exists (reuse map — read before building ANYTHING)

| Need | Existing infrastructure |
|---|---|
| Follow-up workflows with delays | `flow-executor.worker.ts` — multi-step flows with delays, variable interpolation, WhatsApp/Voice/Email steps |
| Scheduled reminders | BullMQ delayed jobs + `scheduled_calls` table (has `scheduledAt`) |
| CRM sync — Monday | Full integration: sync/push/webhook, encrypted tokens |
| CRM sync — Airtable | Integration exists |
| Call summaries | `call-analysis.worker.ts` — Whisper transcript → GPT analysis already generates summaries into `call_learnings` |
| Lead status workflow | `new → contacted → qualifying → qualified/disqualified` with `canTransition()` guard |
| WhatsApp send | `outbound-sender.worker.ts` (UChat path) |
| Email send | Resend integration |
| Meeting booking | Phase 4 Priority 1 — done (calendar + invites via DWD) |

**Bottom line: ~70% of this plan is wiring, not building.**

---

## The plan — 4 workstreams in priority order

### Workstream A — Close the conversation loop (finish Phase 4 Priority 2)
*Prereq for everything else. Already specced.*

1. `capture_lead_info` — save qualification data live during the call
2. `send_whatsapp_confirmation` + `send_email_confirmation` after booking
3. Remaining Tier 1 security: prompt injection tests + toll fraud daily limit

### Workstream B — CRM automation (the "after the call" story)

**B1. Lead status auto-update (Monday + Airtable first):**
- On call end → map call outcome to lead status:
  - `meeting_booked` → status `qualified` + CRM update
  - `not_qualified` / `not_interested` → `disqualified` + reason
  - `callback_requested` → `contacted` + follow-up task created
  - `opt_out` → `opted_out` (already done in Priority 1)
- Push status change to Monday (existing push endpoint) + Airtable

**B2. Call summary into CRM:**
- `call-analysis.worker.ts` already produces a GPT summary after every call
- Add a post-analysis step: push summary + key fields (budget, timeline, pain points, next step) as an update/note on the CRM item
- Monday: item update. Airtable: field update + long-text summary field.

**B3. Fireberry integration (NEW — build like Monday pattern):**
- Israeli CRM (formerly Powerlink), REST API with token auth
- Scope for v1: create/update lead (contact), update status, add note with call summary
- Follow the exact module pattern of `integrations/monday`: configure endpoint (encrypted token), push, status mapping
- Per-tenant: each client connects their own Fireberry token

### Workstream C — Workflows (follow-ups + reminders)

**C1. Meeting reminders — WhatsApp + email, day before + hour before:**
- On `book_meeting` success → enqueue 4 BullMQ delayed jobs:
  - T-24h WhatsApp reminder
  - T-24h email reminder
  - T-1h WhatsApp reminder
  - T-1h email reminder
- Content: Hebrew, warm, includes date/time + Meet link + "reply here to reschedule"
- Cancellation logic: if meeting is cancelled/rescheduled → cancel pending reminder jobs (store job IDs on the `scheduled_calls` row)
- Edge: booking made <24h before meeting → skip the T-24h pair automatically

**C2. Follow-up workflows (defined, solid, but flexible):**
Implemented as flow definitions on the existing flow-executor (config, not code):

| Trigger | Flow |
|---|---|
| Call not answered | Retry call after 3h → if again no answer, WhatsApp "ניסינו להשיג אותך" → mark for manual review |
| `callback_requested` | Schedule callback at requested time (parse from call notes) → reminder to Koren via Slack/WhatsApp |
| Meeting no-show | 15 min after meeting start with no attendance → WhatsApp "פספסנו אותך, נתאם מחדש?" → offer rebooking |
| Post-demo (Koren marks "proposal sent") | T+2d WhatsApp check-in → T+5d email → T+9d final WhatsApp → if no response, status `cold_nurture` |
| WARM lead (not booked, not disqualified) | T+1d WhatsApp with value content → T+4d call attempt #2 → T+10d final email |

- Flows stored per-tenant in `tenants.settings.flows` (existing pattern) → **flexible without code changes**
- Every flow step logged; every outbound respects opt-out + quiet hours (no messages 21:00–08:00 Israel)

### Workstream D — Billing documents (SUMIT + Green Invoice, parallel)

**D0. Provider interface first (`billing/provider.interface.ts`):**
- Same pattern as scheduling providers — one interface, interchangeable implementations
- Interface scope v1: `createCustomer`, `createInvoice` (חשבונית מס/קבלה), `emailDocument`, `getDocumentStatus`
- Per-tenant provider selection: `tenants.settings.billing_provider = 'sumit' | 'greeninvoice'`
- Per-tenant credentials, encrypted like Monday tokens

**D1. SUMIT implementation:**
- What Koren (tenant #1) uses — dogfooding path
- REST API (api.sumit.co.il)

**D2. Green Invoice implementation (same milestone, not deferred):**
- What most Israeli clients use — **launch requirement for selling Keren**
- REST API (api.greeninvoice.co.il), sandbox available

**Shared rules:**
- Trigger: **manual or payment webhook** — NOT from within a call. The agent never discusses money (per prompt rules).
- System endpoint: `POST /api/v1/clients/:id/invoice` routes to the tenant's configured provider
- Both implementations tested against sandbox before live

---

## Prompt improvements (parallel track, ongoing)

- Sharpen discovery questions based on real transcripts accumulated so far
- Tool-use instructions for the new CRM/status functions (when to call what)
- Objection-handling additions from real calls (weekly review loop input)
- Keep methodology rule #1: every prompt change ships with a regression test

---

## Suggested build order (realistic timeline)

| Week | What ships |
|---|---|
| 1 | Workstream A (Priority 2 + security leftovers) + C1 (reminders — high value, low effort) |
| 2 | B1 + B2 (status sync + summaries to Monday/Airtable) |
| 3 | C2 (follow-up flows as config) + prompt improvements round |
| 4 | B3 (Fireberry) — new module |
| 5 | D1 (SUMIT) — new module |
| Later | D2 (Green Invoice), multi-number Twilio production setup |

Merge gate stays: real test call by Koren before flipping any of this live on the tenant.

---

## Kickoff prompt for Claude Code (Workstream A + C1)

```
Read docs/go-live-plan.md. This session: Workstream A + C1 only.

A. Finish Phase 4 Priority 2 on branch feature/voice-livekit-phase-4-tools:
   - capture_lead_info tool (save qualification fields to leads table during the call)
   - send_whatsapp_confirmation + send_email_confirmation (enqueue via existing 
     outbound-sender; only claim channels that actually succeeded)
   - Prompt update with regression tests (methodology rule #1)
   - Security leftovers: prompt injection CRITICAL RULES + 20 tests; toll fraud 
     daily_spend_limit_usd (default 50) checked before outbound dial

B. Meeting reminders (C1), new branch feature/meeting-reminders:
   - On successful book_meeting: enqueue 4 delayed BullMQ jobs (T-24h + T-1h, 
     WhatsApp + email each) 
   - Store job IDs on the scheduled_calls row; cancel them on meeting 
     cancellation/reschedule
   - Skip T-24h pair when booking is less than 24h before the meeting
   - Hebrew reminder templates using israel-time.ts formatting, include Meet link
   - Respect opt-out and quiet hours (no sends 21:00-08:00 Israel time)
   - Tests: job scheduling math (including DST), cancellation path, quiet-hours 
     deferral

Propose a plan for both before writing code. Explain terminology — I'm not a developer.
```

---

## Open items needing Koren's input later

1. **SUMIT API credentials** — create API key in SUMIT settings when Workstream D starts
2. **Fireberry sandbox** — need a Fireberry account/token for development (client's or trial)
3. **Twilio production number** — Israeli number on Twilio vs keeping Zadarma for production caller ID
4. **Quiet hours policy** — confirmed 21:00-08:00? Adjustable per tenant
5. **Post-demo flow trigger** — how does Koren mark "proposal sent"? (Dashboard button / Monday status change / WhatsApp command to bot)
