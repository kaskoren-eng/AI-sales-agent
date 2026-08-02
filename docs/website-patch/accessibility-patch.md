# נגישות האתר — ממצאים ותיקונים (ת"י 5568 / WCAG 2.0 AA)

> נבדק 30.07.2026 מול `website/index.html` ו-`assets/styles.css`.
> הבסיס טוב יותר ממה שציפיתי — יש `:focus-visible`, יש `prefers-reduced-motion`,
> יש `role="status"` על הודעת ההצלחה, אין תמונות בלי alt (כי אין תמונות בכלל).
> להלן הפערים האמיתיים, לפי סדר חומרה.

---

## 🔴 1. טבעת הפוקוס נעלמת בשדות הטופס

**הממצא:** `styles.css:294` — `.f input:focus,.f select:focus{... outline:none}`.
הכלל הזה ספציפי יותר מ-`:focus-visible` בשורה 127, ולכן **מבטל** את טבעת הפוקוס דווקא בשדות הטופס. משתמש מקלדת מקבל רק שינוי צבע גבול — לא מספיק לפי 2.4.7 ולא עומד ב-1.4.11 (ניגודיות רכיבים לא-טקסטואליים).

**למה זה חשוב:** זה הרכיב היחיד באתר שמייצר לידים. מי שמנווט במקלדת פשוט לא יודע באיזה שדה הוא נמצא.

**התיקון** — להחליף את שורה 294:

```css
/* Keep the styling change, but never remove the ring for keyboard users. */
.f input:focus,.f select:focus{background:var(--surface); border-color:var(--indigo)}
.f input:focus:not(:focus-visible),.f select:focus:not(:focus-visible){outline:none}
.f input:focus-visible,.f select:focus-visible{outline:2.5px solid var(--indigo); outline-offset:2px}
```

עכבר → בלי טבעת (נקי ויזואלית). מקלדת → טבעת ברורה. זה בדיוק מה ש-`:focus-visible` נועד לפתור.

---

## 🔴 2. אין קישור דילוג לתוכן ואין ציון דרך `<main>`

**הממצא:** אין `<main>`, ואין "דלג לתוכן". קורא מסך חייב לעבור את כל תפריט הניווט בכל טעינת עמוד. הפרה של 2.4.1.

**התיקון** — מיד אחרי `<body>` בשני עמודי השפה:

```html
<a class="skip" href="#main">Skip to content</a>
```
בעברית: `<a class="skip" href="#main">דלג לתוכן</a>`

לעטוף את התוכן הראשי (מה-`<header class="hero">` ועד לפני ה-`<footer>`) ב-`<main id="main">`, ולהוסיף ל-CSS:

```css
.skip{
  position:absolute; inset-inline-start:-9999px; top:0; z-index:999;
  background:var(--indigo); color:#fff; padding:12px 18px; border-radius:0 0 8px 0;
  font-family:var(--body); font-size:15px; text-decoration:none;
}
.skip:focus{inset-inline-start:0}
```

---

## 🟡 3. הטאבים לא מקושרים ולא נשלטים במקלדת

**הממצא:** `index.html:186-189` — יש `role="tablist"` ו-`role="tab"`, אבל לפאנלים אין `role="tabpanel"`, אין `aria-controls`/`aria-labelledby`, ואין ניווט בחצים. קורא מסך מכריז "טאב" ואז לא מוצא לאן הוא מוביל (4.1.2).

**התיקון ב-HTML:**

```html
<div class="tabs" role="tablist" aria-label="Call outputs">
  <button class="tab" role="tab" id="tab-p1" aria-controls="p1" aria-selected="true"  tabindex="0"  data-pane="p1">Meeting booked</button>
  <button class="tab" role="tab" id="tab-p2" aria-controls="p2" aria-selected="false" tabindex="-1" data-pane="p2">CRM update</button>
  <button class="tab" role="tab" id="tab-p3" aria-controls="p3" aria-selected="false" tabindex="-1" data-pane="p3">Call analysis</button>
</div>
```
ולכל פאנל: `<div class="pane" id="p1" role="tabpanel" aria-labelledby="tab-p1" tabindex="0">`

**התיקון ב-`site.js`** — להחליף את בלוק `// --- demo tabs`:

```js
  // --- demo tabs (ARIA tab pattern: arrows move, roving tabindex)
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));

  function selectTab(t, focus) {
    tabs.forEach(function (x) {
      var on = x === t;
      x.setAttribute('aria-selected', String(on));
      x.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll('.pane').forEach(function (p) { p.removeAttribute('data-on'); });
    var pane = document.getElementById(t.dataset.pane);
    if (pane) pane.setAttribute('data-on', '');
    if (focus) t.focus();
  }

  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { selectTab(t); });
    t.addEventListener('keydown', function (e) {
      // In RTL the visual order flips, so mirror the arrows.
      var rtl = document.documentElement.dir === 'rtl';
      var next = rtl ? 'ArrowLeft' : 'ArrowRight';
      var prev = rtl ? 'ArrowRight' : 'ArrowLeft';
      var to = null;
      if (e.key === next) to = tabs[(i + 1) % tabs.length];
      else if (e.key === prev) to = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') to = tabs[0];
      else if (e.key === 'End') to = tabs[tabs.length - 1];
      if (to) { e.preventDefault(); selectTab(to, true); }
    });
  });
```

---

## 🟡 4. גלי הקול נקראים כרעש ע"י קורא מסך

**הממצא:** `[data-wave]` מייצר עשרות אלמנטי `<i>` ריקים. קורא מסך עלול לעבור עליהם.

**התיקון:** ב-`site.js`, בתוך הלולאה של הגלים, להוסיף אחרי `el.innerHTML = out;`:

```js
    el.setAttribute('aria-hidden', 'true');
```

עיטור טהור — אין סיבה שיוכרז.

---

## 🟡 5. הודעת ההצלחה לא מודיעה על שגיאות

**הממצא:** יש `role="status"` על ההצלחה — טוב. אבל כשה-fetch נכשל אין הודעה נגישה בכלל, רק הכפתור חוזר למצבו. משתמש קורא-מסך לא יודע שקרה כלום (3.3.1).

**התיקון:** להוסיף ליד `.form__ok`:

```html
<p class="form__err" role="alert" hidden></p>
```
ובקוד ה-catch: `var err=form.querySelector('.form__err'); if(err){err.hidden=false; err.textContent='משהו השתבש. אפשר לנסות שוב או להתקשר ל-[טלפון].';}`

---

## 🟢 6. תיבת הסכמה בטופס — משפטי, לא נגישות

**הממצא:** הטופס לא מבקש הסכמה מפורשת לקבלת **שיחת טלפון מסוכנת AI**. הכיתוב הנוכחי ("No setup fee · Live in 5 business days") לא מהווה הסכמה.

**למה זה חשוב:** תיקון 40 לחוק התקשורת דורש הסכמה מפורשת מראש לפנייה פרסומית. הטופס הוא ההוכחה שלך — והפונקציה שומרת אותה כ-`consent_source`.

**התיקון** — לפני הכפתור:

```html
<label class="consent">
  <input type="checkbox" name="consent" required>
  <span>אני מאשר/ת שיחזרו אליי בטלפון, בוואטסאפ או במייל, כולל באמצעות סוכנת דיגיטלית (AI), ושהשיחה תוקלט.
  <a href="/privacy/">מדיניות הפרטיות</a></span>
</label>
```
(אנגלית: "I agree to be contacted by phone, WhatsApp or email — including by an AI agent — and that the call may be recorded.")

---

## מה כבר תקין ואין מה לגעת

- `:focus-visible` גלובלי · `prefers-reduced-motion` מלא · היררכיית כותרות תקינה (h1 יחיד) · `lang` ו-`dir` נכונים בשני העמודים · `hreflang` הדדי · honeypot מוסתר נכון (`position:absolute` ולא `display:none` — נגיש לקורא מסך שממילא מדלג עליו) · שדות טלפון ומייל עם `direction:ltr` בעברית · תוויות `<label for>` על כל שדה.

## אחרי התיקונים

1. לעבור על העמוד עם Tab בלבד — מהקישור הראשון עד הכפתור. כל עצירה נראית.
2. Lighthouse → Accessibility (יעד: 95+).
3. לחזור על שניהם **גם בעמוד העברי** — באג RTL בלתי נראה למי שבודק באנגלית.
4. לעדכן את `accessibility-statement-he.md` עם תאריך הבדיקה ולפרסם ב-`/accessibility/`.
