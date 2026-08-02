# Hebrew Voice AI — Market Research 2026
## מסקנות אסטרטגיות למיגרציית ה-Voice Engine של ClickScales

**נערך:** יולי 2026, בעקבות טענת המשתמש ששמע מתחרים עם ״zero delay״ בעברית
**מקורות:** 5 חוקרי-על מקבילים, ~60 מקורות, adversarial verification על טענות ספציפיות

---

## Bottom line — 3 ממצאים משנים-משחק

### 1. ה-״zero delay״ של המתחרים = כנראה Wonderful.ai. וזה לא מה שנשמע.

**Wonderful.ai** — יוניקורן ישראלי, **גייסו $150M ב-Series B ב-2026 בשווי $2B**. לקוחות מאומתים: **בזק** (2,000 סוכני CS הוחלפו), **מכבי שירותי בריאות**. VP של בזק על הרקורד: *״אתגר משמעותי בעברית כי היא שפה יתומה״*.

**זה כמעט בוודאות מה ששמעת.** אבל הנה מה שמעניין:

- **הסטאק שלהם — קופסה שחורה מוחלטת.** אין GitHub, אין engineering blog, אין הרצאות. ה-CTO (Roey Lalazar) הגיע מ-Kaps (localization כתוביות) — **אין לו רקורד ב-real-time voice**.
- **טענת ה״latency נמוך״ — אין למדידה עצמאית.** כל הציטוטים הם מ-testimonials של לקוחות בעיתונות של Wonderful עצמם. **אין YouTube demo. אין מבחן latency עצמאי של עיתונאי.**
- **המשמעות:** רוב הסיכויים שהם עוטפים את **בדיוק את אותו הסטאק שאנחנו בונים** (LiveKit + Cartesia + OpenAI Realtime) עם fine-tuning קטן בעברית. תחושת ה״zero delay״ שלך יכולה להיות פשוט **הבדל של 500ms** מ-2500ms שלנו — עדיין 1.5-2 שניות, אבל מרגיש חלק יותר עם prompt engineering טוב.

### 2. אף אחד לא הוכיח באופן עצמאי <1s בעברית. אף. אחד.

חיפשנו: benchmarks עצמאיים, סרטוני YouTube עם מדידה, מאמרים אקדמיים על Hebrew voice AI production, ביקורות בפורומים. **התוצאה: אפס עצמאיים.**

- Yappr טוענת ״sub-800ms״ — רק בבלוג שלה, אין אימות
- Wonderful — טענות עמומות של ״remarkable fluency״ בלי מספרים
- Retell — לא רק שאין להם לקוחות ישראלים, **מספרי טלפון ישראליים (+972) לא פעילים כברירת מחדל** אצלם. נדרש workaround דרך צד שלישי.

### 3. הסטאק שאנחנו בונים הוא **הבחירה הנכונה**. אין אלטרנטיבה מוכחת.

**S2S (Speech-to-Speech) מלא לא קיים לעברית:**
- OpenAI Realtime: הפלט העברי **גרוע** (מבטא אמריקאי, 40% consistency)
- Google Gemini Live: **עברית לא ברשימת שפות האודיו** (24 שפות, עברית לא שם)
- כל האופציות open-source (Moshi, Sesame, Ultravox, Kyutai): **אנגלית בלבד**
- מודלים סיניים (Qwen, GLM, Step-Audio): **אין עברית**
- SeamlessM4T של Meta: קלט עברית ✓, פלט **טקסט בלבד** ✗

**המסקנה:** אין ל-Wonderful.ai קסם שאין לנו. **המסלול שלנו הוא המסלול הנכון.**

---

## 5 שיפורים מיידיים שנוכל לעשות עכשיו — לפי סדר עדיפויות

### 🥇 #1 — לבדוק למה Cartesia TTFA שלנו הוא 459ms במקום 188ms
**Coval פרסמו benchmark שרשמי:** Cartesia Sonic-3.5 → **188ms P50 TTFA**. אנחנו מקבלים **459ms** — פי 2.4 מהצפוי.

**סבירים חשודים:**
- Region routing — הבקשות שלנו הולכות ל-region רחוק
- WebSocket vs REST — צריך לוודא שאנחנו על streaming ולא על בקשות בודדות
- Cold connections — אולי אין reuse של connection pool

**רווח פוטנציאלי:** 270ms חינם. **זמן עבודה:** שעה של Claude Code.
**להנחות:** בדוק את הקונפיגורציה של Cartesia — region + streaming mode + connection pool.

### 🥈 #2 — Soniox STT במקום OpenAI gpt-realtime-whisper
**Soniox stt-rt-v4** מפרסם benchmark של:
- **Hebrew WER: 1.25%** (שלנו עם OpenAI: 3.24% — פי 2.6 יותר טוב)
- **Latency: 249ms** median time-to-final
- **Endpointing מובנה** — כולל אלמנטים שיכולים לעזור עם ה-VAD problem שלנו

זה vendor benchmark (זהירות), אבל השוואה מפורטת שלהם היא הכי אמינה שמצאנו. **שווה A/B test.**

**רווח פוטנציאלי:** דיוק STT טוב פי 2.6 + אולי endpointing טוב יותר לעברית.
**זמן עבודה:** יום — צריך לחבר SDK חדש ולעשות מדידה השוואתית.

### 🥉 #3 — ivrit.ai open-source Whisper (טווח ארוך יותר)
**ivrit.ai** — מלכ״ר ישראלי, אקדמיה של אוניברסיטת בר-אילן. **Fine-tune של Whisper large-v3 על 290 שעות עברית מקצועית.** מדדים:
- **2.4% CER** על ILSpeech (state-of-the-art open source לעברית)
- **רישיון MIT** — חופשי לשימוש מסחרי
- **גרסאות faster-whisper מוכנות** — self-hostable

**היתרון האסטרטגי:** לא תלוי בספק, לא vendor lock-in, יכול לרוץ קרוב לנו (edge deployment).
**החיסרון:** self-hosting דורש GPU. עלות תשתית לחודש ~$200-500.
**זמן עבודה:** שבוע כשנרצה — לא Phase 4.

### 🎖️ #4 — LiveKit turn-detector v0.4.1-intl (worth a shot)
LiveKit העלו turn detector רב-לשוני חדש (v0.4.1-intl) שלא ניסינו. **עברית לא רשומה במפורש**, אבל הוא ב-transformer general-purpose. **שווה 30 דקות של ניסוי.**

### 🎯 #5 — לפנות ל-ivrit.ai מייסדים
הם המלכ״ר. **עשירי-משאבים לא, אבל עשירי-קשרים כן.** אולי כדאי לפנות אליהם בנוגע ל:
1. **Hebrew EoU/VAD model** — הם היחידים שבצה יש להם 500+ שעות של אודיו עברי מקצועי מקובץ. שווה שאלה אם הם בונים או יכולים.
2. **שיתוף פעולה בעתיד** — אם ClickScales יכול להיות case study ראשון של voice agent סוכן מבוסס-ivrit, זה win-win.

---

## מה שאין לנו — ולא נבנה עכשיו

**Hebrew semantic VAD / EoU model — לא קיים.** לא ב-OpenAI, לא ב-LiveKit, לא ב-Deepgram, לא ב-Google. **בכל הביומחקר של deep-research לא מצאנו מודל אחד ייעודי.**

זה **הפער האמיתי בשוק**. אם ClickScales יבנה את זה בעתיד (Phase 7+), זה יכול להיות **המוצר עצמו** שאנחנו מוכרים לסוכנויות אחרות. גם Wonderful.ai כנראה בונה את זה עכשיו — זו הסיבה שהם ״קופסה שחורה״.

---

## המלצה סופית — מה לעשות מחר בבוקר

### שנה את המסלול? **לא.**

הסטאק שלנו (LiveKit + Cartesia + OpenAI) הוא בדיוק מה שרוב הסיכויים ש-Wonderful.ai ו-Yappr משתמשים בו. **אין להם קסם שאין לנו.**

### מה כן לעשות — פעילות בסדר הזה:

1. **היום** — הרץ debugging על ה-459ms של Cartesia. תגיד ל-Claude Code:
   ```
   Coval benchmark shows Cartesia Sonic-3.5 P50 TTFA is 188ms. 
   We're measuring 459ms. Investigate why:
   - Are we using WebSocket streaming or REST?
   - What region is our Cartesia connection using?
   - Is there connection pool reuse?
   - Are there any warmup penalties on first call?
   Report findings + propose fixes.
   ```

2. **השבוע** — A/B test של Soniox STT מול OpenAI Realtime. יש להם free tier. תעביר את הפרומפט הבא:
   ```
   Do a controlled A/B: same 20 test conversations in Hebrew, once with OpenAI 
   gpt-realtime-whisper (current), once with Soniox stt-rt-v4. Measure per-turn:
   STT WER, first-token latency, final-transcript latency, end-of-turn detection 
   accuracy. Report full comparison.
   ```

3. **החודש** — קרא ל-ivrit.ai. פנייה של 5 דקות. תשלח email ל-info@ivrit.ai:
   *״שלום, בונה voice agent בעברית ל-ClickScales, סוכנות שיווק דיגיטלי. שמעתי על העבודה שלכם ב-Hebrew ASR. יש לכם מודל end-of-utterance detection ייעודי לעברית או ידע בתחום? נשמח לתמוך במחקר.״*

4. **Q4 2026 — אם עדיין רלוונטי** — Yappr יכולים להיות **פרטנרים אסטרטגיים**, לא רק מתחרים. הם מוכרים ל-SMB ($0.25/דקה), אנחנו הולכים על סוכנויות שיווק. **תיאום, לא תחרות.**

---

## הפרספקטיבה — למה זה בעצם חדשות טובות

הסתכל על מה שגילינו:

| ממצא | משמעות עסקית |
|---|---|
| Wonderful.ai שוה $2B על עברית | **השוק מוכן לשלם.** יש הוכחת ביקוש. |
| הסטאק שלהם קופסה שחורה | **הם לא באמת פתחו פער.** אתה יכול להגיע לאותה נקודה. |
| S2S מלא לעברית לא קיים | **cascade הוא המסלול היחיד.** לא איבדת שום דבר. |
| Retell לא תומכים ב-+972 | **גם ה-״קלים לפרויקט״ בסביבה שלך יזדקקו לך.** יש פוטנציאל כפתרון for-hire. |
| ivrit.ai פתחו נתיב open-source | **יש accelerator טכנולוגי לישראלים בלבד.** יתרון תחרותי long-term. |

**Bottom line שלך:** אתה בונה מוצר נכון, בזמן נכון, בטכנולוגיה נכונה. **תמשיך.**

---

## נספח: מקורות מרכזיים (verified)

**Wonderful.ai / התחרות הישראלית:**
- [CTech — Wonderful $150M Series B](https://www.calcalistech.com/ctechnews/article/mzl1gy8tx)
- [TechCrunch — Wonderful $2B valuation](https://techcrunch.com/2026/03/12/wonderful-raises-150m-series-b-at-2b-valuation/)
- [Yappr — Israel Voice AI Comparison](https://goyappr.com/en/blog/israel-voice-ai-platform-comparison)

**STT benchmarks:**
- [Soniox Hebrew benchmarks](https://soniox.com/compare/soniox-vs-openai/hebrew)
- [ivrit.ai HuggingFace](https://huggingface.co/ivrit-ai)
- [Bar-Ilan Hebrew ASR paper (Interspeech 2025)](https://www.isca-archive.org/interspeech_2025/marmor25_interspeech.pdf)

**TTS analysis:**
- [Coval TTS Benchmark 2026](https://gradium.ai/content/tts-latency-benchmark-2026)
- [Cartesia Hebrew page](https://www.cartesia.ai/languages/hebrew)

**S2S state of the art:**
- [OpenAI Realtime Hebrew issues](https://community.openai.com/t/realtime-api-not-working-well-in-hebrew/1088205)
- [Voice Benchmark realtime leaderboard](https://voicebenchmark.ai/provider/openai-realtime-api)
- [Kyutai Moshi FAQ (English only)](https://github.com/kyutai-labs/moshi/blob/main/FAQ.md)

**Retell Hebrew gap:**
- [Retell +972 outbound thread](https://community.retellai.com/t/enable-israel-972-for-outbound-calls-on-my-account/781)
- [Retell language docs (Hebrew via Cartesia only)](https://docs.retellai.com/agent/language)
