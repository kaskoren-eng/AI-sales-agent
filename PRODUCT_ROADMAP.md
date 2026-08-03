# AI Sales Agent — Product Roadmap

> Living document. Add new ideas anytime — just describe what you want and it gets logged here.
> Last major update: 2026-08-02 (voice migration shipped; Phase A and Phase D partially shipped)

---

## CURRENT INITIATIVE 🚧 — Launch

The voice engine migration is **done and live in production** (since 2026-07-29). The work now is getting to a real launch:

- Merge the two finished-but-unmerged workstreams — CRM automation and the conversation state machine — behind their real-call gates
- Flip the website's lead intake on (`website/netlify/functions/lead.js` is deployed but inert)
- Get through the remaining verification layers, including the outstanding gate of **10 real calls** (4 so far, all internal)

**See `VOICE_MIGRATION_PLAN.md`, `PROJECT_STATUS.md` and `docs/go-live-plan.md`.**

---

## SHIPPED ✅

**Channels & voice**
- Multi-channel outbound: WhatsApp (UChat + Twilio bridge), Email (Resend), Voice
- **Self-built voice pipeline** — Zadarma SIP → LiveKit → Soniox STT → OpenAI `gpt-5.4` → Cartesia TTS. Live in production. Six agent tools (calendar availability, booking, lead capture, two confirmations, end call), prompt-injection defense, DNC handling, recording notice + AI disclosure, toll-fraud spend caps
- Conversation state machine + reflexes (silence / barge-in / voicemail) and an objection playbook *(built, unmerged)*
- Meeting reminders — DST-safe, quiet-hours aware
- Voice engine history: ElevenLabs (POC, retired) → Retell (deprecated) → self-built LiveKit (live)

**Leads, CRM & automation**
- Lead intake webhooks: Meta Lead Ads, generic POST endpoint
- BullMQ flow automation with delayed steps (lead-intake, post-call flows)
- Google Calendar booking (service account + Domain-Wide Delegation, Meet link, auto slot-finding)
- Monday.com two-way sync + Airtable; Google Sheets
- **Automated CRM push after every call** — outcome → lead status → CRM, plus a GPT summary and captured facts *(built, unmerged)*
- Call learnings: recording → Whisper transcription → GPT analysis → injected into future agent prompts
- Post-call flow: update CRM → book calendar → send WhatsApp → send email
- CSV import with background worker

**Platform & dashboard**
- Dashboard UI — 13+ routes: Overview, Leads, Lead Detail, Calls, Call Detail, Voice, Bookings, Integrations, Settings, Copilot, Agent Personality, Simulator, Styleguide
- **Bilingual HE+EN** dashboard with full RTL, and the v5 cool-technical design system across every page
- **Real metrics** — `GET /api/v1/metrics/summary`, Overview wired to live KPIs + trend chart
- **Admin / operator console** — cross-tenant overview, tenant CRUD, suspend, API-key rotation, behind `ADMIN_API_KEY`
- Responsive mobile shell
- **Marketing website** — clickscales.com, EN + HE, on Netlify
- Dual auth: API key + JWT, per-tenant isolation; Sentry error monitoring
- Railway production deployment

---

## PHASE A — Core Intelligence

### Business Profile / Knowledge Base — ✅ largely shipped
The agent learns the owner's business and speaks aligned to it.
- ✅ Owner fills in: company description, product, ICP, pricing, objections, tone of voice
- ✅ Stored per-tenant (`SettingsService.getBusinessProfile()`), injected into every call + AI qualification context
- ✅ Dashboard: "Train My Agent" page (`/agent`)
- ⏳ Remaining: the proposed `agent_persona` setting — each tenant names and genders their own agent, driving both TTS voice selection and Hebrew prompt grammar

### Per-Tenant LLM Connection
Every client connects their own AI subscription.
- Supports: OpenAI (ChatGPT), Google Gemini, Anthropic Claude
- API key stored encrypted per tenant
- Onboarding flow after signup: connect LLM before agent goes live
- Dashboard: settings page with provider selector + key input

### Onboarding Copilot — 🔄 UI only, blocked
- The Copilot page ships at `/chat`, styled and in place
- ⚠️ There is **no assistant/chat backend endpoint**, so the conversation cannot be built. This is the blocker, not the UI

---

## PHASE B — New Channels

### Telegram Bot
- Inbound messages from Telegram → AI responds
- Outbound messages from flows (same as WhatsApp)
- Dashboard: paste Telegram bot token to activate

---

## PHASE C — Research & Reporting

### Market Research
Agent researches the client's market on demand.
- Web search: top competitors, trends, popular products, pricing landscape
- Trigger: manual button in dashboard or scheduled weekly
- Output: structured report shown in dashboard

### Sales Reports (Weekly / Daily / Monthly)
- Auto-generated from existing data: leads created, called, qualified, booked, won/lost
- Delivered by email + shown in dashboard
- Scheduled automatically

---

## PHASE D — Live Voice & Meetings

### Dashboard Voice Chat (Walkie-Talkie) — ✅ SHIPPED
- ✅ Talk to the AI agent directly from the browser, over a real LiveKit web-call
- ✅ Two surfaces exist today: `/voice` (VoiceChat) and `/simulator` (Simulator). Both now do a real web-call — **open decision: fold them into one**
- Backed by `voice-livekit/web-call.routes.ts`, using a placeholder "Web simulator" lead

### Zoom / Google Meet Auto-Join Bot
- Agent joins scheduled calls automatically
- Listens, summarizes, generates post-meeting report
- Delivers team performance stats (weekly/daily/monthly) in the meeting

---

## RAW WISHLIST LOG
> Everything requested, verbatim, in order

- "Learning and understand the business of the owner… agent needs to know how to work aligning to the business information and also understand and learn from live calls with owner how to work and how to speak right on the business."
- "I want the agent to be able to do market research on the client's niche, to do a web search on the market, and to make conclusions on how the market is built, what are the most powerful competitors, what are the popular products and trends."
- "I want this agent to be able to speak with the client in his dashboard or by connecting to telegraph. In the dashboard, I want to have a chat feature where the agent can speak with a voice call with a client, like a walkie-talkie or something like that."
- "I want the agent also to be able to join Zoom or Google Meet calls to review and get everyone on the team the stats of what they've done, like weekly, daily, and monthly reports."
- "The agent has an API connection that the client can connect after signup. After he gets to the agent UI, he can connect his LLM with the API connection… Every client needs to have his own AI subscription… Let's start from cloud and open AI to ChatGPT. And also with the Gemini."
