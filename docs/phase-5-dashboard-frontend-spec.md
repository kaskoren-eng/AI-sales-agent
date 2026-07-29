# Phase 5 — Dashboard Frontend Spec (structure + reference mapping)

> **Owner:** DASHBOARD workstream · **Author:** architect session · **Version:** 1.1 · **Date:** 2026-07-29
> **Save to:** `docs/phase-5-dashboard-frontend-spec.md` (DASHBOARD territory)
> **v1.1 changes:** §0 governing rule (cream-and-glass → cool technical), §1 brief pointer
> v3 → v5 (v4 is the dead cream label — see brief v5 §12), §5 EN/HE order flipped (English
> i18n source), §6 DoD gains token rule + the
> four-screenshot dark gate, §4.8.3 theme preference added (dark mode now in scope),
> §4.3 wording. Structure and references unchanged.

---

## 0. The one rule that governs this whole document

**Structure and layout come from the reference screens. Colour, typography and spacing come
from `brand_assets/keren-brand-brief-v5.md`.**

Every reference below (Front, Midday, Cursor, folk, Calendly, Airtable, ElevenLabs) is a
cool-grey or white product. Copying their palettes produces a Frankenstein. Take the
*skeleton* — column split, information order, what sits next to what, what is a tab vs. a
page. Leave the *skin*. The skin is the **cool technical** system defined in brief v5:
a flat cool palette on `#EDF0F6`, one restrained indigo accent, monospace type doing
structural work over data, **zero gradients and zero glows**, and light + dark as two
first-class themes selected by `data-theme` on `<html>`.

If the brand brief and a reference disagree on a colour, a font, a radius, or a spacing step:
**the brief wins, every time, no exceptions.**

---

## 1. Source-of-truth order

1. What Koren says in the current conversation
2. `CLAUDE.md` — territory rules, conventions, `tenants.settings` claims
3. `brand_assets/keren-brand-brief-v5.md` — all design tokens, typography, light/dark
   theming, i18n/RTL rules, component definition-of-done
4. This document — structure and reference mapping
5. `dashboard-product-spec.md` (v1.1, July 2026) — product intent, screens, statuses
6. `PROJECT_STATUS.md`, `PRODUCT_ROADMAP.md`, `THIRD_PARTY_REPORT.md` — **known stale**,
   historical intent only

---

## 2. Navigation architecture

Seven sidebar items. Bilingual labels; sidebar flips side with direction.

| # | Route | HE | EN | Notes |
|---|---|---|---|---|
| 1 | `/` | סקירה | Overview | **Home. Unchanged from D2.** |
| 2 | `/chat` | שיחה עם קרן | Ask Keren | New page — ships after Overview |
| 3 | `/leads` | לידים | Leads | List + kanban view switcher |
| 4 | `/calls` | שיחות | Calls | List; detail is a drawer, not a route change |
| 5 | `/bookings` | פגישות | Meetings | Calendar |
| 6 | `/agent` | הסוכנת | The agent | Agent configuration |
| 7 | `/simulator` | בדיקת קרן | Test Keren | **Own top-level page. Not a tab inside settings.** |
| ⚙ | `/settings/*` | הגדרות | Settings | Shell containing integrations, billing, profile |

**Decision — home stays Overview.** The product spec (§4, §5) defines Overview as מסך הבית and
D2 is mid-build. The AI chat is an additional page at `/chat`, not a replacement. D2 scope is
unchanged.

**Decision — the simulator is its own page.** Reversed from an earlier proposal to nest it in
agent settings. Rationale: the ElevenLabs reference is a full-bleed three-column experience with
its own top bar; it cannot live inside a settings tab without being crushed.

**Decision — `/simulator` defaults to dark**, regardless of the user's theme preference
(brief v5 §2.4). The orb needs a dark field to read as a light source. The user can override.

---

## 3. Global shell

Applies to every route except `/simulator`, which takes over the full viewport.

**Top bar** (per product spec §5): KEREN logo · presence indicator · language toggle ·
notifications · account menu. Sides mirror with direction.

**Presence indicator** — "קרן בשיחה עם דני כהן" with a pulsing dot. This is the product's
signature element. It gets the one animation allowed per screen (spec §3, principle 5).
Idle state must be designed, not left blank: "קרן זמינה" with a static dot.

**Reduced motion:** the pulse becomes a static dot under `prefers-reduced-motion: reduce`.
Non-negotiable, applies to the simulator orb too.

---

## 4. Page specs

### 4.1 Overview — reference: **Front**

Reference screens:
- https://mobbin.com/screens/e8f668fb-83c8-4214-a7cd-0b1881c30c93 (Overview)
- https://mobbin.com/screens/e510fed5-80c7-4223-871e-9433113026ac (Team performance)

Take from Front, in this order down the page:

1. **Freshness stamp next to the page title** — Front prints "Data from up to 1 hour ago".
   For an autonomous-agent product this is a trust primitive, not a nicety. Ours reads
   "עודכן לפני X דקות".
2. **Filter row** — date range, then any secondary filters. Left/start-aligned.
3. **Main metrics — 4–5 cards, each with value AND delta vs. the previous equal-length period.**
   Front labels this explicitly ("All comparisons are made with the previous period of the same
   length"). Copy that behaviour and that disclosure.
4. **A heatmap of busiest times** — Front uses day × hour. Genuinely useful here: it tells the
   owner when his leads actually answer, which is when Keren should be calling.
5. **Breakdown lists** with counts and deltas.

**Metrics to render.** Five volume metrics from product spec §5 — calls today, meetings booked,
follow-ups sent, answer rate, time-to-first-contact — **plus one quality metric**. Quality metric
source and definition is an open decision (see §7); until it is settled, render the five and
leave the sixth slot structurally present but empty with a clear empty state. Do not invent a
number to fill it.

**Pipeline strip** (spec §5): five stages in a row with counts, each clickable, filtering
`/leads`. Must be visibly interactive — hover and focus states, cursor, not a flat graphic.

### 4.2 Ask Keren (`/chat`) — reference: **Grok**, corrected

Reference: https://mobbin.com/screens/5b28e79b-ddd9-4878-b42e-411826249478

Purpose: create or adjust the agent, and ask questions about activity and results, in
conversation. Powered by the platform LLM (`THIRD_PARTY_REPORT.md` §3 — platform cost, not the
tenant's key).

**The composer is never presented empty.** Above it:
- one line of today's state — "קרן ענתה ל‑12 שיחות וקבעה 3 פגישות היום"
- four suggested prompts generated from real account state, not hardcoded copy

Rationale: Retell's Conductor is a blank box under a greeting. That works for a developer. For
an Israeli SMB owner it is a dead end — he does not know what he is allowed to ask. An empty
composer also inverts product principle #1 (*הסוכנת ממלאת, המשתמש מפקח*).

**Actions the chat can take must be confirmed before they apply.** If the user says "תגידי לקרן
שסגור ביום שישי", the assistant shows what it is about to change and waits for confirmation.
Never silently mutate agent configuration from a chat turn.

### 4.3 Leads — reference: **Airtable**

Reference: https://mobbin.com/screens/8490b97a-dfc7-4f3b-a9a8-cce747fb743f

- Status chips in soft tints on light surfaces — exactly the restraint level this palette
  calls for. Map to the eight statuses in product spec §6 (status-colour mapping is an open
  decision — §7; do not improvise it in component code).
- View switcher: table ↔ kanban (kanban is Sprint 3; build the switcher now, stub the board).
- Filter row above the table with an active-filter count, because users arrive here from a
  pipeline-stage click and must see why the list is filtered.
- Fields Keren extracted are marked as agent-sourced and visually distinct from manually edited
  ones. Pattern reference: Lightfield —
  https://mobbin.com/screens/853bc532-08e1-4e74-88a5-6f40a1651513
- Horizontal scroll is a failure state. If columns don't fit, cut columns.

### 4.4 Calls — reference: **Retell** (Koren's screenshots, not Mobbin)

List columns, translated out of engineering language:

| Retell | KEREN (HE) | KEREN (EN) |
|---|---|---|
| Time | מתי | When |
| Duration | אורך | Length |
| Channel Type | ערוץ | Channel |
| Cost | עלות | Cost |
| Session ID | — | *hidden; advanced view only* |
| End Reason | איך הסתיימה | How it ended |
| `agent hangup` | קרן סיימה | Keren ended |
| `user hangup` | הליד ניתק | Lead hung up |

**Detail is a drawer over the list, not a route change.** Retell does this and it is right —
the user is triaging, and losing list position on every call is friction. Keep Retell's
`↑ ↓ to navigate` affordance between calls.

Drawer contents, top to bottom: header (date, agent, duration, cost) → audio player with
download → tabs **תמלול / נתונים / יומן** (Transcription / Data / Detail Logs).

**Conversation Analysis** section, from Retell's preset + custom split:
- Preset: outcome, status, sentiment, how it ended, latency
- Custom: the extracted fields (`lead_qualified`, `demo_scheduled`, `pricing_expectation`, …)

**Do not mark a call successful when its own summary reports a failure.** Koren's screenshot
shows a call flagged "Successful" whose summary reads that the agent could not book the demo due
to a technical issue. Contradictions like this must surface as an exception, not a green tick.

**Transcript must be RTL-correct**: `dir="auto"` per message bubble, speaker label and timestamp
on opposite ends, bubbles aligned by speaker.

### 4.5 Meetings — reference: **Calendly**

References:
- https://mobbin.com/screens/1db5c805-9bb4-4307-b5c8-7dfdb33b6bf3 (summary rows)
- https://mobbin.com/screens/4fbf810d-97cc-42ce-ae5a-7e84a2145635 (booking page options)
- https://mobbin.com/screens/4f890283-7ba5-452e-a788-030c11bdbda3 (scheduling settings)

Take two things:

1. **Config left, live preview right.** The owner sees what the lead will see while he edits.
2. **The summary-line pattern.** Calendly's Event Type screen is a stack of expandable rows,
   each with a heading and a plain-language summary of its current value underneath
   ("Weekdays, 9 am – 5 pm"). This is the single best pattern for non-technical users in any
   reference in this document — the current state is readable without opening anything.

Apply the same pattern to Keren's availability: when may she book, how long, buffer, minimum
notice, which calendar.

### 4.6 The agent (`/agent`) — reference: **Retell** (Koren's screenshots)

**Take — the Agent Handbook.** Tabs *אישיות וטון / דיוק ופורמט / אמון ובטיחות*, and every
toggle carries **a sample sentence of what Keren will actually say**. Retell's "Natural Filler
Words" toggle shows: *"So yeah, let me just pull that up for you real quick."*

This is the most important single pattern in the whole spec. A business owner cannot evaluate a
prompt. He can absolutely evaluate a sample sentence. **Every behavioural toggle ships with a
Hebrew example or it does not ship.**

**Take — the cost / latency strip** at the top of the editor.

**Reject — the raw markdown prompt box as the primary surface.** `## Role`, `**קרן**`, `---`
is not an interface for this audience. The prompt is *generated* from structured fields plus
`/chat`, and exposed read-only behind "תצוגה מתקדמת".

**Reject — the vocabulary.** No "Single-Prompt Agent", "Post-Call Data Extraction", "MCPs",
"Webhook Settings", "Disconnection Reason" anywhere in the tenant-facing UI.

### 4.7 Test Keren (`/simulator`) — reference: **ElevenLabs**

Reference: Koren's uploaded ElevenLabs screenshot, plus
https://mobbin.com/screens/a77ba735-cb4b-4eb7-9d77-69106c62c02f (voice picker)

Full-bleed, three columns, own top bar. In RTL the whole layout mirrors. **Opens dark by
default** regardless of the user's theme preference (brief v5 §2.4); the user can override.

- **Top bar:** back · history toggle · agent name · version · a live status pill · voice settings
- **Start column (right in HE):** collapsible history of previous test sessions, each with a
  timestamp and a short label
- **Centre:** the animated orb with the call button below it, plus mute and settings.
  **This is the signature element of the entire product.** It is the one place to spend the
  design budget. It must react to actual audio activity — idle, listening, speaking — not loop
  a generic animation.
- **End column (left in HE):** live transcript, agent bubbles aligned to start with avatar, user
  bubbles aligned to end. System lines centred: "השיחה התחילה", "קרן סיימה את השיחה".
- **Below the transcript:** a text input, so the agent can be tested by typing as well as by
  voice.
- **After the call ends:** two buttons — "שיחה חדשה" and "לפרטי השיחה" (deep-links into the
  Calls drawer for that session).

**Emotion tags — conditional.** ElevenLabs prints `[warmly]` / `[thoughtfully]` inline before
each agent line. Render these **only if our own pipeline actually emits them.** As of this
document that is unverified for the LiveKit + Cartesia/DeepDub stack. If the pipeline does not
produce emotion metadata, the tags are omitted entirely — do not fake them, and do not have the
LLM invent them post-hoc. Flag this back to the architect session rather than guessing.

**Reduced motion:** orb becomes a static state with a simple state ring.

### 4.8 Settings shell — reference: **folk**

References:
- https://mobbin.com/screens/903fdc8e-5ccd-4ac1-a6cd-ff2531304fe0 (settings/integrations)
- https://mobbin.com/screens/304ad32c-158d-43d4-9f55-43c31d8b9fc3 (personal details)

Left rail grouped *החשבון שלי* / *העסק*, content pane on the right. folk chosen over Linear so
the account-profile page and its shell come from one system with no visual seam.

Every settings row carries a one-sentence explanation underneath. Cursor does this well; folk's
tone is the model.

#### 4.8.1 Integrations — reference: **Midday**
https://mobbin.com/screens/03313f42-04ef-4481-80db-96429e4a63c7

Card grid, three across. Each card: logo, name, one line of what it does for *the business*
(not for the system), and one action. All / Connected filter plus search. Connected cards show
a status pill and swap the action to Details + Disconnect.

Per `THIRD_PARTY_REPORT.md`, the client brings their own LLM key, calendar, phone and sending
domain — so this page is high-traffic during onboarding and must be legible to a non-technical
user. Product spec §8 defers the connection *plumbing*; build the page shell and card system now,
wire providers as the backend lands.

#### 4.8.2 Billing — reference: **Cursor**
https://mobbin.com/screens/77cb9e3b-d6d4-4780-ae58-d1cb1ffcab4f

Chosen because Cursor is metered, like KEREN (minutes), not seat-based. Take:
- current plan card + upgrade card side by side
- **usage meters with a percentage consumed** — this is the core of the page
- on-demand usage shown separately from included usage
- **a user-settable monthly spend limit.** For an SMB owner buying a product that makes phone
  calls on his behalf, a spend cap is a trust feature, not an accounting feature.

#### 4.8.3 Account profile — reference: **folk**
https://mobbin.com/screens/304ad32c-158d-43d4-9f55-43c31d8b9fc3

Avatar + upload, first/last name, email with a change flow, then app preferences.
**Interface language belongs here** (EN/HE), mirroring the top-bar toggle and persisting per
user. **Theme preference belongs here too** — light / dark / system, per brief v5 §2.1
(three-state preference, resolved to `data-theme` on `<html>`, `system` follows
`prefers-color-scheme` live). Dark mode is in scope as a full toggle; product spec §8 was
amended accordingly.

---

## 5. i18n and RTL — non-negotiable

Per `CLAUDE.md` and brief v5 §4 (default flipped to English, RTL mechanics unchanged):

- **English is the primary interface language and the i18n source.** Default
  `<html lang="en" dir="ltr">`; new strings are authored in English; `he.json` is a real
  translation by someone fluent, not a machine pass. Confirm `he.json` has **full coverage**
  before flipping the default — a missing key now falls back to English silently, which is
  much harder to spot than the reverse was.
- Every string through `t('...')`. English being the default is not licence for literals in
  JSX — including `aria-label` and `alt`.
- **CSS logical properties only.** `margin-inline-start`, not `margin-left`. `inset-inline-end`,
  not `right`. A single physical property is a review failure.
- `dir="auto"` on every element rendering user or lead content — names, transcripts, notes,
  business details. This matters **more** now, not less: Hebrew lead content inside an English
  interface is the default case, not an edge case.
- Icons that encode direction (arrows, chevrons, back) mirror. Icons that don't (play, clock,
  phone, mic) never mirror.
- Numbers, times, currency and phone numbers stay LTR inside RTL text — wrap them.
- Charts: axis and legend order follows direction; the data does not reverse.
- **The failure mode to guard against: "English primary" quietly becomes "Hebrew broken."**
  RTL bugs are visual — a mirrored chevron, a legend on the wrong side, a number escaping its
  bubble — and invisible to anyone reviewing in English. **No page is done until it has been
  reviewed in Hebrew.** Hebrew is the second language, never the deferred one.
- ⚠️ **Interface language governs the dashboard only.** Keren speaks Hebrew first on calls —
  a VOICE-owned setting. Never derive one from the other (brief v5 §0.1).

---

## 6. Definition of done, per page

1. Renders correctly in EN (LTR) and HE (RTL)
2. Zero hardcoded strings, zero physical CSS direction properties
3. All colour, type, radius and spacing values resolve to brand-brief tokens — no raw hex, no
   arbitrary px outside the spacing scale
4. **No component reads a colour any way other than `var(--token)`.** This single rule decides
   whether the final dark pass costs a day or a fortnight (brief v5 §2.3). Includes charts —
   chart libraries take colours as props and must read the computed CSS variable, re-read on
   theme change.
5. Loading, empty and error states designed — an empty screen is an invitation to act, not a
   blank panel
6. Keyboard reachable, visible focus, `prefers-reduced-motion` respected
7. Responsive to the brief's minimum width
8. **Screenshots — two-phase gate per brief v5 §2.3.** During page build (light-only phase):
   two screenshots per page, **EN-light and HE-light**, attached to the handoff note. At the
   final dark pass, the gate becomes **four screenshots — EN-light, EN-dark, HE-light,
   HE-dark** — per page. The four-screenshot gate is not negotiable down to two; it is what
   enforces both the dark theme and the Hebrew review (§5).

---

## 7. Open decisions — do not guess, escalate

1. **The Overview quality metric.** Which one, and computed from what. Candidates: percentage
   of calls where Keren completed the goal; an average score from `CallAnalysisService`.
   Needs a data source before it can be built.
2. **Emotion tags in the simulator** — does the LiveKit + Cartesia/DeepDub pipeline emit them?
   Owned by the VOICE workstream. Until answered, build without.
3. **The "needs attention" queue.** Not in product spec v1.x. Strongly recommended by the
   reference review (Intercom, Hume) and justified by the contradictory call in Koren's own
   screenshots. Placement and rules undecided.
4. **Retell cost baseline.** Koren's screenshot reads `$0.112/min` and `1950–2450ms`;
   `THIRD_PARTY_REPORT.md` and `CLAUDE.md` both say `~$0.25/min`. These disagree by more than
   2×. Not a dashboard blocker, but the cost-saving claim rests on it — resolve before it
   reaches marketing copy or the billing page.
5. **Status colours.** Brief v5 §1.4.1 proposes four (marked proposals, not derivations); product
   spec §6 needs eight lead statuses. Mapping eight onto four plus tints needs sign-off — not a
   component-level improvisation.
6. **Where the theme foundation task sits** — inside D2 (recommended) or between D2 and
   Sprint 3. It must land before further pages are built, or those pages hardcode colours and
   the cheap dark path closes.

---

## 8. Territory reminders

- This is DASHBOARD work: `dashboard/**`, `docs/phase-5-dashboard-*`, `brand_assets/**`.
- API routes under `src/modules/calls/**` and `src/modules/leads/**` may be **extended
  additively, read-only**. Do not touch services, workers or guards there — VOICE owns them.
- Shared files (`env.ts`, `package.json`, `server.ts`, `src/plugins/**`) are additive-only.
  `git fetch` and diff the other branch before editing.
- New `tenants.settings` keys must be claimed in `CLAUDE.md` in the same commit. If an
  interface-language key is ever needed it is `ui_locale`, never `language` (brief v5 §0.1).
- Dashboard dev server for this session runs on **:3002**. Never restart :3000 or :3001.
