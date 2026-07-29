# Sprint D2 Spec — v5 Token Migration + Theme Foundation + Overview Redesign

> ⚠️ **SUPERSEDED DIRECTION — READ THIS FIRST.** This spec was first written for the
> **cream/glass** palette. That palette is **dead** (brand brief v5 §12). Everywhere the git
> history of this file said "v4 tokens", cream `#F4EFE6`, the glass material, teal `#0FA3AC` or
> violet `#5B5BD6`, it meant that dead palette. The spec below is retargeted to
> **`brand_assets/keren-brand-brief-v5.md`** (cool technical: flat surfaces + borders, one indigo
> accent, monospace for data, zero gradients, full light/dark theming). The file keeps its
> `cream` name only so existing links don't break; the content is v5.

> **Owner:** Koren · **Implement in:** Claude Code (dashboard workstream, branch `feature/dashboard-d2-v5`)
> **Governing doc:** `brand_assets/keren-brand-brief-v5.md` — read §0.1 (language firewall),
> §1.1/§1.2 (light + dark tokens), §1.3 (elevation), §1.4 (contrast law), §2 (theming), §3
> (typography), §4 (i18n/RTL, English-primary), §7.1 (anti-AI copy), §7.2 (external components), §9 (DoD).
> **Prerequisite:** D1 (i18n + primitives) merged.

---

## 0. Two phases, in this order

**Phase A — v5 token migration + theme foundation (all existing screens).** Retire the cream/glass
palette (which itself replaced midnight/cyan); adopt the v5 cool-technical tokens **and** stand up
the light/dark theme layer. Layouts stay put; colour, material, radius, type and the theme
mechanism change.

**Phase B — Overview redesign.** Rebuild `/` as the flagship screen on the v5 palette.

Do not start B before A is green. Per v5 §2.3, build against tokens and review **light-first**; the
single dark verification pass runs at the end, not per screen.

---

## PHASE A — v5 token migration + theme foundation

### A1. Token swap in `dashboard/src/index.css`

Replace the `:root` block with the v5 §1.1 **light** tokens verbatim, and ADD the
`[data-theme="dark"]` block from §1.2 verbatim:

```css
:root {
  --surface-page:      #EDF0F6;
  --surface-card:      #FFFFFF;
  --surface-sunken:    #E4E9F1;
  --surface-overlay:   #FFFFFF;
  --text-primary:      #0C1226;
  --text-secondary:    #5B667E;
  --text-tertiary:     #7A8598;
  --text-on-accent:    #FFFFFF;
  --border-default:    #D9E0EA;
  --border-strong:     #C3CDDB;
  --accent:            #2F35C7;
  --accent-hover:      #252AB3;
  --accent-tint:       #EAEAFB;
  --data-1:            #2F35C7;
  --data-2:            #D9861B;
  --data-2-glow:       #F2B24E;
  --data-2-tint:       #FCF0DC;
  --r-sm:  8px;  --r: 14px;  --r-lg: 22px;  --r-full: 999px;
  --container-max: 1180px;
}
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
  --accent:            #2F35C7;
  --accent-text:       #8B90F0;
  --accent-hover:      #3A41D8;
  --accent-tint:       #1B2145;
  --data-1:            #6E74E8;
  --data-2:            #F2B24E;
  --data-2-glow:       #F8CC85;
  --data-2-tint:       #2A2113;
}
```

The light theme has no `--accent-text` (accent doubles as text there); on dark they must separate.
Focus ring: `--accent`, 2px, offset 2px. Radii change with the block (sm 8 / base 14 / lg 22 /
full); the old md-10/xl-20 steps are gone.

**On the previous migration:** an earlier D2 attempt already introduced cream tokens
(`--bg-page #F4EFE6`, `--glass-*`, `--accent-teal`, `--accent-violet`). Those are now themselves
migration targets — the A2 sweep removes them. **Keep no cream token as an alias.**

### A2. Component sweep — flat, not glass

**Glass is retired.** DELETE the `.glass` / `.glass-solid` utilities entirely. Cards are flat:
`--surface-card` fill, 1px `--border-default`, radius `--r` (14px), depth from §1.3's two shadows
(`--shadow-card`) — never `backdrop-filter`. Nothing blurs anywhere; the old "no blur inside scroll
containers" budget is gone with it.

- **Card:** flat `--surface-card` by default (no blur variant). Use `--surface-overlay` +
  `--shadow-overlay` for modals/popovers.
- **Button:** primary = solid `--accent` + `--text-on-accent`, hover `--accent-hover`; secondary =
  `--surface-card` + 1px `--border-default`; ghost = transparent. Zero gradients (§7).
- **Badge:** retire the cream-era semantic set; use the v5 §1.4.1 status colours (`--status-success`
  #1B7F5A, `--status-warning` #9A5D0F text with `--data-2` dot, `--status-danger` #C0392B,
  `--status-neutral`). ⚠️ These are **PROPOSED — sign-off required** (§1.4.1). Mapping the eight lead
  statuses onto four + tints is a **separate decision**; do not improvise it in component code.

**Legacy-hex sweep — now targets BOTH dead palettes:**
- midnight/cyan (first migration): `#0B132B #1C2541 #1F2A4A #060A1A #00F5FF #00B8C2 #6366F1
  #F0F4FF #A0AEC0 #6B7280`, `rgba(0,245,255,…)`.
- cream/glass (second, now-dead migration): `#F4EFE6 #EFE9DE #E8E1D4 #FBF9F5`, teal `#0FA3AC`,
  violet `#5B5BD6`, any `--glass-*`, `--accent-teal*`, `--accent-violet*`, `--bg-page*`,
  `--text-on-teal`, cream `rgba(...)` tints.

**Acceptance: zero hardcoded hex AND zero dead token names in `dashboard/src/`.** Every colour is a
v5 `var(--token)`. No `.glass` utility exists.

Special attention (same screens, new palette): `VoiceChat.tsx` (audio-level rings → `--accent` /
`--data-2`; the orb must read on the **dark** simulator field, §2.4), `CallDetail.tsx` (transcript
bubbles + verdict chips), `LeadDetail.tsx` (timeline dots, channel icons), `Overview.tsx` (rebuilt
in Phase B anyway).

### A3. Theme layer (NEW — the largest addition; brief v5 §2)

Stand up the full light/dark mechanism **before any page work**, so no page hardcodes a colour:

- `data-theme` on `<html>`, resolved to `light|dark`. User preference is **three-state**:
  `light | dark | system`; `system` resolves `prefers-color-scheme` at load and reacts live.
  Preference lives in Account profile, next to interface language.
- **Blocking inline script in `index.html` `<head>`**, before any paint, reads the stored
  preference and sets `data-theme` — NOT a React effect (an effect runs after first paint = flash
  of the wrong theme). (§2.2 item 1)
- `color-scheme: light dark` in CSS + the matching value per theme (native scrollbars, form
  controls, autofill). (§2.2 item 2)
- `<meta name="theme-color">` updated with the theme. (§2.2 item 3)
- **Dual logo assets:** light-on-transparent twins for any dark-on-transparent mark
  (`brand_assets/**` is dashboard territory — produce both). (§2.2 item 5, §10)
- `/simulator` (Test Keren) opens **dark by default** regardless of preference (§2.4).

### A4. Type stacks + contrast (light-first)

**Fonts (§3):** remove the Heebo/Montserrat imports; add the five-family Google Fonts link from §3;
declare `--font-display` (Bricolage Grotesque / Rubik), `--font-body` (Instrument Sans / Assistant),
`--font-mono` (JetBrains Mono / Assistant safety-net) as tokens — no component names a typeface.
Run the §3.2 **optical-calibration test** and commit the resulting `font-size-adjust` values + the
required screenshot (heading, body, button, one mixed `Hebrew + Latin + 12 + 09:41` line, three
sizes, both directions). **Do not ship the stacks uncalibrated.** Mono carries data only — never
Hebrew (§3.1/§3.3).

**Contrast — the MEASURED v5 §1.4 law, not blanket AAA:** primary text AAA by construction (~16:1);
`--text-secondary` AA-only with **no shrink margin** (re-check at the smallest size actually used);
`--text-tertiary` large-text/UI only, never body; **`--data-2` (#D9861B) is NEVER a text colour on
a light surface** (chart fills, dots, borders, strokes only); controls AA (4.5:1).

Verify with `npm run screenshot:dash` (the new :3002 script), reviewing each route in **light only**
at this stage — two screenshots per page (EN + HE), per v5 §2.3 step 2. No per-screen dark check.

### A5. The one dark pass (end of Phase A, v5 §2.3 step 3)

After every page is migrated against tokens in light, flip the toggle **once** and screenshot
everything in dark. Because no component names a colour, this is **verification, not a rebuild**:
what breaks is the six items in §2.2 — chart colours (read as props, don't inherit), theme flash,
`color-scheme`, `theme-color`, logo twins, shadows-do-nothing-on-dark. **Fix the component, never
the theme.** If this pass is expensive, a component hardcoded a colour.

---

## PHASE B — Overview redesign

Structure **unchanged**: top bar → KPI row → pipeline strip → chart + live feed. Only colour, type
and theme references are retargeted to v5. Ignore any cream/teal in older mockups — dead.

### B1. Top bar (new shared component — `components/layout/TopBar.tsx`)

Sits above all pages inside `AppLayout`. Flat `--surface-card`, full width, 1px `--border-default`
bottom border (no glass).

- **Opening edge (start):** "KEREN" wordmark + "by ClickScales", then the **Keren Presence chip** —
  `--accent-tint` pill, pulsing `--accent` dot (`--accent-text` on dark), live status (brief v5 §5.1).
  The ONE animated element on the screen.
- **Closing edge (end):** language switcher (`EN | עב` segmented — **English default**, active one
  filled `--accent`), notifications bell, account menu (avatar initials, user + tenant name, chevron
  → Radix dropdown, wrapped: Profile, Settings, Sign out). **Theme preference (light/dark/system)**
  lives here or in Profile per §2.1.
- Direction automatic via flex + logical properties; **no manual `dir` checks in JSX.** English is
  the default UI language: LTR by default, RTL under Hebrew.
- Presence chip states: `idle` (gray dot — "Keren is waiting for leads" / "קרן ממתינה ללידים"),
  `calling`, `on-call` (pulsing accent), `analyzing`, `paused`. Copy per v5 §7.1 — no em-dashes, no
  "successfully"/"בהצלחה", no exclamation marks. Idle is designed, not blank.

### B2. KPI row — five cards (structure unchanged; colours retargeted)

| KPI | Value | Sub-line |
|---|---|---|
| Calls today | count | delta vs yesterday, e.g. "5+ מאתמול" |
| Meetings booked | count (`--accent`-accented card) | "מתוך N שיחות שנענו" |
| Follow-ups performed | count | channel breakdown, e.g. "6 וואטסאפ, 3 שיחות" |
| Answer rate | % | comparison to 7-day average |
| Time to first contact | minutes | vs target |

Flat `--surface-card` cards; only "Meetings booked" carries an `--accent` border + value (the money
metric). **Vary the sub-line content** — not five identical delta strings (§7.1). No triangle/arrow
glyphs; colour carries the signal, and colour comes from **tokens** (`--status-*`/`--accent`), never
hex. Metric values in `--font-display`; mono data (per §3.3) uses `--font-mono` + `tabular-nums`,
never Hebrew.

**Threshold logic** (constants in `dashboard/src/lib/kpi-thresholds.ts`): `answerRate` green ≥60 /
amber 40–59 / red <40; `timeToFirstContact` green ≤5 / amber 5–15 / red >15; deltas green improving
/ muted flat (±2%) / amber worsening. Threshold **colours map to `--status-*` tokens**, not hex.

### B3. Pipeline strip

One flat `--surface-card`, five stages with dividers: `new → contacted → qualifying → qualified →
booked` (חדשים, נוצר קשר, בתהליך, כשירים, פגישה נקבעה). Count per stage; progression accented with
data/accent tokens (the last two stages, e.g. `--data-2` then `--accent`) — **not** the dead
teal/violet. Each stage clickable → `/leads?status=<stage>`. RTL: order mirrors via grid + logical
properties.

### B4. Calls chart — `recharts` (first external adoption, brief v5 §7.2)

Stacked bar chart, last 7 days, two series: **calls (`--data-1`)** and **meetings (`--data-2`)**.

- **CRITICAL (v5 §2.2 item 4 + §7.2 token rule):** recharts takes colours as **props** and will not
  inherit `data-theme`. The `BarChart` wrapper must **read the computed CSS variables**
  (`getComputedStyle` for `--data-1/--data-2/--text-*/--border-*`) at render and **re-read on theme
  change**, or the chart stays light forever. Single most common dark-mode dashboard bug.
- Permanent count labels above each bar (`LabelList`).
- Hover: custom `<Tooltip>` → flat `--surface-overlay` panel (`--shadow-overlay`) with
  "N שיחות · M פגישות" + date. Bar highlights on hover; siblings dim.
- X axis: weekday short names in the active locale (last = "היום" / "Today").
- **RTL:** `reversed` X axis when `dir==='rtl'`; verify tooltip anchoring both directions.
- Wrap recharts in `components/ui/BarChart.tsx`; pages never import recharts. It must appear on
  `/styleguide` in **both directions and both themes** before use (§7.2).
- Empty state: `EmptyState` ("אין עדיין שיחות להצגה" / "No calls yet"), not an empty axis frame.

### B5. Live feed

Flat `--surface-card`, most recent 6 events, newest first. Row = icon (channel/event colour from
tokens) + title + muted meta line. Kinds: meeting booked, call ended, message sent, no answer +
retry scheduled, lead qualified.

- User content (lead names) through `Bidi` (`dir="auto"`) — matters **more** now: Hebrew lead
  content inside an English-default UI is the normal case (§4.2).
- Rows flat (no blur — glass is gone).
- Poll every 30s via React Query `refetchInterval`; no websockets this sprint.
- States: loading skeleton, empty, error.

### B6. Backend — Overview stats endpoint (UNCHANGED)

`GET /api/v1/stats/overview` (dashboard owns `src/modules/calls|leads`; a new `src/modules/stats/`
is fine if cleaner — announce in CLAUDE.md). Same response shape, derivation and tests as before
(incl. the empty-tenant all-zeros case). No colour/theme concerns here.

```ts
{
  today: { calls: number; meetingsBooked: number; followUps: { total: number; whatsapp: number; voice: number; email: number };
           answerRate: number; avgTimeToFirstContactMins: number | null },
  deltas: { callsVsYesterday: number; answerRateVs7day: number },
  pipeline: { new: number; contacted: number; qualifying: number; qualified: number; booked: number },
  last7Days: Array<{ date: string; calls: number; meetings: number }>,
  liveFeed: Array<{ id: string; kind: string; at: string; leadId: string | null; leadName: string | null;
                    channel: string | null; meta: Record<string, unknown> }>
}
```

---

## Acceptance criteria

1. Zero cream/glass/legacy hex and zero dead token names (`--glass-*`, `--accent-teal/violet`,
   `--bg-page`, `#F4EFE6`, `#0FA3AC`, `#5B5BD6`, midnight/cyan set) in `dashboard/src/`. Every colour
   a v5 `var(--token)`. No `.glass` utility exists.
2. Contrast per the v5 §1.4 measured law, verified on Overview, Leads, LeadDetail, CallDetail, VoiceChat.
3. Theme layer works: `data-theme` on `<html>`, three-state preference persisted, blocking inline
   script (no flash), `color-scheme` + `theme-color` set, `/simulator` defaults dark. Both themes
   render via the toggle.
4. No component reads a colour any way other than `var(--token)` (§2.3, §9 addendum).
5. Charts read colours from computed CSS variables and re-read on theme change (correct in both themes).
6. Top bar on every route; language switcher + account menu swap sides between EN and HE; English default.
7. Exactly one animated element on Overview (presence dot); stops under `prefers-reduced-motion`.
8. Chart: permanent counts, hover tooltip, RTL axis reversal, empty state.
9. Five KPI cards; thresholds from `kpi-thresholds.ts` mapped to `--status-*`; sub-lines not five copies.
10. Pipeline stages navigate to filtered `/leads`.
11. Fonts: Heebo/Montserrat removed; five-family v5 stack as `--font-*`; §3.2 calibration run and
    values + screenshot committed; mono never Hebrew.
12. All new strings EN + HE via `t()`; English authored; `he.json` full coverage; no em-dashes.
13. Review light-first (EN + HE per page); ONE dark pass at the end → final gate is four screenshots
    per page (EN-light, EN-dark, HE-light, HE-dark), only at that gate.
14. `npx tsc --noEmit` clean both projects; `npm test` green; `/styleguide` shows the chart wrapper
    in both directions and both themes.

---

## Execution order (one commit each)

1. Font-stack swap (§3): remove Heebo/Montserrat, add five-family link, declare `--font-*`; run +
   commit the §3.2 calibration values + screenshot.
2. Token swap: `:root` v5 §1.1 light + `[data-theme="dark"]` §1.2; delete `.glass`; radii update.
3. Theme layer (§2): `data-theme`, three-state preference, blocking `<head>` script, `color-scheme`,
   `theme-color`, dual logo assets, `/simulator` defaults dark.
4. Component sweep: Card flat, Button `--accent`, Badge → §1.4.1 status tokens (pending sign-off);
   dead-token + hex sweep across all pages (screenshot light EN/HE before/after each screen).
5. Contrast pass (light) + fixes per §1.4.
6. `TopBar` component + wire into `AppLayout` (moves language switcher out of the sidebar).
7. Backend `/stats/overview` + tests.
8. Overview: KPI row + `kpi-thresholds.ts`.
9. Overview: pipeline strip (with navigation).
10. `recharts` adoption: `BarChart` wrapper (computed-var colour reads + re-read on theme change) +
    styleguide entry (both dirs, both themes) + chart on Overview.
11. Overview: live feed + polling + states.
12. The one dark pass (§2.3 step 3): flip toggle, screenshot every route dark, fix §2.2 breakages.
13. Final: four-screenshot gate per route (EN/HE × light/dark), criteria walkthrough, handoff note.

---

## Kickoff prompt

```
You are the dashboard workstream. Read brand_assets/keren-brand-brief-v5.md (cool technical palette
+ full light/dark theming — cream/glass is DEAD) and
docs/sprint-d2-cream-migration-and-overview-spec.md (retargeted to v5; the filename keeps "cream"
for link stability only). Work on branch feature/dashboard-d2-v5. Execute Phase A fully before
Phase B, one commit per step. Build against tokens and review light-first (EN + HE); run the single
dark pass at the end per v5 §2.3. Never hardcode a colour — only var(--token). Verify with
npm run screenshot:dash (port 3002); never touch :3000/:3001 (CLAUDE.md rules). Write a handoff
note to docs/handoffs/ when you finish.
```
