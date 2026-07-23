# KEREN by ClickScales — Brand & Build Brief

**Version:** 3.0 (supersedes `brand_identity` v2.0 — the "Danie" brief is DEPRECATED)
**Status:** Active — single source of truth for all dashboard design work
**Owner:** Koren (koren@clickscales.com)
**Stack (dashboard):** Vite · React 19 · TypeScript · Tailwind CSS 4 · Radix primitives · Lucide-React · Framer Motion · react-i18next

---

## 0. Product Definition

- **Company:** ClickScales
- **Product:** **KEREN** — an autonomous AI sales agent (SDR-class) that calls leads,
  qualifies them, and books meetings. Hebrew-first voice, multi-channel (voice / WhatsApp / email).
- **Persona:** Keren is a woman. Hebrew feminine grammar for herself, warm and professional.
  She is a "digital worker" the customer manages — a synthetic colleague, not a tool.
- **"Danie" is dead.** Any reference to Danie in code, UI, or docs is legacy and must be
  migrated (see §9 Migration Checklist).

**Voice & tone (dashboard microcopy):**
- Warm, precise, confident, never cute. Concise sentences. Active voice.
- Sample lines (EN):
  - "Keren qualified 4 leads this morning. 2 look promising."
  - "Meeting booked with Sarah Chen — Thursday 14:00. Calendar updated."
- Sample lines (HE):
  - "קרן דיברה עם 6 לידים היום. 2 קבעו פגישה."
  - "נקבעה פגישה עם שרה כהן — חמישי 14:00. היומן עודכן."

---

## 1. Design Tokens — UNCHANGED from v2

The midnight/cyan/violet palette is retained in full. It was never Danie-specific and is
already implemented in `dashboard/src/index.css`. **Do not introduce new colors.**

All tokens in `dashboard/src/index.css` are canonical:
backgrounds (`--bg-primary #0B132B`, `--bg-surface`, `--bg-elevated`, `--bg-inset`),
accents (`--accent-cyan #00F5FF`, `--accent-violet #6366F1` + dims),
text hierarchy, semantic colors, borders, focus ring, durations, easing.

**Cyan usage rule (unchanged, non-negotiable):** Electric Cyan is reserved for CTAs, focus
rings, status indicators, and icon highlights. **Never for body text.**

### 1.1 Typography — UPDATED for bilingual

| Context | Latin | Hebrew |
|---|---|---|
| Display / H1 | Montserrat 700/800, UPPERCASE + `letter-spacing: 0.08–0.12em` | **Heebo 700/800, normal case, normal tracking** |
| H2–H4 | Montserrat 700 / Assistant 600 | Heebo 600 |
| Body / captions | Assistant 400 | Heebo 400 (Assistant covers Hebrew too — Heebo preferred for headings, Assistant acceptable for body) |
| Mono (IDs, JSON) | JetBrains Mono | JetBrains Mono |

**Rules:**
- Uppercase + wide tracking is **meaningless in Hebrew** — never apply it to Hebrew strings.
  Implement via `:lang(he)` CSS or the i18n layer, not per-component hacks.
- Type scale (sizes/line-heights) is unchanged from v2: display 56, h1 40, h2 28, h3 20,
  h4 16, body 15, body-sm 13, caption 12.

### 1.2 Spacing, radii, motion, elevation — UNCHANGED from v2

- Spacing: Tailwind defaults. Radii: sm 6 / md 10 / lg 16 / xl 24. Cards default `lg`.
- Motion: `--duration-fast 150ms / base 220ms / slow 400ms / glow 1600ms`;
  `prefers-reduced-motion` fallback is REQUIRED on every animation.
- Elevation: elev-1 / elev-2 / elev-glow. **elev-glow only for Keren's active-state cards and
  success moments.** No global glassmorphism; `backdrop-filter` on at most two surfaces per page.

---

## 2. Internationalization & RTL — FIRST-CLASS (new, replaces v2 §6)

Bilingual (Hebrew + English) from day one. This is a hard requirement on every component.

- **Library:** `react-i18next` (the dashboard is Vite, not Next). All UI strings go through
  `t('...')` — zero hardcoded user-facing strings in JSX.
- **Direction:** `dir` is set dynamically on `<html>` (`rtl` for Hebrew, `ltr` for English).
- **CSS:** use logical properties everywhere — `padding-inline-start`, `margin-inline-end`,
  `inset-inline-start` — never `left`/`right` paddings/margins in new code.
- **Icons:** directional icons (chevrons, arrows, back buttons) must flip under RTL.
  Lucide + a `[dir="rtl"] .flip-rtl { transform: scaleX(-1) }` utility.
- **User content** (transcripts, summaries, notes, analysis strings) is Hebrew regardless of
  UI language → every element rendering user content sets `dir="auto"`.
- **Dates/numbers:** format via `Intl.*` with the active locale.

---

## 3. Signature Components (renamed from v2 §3)

### 3.1 Keren Presence (persistent status chip, top nav)

> 🔵 **Keren is on a call with Daniel M.** · _live since 09:14_
> (HE: **קרן בשיחה עם דניאל מ.** · _מ-09:14_)

- Pulsing cyan dot, `--duration-glow` loop, opacity 0.4 → 1.0.
- States: idle / calling / on-call / analyzing / paused.
- Click opens the Live Feed drawer.
- Component name in code: `KerenStatusChip` (rename from `DanieStatusChip`).

### 3.2 Live Interaction Feed
Vertical near-real-time timeline of Keren's actions. Entry: icon + timestamp + action title +
optional context line + chips (confidence / source / lead). Required states: empty, booting
(skeleton shimmer), live, error ("Connection lost — retrying").

### 3.3 Pipeline Visualizer (the Kanban — Sprint 3)
Stages mirror the lead state machine: `new → contacted → qualifying → qualified → booked`
(+ terminal: disqualified / lost / opted_out, shown collapsed). Count + delta per stage.
Cards draggable between stages with confirmation toast. RTL: stage order flips.

### 3.4 Task Completion Affordance
When Keren completes something meaningful (meeting booked!): **glow pulse + checkmark +
microcopy, in that order.** Never glow alone.

---

## 4. Iconography — UNCHANGED

Lucide-React only. Stroke 1.5px. Sizes 14/16/20/24. No filled icons, no emoji in UI chrome.

---

## 5. What NOT to Build — UNCHANGED + additions

- ❌ Aurora / blob / mesh-gradient backgrounds
- ❌ Stock isometric illustrations, 3D blobs
- ❌ Emoji in UI chrome
- ❌ Stacked cyan→violet gradient buttons (solid cyan + subtle glow on hover)
- ❌ Marquee logo carousels
- ❌ Light mode (v1)
- ❌ **NEW:** hardcoded UI strings (everything through i18n)
- ❌ **NEW:** physical CSS direction properties (`left`/`right`) in new components
- ❌ **NEW:** any remaining "Danie" reference in UI

---

## 6. Accessibility & Performance Budget — UNCHANGED

WCAG AAA (7:1) body text, AA (4.5:1) controls. Full keyboard nav. Focus ring `--focus-ring`
2px offset. Reduced-motion everywhere. LCP < 2.0s on 4G, initial JS < 180kb gz, CLS < 0.05.

---

## 7. Definition of Done (per component) — UPDATED

A component ships only when it has:

- [ ] Tokens only (no hex literals in JSX/CSS)
- [ ] All strings via `t('...')` with HE + EN entries
- [ ] Renders correctly in BOTH `dir="ltr"` and `dir="rtl"`
- [ ] User content elements set `dir="auto"`
- [ ] Keyboard navigation + focus-visible state
- [ ] Empty / loading / error states
- [ ] `prefers-reduced-motion` fallback (if animated)
- [ ] AAA contrast for text, AA for controls
- [ ] Mobile breakpoint behavior

---

## 8. Asset Inventory

| Asset | Spec | Status | Owner |
|---|---|---|---|
| ClickScales logo (SVG, mono + color) | for sidebar + login | ⚠️ TBD | Koren |
| KEREN wordmark / avatar | for Presence chip + empty states | ⚠️ TBD | Koren |
| Favicon set | 16/32/180/512 | ⚠️ TBD | Koren |
| OG image | 1200×630 | ⚠️ TBD | Koren |

---

## 9. Migration Checklist (Danie → KEREN)

Owned by the **dashboard workstream** (Claude Code session on `feature/dashboard-*`):

- [ ] Sidebar brand text "DANIE" → "KEREN" (+ ClickScales in footer or login)
- [ ] `DanieStatusChip.tsx` → `KerenStatusChip.tsx` (rename file, component, imports)
- [ ] Nav item "Voice Simulator" → "Test Keren" (or `t('nav.testKeren')`)
- [ ] Integrations page stale card "Twilio + ElevenLabs" → real current stack copy
- [ ] Any `danie` string in `dashboard/src/**` (grep and destroy)
- [ ] `brand_assets/brand_identity` (v2) — add a one-line deprecation header pointing here

---

_This brief governs the dashboard. The marketing site (old v2 §7) will get its own brief when
that workstream opens — do not build website sections from the deprecated file._
