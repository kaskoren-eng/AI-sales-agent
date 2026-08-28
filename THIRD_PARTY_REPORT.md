# Third-Party Connections Report
## AI Sales Agent — Who Owns What

> Goal: platform stays lean. Clients bring their own keys wherever possible.
> Last updated: 2026-08-02 (voice migration complete — LiveKit + Soniox + Cartesia live in production since 2026-07-29)

---

## Summary Table

| Service | What It Does | Whose Side | Status |
|---|---|---|---|
| Railway | Hosting, DB, Redis | Platform (Koren) | Live |
| **LiveKit Cloud** | Voice pipeline orchestration (eu-central) | Platform (Koren) | **Live in production since 2026-07-29** |
| **Soniox** | Streaming STT, `stt-rt-v5` — the Hebrew recognizer | Platform (Koren) | **Live — default `STT_PROVIDER`** |
| **Cartesia** | Text-to-Speech (`sonic-3`, Hebrew) | Platform (Koren) | **Live — default TTS** |
| **DeepDub** | Alternative Hebrew TTS (`dd-etts-3.2`), full adapter built | Platform (Koren) | Built, behind `VOICE_TTS_PROVIDER` — **not default** |
| OpenAI (LLM) | Agent brain — `gpt-5.4` via `AI_MODEL` / `VOICE_LLM_MODEL` | Platform (Koren) | Live |
| OpenAI Realtime (`gpt-realtime-whisper`) | Streaming STT — **superseded by Soniox**, kept as fallback | Platform (Koren) | Fallback only |
| ~~Retell AI~~ | ~~Voice agent orchestration~~ | — | **Removed 2026-08-05.** Vendor no longer available; code deleted from the repo |
| Zadarma | SIP number / caller ID → direct SIP trunk into LiveKit | Platform (Koren) | Live |
| Twilio | WhatsApp bridge + conference-call monitoring | Platform (Koren) | Live (WhatsApp templates pending approval) |
| WhatsApp Business API | WhatsApp messaging — direct Meta, no middleware | Platform (Koren) | Needs rebuild |
| Resend | Email sending | Platform (shared domain) / Client (own domain) | Live |
| **Netlify** | Hosts the marketing site + the lead-intake function | Platform (Koren) | Live (lead function deployed **inert**) |
| Google Calendar | Meeting booking | Platform service account (Domain-Wide Delegation) | Live — per-tenant OAuth still future |
| Monday.com | CRM sync | Client | Live |
| Airtable | CRM sync | Client | Live |
| Sentry | Error monitoring | Platform (Koren) | Live |
| LLM — OpenAI / Gemini / Claude | Per-tenant agent brain | Client | Needs build |
| Platform LLM (OpenAI) | Onboarding agent + market research web search | Platform (Koren) | Partial — Copilot UI ships, **no chat backend endpoint exists** |
| Telegram | Messaging channel | Client | Planned |
| Recall.ai (or similar) | Zoom/Meet bot | Platform | Planned |
| Meta (Facebook) | Lead Ads webhook | Client | Live |
| ~~ElevenLabs~~ | ~~AI voice agent~~ | ~~Platform~~ | Retired (original POC) |

---

## PLATFORM SIDE — Koren always owns these

### 1. Railway — Hosting, DB, Redis
- Shared infrastructure for all tenants
- Nothing to configure per client

### 2. Voice Engine — self-built LiveKit pipeline *(live)*

**As built:** Zadarma DID → SIP trunk → LiveKit room → **Soniox `stt-rt-v5`** (STT) → **OpenAI `gpt-5.4`** (LLM) → **Cartesia `sonic-3`** (TTS).

- Platform owns the LiveKit Cloud, Soniox, Cartesia and OpenAI accounts. Clients need none of them — voice is included in the product.
- Per-tenant customization: system prompt built from the tenant business profile + `call_learnings` (same pattern the Retell integration used via `retell_llm_dynamic_variables`).
- Selected per tenant by `tenants.settings.voice_engine`. ClickScales (`613d826c`) has been on `livekit` since 2026-07-29.
- **Two provider decisions worth knowing:**
  - **STT is Soniox, not OpenAI Realtime.** Chosen on a head-to-head over real Hebrew calls: semantic WER 4.3% vs 34.9%. OpenAI Realtime remains selectable via `STT_PROVIDER` but is not the path in use.
  - **DeepDub is built but off.** Full adapter at `voice-livekit/tts/deepdub.tts.ts`, selectable via `VOICE_TTS_PROVIDER`. Koren preferred it 6:1 in a blind A/B; it has not been switched on by default.
- Why we migrated: (1) Retell didn't expose human-sounding features for Hebrew — our primary language; (2) per-minute cost; (3) no vendor lock-in on the orchestration layer.
- Full plan and as-built notes: `VOICE_MIGRATION_PLAN.md` in project root.

**Removed:** Retell AI. Deleted from the repo on 2026-08-05 — the vendor is no longer available to us. The `voice_engine` flag is gone; there is one engine and no rollback.
**Retired:** ElevenLabs (original POC voice provider, phased out before Retell).

### 3. Platform LLM (OpenAI with web search) — Onboarding + Market Research
- Two uses for the platform's own LLM key:
  1. **Onboarding agent**: the AI assistant in the dashboard that talks to new clients, asks them questions, and guides the full setup process conversationally
  2. **Market research**: web-search-enabled queries — no need for a separate Tavily key
- This is separate from the client's LLM key (which powers their sales agent's brain)
- Platform pays for this — it's a product cost
- ⚠️ **Status: partial.** The Copilot page ships at `/chat`, but there is no assistant/chat backend endpoint behind it. The conversation cannot be built until one exists.

### 5. Netlify — marketing site
- Hosts `website/` (clickscales.com, EN primary + `he/`)
- `website/netlify/functions/lead.js` forwards site form submissions into the lead-intake webhook. **Deployed but inert** — awaiting the go-live flip.

### 6. Sentry — error monitoring
- Platform-wide, `src/plugins/sentry.ts`, `SENTRY_DSN` + `SENTRY_ENVIRONMENT`

### 7. Operator console access
- Not a vendor, but a platform credential: `ADMIN_API_KEY` gates all `/api/v1/admin/*` routes. Unset ⇒ every admin route 503s, so the console is opt-in. Shared secret today; real admin accounts and an operator audit log are deferred.

### 4. Recall.ai — Zoom/Meet Bot *(planned)*
- Expensive shared service, platform absorbs the cost

---

## CLIENT SIDE — each client connects their own

### 1. LLM — The Agent's Brain
- Client brings their own API key: OpenAI, Google Gemini, or Anthropic Claude
- Powers: lead qualification, call analysis, conversation responses, sales coaching
- Client pays their own AI bill — usage scales with their business
- Dashboard: provider selector + encrypted API key input during onboarding

### 2. Phone Number — Outbound Calling
- Client brings their own Twilio account (Account SID + Auth Token + Phone Number)
- Their leads see their business number on caller ID
- Recordings stored in their Twilio account
- ⚠️ Internet/VoIP option: to be reviewed — if client wants VoIP calling instead of Twilio, need to evaluate what the connection requires (will confirm)

### 3. Google Calendar — Meeting Booking
- **Today:** a platform service account with **Domain-Wide Delegation** (`GOOGLE_CALENDAR_IMPERSONATE_USER`). This works properly — real email invites and Meet links go out. Not a defect.
- **Future:** per-tenant OAuth, so each client books on their own calendar under their own account. Still unbuilt, and still the right end state for multi-tenant.

### 4. Email — Sending Domain
- Client provides their own sending domain via Resend, or brings their own Resend key
- Leads receive emails from the client's own domain (not the platform's)

### 5. CRM — Monday.com + Airtable *(live)*, HubSpot / Salesforce / Fireberry *(future)*
- Client pastes their API token — already working
- **Automated push (Workstream B):** after each call, the outcome updates the lead status and pushes a GPT summary + captured facts into the connected CRM. Per-tenant `tenants.settings.crm_sync`. Built and tested, **not yet merged** — gated on one real call landing in a connected CRM.

### 6. Telegram Bot *(planned)*
- Client creates bot via @BotFather, pastes token — simple

---

## WHATSAPP — REBUILD REQUIRED

**Current:** relies on UChat (third-party middleware) — remove this dependency.

**Target:** Direct Meta WhatsApp Business Cloud API
- Platform registers as a Meta Business Solution Provider (BSP) or each client connects their own WhatsApp Business Account
- Recommended model: **platform-level BSP** — clients connect their WhatsApp number through the platform's Meta app (no UChat, no third-party)
- Client onboarding: OAuth-style flow via Meta's Embedded Signup — client connects their WhatsApp Business number in a few clicks inside the dashboard
- Incoming messages → platform webhook → BullMQ (same architecture as today, different provider)
- Outgoing messages → Meta Cloud API (replace UChat calls)
- No per-message cost markup from a middleware

**What this requires:**
- Register a Meta App (Business type)
- Apply for WhatsApp Business API access
- Implement Embedded Signup flow in the dashboard
- Rewrite `whatsapp.service.ts` to call Meta Cloud API directly

---

## ONBOARDING FLOW (revised)

The onboarding agent (AI chat inside the dashboard) walks the client through setup conversationally:

```
Step 1 — Required to go live:
  [ ] LLM key (OpenAI / Gemini / Claude) — the agent's brain
  [ ] WhatsApp Business number (via Meta Embedded Signup)
  [ ] Phone number (Twilio credentials) — for outbound calls
       OR review VoIP/internet calling option

Step 2 — Recommended:
  [ ] Google Calendar (OAuth connect) — for meeting booking
  [ ] Email sending domain — for branded emails

Step 3 — Optional integrations:
  [ ] CRM: Monday.com, HubSpot, etc.
  [ ] Telegram bot token
  [ ] Meta Lead Ads webhook
```

The onboarding agent (powered by the PLATFORM LLM) asks questions, explains each step, and configures the tenant automatically based on the client's answers.

---

## PLATFORM MINIMUM (what you always pay for)

Post-migration; Retell is no longer in the running cost (removed from the repo 2026-08-05).

| Service | Estimated cost |
|---|---|
| Railway (hosting + DB + Redis) | ~$20–50/mo |
| LiveKit Cloud (voice orchestration) | Free tier up to 50 hrs/mo, then usage-based |
| Soniox (Hebrew STT, `stt-rt-v5`) | usage-based per streaming minute |
| Cartesia (Hebrew TTS, `sonic-3`) | ~$0.05/1K credits, ~$0.03/min |
| DeepDub (alternative TTS — only if switched on) | usage-based; not currently billed |
| OpenAI (LLM turn, `gpt-5.4`) | usage-based; prompt cache measured at 88% |
| Zadarma (SIP number + inbound minutes) | ~$0.01/min |
| Platform OpenAI key (onboarding + search) | ~$10–30/mo |
| Sentry | free tier so far |
| Netlify (marketing site) | free tier |
| Meta BSP registration | Free (one-time) |
| Recall.ai (Zoom bot, future) | $99+/mo |
| ~~Retell~~ | ~~$0.25/min~~ — decommissioned from the cost model |

**Target was ~$0.08/min all-in vs ~$0.25/min on Retell (~65% saving). ⚠️ This has never been verified against a real bill** — cost verification is still an open Phase 6 success criterion.

---

## PRIORITY BUILD ORDER

1. ✅ ~~Voice engine migration — Retell → self-built LiveKit~~ — **done, live 2026-07-29**
2. **WhatsApp → Meta Cloud API direct** (remove UChat — biggest dependency to kill; Twilio templates are also still awaiting approval)
3. **LLM → per-tenant client key** (so clients power their own agent)
4. **Platform onboarding agent** — the Copilot UI exists at `/chat`; it needs a chat backend endpoint before it can do anything
5. **Google Calendar → per-tenant OAuth** (so each client books on their own calendar)
6. **Email → per-tenant domain**
7. **Billing (Workstream D)** — SUMIT / Green Invoice; `billing_provider` key reserved, nothing built

*Note: "Twilio → per-tenant" removed from priorities — Twilio retained for the WhatsApp bridge and conference-call monitoring; per-tenant SIP numbers handled via Zadarma / LiveKit trunks.*

---

## OPEN QUESTIONS

- **Per-tenant voice selection:** partially answered in practice — three Cartesia voice slots exist (`CARTESIA_VOICE_ID_PRIMARY` / `_SECONDARY` / `_TERTIARY`), so the mechanism is there. Still undecided whether tenants pick their own voice or standardize on one, and this ties into the proposed `agent_persona` setting (each tenant names and genders their own agent).
- **DeepDub vs Cartesia:** DeepDub won a blind A/B 6:1 but is not switched on. Decide whether to flip the default.
- ~~**Retell decommission:** decide whether to delete the Retell code or keep it frozen.~~ **Resolved 2026-08-05 — deleted.** Removing it also fixed two live bugs: `POST /api/v1/calls/outbound` was still dialling via Retell, and the call-detail page was fetching the dead Retell API on every view.
- **Cost verification:** nobody has checked a real per-minute bill since cutover.
