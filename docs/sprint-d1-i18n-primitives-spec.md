# Sprint D1 Spec — i18n Infrastructure + Design-System Primitives

> **Owner:** Koren · **Implement in:** Claude Code (dashboard workstream, branch `feature/dashboard-d1-i18n`)
> **Governing doc:** `brand_assets/keren-brand-brief-v3.md` (§1.1 typography, §2 i18n/RTL, §7 DoD)
> **Why this sprint exists:** every screen built after this one inherits bilingual support and
> shared primitives for free. Every screen built before it gets retrofitted once. Delaying this
> multiplies the retrofit cost by the number of screens shipped.

---

## Scope — what's IN

1. **react-i18next infrastructure** — full setup, HE+EN locale files, live language switcher, dynamic `dir`/`lang`.
2. **Hebrew typography** — Heebo font, `:lang(he)` rules (no uppercase/tracking on Hebrew).
3. **UI primitives** — `Input`, `Select`, `TextArea`, `Modal`, `Tabs`, `EmptyState`, `PageHeader`, `Toast`, `Bidi` — built once, token-only, both directions.
4. **String extraction** for: `AppLayout` (nav/sidebar), `Leads`, `LeadDetail`, `Bookings`. (Other pages get extracted during their own redesign sprints — do not boil the ocean.)
5. **RTL correctness pass** on the four screens above (logical properties, icon flips).
6. **`/styleguide` dev route** — renders every primitive in every state, in the active language/direction. This is the visual regression net for all future design work.
7. **recharts** installed (used by D2 Overview redesign; install now so D2 starts clean).

## Scope — what's OUT

- Redesigning any page (D2+ territory). D1 changes plumbing, not layouts.
- Translating transcripts/summaries/user content (always rendered as-is with `dir="auto"`).
- Overview / CallDetail / Calls / Settings / Integrations string extraction.
- Light mode, locale-aware URLs, server-side locale.

---

## 1. i18n Infrastructure

### 1.1 Dependencies

```bash
npm i react-i18next i18next i18next-browser-languagedetector
npm i recharts
```

### 1.2 File structure

```
dashboard/src/i18n/
  index.ts            # i18next init: resources, fallbackLng 'en', detector (localStorage → navigator)
  locales/
    en.json
    he.json
```

- Key convention: `page.section.key` (e.g. `leads.filters.searchPlaceholder`, `nav.overview`,
  `common.save`, `common.cancel`). Flat-ish, two levels max.
- `returnNull: false`; missing key in dev logs a console warning.

### 1.3 Direction & language plumbing

- In `main.tsx` (or a `<LocaleProvider>`): on language change set
  `document.documentElement.lang = lng` and `document.documentElement.dir = lng === 'he' ? 'rtl' : 'ltr'`.
- Persist choice to `localStorage('keren.lang')` via the detector.
- **Language switcher** in the sidebar footer: a small segmented `EN | עב` control (uses the
  new primitives, `aria-label`, keyboard operable).

### 1.4 Hebrew typography (brief §1.1)

- Add Heebo to the Google Fonts import in `index.css`: weights 400/600/700.
- CSS:

```css
:lang(he) {
  font-family: 'Heebo', 'Assistant', system-ui, sans-serif;
}
/* Uppercase + tracking are meaningless in Hebrew — neutralize wherever headings set them */
:lang(he) .display, :lang(he) h1, [lang="he"] .uppercase-track {
  text-transform: none;
  letter-spacing: normal;
}
```

- Note: existing components set uppercase via inline styles. For D1 it is enough that (a) new
  primitives never hardcode `textTransform` on translatable text and (b) `PageHeader` applies
  uppercase/tracking only when `i18n.language !== 'he'`. Full sweep happens per-page in D2+.

### 1.5 RTL correctness rules (brief §2)

- New/touched code uses **CSS logical properties only**: `paddingInlineStart`,
  `marginInlineEnd`, `insetInlineStart`, `textAlign: 'start'`.
- Directional icons flip: add a `.flip-rtl` utility (`[dir="rtl"] .flip-rtl { transform: scaleX(-1) }`)
  and apply to `ArrowLeft` back-links, chevrons in pagination, timeline connectors.
- The `ScoreBar`, table alignment, and dropdown chevron backgrounds in `Leads.tsx` need a
  logical-property pass.

---

## 2. Primitives — `dashboard/src/components/ui/`

Follow the existing convention (inline styles + CSS variables — do NOT introduce a new styling
system). Every primitive meets the brief §7 DoD. Props kept minimal — extend when needed.

| Component | Base | Key props | Notes |
|---|---|---|---|
| `Input` | styled `<input>` | `size?: 'sm'\|'md'`, `invalid?`, `startIcon?` | replaces the hand-rolled search inputs; icon slot uses `insetInlineStart` |
| `TextArea` | styled `<textarea>` | `rows`, `invalid?` | auto `dir="auto"` when `content` prop marks user text |
| `Select` | styled `<select>` | `options: {value,label}[]`, `placeholder?` | chevron via background-image must flip in RTL — use a wrapper span icon instead |
| `Modal` | Radix Dialog | `title`, `description?`, `footer?` | solid `--bg-elevated`, `elev-2`; focus-trapped by Radix |
| `Tabs` | Radix Tabs | `items: {value,label,content}[]` | replaces Settings' hand-rolled tabs later |
| `EmptyState` | div | `icon`, `title`, `description?`, `action?` | the 3 existing copies (Leads/Calls/etc.) collapse into this |
| `PageHeader` | div | `title`, `subtitle?`, `actions?` | handles the he-vs-en uppercase rule internally |
| `Toast` | Radix Toast | `variant: 'success'\|'error'\|'info'` | provider mounted in `AppLayout`; used by StatusEditor save, future drag-drop confirms |
| `Bidi` | span/p/div | `as?`, `children` | renders with `dir="auto"`; ALL user content (names, notes, summaries, transcript text) goes through it |

**Refactor while extracting (mechanical, low-risk):**
- `Leads.tsx` search input → `Input`; status select → `Select`; empty state → `EmptyState`.
- `LeadDetail.tsx` StatusEditor select → `Select`; save feedback → `Toast`; message bodies → `Bidi`.
- `Bookings.tsx` cancel dialog → `Modal`.
- Do not restyle anything — visual output should be pixel-identical in LTR/EN.

---

## 3. `/styleguide` route (dev-only)

- Route registered only when `import.meta.env.DEV`.
- Sections: all primitives in all variants/states (default, hover-hint, disabled, invalid,
  empty, loading), rendered twice — once per direction — plus a live language toggle.
- No new design here: it's an inventory, not a showcase.

---

## 4. Acceptance criteria

1. Language switcher flips the four in-scope screens EN ↔ HE live; `<html>` gets correct
   `lang` + `dir`; choice survives reload.
2. In HE: Heebo renders, no uppercase/letter-spacing on headings, nav/sidebar fully translated,
   back-arrows and pagination chevrons point the right way, layout has no broken alignment
   (spot-check Leads table + LeadDetail 3-column grid).
3. In EN: pixel-parity with current UI (no visual regressions — compare `npm run screenshot`
   before/after on `/leads`).
4. All four in-scope screens have zero hardcoded user-facing strings (`grep` for Hebrew/English
   literals in their JSX).
5. `/styleguide` renders every primitive in both directions.
6. User content (lead names, message bodies, notes) renders through `Bidi` with `dir="auto"`.
7. `npx tsc --noEmit` clean in `dashboard/`; root suite still green; no console warnings for
   missing i18n keys on the four screens.

---

## 5. Suggested execution order (one commit each)

1. i18n init + locales + provider + `dir`/`lang` plumbing + language switcher (nav strings only).
2. Heebo + `:lang(he)` CSS + `.flip-rtl` utility.
3. Primitives batch 1: `Input`, `Select`, `TextArea`, `EmptyState`, `PageHeader`, `Bidi`.
4. Primitives batch 2: `Modal`, `Tabs`, `Toast` (+ provider in AppLayout).
5. `/styleguide` route.
6. Retrofit `Leads` → primitives + `t()` + RTL pass.
7. Retrofit `LeadDetail` + `Bookings` → same.
8. `recharts` install + trivial smoke import. Final: screenshots, criteria walkthrough.

---

## 6. Kickoff prompt (paste into Claude Code)

```
You are the dashboard workstream. Read docs/sprint-d1-i18n-primitives-spec.md and
brand_assets/keren-brand-brief-v3.md (§1.1, §2, §7). Work on branch
feature/dashboard-d1-i18n. Execute the spec's §5 order, one commit per step.
Do not restyle pages — EN/LTR output must stay pixel-identical (verify with
npm run screenshot against /leads before and after). Dev servers: use port 3002,
never touch :3000/:3001 (see CLAUDE.md shared-machine rules).
```
