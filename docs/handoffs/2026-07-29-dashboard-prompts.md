# Two paste-ready prompts for the DASHBOARD Claude Code session

> **Author:** architect session · 2026-07-29
> Send **Prompt 1 first** and let it finish (one commit). Only then send Prompt 2.
> Shortcut: instead of pasting, you can tell the session:
> *"Read docs/handoffs/2026-07-29-dashboard-prompts.md and execute Prompt 1."*

---

## PROMPT 1 — Update everything to the v5 direction (reconciliation)

```
You are the DASHBOARD workstream. This is a documentation-reconciliation task — do NOT
touch any app code in this task.

Read, in this order, before doing anything:
1. docs/handoffs/2026-07-29-architect-doc-edits.md   — the edit instructions; this is your task list
2. brand_assets/keren-brand-brief-v5.md              — the new single source of truth.
   Note: v3 and anything calling itself "v4 / cream / glass" is DEAD. In this repo "v4"
   means the dead cream palette — never reuse that label.
3. docs/phase-5-dashboard-frontend-spec.md           — already updated to v1.1; verify it
   exists, do not edit it
4. CLAUDE.md — territory rules; the shared-file rules apply to CLAUDE.md itself

Then, on a fresh branch feature/dashboard-v5-reconciliation, in ONE commit:

A. Apply edits 1a–1f from the edits doc to docs/dashboard-product-spec.md (1f is the
   repositioning edit: the product is a voice-agent PLATFORM, not "KEREN"). They are exact
   FIND/REPLACE blocks — the Hebrew FIND text must match character for character. If a FIND
   block does not match, STOP and report; do not improvise.

B. Replace the entire "## Brand — KEREN by ClickScales" section of CLAUDE.md with the block
   given in the edits doc §3. CLAUDE.md is a shared file: git fetch and diff the voice
   branch first, change only that section, and announce the change explicitly in the
   commit message.

C. git rm brand_assets/keren-brand-brief-v3.md
   git rm brand_assets/brand_identity
   (both superseded; git history keeps them)
   git add brand_assets/keren-brand-brief-v5.md docs/phase-5-dashboard-frontend-spec.md
   docs/handoffs/2026-07-29-architect-doc-edits.md (all already on disk)

D. Rework docs/sprint-d2-cream-migration-and-overview-spec.md (flag F1 — approved by Koren).
   GATE: propose the full new text of this spec as a plan FIRST and wait for approval
   before writing it to disk. The rework:
   - Banner at top: cream/glass is superseded by brief v5; every "v4 tokens" reference in
     this file meant the dead cream palette.
   - Phase A becomes "v5 token migration + theme foundation": replace the cream token
     targets with the v5 §1.1 (light) and §1.2 (dark) blocks verbatim; DELETE the .glass
     utilities (glass is retired — flat cards, 1px borders, §1.3 shadows); the legacy-hex
     sweep now also targets the cream/glass/teal/violet values (#F4EFE6, #0FA3AC, #5B5BD6,
     --glass-*, etc.); ADD the §2 theme layer as a Phase A step: data-theme on <html>,
     three-state preference (light/dark/system), the blocking inline script in <head>,
     color-scheme, <meta name="theme-color">, dual logo assets.
   - Phase B structure (top bar → KPI row → pipeline strip → chart + live feed) is
     UNCHANGED. Retarget only its colour and font references: accent = indigo --accent,
     chart series = --data-1/--data-2 (teal/violet are dead), type = the §3 stacks
     (Bricolage/Instrument/JetBrains + Rubik/Assistant fallbacks; remove Heebo/Montserrat).
   - Update the acceptance criteria to match: zero cream/glass/legacy hex, both themes
     render via the toggle, charts read colours from computed CSS variables and re-read on
     theme change, review light-first with one dark pass at the end per v5 §2.3.

E. Additive handoff fix: add a "screenshot:dash" script to package.json that runs the
   screenshot script with PORT=3002. package.json is a collision-zone file — additive
   only, never modify the existing "screenshot" script, pull/rebase before editing, and
   announce the change in the commit message.

Done means: no document in the repo contradicts brand brief v5. Verify with
git grep -l -e "keren-brand-brief-v3" -e "F4EFE6" -e "0FA3AC" -e "5B5BD6" -- "*.md"
— every remaining hit must be a historical/changelog mention that explicitly says
dead/superseded. Write a handoff note to docs/handoffs/ when finished. Do not start any
page or preview work in this task.
```

---

## PROMPT 2 — Page-by-page design previews, starting with Overview

```
You are the DASHBOARD workstream. Prerequisite: the v5 reconciliation commit
(feature/dashboard-v5-reconciliation) is done. If it is not, stop and say so.

Task: DESIGN PREVIEWS of the ClickScales voice-agent-platform dashboard in the v5 brand
system, built page by page WITH Koren — he reviews and approves each page before the next
one starts.

Positioning (brief v5.1 §0 — read it): the product is a PLATFORM; it is not named "KEREN".
Platform branding in the shell (sidebar/top-bar logo) is ClickScales. Every tenant names
their own agent; "Keren / קרן" is only the sample persona.

What a preview is: one self-contained static HTML file per dashboard page. No React, no
build step — it opens directly in a browser. Previews live in
dashboard/design-previews/<page>.html and are not imported by the app. An approved preview
becomes the visual contract: the production page must match it.

Read before building anything:
1. brand_assets/keren-brand-brief-v5.md — tokens §1, theming §2, typography §3, i18n §4,
   what-not-to-build §7. This is law; where anything disagrees with it, the brief wins.
2. docs/phase-5-dashboard-frontend-spec.md — structure and reference mapping per page.
3. docs/dashboard-product-spec.md — product intent, the five KPIs, the eight lead statuses.
4. docs/sprint-d2-cream-migration-and-overview-spec.md (v5 rework) — Phase B has Overview's
   exact section order: top bar → KPI row → pipeline strip → chart + live feed.

Working mode — strictly one page at a time:
- First page: Overview (/).
- BEFORE building a page: propose a ~10-line outline (sections top to bottom, what data
  each shows, which reference pattern it takes) and WAIT for Koren's ok.
- AFTER building: give Koren the file path to open, plus 4 screenshots — EN-light,
  EN-dark, HE-light, HE-dark. Then STOP and wait for feedback. Iterate on the same page
  until Koren says approved. Never start the next page before approval.
- Suggested order after Overview (Koren may reorder): Calls (with the detail drawer) →
  Leads → The agent → Test Keren (/simulator — opens dark by default, v5 §2.4) →
  Meetings → Ask Keren → Settings shell.

Hard constraints for every preview:
- v5 tokens verbatim as CSS variables (§1.1 light + §1.2 dark). Zero raw hex outside the
  token block. Zero gradients, zero glows, zero glass/backdrop-blur.
- The five-family Google Fonts link from §3. Mono carries LTR data only — never Hebrew,
  never body copy (§3.3). tabular-nums where mono carries columns.
- NO HARDCODED AGENT NAME anywhere. Each preview defines one constant at the top —
  const AGENT = { nameHe: 'קרן', nameEn: 'Keren', gender: 'f' } — and every mention of the
  agent (nav labels "שיחה עם …" / "בדיקת …", presence chip, KPI copy, feed lines, sample
  sentences) renders from it. Hebrew strings that carry gender have both variants and pick
  by AGENT.gender ("קרן סיימה" / "דניאל סיים").
- A small fixed preview-control strip (visually separate from the design, e.g. bottom
  corner) with THREE working toggles: theme (light/dark via data-theme on <html>),
  language (EN-LTR / HE-RTL — swaps lang, dir and every string), and sample persona
  (קרן/Keren/f ↔ דניאל/Daniel/m). The persona toggle exists to PROVE nothing is hardcoded
  and the gender grammar works — Koren will flip it on every review.
- English default; complete Hebrew strings for everything, written in natural,
  native-quality Hebrew. CSS logical properties only. dir="auto" on all lead content
  (names, transcripts, notes).
- Sample data: realistic Israeli-SMB content — Hebrew lead names, plausible counts and
  times. Anti-AI copy rules (§7.1): no em-dashes in UI copy, no "successfully"/"בהצלחה",
  no exclamation marks, varied card sub-lines, exactly ONE animated element per screen
  (the presence dot owns it on Overview) with a prefers-reduced-motion fallback.
- Never invent a metric that has no data source: the sixth KPI slot on Overview renders as
  a designed empty state (frontend spec §4.1). No emotion tags in the simulator preview —
  the pipeline capability is unverified. Status chips use the §1.4.1 PROPOSED colours and
  the file carries a comment noting they await sign-off.
- Amber --data-2 is never a text colour on a light surface (§1.4) — dots, borders, chart
  fills only.

Track progress in dashboard/design-previews/STATUS.md: page · state
(outline / built / iterating / approved) · open questions. Product-behaviour or
cross-workstream questions go to the architect via docs/handoffs/, not guessed.
```
