# עדכון `website/assets/site.js` — חיבור הטופס לקרן + אירוע Lead

מחליף את בלוק `// --- demo form` הקיים (שורות 39–74 בקובץ הנוכחי).

**מה משתנה ולמה:** היום הטופס נשלח רק ל-Netlify Forms — הליד נשמר אבל שום דבר לא קורה איתו. הגרסה החדשה שולחת **שני** בקשות במקביל: אחת ל-Netlify (שמירה + התראת מייל, רשת ביטחון) ואחת לפונקציה `/.netlify/functions/lead` שמעבירה לקרן ומפעילה שיחה. אם אחת נכשלת השנייה עדיין עובדת — ליד לא הולך לאיבוד.

```js
  // --- demo form
  // Two destinations, on purpose:
  //   1. Netlify Forms  — durable capture + email notification (safety net)
  //   2. /.netlify/functions/lead — forwards to KEREN so the agent calls back,
  //      and fires the server-side Meta Lead event.
  // Either one failing must not lose the lead, so they run independently.
  var form = document.querySelector('form[data-demo-form]');
  if (!form) return;

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = form.querySelector('.btn');
    var ok = form.querySelector('.form__ok');
    var original = btn.textContent;

    btn.disabled = true;
    btn.textContent = btn.dataset.sending || 'Sending…';

    // One id shared by the browser pixel and the server event so Meta
    // counts this lead once, not twice.
    var eventId = 'lead-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    var fd = new FormData(form);
    fd.append('event_id', eventId);
    fd.append('language', document.documentElement.lang || 'en');
    var data = new URLSearchParams(fd).toString();

    var toNetlify = fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: data
    });

    var toAgent = fetch('/.netlify/functions/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: data
    }).catch(function () { /* the agent hop is best-effort; logs hold the detail */ });

    toNetlify
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        form.setAttribute('data-sent', '');
        if (ok) ok.setAttribute('data-on', '');
        if (window.fbq) fbq('track', 'Lead', {}, { eventID: eventId });
      })
      .catch(function () {
        // Never swallow a lead: fall back to a normal browser POST.
        btn.disabled = false;
        btn.textContent = original;
        form.removeAttribute('data-demo-form');
        form.submit();
      });

    return toAgent;
  });
```

## בדיקה אחרי הפריסה

1. פתח את הטופס, מלא **את המספר שלך**, שלח.
2. תוך פחות מדקה — הטלפון מצלצל.
3. ב-Netlify → Forms — ההגשה מופיעה.
4. ב-Netlify → Functions → lead → Logs — אין שגיאות.
5. ב-Meta Events Manager → Test Events — אירוע Lead אחד (לא שניים).

אם השיחה לא מגיעה אבל ההגשה נשמרה — הבעיה בפונקציה או ב-`LEAD_WEBHOOK_SECRET`, לא בטופס. הלוגים של הפונקציה יראו את הסטטוס שהוחזר מה-API.
