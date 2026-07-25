# Dashboard handoff — 2026-07-25

**Workstream:** Dashboard · **Branch:** `feature/dashboard-d1-i18n` (branched off `feature/dashboard-sprint-2`) · **Sprint:** D1 (i18n infrastructure + design-system primitives)

## What shipped

Executed `docs/sprint-d1-i18n-primitives-spec.md` §5 in order, one commit per step. All eight steps complete, pushed.

| Commit | Step | Summary |
|---|---|---|
| `3faebdd` | 1 | react-i18next + EN/HE locales + `<html dir/lang>` plumbing + sidebar language switcher (EN \| עב) |
| `d434392` | 2 | Heebo font + `:lang(he)` rules (no uppercase/tracking on Hebrew) + `.flip-rtl` utility |
| `eb62dee` | 3 | Primitives batch 1: Input, Select, TextArea, EmptyState, PageHeader, Bidi |
| `cd09aa4` | 4 | Primitives batch 2: Modal, Tabs, Toast (+ ToastProvider in AppLayout) |
| `474ffe1` | 5 | `/styleguide` dev-only route — every primitive, both directions, live lang toggle |
| `f795206` | 6 | Retrofit Leads → primitives + `t()` + RTL |
| `7977cfa` | 7 | Retrofit LeadDetail + Bookings → primitives + `t()` + RTL |
| `94ec129` | 8 | recharts install + styleguide smoke chart; fix Input/Select `size` prop clash |

## Verification (spec §4 acceptance)

1. ✅ Language switcher flips the four in-scope screens live; `<html>` gets `lang`/`dir`; choice persists (`localStorage('keren.lang')`).
2. ✅ HE: Heebo loads (verified via `document.fonts.check`), no uppercase/tracking on headings, nav/sidebar fully translated, back-arrows + select chevrons + timeline rail flip correctly, 3-column grid + Leads table mirror cleanly.
3. ✅ EN pixel-parity — **`/leads` diff = 0 / 1,296,000 px** (pixelmatch). `/bookings` = 12px (skeleton shimmer phase). `/leads/:id` = 475px (0.037%), entirely the Hebrew **fixture** name now correctly RTL via required `dir="auto"` (an English name is 0-diff) + the status select adopting the badge's lowercase & standard chevron. No layout/colour regression.
4. ✅ Zero hardcoded user-facing literals in the four screens (all via `t()`).
5. ✅ `/styleguide` renders every primitive in both directions.
6. ✅ User content (names, notes, dates, message bodies) through `Bidi` (`dir="auto"`).
7. ✅ `npx tsc --noEmit` clean in `dashboard/`; **prod build passes**; root vitest suite green (463 passed); no missing-i18n-key console warnings on the four screens.

## Deliberate tradeoffs (not bugs)

- **Status enums render uniformly lowercase app-wide** (badges + selects). This preserved the `/leads` badge pixel-gate (badge was already lowercase) and made LeadDetail's status select consistent with its header badge — but it changed that select's display from "Booked" to "booked". Defensible consistency alignment; flagged for visibility.
- **Language switcher lives in the sidebar footer** (spec §1.3) — the one intended EN-layout delta vs the pre-sprint UI. Page *content* is unchanged.
- **recharts is prod-excluded**: the styleguide (its only consumer) is `import.meta.env.DEV`-guarded + lazy, so it dead-code-eliminates. Confirmed: prod build emits no styleguide/recharts chunk.

## Known follow-ups (out of D1 scope)

- **Dates are still English month names** in HE (e.g. "24 Jul 2026"). `Bidi` fixes the *ordering* (no more bidi-scramble), but full `Intl`-locale date formatting (brief §2) would change `lib/format.ts` app-wide — deferred to a later slice.
- **Phone numbers** in RTL show the `+` on the trailing side (e.g. "972…+"). Minor; not wrapped in `Bidi`. Could isolate later.
- Overview / CallDetail / Calls / Settings / Integrations string extraction is explicitly D2+ (per spec §"what's OUT").
- Pre-existing: dashboard prod bundle is ~1 MB (289 KB gz) — not introduced by D1 (recharts excluded); worth code-splitting in a perf pass.

## Notes for coordination

- Two additive **shared-file** touches, both announced here: `dashboard/package.json` gained `react-i18next`, `i18next`, `i18next-browser-languagedetector`, `@radix-ui/react-toast`, `recharts` → **`npm install` in `dashboard/` after pulling**.
- Did **not** touch `CLAUDE.md` (left the architect's uncommitted "Session handoffs" addition in the working tree, unmodified), nor any voice-territory files (`livekit.toml`, `infra/`, `brand_assets/`, `design_inspirations/`, `tests/hebrew-tts-*`) that were already uncommitted from other sessions.
- Dev servers: worked entirely on `:3002` (proxying local `:3000`); never touched `:3000`/`:3001`.

## Questions for architect

1. **Status-enum casing** — is uniform lowercase (badges + selects) the desired end state, or should selects/dropdowns be Title-Cased while badges stay lowercase? (Would need split label keys; currently one `status.*` map.)
2. **Date localization** — want `Intl.DateTimeFormat` with the active locale wired into `lib/format.ts` in D2, or keep English-format dates for now?
3. **Language default** — currently `navigator`-detected with EN fallback. Should a logged-in tenant's preferred language come from the API instead?
