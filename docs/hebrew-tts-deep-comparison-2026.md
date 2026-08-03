# Hebrew TTS Deep Comparison — 2026
## מחקר עמוק על ספקי קול AI לעברית

**נערך:** יולי 2026, 5 חוקרי-על מקבילים, ~50+ מקורות עצמאיים
**מטרה:** האם Cartesia הוא באמת הבחירה הכי טובה לעברית, או שיש משהו טוב יותר שאנחנו מפספסים?

---

## 🚨 הממצא הכי חשוב — Cartesia לא באמת מאומת בעברית

**הנחת יסוד שקיבלנו כמובן מאליו:** Cartesia הוא הטוב ביותר לעברית.
**האמת מהמחקר:** אין **אף** בדיקה עצמאית של Cartesia בעברית.

- **חיפוש בעברית** (״קורטזיה בעברית״, ״Cartesia עברית״) — **אפס דיונים בקהילה ישראלית**.
- **בדיקת מפתחים עצמאית** של danielrosehill (מרץ 2025) שהשוותה 6 ספקים בעברית — **Cartesia לא נבדק בכלל**.
- **כל המקורות ש״אומרים ש-Cartesia טוב בעברית״** מקורם בעמודי מרקטינג של Cartesia עצמם.

**התוצאה:** אנחנו מהמרים על Cartesia בהתבסס על benchmarks של latency ומחיר (שלגמרי מאומתים) — אבל **לא על benchmarks של איכות בעברית**.

---

## הדירוג העצמאי היחיד שמצאנו (danielrosehill, מרץ 2025)

| מקום | ספק | הערכה |
|---|---|---|
| 🥇 1 | **MiniMax T2A v2.6 Turbo** | **״התוצאות הכי מרשימות — קולות משוכפלים נשמעו טבעי בעברית״** |
| 🥈 2 | ElevenLabs v3 (עם `language_code:"he"`) | ״טוב״ — אבל v2 היה **״בלתי מובן״**. v3 מחייב |
| 🥉 3 | Google Gemini 2.5 Flash Preview TTS | ״טוב״ — קולות Puck, Zephyr |
| 4 | Edge TTS (Microsoft — חינם) | טוב, קולות Avri/Hila |
| 5 | Chatterbox | גרוע — voice-clone לא עבר לעברית |
| 6 | Resemble AI | גרוע — צריך diacritics כדי להיות מובן |

**Cartesia — לא בטבלה. לא נבדק.**

---

## 3 חלופות עם פוטנציאל אמיתי לעברית

### 🏆 #1 — Deepdub Phantom X (dd-etts-3.0)
**חברה ישראלית + streaming של 125ms + API סטנדרטי + עברית native**

- **מקור:** [deepdub.ai/voice-api-for-agents](https://deepdub.ai/voice-api-for-agents), [GitHub](https://github.com/deepdub-ai/deepdub-api)
- **TTFA:** **125ms E2E** (מהיר יותר מ-Cartesia — פי 1.5)
- **פרוטוקול:** WebSocket streaming, Node SDK מוכן (`@deepdub/node`), MP3/Opus/mulaw
- **תמיכה עברית:** `he-IL` רשומה במפורש ב-locales
- **החברה:** ישראלית, נוסדה 2019, מתמחה ב-real-time voice
- **חיסרון:** אין לקוחות רשומים בשוק ה-voice agents (רק dubbing), נהיה early adopter
- **סיכון:** אין תיעוד ציבורי של מחיר — enterprise sales, כנראה $$$

### 🥈 #2 — Inworld Realtime TTS-2
**זול פי 8, LiveKit-native, #2 בזירת Artificial Analysis**

- **מקור:** [Inworld blog May 2026](https://inworld.ai/blog/realtime-tts-2), [AA leaderboard](https://artificialanalysis.ai/text-to-speech/leaderboard)
- **TTFA:** **sub-200ms** streaming (WebSocket)
- **מחיר:** **~$0.01/דקה בקנה מידה** (Cartesia שלנו ~$0.03) — חיסכון של 66%
- **LiveKit integration:** רשמית, ה-CTO של LiveKit ציטט אותם ב-launch
- **תמיכה עברית:** רשומה כ-״production language, best quality״ יחד עם אנגלית/ערבית/רוסית
- **סיכון:** עברית ב-״100+ שפות״ ולא ״tier-1״ כמו EN/AR — צריך לאמת עם playground
- **מעולה עבורנו כי:** אם עברית באמת ברמת production, זה **החיסכון הכי גדול על הלוח + latency טוב יותר**

### 🥉 #3 — MiniMax Speech 2.6 HD
**#1 בבדיקה העצמאית של Rosehill, עברית מפורשת**

- **מקור:** [MiniMax Speech 2.5 news](https://www.minimax.io/news/minimax-speech-25)
- **TTFA:** <250ms
- **מחיר:** ~$0.05-0.10/דקה
- **תמיכה עברית:** **נוספה במפורש ב-Speech 2.5** (״new additions include Bulgarian, Danish, **Hebrew**, Malay...״)
- **גישה:** דרך WaveSpeed, fal, Replicate, Novita — לא ישירות מ-MiniMax
- **סיכון:** חברה סינית — issues של regulatory, data residency, uptime
- **יתרון:** יש **בדיקה עצמאית שמדרגת אותו #1 לעברית**

---

## מה שאני **לא** ממליץ (עם הנימוקים)

### ❌ ElevenLabs v3 — הסיפור המסובך
v3 הוא **הכי מדובר** לעברית ואפילו מוזכר בבלוגים ישראלים כ״מדהים בעברית״ — אבל **v3 לא streaming**. הגרסה הזורמת (Flash/Turbo v2.5) היא ״טובה״ בעברית לפי Rosehill, אבל **בלי audio tags** (רגש, לחישות). זה בדיוק המגבלה של Retell שברחנו ממנה. **לא שדרוג משמעותי.**

### ❌ OpenAI Realtime (Cedar/Marin) — עברית שבורה
Forum של OpenAI מלא בישראלים שאומרים שההגייה **״עברית עם מבטא אמריקאי כבד״**, ויש **באג של הבנה**: המודל מבלבל ״ראשון״ עם ״שני״. **לא בשל.**

### ❌ Azure Neural (Hila/Avri) — מיושן
שני קולות, לא השתנו מ-2020. **לא בטיר HD** של Azure. פרוזודיה מוגבלת. Enterprise-boring אבל אמין.

### ❌ Google Chirp 3 HD — עברית מוחרגת מהיכולות
Google הוסיפו עברית ב-Nov 2025 עם ~30 קולות. אבל **he-IL מוחרגת מ-custom pronunciations ו-pause control**. אין `<prosody pitch>`. אלה יכולות שצריכים לקול טבעי. **מפוקפק.**

### ❌ Yappr / Wonderful.ai — פלטפורמות סגורות
לא חושפות TTS כרכיב עצמאי. אלה **מתחרים**, לא ספקים. Wonderful שווה $2B אבל אין להם dev docs — sales-only.

### ❌ פתרונות open-source — לא בשלים
**Phonikud + MMS-TTS-heb** הוא הכי טוב לעברית ב-OSS — אבל: (1) רישיון non-commercial חוסם שימוש מסחרי, (2) איכות ״מובנת אבל רובוטית״, (3) break-even רק ב-60K+ דקות/חודש כשמחשבים devops.

---

## 💎 גילוי אחר חשוב — Phonikud (שכבת preprocessing)

**Phonikud** ([arxiv](https://arxiv.org/abs/2506.12311), [GitHub](https://github.com/thewh1teagle/phonikud)) הוא **לא TTS** — הוא **שכבת G2P** (grapheme-to-phoneme) שמוסיפה **ניקוד ותנועות עבריות** לטקסט לפני שהוא נכנס לספק ה-TTS.

**הבעיה שהוא פותר:** כל ספקי ה-TTS המסחריים (כולל Cartesia) מקבלים טקסט **בלי ניקוד**. עברית **לא נקראת נכון בלי ניקוד** — במיוחד שמות, מספרים, ומילים דו-משמעיות (״ספר״ = book או barber). Phonikud מוסיף את הניקוד + **stress + shva** לפני השליחה ל-TTS.

**המשמעות:** בלי קשר לאיזה TTS נבחר, **הוספת Phonikud כשכבה לפניו תשפר את איכות ההגייה בעברית באופן דרמטי**. זה **החזר על השקעה הכי גדול לאיכות** מכל השינויים.

- **Runtime:** ONNX, real-time, ~5-10ms נוספים
- **רישיון:** Apache-2.0 (מסחרי OK)
- **מטפל ב:** מספרים, תאריכים, מיקסי אנגלית/עברית ברמה סבירה
- **חולשה:** שמות עם הגייה לא סטנדרטית עדיין הימור

---

## הטבלה המלאה של 5 המובילים

| # | ספק | איכות עברית | TTFA | מחיר/דקה | Streaming | היתרון | החולשה |
|---|---|---|---|---|---|---|---|
| 1 | **Deepdub Phantom X** | **?** (Israeli, לא נבדק עצמאית) | **125ms** ✨ | $$-$$$ (enterprise) | ✅ WebSocket | Israeli, מהיר ביותר, API סטנדרטי | אין תמחור ציבורי, אין reference customers ל-voice agents |
| 2 | **Inworld TTS-2** | **?** (מסומן production, לא מאומת) | **<200ms** | **$0.01/min** ✨ | ✅ + LiveKit-native | 8x זול, LiveKit-integrated | עברית לא tier-1 |
| 3 | **MiniMax Speech 2.6 HD** | 🥇 (#1 בבדיקת Rosehill) | <250ms | $0.05-0.10/min | ✅ | דירוג #1 עצמאי לעברית, מחיר סביר | חברה סינית, regulatory concerns |
| 4 | **Cartesia Sonic-3** (baseline) | **?** (אין reviews עצמאיים) | 188ms (measured 459) | $0.03/min | ✅ | סטאק נוכחי | לא מאומת עצמאית לעברית |
| 5 | **ElevenLabs Flash v2.5** | Good (Rosehill) | 288ms | ~$0.20 | ✅ | הקהילה מאשרת לעברית | יקר פי 6, בלי audio tags |

---

## המלצה סופית — 3 צעדים

### 🎯 עשה כעת (השבוע)
**הוסף Phonikud לסטאק הנוכחי.** בלי לשנות את Cartesia. **זה יעלה את איכות ההגייה מיד**, ללא שינוי ספק, ללא שינוי מחיר, ללא סיכון. תגיד ל-Claude Code:

```
Add Phonikud (https://github.com/thewh1teagle/phonikud) as a G2P preprocessing 
layer before the Cartesia TTS call. Every Hebrew text going to Cartesia should 
first pass through Phonikud for niqqud + stress + shva markup. Measure the 
quality delta with 20 test sentences (names, numbers, mixed English) before 
committing to production.
```

### 🔬 עשה החודש (בדיקה יסודית)
**Blind test של 4 ספקים עם דוברי עברית ילידיים.** זה הדבר היחיד שיסגור את הפער של ״Cartesia לא מאומת״.

**מתודולוגיה:**
1. קח 10 משפטים של Keren מהפרומפט (כולל שמות: יובל, שרה, קורן; מספרים: עשרים ושתיים, שלוש וחצי; מיקסי EN-HE: ״אני עובד עם CRM״)
2. הפק אודיו מ-4 ספקים: **Cartesia (baseline), Deepdub Phantom X, Inworld TTS-2, MiniMax 2.6 HD**
3. השמע ל-**5 דוברי עברית ילידיים** (חברים שלך, לא מפתחים), בלי לומר להם איזה קול איזה
4. תבקש כל אחד לדרג ב-3 מדדים: (א) טבעיות, (ב) מהירות/קצב, (ג) איכות הגייה של שמות
5. **הזוכה במדד (א) — הוא ה-TTS שלנו לפרודקשן.**

### 🚀 עשה ב-Q4 (Migration אם רלוונטי)
אם הבדיקה מראה שספק אחר מנצח **באיכות עברית + מחיר סביר** — נעשה migration. **הסטאק שלנו מודולרי** (הודות ל-LiveKit) — Claude Code יכול להחליף ספק TTS ב-1-2 קבצים.

---

## הפרספקטיבה הכוללת

**מה שגילינו:** ההנחה שלנו על Cartesia הייתה מבוססת על benchmarks של latency (מאומת) ומחיר (מאומת) — **אבל לא על benchmarks של איכות בעברית** (לא מאומת).

**זה לא אומר ש-Cartesia גרוע.** זה אומר ש-**אנחנו לא באמת יודעים**. כמו במחקר על Wonderful.ai — יש שוק מוכן לשלם על ״עברית טובה״, אבל אין benchmarks עצמאיים שמראים מי הכי טוב.

**היתרון שלנו:** הסטאק שלנו modular. **אנחנו יכולים להחליף TTS ב-2 שעות עבודה** אם נמצא משהו יותר טוב. עשה את הבדיקה, קח החלטה מבוססת ראיות.

---

## מקורות מרכזיים

**התוצר העצמאי הכי חשוב:**
- [danielrosehill/Hebrew-TTS-Providers](https://github.com/danielrosehill/Hebrew-TTS-Providers) — הבדיקה העצמאית היחידה שמצאנו

**Deepdub:**
- [Voice API for Agents](https://deepdub.ai/voice-api-for-agents)
- [GitHub SDK](https://github.com/deepdub-ai/deepdub-api)

**Inworld TTS-2:**
- [Launch blog May 2026](https://inworld.ai/blog/realtime-tts-2)
- [AA leaderboard](https://artificialanalysis.ai/text-to-speech/leaderboard) (#2 ranking)

**MiniMax:**
- [Speech 2.5 news (Hebrew added)](https://www.minimax.io/news/minimax-speech-25)
- [Speech 2.6 HD on WaveSpeed](https://wavespeed.ai/models/minimax/speech-2.6-hd)

**Phonikud:**
- [Paper (arxiv 2506.12311)](https://arxiv.org/abs/2506.12311)
- [GitHub](https://github.com/thewh1teagle/phonikud)

**Community sentiment:**
- [Israeli YouTube — ElevenLabs v3 Hebrew](https://www.youtube.com/watch?v=-bjJTWYGKU4)
- [OpenAI forum — Hebrew accent complaint](https://community.openai.com/t/tts-1-and-tts-1-hd-in-hebrew-has-an-american-accent/500307)

**Latency benchmarks:**
- [Gradium TTS Latency 2026](https://gradium.ai/content/tts-latency-benchmark-2026)
- [Coval TTS benchmark](https://www.coval.ai/blog/best-text-to-speech-providers-in-2026-how-to-choose-(and-why-vendor-benchmarks-lie)/)
