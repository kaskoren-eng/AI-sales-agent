# Hebrew Voice AI Agent — Development Plan for Claude Code

**Owner:** Koren
**Stack:** Zadarma (SIP) + LiveKit Agents (Python) + OpenAI GPT-Realtime-Whisper (STT) + OpenAI GPT (LLM) + Cartesia Sonic 4 (TTS)
**Language:** Hebrew (primary)
**Target latency:** < 800ms end-to-end
**Prepared:** July 2026

---

## חלק 0 — הכנות (30 דקות, אתה עושה, לפני שמדברים עם Claude Code)

### חשבונות שאתה פותח וה-API keys שאתה אוסף:

| שירות | מה צריך | תיעוד |
|---|---|---|
| **LiveKit Cloud** | API Key + Secret + WebSocket URL | livekit.io — יש free tier נדיב, עד 50 שעות שיחה בחודש |
| **Zadarma** | SIP username, password, server, ומספר נכנס | לוח בקרה → Settings → SIP |
| **OpenAI** | API key עם גישה ל-Realtime API + GPT-5 | platform.openai.com — קנה $50 credits להתחלה |
| **Cartesia** | API key | cartesia.ai — חינם עד 10K תווים ראשונים |
| **Google Cloud** | OAuth credentials ל-Calendar API | console.cloud.google.com → Enable Google Calendar API → OAuth consent screen |
| **Meta WhatsApp Cloud API** | WABA account, phone number ID, permanent access token, template approvals | business.facebook.com → WhatsApp Business Platform. **חשוב:** אישור template בעברית לוקח 24-48 שעות |
| **Resend** | API key + verified sending domain | resend.com — חינם עד 3K מיילים בחודש. תוודא domain בspf/dkim |

### כלי הפיתוח שאתה מתקין:
1. **Claude Code** — `curl -fsSL https://claude.ai/install.sh | bash` (או דרך Homebrew)
2. **Python 3.11+** — https://python.org
3. **Git** — למעקב אחרי שינויים
4. **Cursor** או **VS Code** — עורך קוד לפתיחת קבצים

### תיקייה לפרויקט:
צור תיקייה ריקה, למשל `~/voice-agent`. שם תריץ את Claude Code.

---

## שלב 1 — Bootstrap הפרויקט (יום 1, ~1 שעה)

### Prompt ראשון ל-Claude Code (העתק מילה במילה):

```
I am NOT a developer. Explain every step before you do it in simple language. 
I want to build a Hebrew voice AI agent on LiveKit with this stack:

- Telephony: Zadarma SIP trunk
- Orchestration: LiveKit Agents (Python SDK)
- STT: OpenAI gpt-realtime-whisper (streaming)
- LLM: OpenAI GPT-5 (or best available)
- TTS: Cartesia Sonic 4 (Hebrew voice)

For this first task:
1. Set up a fresh LiveKit Agents Python project using the official starter template
2. Create a .env file with placeholders for all API keys I will need
3. Write a minimal working agent that:
   - Accepts a LiveKit room connection
   - Uses the pipeline: gpt-realtime-whisper → GPT-5 → Cartesia
   - Speaks Hebrew, listens in Hebrew
   - Says: "שלום, איך אני יכול לעזור?" when a call connects
4. Explain to me:
   - What each file does
   - How to run it locally
   - How to test it in the LiveKit playground

Do NOT connect Zadarma yet. First get it working in the LiveKit web playground with my microphone.
```

### מה Claude Code יעשה:
- יצור מבנה פרויקט (`agent.py`, `requirements.txt`, `.env.example`, `README.md`)
- יתקין תלויות: `livekit-agents`, `livekit-plugins-openai`, `livekit-plugins-cartesia`
- יסביר לך איפה להדביק כל API key
- יעזור לך להריץ locally ולהתחבר ל-playground

### מבחן הצלחה שלב 1:
נכנסת ל-LiveKit playground בדפדפן, לחצת "Connect", והסוכן אמר "שלום, איך אני יכול לעזור?" בעברית. אתה יכולת לדבר איתו והוא ענה לך.

---

## שלב 2 — אופטימיזציה לעברית (יום 2, ~2-3 שעות)

### Prompt שני ל-Claude Code:

```
The agent is working but I need to make the Hebrew sound natural. Do the following:

1. Configure Cartesia to use their best Hebrew voice. 
   - Test 3 different Hebrew voices from their voice library
   - Pick the one that sounds most natural (I will listen and decide)
   - Show me how to swap voices via config

2. Tune the LLM system prompt for natural Hebrew conversation:
   - Add instructions to keep responses short (max 2 sentences per turn)
   - Instruct it to use natural Hebrew — not translated English
   - Include examples of good/bad Hebrew responses
   - Use casual/professional register (I will tell you which)

3. Add these "human" features:
   - Backchannel responses: agent says "כן", "אוקיי", "הבנתי" while listening
   - Interruption handling: enable LiveKit's adaptive_interruption
   - Endpointing tuning: reduce silence-to-response gap to 300-500ms

4. Add basic filler phrases library ("רגע אחד...", "בוא נחשוב...") for when the LLM is thinking, so there's no dead air.

Explain what each change does and why it makes the agent sound more human.
```

### מבחן הצלחה שלב 2:
דיברת עם הסוכן ומדדת: latency פחות משנייה, קול טבעי בעברית, הוא לא מדבר יותר מדי, הוא לא נבהל אם קוטעים אותו.

---

## שלב 3 — חיבור Zadarma SIP (יום 3, ~2-3 שעות)

### Prompt שלישי ל-Claude Code:

```
Now connect the agent to real phone calls via Zadarma SIP trunk.

My Zadarma credentials:
- SIP server: [I will provide - from Zadarma dashboard]
- SIP username: [I will provide]
- SIP password: [I will provide]
- DID number: [my Zadarma phone number]

Steps:
1. Create a LiveKit SIP inbound trunk using the LiveKit CLI (`lk sip`)
2. Configure a dispatch rule that routes incoming calls to my agent
3. Update the agent to handle SIP-initiated rooms (participant identity, phone metadata)
4. Test flow:
   - I call my Zadarma number from my personal phone
   - Call routes: Zadarma → LiveKit SIP → my agent
   - Agent picks up, says the greeting in Hebrew, holds a conversation
5. Add call metadata capture: caller number, call start time, duration

Walk me through the LiveKit CLI commands step by step — I've never used it.
If there's an issue with Zadarma-specific SIP settings (codec, DTMF, NAT), debug 
it by reading Zadarma's docs at zadarma.com/en/support/instructions/ and adjust.
```

### מבחן הצלחה שלב 3:
התקשרת מהנייד האישי שלך למספר Zadarma. הסוכן ענה, ניהלת שיחה מלאה. השיחה נשמעת נקייה (בלי אקו, בלי חיתוכים).

---

## שלב 4 — לוגיקה עסקית: Inbound Lead → Discovery Call Booking

**Use case:** ליד חדש מתקשר לסוכנות שיווק דיגיטלי. הסוכן ממיין אותו, קובע לו discovery call של 15 דקות ביומן Google של Koren, ושולח אישור בוואטסאפ + אימייל.

### Prompt ל-Claude Code:

```
Add the following business logic to the agent. This is an inbound lead 
qualification + booking agent for my digital marketing agency (ClickScales).

=== CONVERSATION FLOW (Hebrew) ===

1. GREETING
   - "שלום, הגעת ל-ClickScales, אני עוזרת אישית ואשמח לעזור לקבוע איתך שיחת היכרות. איך אפשר לקרוא לך?"
   - Capture: full_name

2. QUALIFY (short, warm — do NOT interrogate)
   Ask in this order, one question at a time:
   
   a. "מגניב [name], ספר לי בשתי מילים על העסק שלך — מה אתם עושים?"
      Capture: business_type
   
   b. "ובאיזה תחום אתה מרגיש שהכי צריך עזרה בשיווק? קידום ממומן, אורגני, קריאייטיב, אסטרטגיה?"
      Capture: service_needed
   
   c. "מה התקציב שאתה מתכנן להשקיע בשיווק בחודש?"
      Capture: monthly_budget (options: <5K / 5-15K / 15-50K / 50K+)
      → If under 5K NIS/month: politely say we're not the right fit, offer to send resources by email, end call gracefully.
   
   d. "ומתי היית רוצה להתחיל?"
      Capture: timeline (options: immediately / 1 month / 3 months / just exploring)

3. LEAD SCORING (internal — do not say out loud)
   - HOT: budget > 15K AND timeline <= 1 month
   - WARM: budget 5-15K OR timeline 1-3 months
   - COLD: budget < 5K OR "just exploring"
   
   Store this classification in the call log.

4. BOOKING (for HOT and WARM leads)
   - "מעולה, בוא נקבע שיחת היכרות של רבע שעה עם קורן, המייסד. אני בודקת לך זמינות ביומן שלו..."
   - Call Google Calendar API to find 3 available 15-min slots in the next 5 business days.
   - Business hours: Sunday-Thursday, 09:00-17:00 Israel time. Buffer of 15 min between meetings.
   - Offer the 3 slots verbally in a natural way: "יש לי מחר ב-11:00, מחרתיים ב-14:30, או ביום חמישי ב-10:00 — מה מתאים לך?"
   - Confirm selection.

5. CONTACT INFO
   - "מעולה. מה מספר הוואטסאפ שלך שאשלח אליו אישור?"
     (Default to caller ID from Zadarma if they confirm it)
     Capture: phone
   - "ומה כתובת המייל שלך?"
     Capture: email
   - Confirm both back to them.

6. CREATE BOOKING
   - Create Google Calendar event:
     - Title: "Discovery Call — [full_name] ([business_type])"
     - Description: qualifying answers + lead score
     - Attendees: koren@clickscales.com + lead's email
     - Google Meet link auto-generated
   
7. SEND CONFIRMATIONS (in parallel):
   
   a. WhatsApp via Meta WhatsApp Cloud API to lead's phone:
      Message template:
      "היי [name] 👋
      אישרנו את השיחה שלך עם קורן ב-[date] בשעה [time].
      השיחה תהיה בזום — הלינק כבר ביומן שקיבלת במייל.
      נשמח לראותך! – צוות ClickScales"
   
   b. Email via Resend API:
      - To: lead's email
      - Subject: "אישור: שיחת היכרות עם ClickScales – [date]"
      - Body: friendly confirmation + calendar .ics attachment + agenda for the call
      - CC: koren@clickscales.com

8. CLOSE
   - "מעולה [name], נדבר ב-[date]. שיהיה יום נהדר!"
   - Hang up gracefully.

=== FOR COLD LEADS ===
- Do NOT book a call.
- "תודה [name], כרגע אנחנו מתמקדים בעסקים בסקייל מסוים. אשמח לשלוח לך במייל מדריך חינמי שיעזור לך להתחיל לבד. מה המייל שלך?"
- Send resources email via Resend.
- Log to CRM as "nurture — not qualified now".

=== TECHNICAL SETUP ===

1. Create Google Calendar integration:
   - Use OAuth2 with a service account OR my personal token
   - Scopes: calendar.readonly + calendar.events
   - Cache free/busy for 5 minutes to reduce API calls
   
2. Set up WhatsApp Cloud API (Meta Business):
   - I'll provide my WABA phone number ID and access token
   - Create approved template messages in advance (Meta requires pre-approval for outbound)
   - Fallback to SMS via Zadarma if WhatsApp fails
   
3. Set up Resend API:
   - I'll provide the API key
   - Create HTML email template in Hebrew (RTL-aware)
   - Include ICS calendar attachment for the meeting
   
4. Create a leads.jsonl log file with every call:
   - timestamp, caller_phone, full_name, business_type, service_needed, 
     monthly_budget, timeline, lead_score, booking_status, booked_slot
   - This is the raw data — later we'll pipe it to a proper CRM

=== EDGE CASES TO HANDLE ===

- Lead says "אני רק בודק" → treat as COLD.
- Lead won't share budget → politely ask again once, then classify as WARM by default.
- No calendar slots in next 5 days → offer to check next week.
- Google Calendar API fails → apologize, take their contact, promise Koren will call within 24h, alert Koren via WhatsApp.
- Lead wants to reschedule (calls back later) → recognize by phone number, offer to move existing booking.
- Lead requests to speak to a human → provide Koren's WhatsApp number and end the call politely.

Explain each step as you build it. Show me test scenarios I can run.
```

### מבחן הצלחה שלב 4:
1. אתה מתקשר מהנייד, מדבר כ״ליד״ עם תקציב סביר → הסוכן קובע פגישה, אתה רואה אותה מופיעה ביומן Google תוך שניות, מקבל וואטסאפ + מייל.
2. אתה מתקשר שוב, אומר "יש לי 2000 ש״ח לחודש" → הסוכן מנומס, לא קובע פגישה, שולח לך מייל עם משאבים.
3. אתה מתקשר, מבקש לדבר עם קורן ישירות → הסוכן נותן לך מספר וסוגר יפה.

---

## שלב 5 — Testing מובנה (יום 5-6, ~2 שעות)

### Prompt ל-Claude Code:

```
Set up automated testing for the agent:

1. Create a `tests/` folder with scripted test conversations in Hebrew
2. Use LiveKit's testing framework to simulate calls without dialing
3. Add metrics logging:
   - Latency per turn (STT + LLM + TTS times separately)
   - Interruption count
   - Successful task completion (e.g., booking made)
   - LLM token usage / cost per call
4. Create a dashboard file (HTML or CLI) that shows:
   - Last 20 calls
   - Average latency
   - Cost per call
   - Failure reasons
5. Add a "record and review" mode: save all calls to audio + transcript 
   so I can listen back and identify issues.

Show me how to run: `python tests/run_all.py` and get a report.
```

---

## שלב 6 — Production Deploy (יום 6-7, ~2 שעות)

### Prompt ל-Claude Code:

```
Deploy the agent to production on LiveKit Cloud so it runs 24/7.

1. Configure the agent for LiveKit Cloud deployment:
   - Dockerfile
   - livekit.toml config
   - Environment variables via LiveKit dashboard
2. Deploy with: `lk agent deploy`
3. Test the deployed agent by calling my Zadarma number again
4. Set up monitoring:
   - Sentry for error tracking (free tier)
   - Slack webhook for failed calls
5. Create a runbook (RUNBOOK.md) with:
   - How to restart the agent
   - How to check logs
   - How to roll back to previous version
   - Common issues and fixes

Estimate my monthly cost at 1,000 calls of 3 minutes each and break it down by 
component (LiveKit, Zadarma, OpenAI, Cartesia).
```

---

## שלב 7 — לולאת שיפור (מתמשך)

אחרי שאתה בפרודקשן, זה הפלואו השבועי:

**שבועי — יום שני בבוקר:**
1. הורד את 20 השיחות הכי חדשות (mp3 + transcript)
2. תשמע 5-10 מהן
3. סמן את הבעיות שאתה מזהה
4. פרומפט ל-Claude Code:

```
Here are 10 transcripts from last week's calls. I noticed these issues:
- [Issue 1: agent responded too slowly at line X]
- [Issue 2: didn't understand "בבקשה"]
- [Issue 3: hung up too early]

Analyze the transcripts, find the root cause of each issue, and propose fixes.
Then implement the fixes and add regression tests so these don't come back.
```

---

## עלות משוערת בייצור

| רכיב | לדקה | לחודש (100 שיחות × 3 דק) |
|---|---|---|
| Zadarma (מספר + דקות) | ~$0.01 | ~$8 |
| LiveKit Cloud | ~$0.005 | ~$5 (עד 50 שעות free) |
| OpenAI Realtime Whisper | $0.017 | $15 |
| OpenAI GPT-5 (LLM) | ~$0.03 | $27 |
| Cartesia Sonic 4 | ~$0.02 | $18 |
| **סה"כ** | **~$0.08/דקה** | **~$73 לחודש** |

לעומת Retell באותה תפוקה: **~$0.25/דקה = $225 לחודש**. חיסכון של **~68%**, פלוס שהקול בעברית טוב יותר.

---

## Checklist להתחלה עכשיו

**היום (חובה לשלב 1-3):**
- [ ] פתחתי חשבון LiveKit Cloud ולקחתי API key
- [ ] פתחתי חשבון OpenAI וקניתי $50 credits
- [ ] פתחתי חשבון Cartesia ולקחתי API key
- [ ] יש לי Zadarma SIP credentials + מספר טלפון פעיל
- [ ] התקנתי Claude Code + Python 3.11
- [ ] יצרתי תיקייה `~/voice-agent`
- [ ] הרצתי `claude` בתוך התיקייה
- [ ] הדבקתי את ה-prompt של שלב 1

**עד סוף השבוע (חובה לשלב 4):**
- [ ] הפעלתי Google Calendar API ב-Google Cloud Console + יצרתי OAuth credentials
- [ ] פתחתי WhatsApp Business Platform ב-Meta Business + שלחתי template לאישור (זמן המתנה 24-48 שעות — **תעשה את זה עכשיו!**)
- [ ] פתחתי חשבון Resend + אימתתי את הדומיין clickscales.com
- [ ] הכנתי טיוטת template לוואטסאפ + טיוטת מייל אישור בעברית

---

## טיפים אחרונים לעבודה עם Claude Code

1. **תמיד תגיד לו "explain before you do"** — הוא ילמד אותך תוך כדי.
2. **אחרי כל שלב תעשה `git commit`** — כך אפשר לחזור אחורה אם שברת משהו.
3. **אם משהו לא עובד — תעתיק לו את הודעת השגיאה במלואה.** אל תסביר במילים.
4. **תבקש ממנו לרוץ tests לפני כל commit** — יחסוך לך שעות של debug.
5. **אל תיתן לו יותר מדי כללים בבת אחת** — כל prompt = משימה אחת.
