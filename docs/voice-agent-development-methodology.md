# מתודולוגיית פיתוח סוכן AI קולי — שיטת עבודה מהמאמרים

**מבוסס על:** ElevenLabs FDE playbook + Shekhar Gulati production lessons + Vatsal Shah architecture + Fountain City AI-authored code + Agora 10 lessons + LiveKit best practices

**מטרה:** לא ״מה לבנות״ אלא ״איך לבנות״ — התהליך והמדדים שהופכים POC למוצר שעובד.

---

## עקרון-על #1: הגדר "מה זה מוצלח" לפני שאתה כותב שורת קוד

**מהמאמר:** *"Development teams should jointly define Success Evaluation Criteria... expanding tests incrementally as new behaviors are introduced."* (ElevenLabs FDE)

**מה זה אומר בפועל אצלנו:**

לפני שאתה נותן ל-Claude Code לכתוב שורת קוד, ניצור קובץ `SUCCESS_CRITERIA.md` בפרויקט. תוכן:

```
=== Business Success ===
- 70%+ מהלידים ה-HOT נסגרים על פגישה בשיחה הראשונה
- 90%+ מהשיחות מסתיימות תוך 4 דקות
- 0 booking conflicts ביומן

=== Technical Success ===
- Latency P95 < 800ms per turn
- Latency P50 < 400ms per turn
- 0 hallucinations בתאריכים או במחירים
- 100% מהשיחות נשמרות עם transcript

=== Voice Quality Success ===
- הסוכן לא נשמע רובוטי (עוברים blind test עם 5 חברים)
- אין dead air > 1.2 שניות
- barge-in עובד ב-95% מהמקרים
- הסוכן לא קוטע את הלקוח באמצע משפט
```

**למה זה קריטי:** בלי המסמך הזה, כל שיפור זה "אני חושב שזה יותר טוב עכשיו" במקום מדידה. Claude Code לא יודע מה טוב בשבילך אם לא הגדרת.

---

## עקרון-על #2: Prompt הוא artifact חי — לא נכתב פעם אחת

**מהמאמר:** *"Prompt engineering for voice agents is empirical, and prompts on day one will look nothing like prompts after a month of production calls."* (Shekhar Gulati)

**Prompt lifecycle שלנו:**

| שלב | מה קורה ל-prompt | כמה זמן זה לוקח |
|---|---|---|
| Day 1 | prompt ראשוני שכתבנו יחד ב-Phase 1. 20 שורות. | שעה |
| Day 3 | אחרי 10 test calls — מתגלה שהסוכן מדבר בשם עצם זכר לנשים | תיקון של 5 שורות |
| Week 1 | אחרי 30 שיחות אמיתיות — 40 שורות. עם 10 few-shot examples מהמציאות | שעה |
| Week 4 | 80+ שורות. Sections לכל edge case שהתגלה. Anti-hallucination rules | שעתיים |
| Month 3 | 150+ שורות. Modular — נטען לפי סוג ליד | 3 שעות |

**איך מנהלים את זה:**
1. הקובץ `system_prompt.md` נמצא ב-git.
2. כל commit ל-prompt חייב סיבה (״fix: agent said 'הוא' to female caller Sarah״).
3. כל שינוי מגובה בטסט חדש ב-`tests/prompt_regressions/`.
4. Claude Code מקבל הוראה: *״never edit system_prompt.md without adding a regression test to prove the fix works and doesn't break old behavior.״*

---

## עקרון-על #3: הסתכל על ה-orchestration כמו CS problem, לא כמו "chatbot with audio"

**מהמאמר:** *"The most common mistake is the 'chatbot extension' approach. Cascaded STT→LLM→TTS pipelines are broken for conversations."* (AssemblyAI)

**החלטות ארכיטקטורה שנעשה מוקדם:**

### 1. Streaming או Buffered?
**כלל:** כל שלב חייב להיות streaming, אחרת latency מצטבר עד ל-2 שניות+.
- STT: streams tokens as they arrive
- LLM: streams tokens to TTS ברגע שיש 3-4 מילים
- TTS: מתחיל להשמיע לפני שקיבל את כל המשפט
- **Claude Code prompt לכלול:** *"Never buffer complete responses between stages. Every stage must forward partial results as soon as available."*

### 2. Cascaded pipeline או Speech-to-Speech?
לפי המאמרים ב-2026 יש שתי גישות:
- **Cascaded** (STT → LLM → TTS): שליטה מלאה, גמישות בבחירת ספקים, latency ~600-800ms אחרי אופטימיזציה. **זה מה שנבנה.**
- **S2S** (GPT-4o Realtime): מודל אחד, latency ~250ms, אבל אין שליטה על TTS voice, בעברית פחות טוב.

**החלטה:** cascade. בעברית, איכות הקול של Cartesia עדיפה בהרבה על-פני voices של OpenAI Realtime.

### 3. State management בין תורות
כל תור בשיחה חייב לגשת ל:
- ההיסטוריה של השיחה (last 10 turns min)
- Extracted variables (name, budget, timeline מהתשובות עד עכשיו)
- Business context (calendar availability cached)

**Claude Code prompt לכלול:** *"Maintain a Session object per call. Never send only the last user message to the LLM — always the full context window."*

---

## עקרון-על #4: Latency Budget — מדוד לפני שאתה מייעל

**מהמאמר:** *"12 techniques compounding into 600-900ms of savings on a P95 turn."* (Future AGI)

**מה עושים ב-Phase 2:**

1. הוספה של latency instrumentation לכל שלב:
```python
# Claude Code יבנה את זה
timings = {
    'vad_end_of_turn': 45,      # ms
    'stt_first_token': 120,     # ms
    'stt_final': 210,           # ms
    'llm_first_token': 180,     # ms
    'llm_final': 320,           # ms
    'tts_first_audio': 90,      # ms
    'total_perceived': 435,     # ms  ← זה מה שהמשתמש מרגיש
    'total_end_to_end': 650,    # ms
}
```

2. **Budget** לכל שלב:
   - VAD end-of-turn: < 300ms
   - STT first token: < 150ms
   - LLM first token: < 300ms
   - TTS first audio: < 100ms
   - **סה"כ perceived: < 500ms**

3. כל commit צריך להריץ latency benchmark. אם חרג — התראה.

---

## עקרון-על #5: אין agent טוב בלי Testing Infrastructure

**מהמאמר:** *"Agent Testing, Conversation Analysis, and branched rollouts form the foundation for turning a proof of concept into a system that resolves customer issues at scale."* (ElevenLabs)

**3 שכבות בדיקה שנבנה:**

### שכבה 1 — Unit Tests (רץ בכל commit)
- Function calls: `book_calendar_slot()` עם תאריכים תקינים ולא תקינים
- LLM output parsing: extractor של budget/timeline עובד על 30 דוגמאות
- Prompt injection resistance: 20 נסיונות jailbreak מוכרים

### שכבה 2 — Scripted Conversation Tests (רץ בכל שינוי ל-prompt)
פורמט: JSON של conversation, agent responses, expected outcomes:
```json
{
  "name": "hot_lead_books_meeting",
  "turns": [
    {"user": "היי, ראיתי את המודעה שלכם", "expect_intent": "greeting"},
    {"user": "אני יובל, יש לי חנות אונליין", "expect_captured": {"name": "יובל", "business_type": "e-commerce"}},
    {"user": "אני מוציא בערך 20 אלף בחודש על שיווק", "expect_lead_score": "HOT"},
    ...
  ],
  "expect_outcome": {"meeting_booked": true, "whatsapp_sent": true, "email_sent": true}
}
```

בונים 20+ תסריטים כאלה: HOT lead, COLD lead, WARM, אגרסיבי, מבולבל, מדבר אנגלית, סוגר באמצע, וכו׳.

### שכבה 3 — Conversation Analysis (רץ שבועית על שיחות אמיתיות)
- לוקח 20 שיחות אקראיות של השבוע
- מריץ LLM עליהן שנותן score ל-10 מדדים
- מסמן שיחות ״failed״ שדורשות בדיקה ידנית שלך
- מציע שיפורים ל-prompt

---

## עקרון-על #6: Branched Rollouts — לא שוברים production

**מהמאמר:** *"branched rollouts form the foundation..."* (ElevenLabs)

**איך נעבוד:**
- `main` branch = מה שרץ בפרודקשן
- `develop` branch = השינויים הבאים
- כל שינוי משמעותי → PR עם:
  - הרצת כל ה-tests
  - Latency benchmark
  - הרצת 5 test calls בקול (על environment staging)
- רק אז merge ל-main → deploy אוטומטי

**5% Canary Deploy** בהמשך: 5% מהשיחות ל-version חדש, 95% ל-stable. אם metrics טובים → 100%. אם לא → rollback אוטומטי.

---

## עקרון-על #7: Human-in-the-Loop שבועי — לא אופציה

**מהמאמר:** *"A voice agent that gets reviewed and updated regularly will improve significantly over its first 90 days; agents performing well six months after launch are almost always those with a human reviewing transcripts on a schedule."* (Agora)

**הריטואל השבועי שלך (יום שני, 1 שעה):**

1. **הורדת דגימה** (10 דק): המערכת דגמה 20 שיחות מהשבוע — 5 HOT, 5 WARM, 5 COLD, 5 שנכשלו.
2. **האזנה** (30 דק): אתה שומע את השיחות. סימון בעיות בקובץ `weekly_review/YYYY-WW.md`:
   - ״שיחה #7: הסוכן חזר על עצמו כי הלקוח דיבר לאט״
   - ״שיחה #12: לא זיהה תקציב 25K כי הלקוח אמר ׳רבע מיליון בשנה׳״
3. **פרומפט ל-Claude Code** (10 דק): נותן לו את הקובץ, הוא מציע 3-5 שיפורים ומריץ regression tests.
4. **Merge** (10 דק): אתה מאשר, deploy.

**אחרי 12 שבועות** (3 חודשים) — אמור להיות שיפור מדיד של 30-50% ב-completion rate. זו לא תיאוריה, זה נמדד באמפירי במאמרים.

---

## עקרון-על #8: Prompt Engineering ל-Voice ≠ ל-Chat

**מהמאמרים:** מספר מקורות. סיכום:

**כללים ל-prompt של voice agent (שנתן ל-Claude Code כ-guidelines):**

1. **תגובות קצרות**: max 2 משפטים לתור. Voice ≠ chat. אנשים מנתקים בשיחה של פסקאות.
2. **אין רשימות ממוספרות**: "ראשית... שנית... שלישית..." שוברים את הזרימה. במקום — "אני יכולה לעזור בכמה דברים: קידום ממומן, אורגני, או קריאייטיב. מה מעניין אותך?"
3. **כתיב פונטי לשמות ומספרים בעברית**: "22" → "עשרים ושתיים". "OpenAI" → "אופן איי איי" (כשהסוכן צריך להגיד את זה).
4. **Fillers מובנים**: "רגע אחד...", "אני בודקת עבורך..." לפני tool calls שלוקחים > 500ms.
5. **Confirmation loops**: תמיד לחזור על מספר טלפון/מייל/תאריך לפני שמאשרים. "אז זה 054-1234567, נכון?"
6. **Anti-hallucination rules בפרומפט**:
```
CRITICAL RULES — never violate:
- Never invent calendar availability. Only offer slots returned by check_availability()
- Never quote a price. If asked, say "אבדוק את זה עם קורן בשיחת ההיכרות"
- Never claim you're a human. If asked, say "אני עוזרת אוטומטית של קורן"
- Never spell a Hebrew name letter by letter — ask for confirmation instead
```

---

## עקרון-על #9: הפרד את הפרוברייטרי מהקומודיטי

**מהמאמר:** *"Build only the proprietary parts: prompt, knowledge base, function endpoints, and workflows."* (AssemblyAI)

**מה שלנו (proprietary — נשקיע בו):**
- system_prompt.md ← ה-IP האמיתי
- Business logic (lead scoring, booking rules)
- Knowledge base ClickScales (services, pricing philosophy, case studies)
- Tests המבוססים על השיחות האמיתיות שלנו
- Weekly analysis pipeline

**מה שלא שלנו (commodity — לא נעשה):**
- אלגוריתם VAD → LiveKit
- Turn detection → LiveKit adaptive
- Barge-in → LiveKit
- SIP handling → LiveKit + Zadarma
- STT/LLM/TTS models → OpenAI + Cartesia

**Claude Code prompt:** *"When building new features, first check if LiveKit/Pipecat/OpenAI already solves it. Only write custom code for business-specific logic."*

---

## עקרון-על #10: קרא ל-AI לכתוב את הקוד — Fountain City validated this

**מהמאמר:** *"AI Agent Case Study: Voice Platform Built With Zero Human Code (2026)"* (Fountain City)

הם הוכיחו שאפשר לבנות פלטפורמת voice AI שלמה בפרודקשן **בלי מפתח אנושי**, עם:
- Twilio ל-audio
- n8n ל-orchestration
- Supabase ל-DB
- AI שכתב את כל workflows

**המפתח אצלם:** ארכיטקטורה ברורה של ״who owns what״.
עבורנו:
- **Zadarma owns ears/mouth** (audio in/out)
- **LiveKit owns orchestration** (session, turn-taking, streaming)
- **OpenAI owns thinking** (LLM + STT)
- **Cartesia owns voice** (TTS)
- **Claude Code owns building** (all glue code)
- **You own decisions** (product, prompts, testing)

זה הצוות. אין צוות מפתחים.

---

## סיכום — 10 העקרונות כ-checklist שאתה נותן ל-Claude Code

בכל פרומפט חדש, תזכיר לו:

```
When building this feature, follow our development methodology:
1. Reference SUCCESS_CRITERIA.md — check if this change moves any metric
2. Never edit system_prompt.md without adding a regression test
3. Every pipeline stage must stream — never buffer full responses
4. Cascade architecture — don't suggest S2S alternatives
5. Add latency instrumentation to any new code path
6. Test at 3 levels: unit + scripted conversation + benchmark
7. Deploy to develop branch first, never straight to main
8. Design for weekly human review — write logs a human can skim
9. Follow voice-prompt rules: short, no lists, phonetic, fillers, confirmations
10. Use off-the-shelf for commodity, custom only for business logic
```

**זה הופך את Claude Code ממתכנת אקראי ל-FDE שיודע את המתודולוגיה.**

---

## התוצאה הצפויה של השיטה הזאת

לפי המאמרים, פרויקטים שהריצו כזה תהליך הגיעו ל:
- **Week 2**: MVP רץ בפרודקשן, latency ~1.2s
- **Week 4**: Latency < 800ms, prompt v3, 15 tests passing
- **Month 2**: Prompt v10, 40 tests, completion rate 60%+
- **Month 3**: Prompt v20, 80 tests, completion rate 75%+, agent פחות טוב ממנוסה אנושי אבל **זמין 24/7 ב-5% מהעלות**
- **Month 6**: Prompt v40, 150 tests, completion rate 82%+, **עדיף על סוכן אנושי ממוצע במדדים הקשיחים**

**הנתון הזה מ-Medical Data Systems**: 100% automation אחרי 3-4 חודשי iteration עם מתודולוגיה דומה.
