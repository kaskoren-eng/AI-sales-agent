# Retell AI Dashboard — Full Feature Reference *(ARCHIVED)*

> ⚠️ **Archived 2026-08-05.** Retell is no longer a vendor of ours and its code has been removed
> from this repo. Nothing here describes a system we run or can log into.
>
> **It is kept for one reason:** the feature→phase mapping table near the end is still the
> clearest statement of the dashboard backlog — what to build, what to skip, and why. Read it as
> a product backlog that happens to be organized around a competitor's surface area, not as
> integration documentation.

**Purpose (at capture time):** Feature parity reference for building our own voice AI platform on LiveKit — the checklist of "what Retell offers" so we knew what to prioritize, replicate, skip, or improve.
**Captured:** July 2026
**Source:** Full walkthrough of the Retell AI production dashboard, while we were still a customer

---

## Agent Builder (the core product)

The heart of the platform. Agent creation choices:

**Agent type:**
- **Single Prompt** — free-form, prompt-driven conversation
- **Conversation Flow** — deterministic, node-based flow builder for production-grade scripted conversations

**Modality:** Voice Agent or Chat Agent

**Starting points:**
- Library of ready-made templates: receptionist, outbound sales, appointment booking, lead qualification, delivery status caller, multi-department router, event reminders, B2B demo qualification, etc.
- "Build from scratch" blank option
- "Generate from prompt" — AI writes the agent config from a plain-language description

### Agent Editor — Top Bar
- Live estimated cost per minute
- Expected latency
- Token usage
- LLM selector: GPT-5.5/5.4/4.1, Claude 5/4.6 Sonnet, etc. (per-minute pricing shown per model)
- Voice selector: large library filterable by gender/accent, voice cloning, custom TTS provider support, plus speed/volume/expressiveness controls
- Spoken language/locale selector
- "Agent Handbook" for reference docs
- Version history icon

### Agent Editor — Configuration Panels (right side, collapsible)

**Functions** — agent capabilities:
- End the call
- Warm/cold call transfer
- Transfer to human agent
- Check/book calendar availability (Cal.com)
- IVR digit press
- Send in-call SMS
- Extract dynamic variables
- Run custom code
- Call a custom webhook function

**Knowledge Base**
- Attach PDF/DOCX/MD documents the agent references during calls

**Speech Settings**
- Response eagerness
- Interruption sensitivity
- Background sound
- Reminder message frequency
- Custom pronunciation rules

**Realtime Transcription Settings**
- Noise/denoising mode
- Speed-vs-accuracy transcription mode
- Boosted keyword vocabulary

**Call Settings**
- Voicemail detection + auto voicemail message
- IVR hangup detection
- Keypad input handling
- Silence timeout
- Max call duration
- Ring duration

**Post-Call Data Extraction**
- Define custom structured fields (call summary, sentiment, qualification status, etc.)
- Auto-extracted from every call transcript

**Security & Fallback Settings**
- Data retention/storage policy: everything | everything-except-PII | basic-attributes-only
- Content moderation setup
- Secure signed URLs
- Fallback voice if primary provider fails
- Default fallback values for variables

**Webhook Settings & MCPs**
- Real-time call events to your backend
- Attach Model Context Protocol tool integrations

---

## Deploy

**Phone Numbers**
- Buy/import numbers
- Separate inbound and outbound agents per number
- Allowed countries
- Fallback numbers

**Batch Call**
- Queue outbound calls to a list of contacts in bulk

---

## Data

**Call History & Chat History**
- Every session logged with: duration, cost, transcript, sentiment, end-reason

**Contacts**
- Lightweight CRM-like table (phone, name, contact ID)
- Sync from HubSpot or Salesforce

---

## Monitor

**Analytics**
- Dashboards for: call/chat volume, duration, latency, pick-up rate, transfer rate, voicemail rate, sentiment breakdowns
- Filterable by date range

**Live Monitoring**
- Ongoing calls in real time

**AI Quality Assurance**
- Scores completed calls on: audio quality, hallucinations, resolution accuracy
- Reports: average QA score, resolution rate, top user questions

**Alerting**
- Threshold-based alerts (payment failure spikes, concurrency exhaustion)
- Notifies via email/webhook

---

## System

**Integrations**
- HubSpot, Salesforce (more planned)

**Billing**
- Pay-as-you-go usage and history

**Settings**
- Concurrency/rate limits
- "Stable server" reliability opt-in
- API keys
- Workspace-level webhooks
- Team/workspace management

---

## Notes for our build

Categories mapped to our LiveKit stack:

| Retell Feature | Our Equivalent | Priority for MVP |
|---|---|---|
| Single Prompt agent | Python file with system prompt | ✅ Phase 1-2 |
| Conversation Flow builder | Not needed for MVP — start prompt-based | ❌ Skip |
| Voice selection | Cartesia voice_id in config | ✅ Phase 2 |
| Functions (end call, transfer, book calendar) | LiveKit function tools + Google Calendar API | ✅ Phase 4 |
| Knowledge Base | RAG over markdown files | 🔶 Phase 5+ |
| Speech Settings (interruption, silence) | LiveKit adaptive_interruption + VAD tuning | ✅ Phase 2 |
| Post-Call Data Extraction | GPT summarization on transcript → JSONL | ✅ Phase 4 |
| Webhook Settings | LiveKit event handlers → HTTP POST | 🔶 Phase 5 |
| Phone Numbers | Zadarma SIP trunk | ✅ Phase 3 |
| Batch Call (outbound campaigns) | LiveKit outbound dispatch | 🔶 Phase 6+ |
| Call History + transcripts | Save mp3 + JSONL per call | ✅ Phase 5 |
| Contacts CRM | JSONL / lightweight DB | 🔶 Phase 5 |
| Analytics dashboard | HTML dashboard reading JSONL | ✅ Phase 5 |
| Live Monitoring | LiveKit egress + browser player | ❌ Skip for MVP |
| AI Quality Assurance | Separate scoring pipeline (GPT reviews transcripts weekly) | 🔶 Phase 7 |
| Alerting | Slack webhook on errors | ✅ Phase 6 |
| Integrations (HubSpot/Salesforce) | Zapier webhook for now | 🔶 Later |
| Multi-workspace / teams | Skip — single-tenant for own use | ❌ Skip |

**Bottom line:** Retell's real value beyond the core voice pipeline is the **QA + Analytics + Post-Call Extraction + Flow Builder**. Those are what we'll want to replicate over time. The core voice conversation itself is largely commodity glue.
