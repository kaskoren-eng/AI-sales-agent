# Dashboard handoff — D2 Phase A (cream/glass migration)

**Workstream:** Dashboard · **Branch:** `feature/dashboard-d2-cream` (off `feature/dashboard-d1-i18n`) · **Pushed.**
**Spec:** `docs/sprint-d2-cream-migration-and-overview-spec.md` · **Governing:** brand brief v4 §1.

Executed autonomously while Koren was away. **Phase A (palette migration) is done and verified. Phase B
(Overview redesign) was deliberately NOT started** — it needs the v5 Overview mockup (referenced in the spec
but not in the repo) and design steering. There is also one real contrast blocker (below) that is an
architect/brand decision, not something I should resolve by guessing.

## What shipped (4 commits)

| Commit | Step | Summary |
|---|---|---|
| `7f21193` | A1 | Token swap → cream/glass in index.css (from brief v4 §1) + `.glass`/`.glass-solid` utilities; Card glass-by-default (+`variant="solid"`), Button teal primary, Badge new semantic tints. Legacy names kept as one-commit aliases. |
| `25477dc` | A2 | Legacy-hex sweep: every inline `rgba(0,245,255,α)`→teal, `rgba(99,102,241,α)`→violet-v4 (alpha preserved) across the color-heavy screens (CallDetail/LeadDetail/VoiceChat/nav/switcher/presence chip). KerenStatusChip popover `left`→`insetInlineStart`. |
| `eb88368` | A-cleanup | Renamed all 58 `var(--old)` refs to v4 names across 19 files; removed the alias block. Modal/Toast → `--glass-bg-solid` + soft warm shadow. |

Prereq note: this branch also carries a small D1 self-review fix (`2c75f2b`, on the D1 branch) — Toast swipe
direction now follows reading direction; lead email/phone wrapped in `<Bidi>` (also fixed the phone `+` RTL
placement). The `/code-review` had skipped the dashboard/i18n diff, so I reviewed it; the Modal-footer
"finding" was a verified false positive (`flex-end` already mirrors under `dir=rtl` — measured).

## Verified

- **Renders cream/glass, coherent, in both directions:** `/leads`, `/calls/:id`, `/` (Overview, pre-B),
  `/styleguide` (all primitives × LTR+RTL — the regression net; teal recharts smoke line renders).
- `npx tsc --noEmit` clean; **prod build passes**; zero retired-theme hex remain in `dashboard/src` (only
  legit third-party brand colors left: WhatsApp `#25D366`, Google `#4285F4/#34A853`, Meta `#F62B54`).
- Sidebar/canvas/chips all compute to the cream tokens (`--bg-inset` = `#E8E1D4`, etc.).

## 🔴 Contrast blocker — needs a brand decision (spec acceptance #2 cannot be met without it)

Measured WCAG ratios against cream `#F4EFE6` (page) — the v4 accent teal fails as an interactive color:

| Pair | Ratio | Needs | Verdict |
|---|---|---|---|
| body `#262524` / cream | 13.36 | 7 (AAA) | ✅ |
| secondary `#6B6A66` / cream | 4.73 | 4.5 (AA) | ✅ |
| **white / teal `#0FA3AC`** (every primary button) | **3.06** | 4.5 | ❌ |
| **teal `#0FA3AC` as text / cream** ("View" links, active nav, presence chip) | **2.67** | 4.5 | ❌ |
| muted `#8B8880` / cream (captions) | 3.09 | 4.5 | ⚠️ small-text fail |
| violet `#5B5BD6` / cream | 4.69 | 4.5 | ✅ |

The brief's §6 requires AA on controls, but its own `--accent-teal #0FA3AC` + `--text-on-teal #FFFFFF` only
reach 3.06 on the primary button, and teal-as-text is 2.67. I did **not** fix this because every option
changes the authored brand contract:
- **(a)** darken `--accent-teal` to ~`#0A7B82` (interactive) — white-on-it clears 4.5, but changes the brand hue;
- **(b)** keep teal bg, put **charcoal** text on primary buttons — contradicts `--text-on-teal #FFFFFF`;
- **(c)** split into `--accent-teal` (decorative) + a darker `--accent-teal-text` (interactive/text only).

**My recommendation: (c)** — keep the bright teal for fills/dots/chart series, add a darker teal token used
only for text-on-cream and as the primary-button fill. Also nudge `--text-muted` to ~`#736F66` (→ ~4.6) so
captions clear AA. All three are one-line token edits in index.css once the direction is chosen.

## Not done (out of this autonomous slice)

- **Phase B (Overview redesign)** — needs the v5 mockup + your eye. Recharts is proven (styleguide smoke).
- **v4 brief is uncommitted** in the working tree (architect's authored rewrite of `keren-brand-brief-v3.md`).
  I read tokens from it but did **not** stage/commit it (not my authored work). It should be committed by its
  author so this branch has a stable governing reference.
- **D1 is not merged to master** (D2's stated prereq). This branch stacks on D1; merge order = D1 → D2.

## Questions for architect

1. **Teal contrast (above)** — pick (a)/(b)/(c). Blocks spec acceptance #2. I recommend (c).
2. Commit the v4 brief (`brand_assets/keren-brand-brief-v3.md` working-tree changes) so D2 has a committed reference?
3. Is the pre-B Overview acceptable on cream until Phase B lands, or should Phase B be prioritized next?
