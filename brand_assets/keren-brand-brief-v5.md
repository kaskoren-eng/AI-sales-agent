# KEREN by ClickScales — Brand & Build Brief

**Version:** 5.1 — one type family (IBM Plex), official logo shipped
**Status:** Active — single source of truth for all dashboard design work
**Owner:** Koren (koren@clickscales.com) · **Merged:** 2026-07-29 · **Revised:** 2026-09-02, architect session
**Stack (dashboard):** Vite · React 19 · TypeScript · Tailwind CSS 4 · Radix primitives · Lucide-React · Framer Motion · react-i18next

> **Version note — read once, it prevents a real bug.** The previous file
> (`keren-brand-brief-v3.md`) internally called its cream/glass revision "v4.0". Any document
> that says "the v4 tokens" and means **cream** (notably
> `docs/sprint-d2-cream-migration-and-overview-spec.md`) refers to a **dead** palette. This
> brief is **v5** precisely so that "v4" can never be read two ways. The cream/glass direction
> — including the glass material, the teal/violet accents, and the one-theme rule — is fully
> superseded. §12 lists everything that changed.

---

## 0. Product Definition

- **Company:** ClickScales
- **Product:** **KEREN** — an autonomous AI sales agent (SDR-class) that calls leads,
  qualifies them, and books meetings. Hebrew-first voice, multi-channel (voice / WhatsApp / email).
- **Persona:** Keren is a woman. Hebrew feminine grammar for herself, warm and professional.
  She is a "digital worker" the customer manages — a synthetic colleague, not a tool.
- **"Danie" is dead.** Any reference to Danie in code, UI, or docs is legacy and must be
  migrated (see §11.1 Migration Checklist).

**Voice & tone (dashboard microcopy):**
- Warm, precise, confident, never cute. Concise sentences. Active voice.
- Sample lines (EN):
  - "Keren qualified 4 leads this morning. 2 look promising."
  - "Meeting booked with Sarah Chen — Thursday 14:00. Calendar updated."
- Sample lines (HE):
  - "קרן דיברה עם 6 לידים היום. 2 קבעו פגישה."
  - "נקבעה פגישה עם שרה כהן — חמישי 14:00. היומן עודכן."

### 0.1 ⚠️ Two language settings — the firewall

**The dashboard interface language and the agent's spoken language are two independent
settings that must never collapse into one.**

| Setting | Value | Owner |
|---|---|---|
| Dashboard interface language | **English default**, Hebrew available | DASHBOARD |
| Agent spoken language | **Hebrew first**, English on switch | VOICE |

Keren speaks Hebrew first to leads — that is the product, and the reason the Retell → LiveKit
migration exists. A business owner reading an English dashboard about a call his agent
conducted in Hebrew is the normal case, not an edge case. Never derive one default from the
other, and never introduce a shared "language" key both read. If a `tenants.settings` key is
ever needed for interface language it is named `ui_locale` — never `language` — and it is
claimed in `CLAUDE.md` before use.

---

## 1. Design Tokens — v5 COOL TECHNICAL (replaces the v4.0 cream/glass palette)

**Decision (2026-07-29):** the dashboard adopts the cool technical system derived from the
ClickScales landing page (`clickscales-landing_2.html`). Why it reads as techy — and this
matters more than the hexes: in the source file monospace is used **30 times, more than any
other token**; indigo appears 14 times; there are **zero gradients in the entire file**. The
technical character comes from monospace type doing structural work over a flat cool palette
with one restrained accent. It does not come from glows or gradients. Do not add them.

The cream/glass system — `#F4EFE6`, `--glass-*`, teal `#0FA3AC`, violet `#5B5BD6`, backdrop
blur — is **retired**. Any occurrence in `dashboard/src/**` is a migration target, not a
reference.

### 1.1 Light tokens — primary

```css
:root {
  /* Surfaces */
  --surface-page:      #EDF0F6;  /* app background */
  --surface-card:      #FFFFFF;  /* cards, panels, drawers */
  --surface-sunken:    #E4E9F1;  /* table headers, input rest, wells */
  --surface-overlay:   #FFFFFF;  /* modals, popovers — pair with --shadow-overlay */

  /* Text */
  --text-primary:      #0C1226;  /* headings, body, values */
  --text-secondary:    #5B667E;  /* labels, supporting copy */
  --text-tertiary:     #7A8598;  /* captions ≥16px, placeholders, disabled — NEVER body */
  --text-on-accent:    #FFFFFF;

  /* Lines */
  --border-default:    #D9E0EA;
  --border-strong:     #C3CDDB;  /* emphasis, active field */

  /* Accent — actions, links, active nav, focus */
  --accent:            #2F35C7;
  --accent-hover:      #252AB3;
  --accent-tint:       #EAEAFB;  /* selected row, active nav background */

  /* Data — charts, graphics, status dots. NOT a text colour on light. See §1.4. */
  --data-1:            #2F35C7;
  --data-2:            #D9861B;
  --data-2-glow:       #F2B24E;
  --data-2-tint:       #FCF0DC;

  /* Radii */
  --r-sm:  8px;   /* chips, badges, inputs */
  --r:     14px;  /* cards, buttons */
  --r-lg:  22px;  /* panels, modals, hero surfaces */
  --r-full: 999px;

  --container-max: 1180px;
}
```

`--accent-hover` and `--data-2-tint` are the landing page's own `#252AB3` and `#FCF0DC`, which
appear as raw hex there. Promoting them to tokens is the fix, not an invention.

**Focus ring:** `--accent`, 2px, offset 2px (replaces the teal ring).

**Accent rule:** `--accent` carries CTAs, links, active nav, focus and selection. `--data-2`
(amber) carries chart series, status dots, badge borders and icon strokes. Neither is ever a
large filled background wash; if more than ~10% of a screen is accent-coloured, it's wrong.

### 1.2 Dark tokens

```css
[data-theme="dark"] {
  --surface-page:      #0A0F20;
  --surface-card:      #141B31;
  --surface-sunken:    #070B17;
  --surface-overlay:   #1A2240;

  --text-primary:      #EDF0F6;
  --text-secondary:    #A2A9BC;
  --text-tertiary:     #767E93;
  --text-on-accent:    #FFFFFF;

  --border-default:    #232941;
  --border-strong:     #333B57;

  --accent:            #2F35C7;  /* as a FILL — white text on it passes */
  --accent-text:       #8B90F0;  /* accent AS TEXT on dark — the light value fails here */
  --accent-hover:      #3A41D8;
  --accent-tint:       #1B2145;

  --data-1:            #6E74E8;  /* lightened — #2F35C7 is too dark on #0A0F20 */
  --data-2:            #F2B24E;  /* the glow value becomes the base on dark */
  --data-2-glow:       #F8CC85;
  --data-2-tint:       #2A2113;
}
```

The light theme has no `--accent-text` because `--accent` doubles as both there. On dark they
must separate — this is the single most common bug when porting a light palette.

### 1.3 Elevation

The source design uses borders and flat fills, not heavy shadows. Keep that.

```css
--shadow-card:    0 1px 2px rgba(12,18,38,.04), 0 8px 24px rgba(12,18,38,.06);
--shadow-overlay: 0 2px 4px rgba(12,18,38,.06), 0 24px 60px rgba(12,18,38,.16);
```

On dark, shadows do nothing. Separate dark surfaces with `--border-default` and a lighter
`--surface-card`, never by deepening a shadow.

The glass material (backdrop blur, translucent surfaces) is **retired** — depth now comes from
borders, flat surface steps, and the two shadows above. This also deletes the old blur
performance budget; nothing blurs anymore.

### 1.4 Contrast — measured, not estimated

| Pair | Ratio | Verdict |
|---|---|---|
| `--text-primary` on `--surface-page` | ~16:1 | pass, comfortable (AAA) |
| `--text-secondary` on `--surface-page` | **~5.0:1** | passes AA, **no margin** — never below body size |
| `--text-tertiary` on `--surface-page` | **~3.3:1** | large text (≥16px) and UI only. **Never body text.** |
| `--accent` on `--surface-card` | ~8:1 | pass |
| **`--data-2` (#D9861B) on white** | **~2.9:1** | **FAILS AA for text** |

**Hard rule: `--data-2` is never a text colour on a light surface.** It is chart fills, status
dots, focus rings, badge borders and icon strokes. If amber must label something on light, the
text is `--text-primary` and amber carries the dot or border. On dark `--surface-page` it is
fine as text.

**Contrast law (amends the old blanket-AAA rule):** primary body text is AAA by construction
(~16:1). `--text-secondary` is AA-only with no shrink margin — re-check it at the smallest
size actually used. `--text-tertiary` is restricted as above. Controls: AA (4.5:1) minimum.

#### 1.4.1 Status colours — PROPOSED, sign-off required

The landing page contains `#C0392B` and no other status colour, so there is no status system
to derive. These are proposals, harmonised to the cool palette. The old cream-era semantic set
(`#1D9E75 / #B45309 / #B3261E / #185FA5`) retired with the palette it was tuned for.

```css
--status-success: #1B7F5A;
--status-warning: #9A5D0F;   /* text-safe amber; --data-2 carries the dot */
--status-danger:  #C0392B;   /* from the source file */
--status-neutral: #5B667E;
```

Product spec §6 needs eight lead statuses. Mapping those eight onto these four plus tints is a
separate decision — do not improvise it in component code.

### 1.5 Spacing & motion — carried over

- Spacing: Tailwind defaults, unchanged from the previous brief.
- Motion: `--duration-fast 150ms / base 220ms / slow 400ms / glow 1600ms`;
  `prefers-reduced-motion` fallback is REQUIRED on every animation.
- Radii changed with the token block above: sm 8 / base 14 / lg 22 / full. The old md-10 and
  xl-20 steps are gone.

---

## 2. Theming — full light/dark toggle

**Decision (Option B):** two complete token sets, a user preference, and `data-theme` on
`<html>`. Both themes are first-class. This **supersedes the previous one-theme rule** ("no
dark mode in v1, do not add a theme toggle") — dark-as-zones was considered and rejected: a
theme is a property of the workspace, not of a surface.

**The cost is manageable under exactly one discipline: no component ever names a colour, only
a token.** If that holds, dark is close to free. If it slips even a little, every page gets
built twice.

### 2.1 Application

`data-theme` sits on `<html>` and carries one of two resolved values, `light` or `dark`. The
user preference has three states — `light`, `dark`, `system` — and `system` resolves against
`prefers-color-scheme` at load and reacts to changes live. The preference lives in Account
profile, next to interface language.

```html
<html lang="en" dir="ltr" data-theme="light">
```

Every component reads tokens through `var(--surface-card)` and inherits from `<html>`. No
component knows which theme is active. No component contains a colour value.

### 2.2 Six things that are always forgotten

1. **Flash of wrong theme.** A blocking inline script in `<head>`, before any paint, reads the
   stored preference and sets the attribute. Not a React effect — by the time an effect runs
   the user has already seen the wrong theme.
2. **`color-scheme: light dark`** in CSS, plus the matching value per theme. Without it, native
   scrollbars, form controls, and autofill styling stay light on a dark page.
3. **`<meta name="theme-color">`** updated with the theme, so mobile browser chrome matches.
4. **Charts.** Recharts and friends take colours as props, so they will not inherit. Read the
   computed CSS variable at render and re-read on theme change, or charts stay light forever.
   This is the single most common dark-mode bug in a dashboard.
5. **Logo and imagery.** Any asset that is dark-on-transparent needs a light-on-transparent
   twin. `brand_assets/**` is DASHBOARD territory — produce both.
6. **Shadows do nothing on dark.** Separate dark surfaces with `--border-default` and a lighter
   `--surface-card`, never by deepening a shadow.

### 2.3 Sequencing, so this does not double the work

Do **not** build each page twice as you go.

1. Land both token sets and the toggle mechanism first, before any page work.
2. Build every page against tokens, reviewing in **light only**. Page DoD during this phase
   stays at two screenshots — EN and HE.
3. Run **one dark pass** across all pages at the end. Because no component names a colour, this
   pass is a verification exercise, not a rebuild: flip the toggle, screenshot everything, fix
   what breaks. What breaks will be the six items in §2.2, and almost nothing else.
4. Final DoD per page becomes four screenshots — EN-light, EN-dark, HE-light, HE-dark — but
   only at that final gate, not on every commit along the way.

If step 3 turns out to be expensive, the cause is always the same: a component hardcoded a
colour. Fix the component, not the theme.

### 2.4 The simulator leads dark

Regardless of the user's preference, `/simulator` opens dark by default. The orb needs a dark
field to read as a light source rather than a sticker. The user can override; the default is
dark.

---

## 3. Typography — ONE family, three scripts

**Changed in v5.1 (2026-09-01).** The five-family Latin-first system below was replaced on the
marketing site by a single family covering Latin, Hebrew and mono: **IBM Plex**. Hierarchy
comes from **weight**, not from a second typeface.

```css
--font-display: "IBM Plex Sans", "IBM Plex Sans Hebrew", system-ui, sans-serif;
--font-body:    "IBM Plex Sans", "IBM Plex Sans Hebrew", system-ui, sans-serif;
--font-mono:    "IBM Plex Mono", "IBM Plex Sans Hebrew", ui-monospace, monospace;
```

| Role | Face | Used for |
|---|---|---|
| Display | IBM Plex Sans + IBM Plex Sans Hebrew | page titles, headings, metric values, presence indicator |
| Body | the same two faces | body, labels, buttons, form fields, everything else |
| Mono | IBM Plex Mono | LTR data — see §3.1 |

**Why one family.** Latin and Hebrew here are drawn by the same design team on the same
skeleton, so a mixed line — `ליד נכנס ב־21:40` — is drawn by one designer instead of two.
That removes the entire class of problem the old §3.2 existed to manage: no x-height mismatch
to normalise, no `size-adjust` descriptors, no self-hosting for optical control, no
per-direction line-height correction. The calibration gate is retired, not deferred.

**Alternatives rejected, and why.** Noto Sans Hebrew was the runner-up and carries a genuine
condensed width axis, which Plex does not; it was rejected because its Latin is deliberately
neutral to the point of having no voice, and this brand's whole character claim is
"technical, not generic". Heebo and Assistant were rejected as the two faces every Israeli
SMB site already uses — they read as a template. Bricolage Grotesque plus Instrument Sans was
the v5.0 answer and was rejected on the evidence: paired with a Hebrew fallback it produced
exactly the mixed-line mismatch §3.2 predicted, and the Hebrew read as cheap.

```
https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@200;300;400;500;600;700&family=IBM+Plex+Sans+Hebrew:wght@200;300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap
```

Three families, not five, and Google Fonts still serves Hebrew as a separate `unicode-range`
subset, so an English-only session never downloads the Hebrew faces. **Plex maxes out at 700** —
there is no 800. Any `font-weight: 800` in the codebase is a silent fallback to 700 and should
be written as 700.

### 3.0 The optical weight ladder — REQUIRED

Plex's light weights hold their shape at large sizes, which is the point of choosing it. Set
big type lighter so every level reads with equal visual force:

| Level | Weight | Letter-spacing |
|---|---|---|
| h1 / display | **200** | `-0.035em` |
| h2 | **300** | `-0.03em` |
| h3 | **600** | `-0.015em` |
| emphasised span inside a heading | **700**, coloured `--accent` | inherits |
| numerals inside a heading | **500** | inherits |
| body | 400 | normal |

Setting an h1 at 600 or 700 is the single fastest way to make this brand look like every other
SaaS page. Do not do it.

**Casing rules — unchanged.** Uppercase + wide tracking is dead as a display style. It survives
in one place only: mono eyebrow labels and column headers, Latin only. It remains
**meaningless in Hebrew** — never apply uppercase or tracking to Hebrew strings; enforce via
`:lang(he)` CSS or the i18n layer, not per-component hacks.

### 3.1 The mono rule

There is no good Hebrew monospace. IBM Plex Sans Hebrew sits in the mono stack purely as a
safety net so that stray Hebrew renders in a known face rather than a system default —
**never as licence to set Hebrew in mono deliberately.** Mono is for LTR data; see §3.3.

Tabular figures matter here: apply `font-variant-numeric: tabular-nums` wherever mono carries
column data, or numbers will not align.

### 3.2 Optical calibration — RETIRED

This section previously mandated a cross-face calibration ritual (`font-size-adjust`,
`@font-face` override descriptors, per-direction line-height, and a screenshot artefact before
sign-off). **One family removed the problem it solved.** Nothing here is required any more.

The one check that survives, and it is cheap: render a mixed
`Hebrew + Latin + 12 + 09:41` line at three sizes in both directions and confirm the numerals
sit on the same baseline as the Hebrew. If they do, the system is calibrated.

**A verification trap worth knowing about.** During the 2026-09-01 font selection, several
rounds of Hebrew screenshots were taken in an environment that could not reach
`fonts.googleapis.com`. Every one of them silently rendered in a system fallback, so the
comparisons measured nothing. If you are evaluating Hebrew type in any sandboxed or offline
tool, install the real `woff2` files locally and embed them before you trust a single
screenshot.

### 3.3 Where mono is used

Monospace is the primary carrier of the techy character (§1). **Mono is used for:** eyebrow
labels above sections · table column headers · timestamps, durations, dates · costs, latency
figures, token counts, percentages in tables · call IDs, agent IDs, version and status badges
· keyboard hints.

**Mono is never used for:** **Hebrew text of any kind** · body copy, headings, button labels ·
lead names, business names, or any user-entered content.

The Hebrew exclusion is not a compromise. Mono carries *data* in this system, and data is
digits and Latin. A Hebrew column header sits in `--font-body` while its values sit in
`--font-mono`; that pairing is correct and intentional.

### 3.4 Type scale — carried over

The type scale is unchanged: display 56, h1 40, h2 28, h3 20, h4 16, body 15, body-sm 13,
caption 12. Apply the §3.0 weight ladder on top of it. Adjust line-height if needed; do not
renumber the scale.

## 3.5 The logo — SHIPPED 2026-09-01, no longer TBD

The mark is a **circle enclosing five descending waveform bars**. It is the brand's only
signature graphic device, and everything visual in the system is derived from it.

```svg
<svg viewBox="0 0 48 48">
  <circle cx="24" cy="24" r="19.5" fill="none" stroke="#2563EB" stroke-width="3.6"/>
  <rect x="13.2" y="20" width="3.6" height="8"  rx="1.8" fill="#2563EB"/>
  <rect x="17.7" y="17" width="3.6" height="14" rx="1.8" fill="#2979EE"/>
  <rect x="22.2" y="14" width="3.6" height="20" rx="1.8" fill="#2E90F1"/>
  <rect x="26.7" y="17" width="3.6" height="14" rx="1.8" fill="#33A6F4"/>
  <rect x="31.2" y="20" width="3.6" height="8"  rx="1.8" fill="#38BDF8"/>
</svg>
```

**The five blues, in fixed order:** `#2563EB` `#2979EE` `#2E90F1` `#33A6F4` `#38BDF8`.
Never reorder them, never add a sixth, never render the mark in a single flat blue.

**Wordmark:** `ClickScales` beside the mark — "Click" at weight 700, "Scales" at 400. Latin
only; never transliterated to Hebrew.

**These five blues are NOT the accent.** `--accent` is still indigo `#2F35C7` (§1.1) and
`--data-2` is still amber `#D9861B`. The blues belong to the logo and to graphics derived
from it (the waveform device, capability icons, the call illustration). A button painted
`#2563EB` is a bug. This separation is deliberate: the mark stays recognisable precisely
because its colours appear nowhere else.

**Derived icon system.** The marketing site's capability icons are all built from the
waveform: bars against a threshold line, two facing waves, a wave resolving into text, a
wave enclosing the letter א. When new iconography is needed, derive it from the mark rather
than reaching for a generic icon set — that derivation is what stops the set looking
AI-generated (§7.1).

---

## 4. Internationalization & RTL — FIRST-CLASS, English primary

Bilingual (English + Hebrew) from day one. This is a hard requirement on every component.
**The default flipped in v5: English is the primary interface language and the i18n source.**
The RTL mechanics below are unchanged from the previous brief and still binding.

### 4.1 What changed

| | Before | After |
|---|---|---|
| Default document | `<html lang="he" dir="rtl">` | `<html lang="en" dir="ltr">` |
| i18n source language | Hebrew | **English** |
| Translation file | `en.json` | `he.json` |
| New strings authored in | Hebrew | **English**, then translated |
| Type stacks | — | Latin leads (§3) |

Confirm `he.json` has **full coverage** before switching the default — a missing key now falls
back to English silently, which is much harder to spot than the reverse was.

### 4.2 What does NOT change — the mechanics

- **Library:** `react-i18next`. All UI strings go through `t('...')` — zero hardcoded
  user-facing strings in JSX, including `aria-label` and `alt`. English being the default is
  not licence for literals.
- **Direction:** `dir` is set dynamically on `<html>` (`rtl` for Hebrew, `ltr` for English).
  The UI language sets the WHOLE layout direction: Hebrew UI = full RTL mirroring (nav, grids,
  charts start-edge, back arrows), English UI = full LTR.
- **CSS:** logical properties everywhere — `padding-inline-start`, `margin-inline-end`,
  `inset-inline-start` — never `left`/`right` in new code. A physical direction property is a
  review failure.
- **Icons:** directional icons (chevrons, arrows, back buttons) flip under RTL. Lucide + a
  `[dir="rtl"] .flip-rtl { transform: scaleX(-1) }` utility. Non-directional icons (play,
  clock, phone, mic) never flip.
- **User content** (lead names, transcripts, summaries, notes) sets `dir="auto"`. **This gets
  more important, not less** — lead content is overwhelmingly Hebrew while the interface
  around it defaults to English. That mixing is now the default case.
- **Dates/numbers:** format via `Intl.*` with the active locale. Numbers, times, currency and
  phone numbers stay LTR inside RTL text — wrap them.

### 4.3 The failure mode to guard against

"English primary" quietly becomes "Hebrew broken." RTL bugs are visual — a mirrored chevron, a
legend on the wrong side, a number escaping its bubble — and they are invisible to anyone
reviewing in English.

**Rule: no page is done until it has been reviewed in Hebrew.** Hebrew is the second language,
never the deferred one. The four-screenshot gate in §2.3 is what enforces this; it is not
negotiable down to two.

### 4.4 Copy

English UI copy is now authored, not translated. It carries the product's voice and gets the
same care Hebrew copy got when Hebrew was the source. Hebrew is then a real translation by
someone fluent — not a machine pass over English strings.

Note the split from marketing: the target market is Israeli SMBs, so Hebrew marketing copy
remains primary on the landing page even though the dashboard interface defaults to English.
Different surfaces, different audiences. And per §0.1: none of this touches what Keren says on
a call.

---

## 5. Signature Components

### 5.1 Keren Presence (persistent status chip, top nav)

> 🔵 **Keren is on a call with Daniel M.** · _live since 09:14_
> (HE: **קרן בשיחה עם דניאל מ.** · _מ-09:14_)

- Pulsing accent dot (`--accent` on light, `--accent-text` on dark), `--duration-glow` loop,
  opacity 0.4 → 1.0. This is the one animated element the Overview screen gets.
- States: idle / calling / on-call / analyzing / paused. Idle is designed, not blank.
- Click opens the Live Feed drawer.
- Component name in code: `KerenStatusChip` (rename from `DanieStatusChip`).

### 5.2 Live Interaction Feed
Vertical near-real-time timeline of Keren's actions. Entry: icon + timestamp + action title +
optional context line + chips (confidence / source / lead). Required states: empty, booting
(skeleton shimmer), live, error ("Connection lost — retrying").

### 5.3 Pipeline Visualizer (the Kanban — Sprint 3)
Stages mirror the lead state machine: `new → contacted → qualifying → qualified → booked`
(+ terminal: disqualified / lost / opted_out, shown collapsed). Count + delta per stage.
Cards draggable between stages with confirmation toast. RTL: stage order flips.

### 5.4 Task Completion Affordance
When Keren completes something meaningful (meeting booked!): **a brief `--accent-tint`
background wash + checkmark + microcopy, in that order.** No glow — glows are dead in this
system (§1). Never a wash alone.

---

## 6. Iconography — UNCHANGED

Lucide-React only. Stroke 1.5px. Sizes 14/16/20/24. No filled icons, no emoji in UI chrome.

---

## 7. What NOT to Build

- ❌ **Gradients, anywhere.** The source system contains zero. A gradient is a review failure.
- ❌ **Glows and neon effects** (the old "subtle glow on hover" is dead too)
- ❌ **Glass / backdrop blur** — the material is retired; surfaces are flat with borders
- ❌ Aurora / blob / mesh-gradient backgrounds
- ❌ Stock isometric illustrations, 3D blobs
- ❌ Emoji in UI chrome
- ❌ Gradient buttons of any kind — solid `--accent` fill, `--accent-hover` on hover
- ❌ Marquee logo carousels
- ❌ Hardcoded UI strings (everything through i18n)
- ❌ Physical CSS direction properties (`left`/`right`) in new components
- ❌ Any remaining "Danie" reference in UI
- ❌ **Component-level colour values** — a component that names a colour instead of a token
  breaks the entire theming economics (§2)

*(Removed from this list in v5: "Light mode" — light is now the primary theme, and dark ships
with it as a full toggle.)*

### 7.1 Anti-"AI-generated" rules (copy + visual) — UNCHANGED

The dashboard must read like a product built by people. These are the tells to eliminate:

**Copy:**
- No em-dash / en-dash ("—", "–") in any UI copy, in either language. Use a comma, a period,
  or the Hebrew maqaf-free phrasing instead.
- No filler qualifiers: "successfully", "seamlessly", "בהצלחה" on toasts. "הפגישה נקבעה" is enough.
- No exclamation marks in system copy.
- Deltas and stats phrased like a colleague reports them: "12+ מאתמול", not "▲ 12% vs yesterday avg".
- Numbers concrete and rounded sensibly. Never fake precision (61.37%).

**Visual:**
- One pulsing/animated element per screen MAX (the Keren presence dot owns it on Overview).
- Delta arrows/triangles used sparingly; color alone often suffices.
- Not every card needs an icon. Icons earn their place or get cut.
- Vary card content structure when the data differs; identical-skeleton cards in a row read
  as generated filler.

### 7.2 External component adoption — UNCHANGED gate, one addition

**Approved sources, in order of preference:**
1. **shadcn/ui** — copy-in code (not a dependency), Radix-based, already compatible with the stack.
2. **Purpose-built libraries** for a specific job: `recharts` (charts), `dnd-kit` (Kanban drag),
   `FullCalendar` (calendar), `TanStack Table` (advanced tables), `cmdk` (⌘K palette), `sonner` (toasts).
3. **Copy-in galleries**: Origin UI, Tremor, Magic UI. Take the markup, discard their colors.

**Adoption gate — all five, no exceptions:**
1. **Wrapper rule.** External components are never imported directly into a page. They are wrapped
   in `dashboard/src/components/ui/<Name>.tsx`, and only the wrapper is used in pages. Swapping a
   library later must touch one file, not ten screens.
2. **Token rule.** The component is restyled to the §1 tokens before first use. Zero library
   default colors, zero hex literals. **v5 addition: the wrapper must read colours from the
   computed CSS variables and re-read them on theme change** — chart libraries take colours as
   props and will not inherit `data-theme` (§2.2 item 4).
3. **RTL gate.** It must render correctly under `dir="rtl"` with Hebrew content. A library that
   can't do RTL is rejected regardless of how good it looks. This is the FIRST check, not the last.
4. **One at a time.** Add a library only when a concrete sprint needs it. Announce the dependency
   in the commit message (`deps: add X for Y`).
5. **Styleguide rule.** Every adopted component appears on `/styleguide` in both directions and
   both languages before it may be used in a page — and, once the theme layer lands, in both
   themes.

**Planned adoption schedule:** D2 → `recharts` · Sprint 3 → `dnd-kit` · Sprint 4 → `FullCalendar` ·
later polish → `cmdk`, `sonner`.

**Rejected by default:** anything with heavy 3D/parallax/aurora effects, anything that ships its
own theme system that fights the tokens, anything unmaintained (<6 months since last release).

---

## 8. Accessibility & Performance Budget

Contrast per the measured law in §1.4 (primary text AAA by construction; secondary AA with no
shrink margin; `--data-2` never text-on-light). Full keyboard nav. Focus ring `--accent`, 2px,
offset 2px. Reduced-motion everywhere. LCP < 2.0s on 4G, initial JS < 180kb gz, CLS < 0.05.
Font payload per §3 — three families, and Hebrew subsets load on demand, so an English-only
session never fetches the Hebrew faces. If LCP suffers, drop the weights the ladder (§3.0)
does not use before touching anything else.

---

## 9. Definition of Done (per component)

A component ships only when it has:

- [ ] Tokens only (no hex literals in JSX/CSS)
- [ ] All strings via `t('...')` with HE + EN entries
- [ ] Renders correctly in BOTH `dir="ltr"` and `dir="rtl"`
- [ ] User content elements set `dir="auto"`
- [ ] Keyboard navigation + focus-visible state
- [ ] Empty / loading / error states
- [ ] `prefers-reduced-motion` fallback (if animated)
- [ ] Contrast per §1.4 (AAA primary text, AA controls)
- [ ] Mobile breakpoint behavior

**v5 addendum (theming):** colours are read only via `var(--token)` — no computed hex, no
inline styles with colour values. Components are verified in dark at the project-level dark
gate (§2.3), not per commit.

---

## 10. Asset Inventory

| Asset | Spec | Status | Owner |
|---|---|---|---|
| ClickScales logo (SVG, colour) | circle + five waveform bars — spec in §3.5 | ✅ **shipped** `website/favicon.svg`, inline in nav + footer | — |
| Favicon set | svg + ico(16/32) + apple-touch 180 + 192 + 512 + webmanifest | ✅ **shipped** 2026-09-01, `website/` root | — |
| ClickScales logo (mono / single-colour) | for print, faxes, one-colour contexts | ⚠️ TBD — derive from §3.5 by flattening all bars to `--ink` | Koren |
| **Dark-theme logo twin** | light-on-transparent wordmark (§2.2 item 5); the mark itself already works on `--night` | ⚠️ TBD | Koren |
| Agent avatar (generic) | for Presence chip + empty states — must NOT be a named persona, see §0 | ⚠️ TBD | Koren |
| OG image | 1200×630 | ⚠️ TBD | Koren |
| Call recordings | `booking.mp3`, `price-objection.mp3`, `callback.mp3` for the hero player | ⚠️ **blocking** — `website/assets/audio/` holds only a README; the three rows render "בקרוב" until these land | Koren |
---

## 11. Migration Checklists

### 11.1 Danie → KEREN — UNCHANGED, still owned by the dashboard workstream

- [ ] Sidebar brand text "DANIE" → "KEREN" (+ ClickScales in footer or login)
- [ ] `DanieStatusChip.tsx` → `KerenStatusChip.tsx` (rename file, component, imports)
- [ ] Nav item "Voice Simulator" → "Test Keren" (or `t('nav.testKeren')`)
- [ ] Integrations page stale card "Twilio + ElevenLabs" → real current stack copy
- [ ] Any `danie` string in `dashboard/src/**` (grep and destroy)
- [ ] `brand_assets/brand_identity` (v2) — add a one-line deprecation header pointing here

### 11.2 Type + token migration (cream → v5.0 → v5.1)

1. Swap the Google Fonts link for the three-family IBM Plex link in §3; remove the
   Bricolage/Instrument/JetBrains/Rubik/Assistant import. Declare the three stacks as tokens —
   no component names a typeface directly. Rewrite every `font-weight: 800` as 700 (Plex has
   no 800). Grep for hardcoded faces outside the tokens; as of 2026-09-02 the dashboard has
   two (`pages/CallDetail.tsx` names JetBrains Mono inline, `pages/Styleguide.tsx` labels a
   row "Heebo").
2. Apply the §3.0 weight ladder. The old §3.2 calibration gate is retired — one family, no
   cross-face tuning needed.
3. Replace the `:root` token block with §1.1. Add the `[data-theme="dark"]` block from §1.2.
4. Grep the dashboard for raw hex and for old token names (`--glass-*`, `--accent-teal*`,
   `--accent-violet*`, `--bg-page*`, cream values). Every hit becomes a token or a justified
   exception in review.
5. Build the theme layer per §2: `data-theme` on `<html>`, three-state preference, the blocking
   inline script, `color-scheme`, `theme-color`, chart colour reads, dual logo assets. Set
   `/simulator` to default dark per §2.4.
6. **Verify no component reads a colour any way other than `var(--token)`.** This is the step
   that decides whether the dark pass in §2.3 costs a day or a fortnight. Do not sign it off
   loosely.
7. Flip the i18n default to `en` per §4. Confirm `he.json` has full coverage before switching.
8. Screenshot every existing page — EN-light, EN-dark, HE-light, HE-dark — before and after,
   and attach all of them to the handoff.
9. Re-check `--text-secondary` at the smallest size actually used in the UI. It has ~5:1 and
   no room to shrink.

---

## 12. Version history — what changed and why

| Version | Palette | Fate |
|---|---|---|
| v2 ("Danie", midnight) | navy `#0B132B` + cyan `#00F5FF` | dead — read as gaming/dev-tool |
| v3 file / internal "v4.0" (cream + glass) | cream `#F4EFE6`, glass, teal/violet | **dead — superseded by this file.** Beware: some docs say "v4 tokens" and mean cream |
| v5.0 | cool technical, from the ClickScales landing page | palette **active**; its typography is dead |
| **v5.1 (this file)** | unchanged palette + the shipped logo's five blues (§3.5) | **active** |

**v5 supersedes, explicitly** (the previous brief asserted each of these):
- "There is ONE theme. No dark mode in v1. Do not add a theme toggle." → full light/dark
  toggle, §2.
- "❌ Light mode" in What-NOT-to-build → light is now primary.
- The entire glass material system (tokens, blur rules, blur performance budget) → flat
  surfaces + borders + two shadows, §1.3.
- Teal/violet accents and the teal focus ring → indigo `--accent` + amber `--data-2`, §1.1.
- "Pulsing cyan dot" and glow-based affordances → accent dot, tint wash, no glows, §5.
- Montserrat/Heebo typography and the uppercase display style → Latin-first stacks with
  Hebrew fallback, §3 — **itself superseded in v5.1, see below.**
- Blanket AAA body-text rule → the measured contrast law, §1.4.
- Hebrew as i18n source and RTL default → English primary, §4 (interface only — §0.1).
- Radii md-10/xl-20 → 8/14/22/full, §1.1.

**Unchanged from the previous brief, deliberately:** product definition and voice (§0),
signature component structure (§5), iconography (§6), anti-AI rules (§7.1), external adoption
gate (§7.2), spacing and type scale (§1.5, §3.4 — verify, don't renumber), component DoD
core (§9), Danie migration checklist (§11.1), performance budget (§8).

---

**v5.1 supersedes v5.0, explicitly** (2026-09-02, after the marketing-site rebuild):
- Five-family Latin-first type (Bricolage Grotesque / Instrument Sans / JetBrains Mono, with
  Rubik / Assistant behind them) → **one family, three scripts: IBM Plex**, §3. Hierarchy
  from weight, not from a second typeface.
- The §3.2 optical-calibration gate, its `size-adjust` descriptors and its required screenshot
  artefact → **retired**, §3.2. One family removed the problem.
- No weight guidance → the **optical weight ladder**, §3.0 (h1 200 / h2 300 / h3 600).
- Logo "⚠️ TBD" → **shipped and specified**, §3.5, with the five brand blues and the rule that
  they are not the accent.
- Asset inventory rewritten against what actually exists, §10.

**Still open, needs Koren's decision — do not guess:** the dashboard is still running the
v5.0 five-family stack (`dashboard/src/index.css` lines 1, 21-23). The website has moved to
IBM Plex. Until this is decided the product has two typefaces. The change is cheap because
every dashboard component already reads `var(--font-display|body|mono)` — it is the import
line, three token lines, and two hardcoded spots (see §11.2 step 1).

**Unchanged in v5.1, deliberately:** the entire palette (§1) including indigo `--accent`
`#2F35C7` and amber `--data-2` `#D9861B`, theming (§2), i18n and RTL (§4), signature
components (§5), iconography rules (§6), anti-AI rules (§7.1), the adoption gate (§7.2),
contrast law (§1.4), spacing (§1.5), type scale (§3.4), DoD (§9), performance budget (§8).

---

_This brief governs the dashboard. The marketing site's own brand kernel — the ad-creative
palette, copy bank and hard rules — is `claude/2026-09-02-claude-design-ad-handoff.md`, and
the shipped `website/assets/styles.css` is the authoritative token file for anything
public-facing. Where this brief and the shipped stylesheet disagree, **the stylesheet wins**
and this file is the bug. Do not build website sections from any deprecated file._
