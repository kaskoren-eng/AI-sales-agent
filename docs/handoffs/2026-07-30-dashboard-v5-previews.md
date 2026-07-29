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
