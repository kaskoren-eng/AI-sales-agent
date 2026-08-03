# Design previews — status

Self-contained static HTML, one file per dashboard page. Not imported by the app; open directly
in a browser. An **approved** preview is the visual contract: the production page must match it.
Built page by page with Koren — each approved before the next starts. Governed by
`brand_assets/keren-brand-brief-v5.md` (v5 cool-technical, light+dark).

| Page | File | State | Open questions |
|---|---|---|---|
| Overview | `overview.html` | **approved** (2026-07-29, "looks good enough for now") | chart-vs-heatmap (built the D2 bar chart); Overview quality metric has no data source (frontend spec §7.1) → 6th KPI is a designed empty state |
| Calls (+ detail drawer) | `calls.html` | **approved** (2026-07-29) | modal drawer dims list in a real browser (Playwright doesn't composite the fixed dim) |
| Leads | `leads.html` | **approved** (2026-07-29) | lead detail is a **pop-out drawer** folding conversations+messages+meetings into one timeline; 8-status→4 colour mapping still open (used PROPOSED chips) |
| The agent | `agent.html` | **approved** (2026-07-29) | hero pattern = every toggle carries a Hebrew sample sentence; raw prompt read-only behind Advanced view |
| Test Keren (`/simulator`, dark default) | `simulator.html` | **approved** (2026-07-29) | emotion tags OMITTED (pipeline gate unverified §4.7); orb is the signature animation (flat, no gradient/glow); opens dark by default |
| Meetings | `meetings.html` | **approved** (2026-07-29) | config-left / booking-preview-right; Calendly summary-row pattern for availability; upcoming-meetings strip on top; status chips PROPOSED (confirmed/pending) |
| Ask Keren (`/chat`) | `chat.html` | **approved** (2026-07-30) | Grok-style centered hero (big composer + Skills/mic/send, suggestion pills); never-empty (today-state pill + real-state prompts); confirm-before-apply diff card; preview-only View toggle Empty↔In conversation; persona genericized to "the agent" / "הסוכנת" on this page (per-tenant name) |
| Settings shell | `settings.html` | **approved** (2026-07-30) | folk rail (My account / The business); panes Profile / Notifications / Business details / Integrations (Midday grid) / Billing (Cursor meters + spend cap); every row has one-sentence explanation; Profile carries interface-language (firewall callout) + three-state theme, both drive the page |

**Standing decisions / done:**
- **Platform brand = ClickScales** (decided 2026-07-29, spec v1.2). Agent name is per-tenant
  `{agentName}` (sample "Keren/קרן"). **DONE 2026-07-30:** shell wordmark swapped KEREN→**ClickScales**
  across all 8 previews (redundant "by ClickScales" tag dropped; avatar stays **CS**). The **Ask Keren**
  page persona is genericized to "the agent" / "הסוכנת". Other pages keep the sample agent name
  Keren/קרן (that is the agent persona, per brand, not the platform wordmark).

**Standing gates (v5):**
- Status colours use the §1.4.1 **PROPOSED** set — awaiting sign-off. The 8-lead-status → 4-status
  + tints mapping (product spec §6) is undecided; not improvised in any preview.
- Amber `--data-2` is never a text colour on a light surface — dots, borders, chart fills only.
- Every preview: v5 tokens verbatim, five-family font link, working theme + language toggles,
  English default with full native Hebrew, one animated element (the presence dot), reduced-motion
  fallback.
