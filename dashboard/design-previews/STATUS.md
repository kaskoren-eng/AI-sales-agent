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
| The agent | `agent.html` | built — awaiting review | hero pattern = every toggle carries a Hebrew sample sentence; raw prompt read-only behind Advanced view; human vocabulary only |
| Test Keren (`/simulator`, dark default) | `simulator.html` | pending | emotion tags — LiveKit/Cartesia pipeline unverified (§4.7); render without |
| Meetings | `meetings.html` | pending | — |
| Ask Keren (`/chat`) | `chat.html` | pending | — |
| Settings shell | `settings.html` | pending | — |

**Standing decisions / later pass:**
- **Platform brand = ClickScales** (decided 2026-07-29, spec v1.2). Agent name is per-tenant
  `{agentName}` (sample "Keren/קרן"). All preview shells currently show the **KEREN** wordmark;
  swap wordmark KEREN→**ClickScales** across every page in one later pass. Do NOT rework the
  approved pages piecemeal — keep the set consistent until the batch swap.

**Standing gates (v5):**
- Status colours use the §1.4.1 **PROPOSED** set — awaiting sign-off. The 8-lead-status → 4-status
  + tints mapping (product spec §6) is undecided; not improvised in any preview.
- Amber `--data-2` is never a text colour on a light surface — dots, borders, chart fills only.
- Every preview: v5 tokens verbatim, five-family font link, working theme + language toggles,
  English default with full native Hebrew, one animated element (the presence dot), reduced-motion
  fallback.
