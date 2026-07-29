# Downstream Document Edits — brand direction reconciliation (brief v5)

> **Author:** architect session · **Date:** 2026-07-29 (updated same day: v4→v5, see F2)
> **Implements:** handoff §7.1 · derived from `keren-brand-brief-v4-patch.md` §L, merged
> into `brand_assets/keren-brand-brief-v5.md`
> **Apply in:** DASHBOARD Claude Code session, **one commit/PR, before either page-work prompt is sent.**
> `CLAUDE.md` is a shared file — pull/rebase first, edit only the Brand section, announce in the commit message.

Three documents currently contradict the agreed direction (cool technical palette, full
light/dark toggle, English-primary interface). Each edit below is paste-ready: the **FIND**
block is the exact current text, the **REPLACE** block is the new text. Nothing outside the
named sections changes.

**Sequencing (why one commit):** the merged brief already exists on disk as
`brand_assets/keren-brand-brief-v5.md` (the architect session applied the patch to v3 —
**v5, not v4**: v3's internal header labels the *cream* revision "Version 4.0", so "v4" was
already taken by the dead palette; see flag F2, now resolved). The same commit must `git add`
the v5 brief and `git rm brand_assets/keren-brand-brief-v3.md` (history preserved). If the
docs move and the brief doesn't — or vice versa — the DASHBOARD session reads a contradiction,
which is exactly what this pass exists to prevent.

---

## 1. `docs/dashboard-product-spec.md` (v1.0, Hebrew)

Bump the header line to: `**גרסה:** 1.1 · **תאריך:** יולי 2026 · **בעלים:** קורן, ClickScales`

### 1a. §3 — principle 3 (interface language)

**FIND:**

```
3. **דו־לשוני מלא.** ממשק עברי מימין לשמאל, אנגלי משמאל לימין, מתחלף בלחיצה.
```

**REPLACE:**

```
3. **דו־לשוני מלא, אנגלית תחילה.** ברירת המחדל של הממשק היא אנגלית (משמאל לימין); עברית
   (מימין לשמאל) זמינה במתג ונשמרת למשתמש. עברית היא שפה שנייה מלאה, לא נדחית — אף מסך
   אינו גמור לפני שנבדק בעברית. ⚠️ זה חל על ממשק הדאשבורד בלבד: **קרן מדברת עברית תחילה
   בשיחות.** שתי הגדרות נפרדות שלעולם לא מתמזגות (brand brief v5 §0.1).
```

*Why:* decision A4 in the v4 patch. The firewall sentence is inside the product spec on
purpose — this is the document a future contributor is most likely to read alone.

### 1b. §3 — principle 4 (premium restraint)

⚠️ **Deviation from patch §L, flagged:** §L marks principle 4 "no change", but its current
text literally names cream and glass ("רקע שמנת, משטחי זכוכית"). The *principle* survives;
the two dead words don't. Minimal scoped fix:

**FIND:**

```
4. **פרימיום עסקי.** רקע שמנת, משטחי זכוכית, צבע במינון קטן. לא גיימינג, לא צעקני.
```

**REPLACE:**

```
4. **פרימיום עסקי.** פלטה טכנית קרירה, משטחים שטוחים עם קווי מתאר עדינים, צבע במינון
   קטן. בלי גרדיאנטים, בלי זוהר. לא גיימינג, לא צעקני.
```

### 1c. §7 — design summary (wholesale replacement)

**FIND (entire section body):**

```
רקע שמנת חם, כרטיסי זכוכית מטושטשת, טקסט בפחם חם. טורקיז לפעולות ולסטטוס חי,
סגול לנתונים בגרפים. פונט Heebo לעברית, Assistant/Montserrat לאנגלית.
ללא מצב כהה בגרסה הראשונה.

הפירוט המלא: `brand_assets/keren-brand-brief-v3.md`
```

**REPLACE:**

```
פלטה טכנית קרירה, שנגזרה מדף הנחיתה של ClickScales: רקע `#EDF0F6`, כרטיסים לבנים שטוחים
עם מסגרת, טקסט כחול־דיו `#0C1226`, אינדיגו `#2F35C7` לפעולות, לקישורים ולפוקוס, וענבר
`#D9861B` לגרפים ולנקודות סטטוס בלבד — לעולם לא כצבע טקסט על רקע בהיר (נכשל בנגישות).
האופי הטכני מגיע מטיפוגרפיית מונוספייס שעושה עבודה מבנית — לא מזוהר ולא מגרדיאנטים,
ואין אף גרדיאנט במערכת.

טיפוגרפיה: Bricolage Grotesque / Instrument Sans / JetBrains Mono מובילים, עם Rubik /
Assistant כגיבוי עברי בתוך אותו font stack — הדפדפן בוחר גופן לפי תו. מונוספייס נושא
נתונים בלבד (מספרים, זמנים, מזהים) ולעולם לא טקסט עברי.

מצב כהה: מתג מלא — בהיר / כהה / לפי המערכת, לכל המערכת. מסך "בדיקת קרן" נפתח כהה
כברירת מחדל בלי קשר להעדפה.

הפירוט המלא: `brand_assets/keren-brand-brief-v5.md`
```

### 1d. §8 — out-of-scope list (dark mode leaves it)

**FIND:**

```
מצב כהה · אפליקציית מובייל · הרשאות משתמשים מרובות · דוחות מותאמים אישית ·
בונה תהליכים ויזואלי · מסך חיובים · ממשק חיבורים (החיבורים עצמם עדיין לא מוכנים בצד השרת).
```

**REPLACE:**

```
אפליקציית מובייל · הרשאות משתמשים מרובות · דוחות מותאמים אישית ·
בונה תהליכים ויזואלי · מסך חיובים · ממשק חיבורים (החיבורים עצמם עדיין לא מוכנים בצד השרת).

**מצב כהה יצא מהרשימה** — הוא נבנה, כמתג מלא (§7). כדי שזה לא יכפיל את העבודה, הסדר
מחייב: תשתית הטוקנים והמתג נבנית פעם אחת לפני המסכים; כל מסך נבנה מול טוקנים בלבד
ונבדק בבהיר; מעבר אימות כהה אחד רץ על הכול בסוף (brand brief v5 §2.3). אם המעבר הכהה
יקר — הסיבה היא תמיד קומפוננטה שקידדה צבע במקום טוקן.
```

### 1e. §9 — build order (D2 scope)

**FIND:**

```
| **D2** | **מעבר לשמנת + מסך הבית** | **בביצוע** |
```

**REPLACE:**

```
| **D2** | **מעבר לפלטה הטכנית: טוקנים v4 + מתג ערכות נושא + מסך הבית** | **בביצוע** |
```

And add directly under the table:

```
**הערה על D2:** מתג ערכות הנושא הוא עבודה חדשה שלא הייתה בהיקף המקורי. ההמלצה: הוא נכנס
ל־Phase A של D2 — החלפת הטוקנים קורית שם ממילא, וזה הרגע הזול היחיד להניח גם את המתג.
בכל מקרה הוא חייב לנחות **לפני** שנבנים מסכים נוספים, אחרת מסכים יקדדו צבעים והמסלול
הזול נסגר. ההחלטה הסופית על המיקום — אצל קורן (החלטה פתוחה §5.7 ב־handoff).
```

*Why the recommendation:* D2 Phase A is already a token swap touching every screen. Doing
the swap to the *old-name* cream tokens and then re-swapping to v4 later means paying the
same sweep twice. One decision for Koren: confirm or veto D2 placement.

---

## 2. `docs/phase-5-dashboard-frontend-spec.md`

The spec is architect-owned and not yet committed, so a **fully updated v1.1 file
accompanies this note** — save it to `docs/phase-5-dashboard-frontend-spec.md` as-is.
For review, the changes are:

### 2a. §0 — governing rule

"cream-and-glass direction" → the skin is now the **cool technical** system from
`brand_assets/keren-brand-brief-v5.md`: flat cool palette, one restrained indigo accent,
monospace doing structural work, zero gradients, light + dark as first-class themes.
The structure-from-references / skin-from-brief split is unchanged — that split is why
the palette could change without invalidating a single reference.

### 2b. §1 — source-of-truth pointer

Item 3: `keren-brand-brief-v3.md` → `keren-brand-brief-v5.md`, scope now includes theming.

### 2c. §5 — HE/EN order flips; RTL rules stand

English is the i18n source language; strings are authored in English and `he.json` is a
real translation with full coverage. All RTL mechanics (logical properties, `dir="auto"`,
icon mirroring, LTR-wrapped numbers) are unchanged and still binding — they matter *more*
now, because Hebrew lead content inside an English interface is the default case, and the
guarded failure mode is "English primary quietly becomes Hebrew broken." No page is done
until reviewed in Hebrew.

### 2d. §6 — definition of done gains the theme gates

Build phase: pages are built against tokens and reviewed in **light only** — two
screenshots (EN, HE) per page, as today. Final gate: after the one dark pass, the DoD
becomes **four screenshots — EN-light, EN-dark, HE-light, HE-dark**. Plus a new DoD item:
no component reads a colour any way other than `var(--token)`.

### 2e. §4.8.3 — dark-mode contradiction fix (beyond the §7.1 list, flagged)

The section said "No dark mode toggle — out of scope per product spec §8", which §7.1
didn't name but now directly contradicts the direction. Fixed to: theme preference
(light / dark / system) lives in Account profile next to interface language (brief v5 §2.1).
Also fixed: §4.3's "survives the cream palette" wording.

---

## 3. `CLAUDE.md` — Brand section

Shared file: pull/rebase first, replace **only** the `## Brand — KEREN by ClickScales`
section, announce in the commit message. Must land in the same commit as the v4 brief
rename, because the pointer changes.

**REPLACE the entire Brand section with:**

```markdown
## Brand — KEREN by ClickScales

- **Company:** ClickScales · **Product:** KEREN (the agent persona is "קרן", female)
- **Two language settings, never collapsed into one:**
  - **Agent spoken language (VOICE-owned): Hebrew first.** Keren speaks Hebrew to leads by
    default, English on switch. This is the product — the entire Retell→LiveKit migration
    exists because Retell's human-sounding features are unavailable in Hebrew. Nothing in
    the dashboard changes this.
  - **Dashboard interface language (DASHBOARD-owned): English default**, Hebrew available
    via toggle. `<html lang="en" dir="ltr">`, English is the i18n source, `he.json` is the
    translation. Never derive one setting from the other. If a `tenants.settings` key is
    ever needed for interface language it is `ui_locale` — never `language` — and it must
    be claimed in this file's key-claims list before use.
- **"Danie" is deprecated.** `brand_assets/brand_identity` (v2) and brief v3 are superseded
  by `brand_assets/keren-brand-brief-v5.md` — the single source of truth for all dashboard
  design work (tokens, typography, light/dark theming, i18n/RTL rules, component DoD).
  v3 stays in git history; v5 §12 defines exactly what changed and why the number skips
  ("v4" internally meant the dead cream palette — never reuse it).
- Palette is the **cool technical** system derived from the ClickScales landing page —
  flat cool surfaces, indigo accent, mono for data, zero gradients, full light/dark toggle
  (`data-theme` on `<html>`). The cream/glass direction is dead; do not reintroduce it.
- Dashboard is **bilingual (HE+EN) from day one**: react-i18next, all UI strings via
  `t('...')`, CSS logical properties only, `dir="auto"` on all user content. English
  primary must not become Hebrew broken — no page is done until reviewed in Hebrew.
  See brief v5 §4.
```

*Why the firewall lives here too:* `CLAUDE.md` is #2 in the source-of-truth order and the
one file both Claude Code sessions always read. A VOICE session must never infer an agent
language default from the dashboard's UI default — this is where that inference gets cut.

---

## 4. Flags — found while writing these edits

**F1 — `docs/sprint-d2-cream-migration-and-overview-spec.md` is the fourth contradicting
document, and the most dangerous one.** The handoff §7.1 names three docs; this one is the
spec D2 is *actively being built from*, and it is cream end-to-end ("Retire the midnight/
cyan theme, adopt cream + glass", `#F4EFE6`, `.glass` utilities, teal/violet accents,
"screens render cream/glass" acceptance). If it isn't reconciled in the same pass, the
DASHBOARD session migrates every screen to cream while every other document says cream is
dead — the exact conflict this pass exists to prevent. Minimum fix in the same commit: a
supersession banner at the top of the file, and Phase A retargeted at the v5 brief §1.1/§1.2
tokens + §2 theme mechanism instead of the cream tokens and glass utilities (Phase B's
structure — top bar, KPI row, pipeline, chart, feed — survives untouched; it never named
colours it can keep). I have not rewritten this spec — it changes an in-flight sprint's
instructions, which is Koren's call. Say the word and the reworked D2 spec is the next
deliverable.

**F2 — "v4" naming collision. RESOLVED (2026-07-29).** Confirmed: v3's internal header
reads "Version: 4.0 — cream + glass palette", so "v4" already meant cream inside the repo
(the D2 spec's "v4 tokens" = cream). The merged brief is therefore **v5**
(`brand_assets/keren-brand-brief-v5.md`, already on disk), and every pointer in this
document says v5. Standing rule: never reuse "v4" for the cool technical direction — in
this repo "v4" is the dead cream revision, full stop.

**F3 — standing reminder, raised twice before:** `_env` / `_agent-secrets.env` with live
keys (one marked "ROTATE, exposed in chat") are still in project knowledge. Strip to
`.env.example` and rotate.

---

## 5. What "done" looks like

One commit on the dashboard branch containing: the v5 brief (`git add
brand_assets/keren-brand-brief-v5.md`, `git rm brand_assets/keren-brand-brief-v3.md`,
`git rm brand_assets/brand_identity` — both superseded files leave the working tree, history
keeps them; this also closes the "add a deprecation header to brand_identity" checklist item,
deletion being stronger than deprecation), product-spec edits 1a–1e, frontend spec v1.1, the
new `CLAUDE.md` Brand section, and the F1 supersession fix once Koren approves it. After that commit, no repo document contradicts
the agreed direction, and the two page-work prompts can be sent as-is.
