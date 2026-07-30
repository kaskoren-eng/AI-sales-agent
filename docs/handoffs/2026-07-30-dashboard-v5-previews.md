# Handoff — Dashboard v5 design previews (2026-07-30)

Workstream: **DASHBOARD** · Branch: `feature/dashboard-v5-previews`

## What shipped

All **8 dashboard pages** exist as approved, self-contained v5 static previews in
`dashboard/design-previews/` (one HTML file each, no build step, open in a browser). Each was
built page-by-page with Koren and **approved**; each is now the **visual contract** for its
production page. State tracked in `dashboard/design-previews/STATUS.md`.

| Page | Preview file | Route (target) | Reference |
|---|---|---|---|
| Overview | `overview.html` | `/` | Mobbin dashboards |
| Calls (+ detail drawer) | `calls.html` | `/calls`, `/calls/:id` | Retell |
| Leads (+ pop-out timeline drawer) | `leads.html` | `/leads`, `/leads/:id` | Airtable |
| Your agent | `agent.html` | `/agent` (new) | Retell agent editor |
| Test agent (simulator) | `simulator.html` | `/simulator` (new), dark default | ElevenLabs |
| Meetings | `meetings.html` | `/bookings` | Calendly |
| Ask the agent | `chat.html` | `/chat` (new) | Grok |
| Settings shell | `settings.html` | `/settings` | folk |

Every preview: v5 tokens verbatim (light **and** dark via `data-theme` on `<html>`), five-family
Google Fonts, zero gradients/glows/glass, working theme + language toggles, English default with
full native Hebrew RTL, logical properties only, mono on LTR data only, one animated element
(presence dot) with reduced-motion fallback. All four states (EN/HE × light/dark) reviewed per page.

**Late passes done 2026-07-30:**
- Shell wordmark swapped **KEREN → ClickScales** across all 8 previews (platform brand, spec v1.2);
  redundant "by ClickScales" tag dropped; **CS** avatar kept.
- **Ask the agent** page genericized off the sample persona to **"the agent" / "הסוכנת"**
  (per-tenant `{agentName}`). Other pages keep the sample agent name **Keren / קרן** — that is the
  agent persona (per brand brief), not the platform wordmark.

Commits (this branch): overview → calls → leads → agent → simulator → meetings (`a6ebce4`) →
Ask the agent (`147caac`) → Settings (`8b3b02c`) → wordmark swap + genericize (`8e97d3c`).

## Questions for architect (not guessed — deliberately deferred)

1. **Status-colour mapping.** Product spec §6 defines 8 lead statuses; §7 leaves the 8→N colour
   mapping open. Previews use the §1.4.1 **PROPOSED** status set with a note; needs sign-off before
   production status chips are final. (Affects Leads, Calls, Meetings chips.)
2. **Overview quality metric.** Frontend spec §7.1 — the 6th KPI has no data source. Preview ships it
   as a designed empty state. Confirm the source or drop the tile.
3. **Routes gap.** Current router (`dashboard/src/App.tsx`) has `/`, `/leads`, `/leads/:id`, `/calls`,
   `/calls/:id`, `/voice`, `/bookings`, `/integrations`, `/settings`. The previews add **`/agent`**,
   **`/chat`**, **`/simulator`**. Confirm final route names and what `/voice` (VoiceChat) becomes
   (folded into `/simulator` and/or `/chat`?).

## Production build — gap analysis + plan

A React app already exists under `dashboard/src/` (Vite + React Router + react-i18next + Tailwind,
UI primitives, page stubs, hooks wired to the API). **It is on the retired v4 cream + glass palette**
(`index.css`: `--bg-page` cream, `--glass-bg` + `backdrop-filter`, `--accent-teal`, Heebo/Montserrat).
So this phase is a **migration to the v5 contract**, not a greenfield build.

Proposed sequence (each page not "done" until reviewed in Hebrew — brief v5 §4 / spec §5):

1. **Foundation.** Replace `index.css` token layer with the v5 block (light §1.1 + dark §1.2 under
   `:root[data-theme="dark"]`); swap font imports to the five-family v5 stack; delete `.glass` /
   `backdrop-filter` / glow. Add a theme store (light/dark/**system**, three-state per brief §2.1)
   resolving to `data-theme` on `<html>`, persisted per user. Audit Tailwind usage — v5 is
   token-driven; keep Tailwind only if it reads the CSS vars.
2. **Shell.** `TopBar` (ClickScales wordmark, presence dot = the one animation, CS avatar),
   `Sidebar`/rail, `AppLayout` to match the preview shell. Wire the theme + language toggles to the
   real stores (Settings › Profile is the canonical control; top bar mirrors it).
3. **Pages, in approved order**, each matched pixel-intent to its preview: Overview → Calls (+ drawer,
   `↑↓` nav, no false "successful") → Leads (+ pop-out timeline drawer, agent-sourced field marks) →
   Your agent (handbook toggles w/ Hebrew samples, advanced read-only prompt) → Test agent
   (`/simulator`, dark default, orb) → Meetings (config-left/preview-right, summary rows) → Ask the
   agent (`/chat`, Grok hero, never-empty, confirm-before-apply) → Settings (folk rail + panes).
4. **Cross-cutting:** status chips wait on decision #1; `dir="auto"` on all lead/user content;
   numbers/times/phones wrapped LTR; one animated element per screen.

**Contract rule:** an approved preview is authoritative — the production page must match it. Diverge
only with a new decision recorded here and in `STATUS.md`.

## Progress

- **Phase 1 (Foundation + Shell) — DONE 2026-07-30.** `index.css` now carries the v5 token layer
  (light §1.1 + dark §1.2 under `:root[data-theme="dark"]`) with a **migration bridge** aliasing the
  old v4 names to v5 equivalents (delete once no page references them — search hint in the CSS
  comment). Five-family fonts; glass/blur/glow removed (`.glass` kept as a flat-card alias). Theme
  store `src/lib/theme.ts` (three-state light/dark/system, persisted, pre-paint script in
  `index.html` to avoid FOUC) + `useTheme` hook + `ThemeToggle`. Shell reworked to v5: `Sidebar`
  (flat, ClickScales wordmark, v5 rail states), `TopBar` (presence dot = the one animation, CS
  avatar), `AppLayout`, `LanguageSwitcher`. `tsc -b` + `vite build` clean; verified in EN/HE ×
  light/dark. Interim IA note: production keeps the **left sidebar as global nav** (previews were
  topbar-only and didn't depict global nav) — revisit when routes decision (#3) lands.
- **Navigation IA restructured (2026-07-30, per Koren)** into Retell-style grouped rail:
  **Monitor** (Analytics `/`, Copilot `/chat`) · **Activity** (Leads, Calls, Calendar `/bookings`) ·
  **Setup** (Personality `/agent`, Simulator `/simulator`) · **General** (Settings, Integrations,
  Billing & Subscription — disabled "Soon"). Overview label/title is now **Analytics / דאשבורד**;
  Meetings renamed **Calendar / יומן**; Ask-the-agent is **Copilot / עוזר אישי**; The-agent is
  **Personality / אישיות**. New routes `/chat`, `/agent`, `/simulator` render an interim
  `Placeholder` page (names its target preview) until Phase 3 builds them. Billing HE rendered as
  **חיוב ומנוי** (Koren's note read "הגדרות ומנוי", adjusted to avoid duplicating הגדרות/Settings —
  confirm). `/billing` intentionally has no route yet (item disabled).
- **Phase 3 — Analytics/Overview page migrated (2026-07-30).** Rebuilt `pages/Overview.tsx` to the
  approved `overview.html` on v5 tokens: header (Live + Today/7d/30d range), 6-up KPI grid (5 real +
  1 designed-empty Quality card), pipeline strip (stage → `/leads?status=`), bottom chart + recent
  activity. **Data wired honestly, no invented metrics:** windowed calls count (range → `from/to`),
  total calls, total/qualified/booked leads and pipeline stage counts (from a single leads fetch,
  exact ≤1000 leads), recent activity from recent calls. **Backend gap flagged:** the weekly chart
  (per-day series) and richer KPIs (answer rate, follow-ups, time-to-first-contact, quality) need a
  metrics/summary endpoint that does not exist — those render designed-empty until
  dashboard-backend adds it. i18n `overview.*` added (en + he). tsc + build clean; verified
  EN/HE × light/dark.
- **Phase 3 — ALL remaining pages migrated to v5 (2026-07-30).** Each built to its approved preview on
  v5 tokens, i18n (en+he), RTL-correct, honest data/empty states; `tsc -b` + `vite build` clean;
  visual sweep in EN light passed for every page.
  - **Calls** — v5 table + in-page detail **drawer** (scrim/panel, not a route change): meta, recording
    state, outcome summary, sales analysis, Transcript/Data tabs (`useCallDetail`). PROPOSED chips.
  - **Leads** — v5 table + pop-out **timeline drawer** folding lead facts + messages(in/out) + meetings,
    time-sorted (`useLeadDetail`). PROPOSED chips, v5 score bar.
  - **Personality** (`/agent`) — full port: metrics strip, identity, handbook tabs with toggles + Hebrew
    "the agent says" samples, advanced generated-prompt, save bar. Local state.
  - **Simulator** (`/simulator`) — orb stage (animates only while active) + live transcript + type-to-test.
    **Deferred:** real mic/LiveKit wiring (`createWebCall`) — visual shell only this pass.
  - **Calendar** (`/bookings`) — upcoming meetings (real, from bookings endpoint) + availability summary
    rows + booking-preview panel. **Dropped this pass:** the old cancel-booking modal (revisit as a row
    action).
  - **Copilot** (`/chat`) — Grok hero (avatar, composer, suggestion pills, platform-LLM note). **Deferred:**
    the conversation thread + confirm-before-apply card; today-state numbers omitted (no metrics source).
  - **Settings** — converted the Radix top-tabs to a **folk grouped left rail** (My account / The business)
    with **no feature loss** (business profile, Twilio, tenant name, flows JSON, API-key regen all preserved);
    new Account pane wires the real interface-language + three-state theme controls + firewall note. The
    inner tab components still use bridge tokens — a later polish pass restyles their internals to v5.
- **Routing:** `/agent`, `/chat`, `/simulator` now render real pages (interim `Placeholder` removed).
- **Bridge status:** still in `index.css` — most migrated pages now use v5 tokens directly, but Settings'
  inner tabs and a few UI primitives still reference old names. Delete the bridge once none remain (search
  hint in the CSS comment).
- **Follow-ups queued:** Simulator live-wiring · Copilot conversation + confirm-card · Calendar cancel
  action · Settings inner-tab v5 polish · backend metrics endpoint (Overview chart + richer KPIs) · retire
  the token bridge.

## Cleanup pass — 2026-07-30 (bridge retired, v5 polish, HE+dark QA)

- **Token bridge RETIRED (`f174dc2`).** Migrated all 19 remaining files (12 UI primitives + 7
  pages/components) off the aliased v4 names to their v5 equivalents (200 mechanical `var()` renames,
  zero visual change — each alias mapped to the value the bridge resolved to), then deleted the bridge
  block from `index.css`. `rg` confirms no old token name remains in `src/`. tsc + build clean.
- **Legacy fonts swept + Settings polish (`bf081be`).** Killed the last hardcoded font literals
  (`'Montserrat'`/`'Assistant'`/`'Heebo'`/`'Courier New'`) across the UI primitives + CallDetail/
  LeadDetail/Integrations/KerenStatusChip → v5 font vars (`--font-display`/`-body`/`-mono`). Because
  migrated v5 pages consume these primitives, this fixed wrong-font bleed on already-"done" pages.
  Settings inner tabs restyled to v5: shared `SectionCap` (mono caption, auto-neutralized in Hebrew),
  theme-safe success tints via `color-mix`, overlay dialogs on `--shadow-overlay`/`--surface-overlay`,
  logical `insetInlineEnd`. **No functional change** — all business-profile / Twilio / API-key / flows
  behavior preserved.
- **Copilot avatar genericized (`8950bd6`).** The Grok hero rendered a hardcoded `ק` (Keren's initial —
  the very persona the page was genericized away from; a Latin-first stack rendered it as a stray "P").
  Replaced with a neutral Sparkles icon (persona-agnostic, locale-safe).
- **Hebrew + dark QA sweep PASSED** for every migrated page (Overview, Leads, Calls, Personality,
  Copilot, Simulator, Settings): sidebar/folk-rail correctly flip to inline-start, group caps neutralized
  (not mono-uppercase) in Hebrew, metric values stay LTR (mono data), media-play icons correctly NOT
  flipped, honest empty/loading states throughout. Only defect found was the Copilot avatar (fixed above).

### ⚠️ Blocker surfaced — Calendar cancel action needs VOICE-owned backend

Re-adding the cancel-booking row action is **blocked**, not skipped:
1. **There is no `GET /scheduling/bookings` list endpoint.** `dashboard/src/lib/api.ts:fetchBookings()`
   calls `/scheduling/bookings`, but `src/modules/scheduling/scheduling.routes.ts` registers only
   `/slots`, `/book`, and `/cancel/:bookingUid` — nothing serves the list. So the Calendar page's
   "upcoming meetings" section is currently wired to a **404 endpoint** (renders its error/empty state
   in prod). This predates this pass.
2. **The cancel endpoint keys on `scheduledCalls.providerRef` (as `bookingUid`), which the frontend
   `Booking` type never exposes** (`types.ts` has `id`, `leadId`, `calendarEventId`, … but no
   `providerRef`). Even with a list endpoint, the UI has no value to pass to `/cancel/:bookingUid`.

Both fixes live in `src/modules/scheduling/**` — **VOICE territory** (per CLAUDE.md TERRITORY RULES),
so this session did not touch them and did **not** ship a button that calls a dead/underspecified route.
**Ask for VOICE session:** add `GET /scheduling/bookings` returning the scheduled-call rows **including
`providerRef`**; then the dashboard wires cancel additively (client fn + row action) with zero backend
edits from this side.

### Still deferred (unchanged)
- **Settings inner-tab i18n.** Bodies are still hardcoded English. Full i18n needs **native Hebrew
  marketing copy** (placeholders, helper text, objection examples) → genuinely needs Koren's review per
  the "no page done until reviewed in Hebrew" DoD, so not auto-translated this pass.
- Simulator live LiveKit/mic wiring · Copilot conversation + confirm-before-apply card · Overview
  chart + richer KPIs (backend metrics endpoint).
